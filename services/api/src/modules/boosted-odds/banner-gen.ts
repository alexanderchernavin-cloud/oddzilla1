// /webhooks/banner-gen/:secret/* — server-to-server endpoints for the
// ZillaBoost graphics-banner worker (services/zillaboost-banner-gen).
// The worker runs on an operator PC with local models (LM Studio for
// prompt authoring, a local image model for rendering), polls /pending
// over outbound HTTPS, and uploads finished graphics back.
//
// PULL MODEL, deliberately: the production box never dials the
// operator's LAN. "The PC is off" therefore needs no server-side retry
// machinery at all — jobs simply sit at status='pending' until the
// worker comes back and drains the queue. Reachability retry exists
// only inside the worker, for its LOCAL image backend (hourly).
//
// Auth mirrors /webhooks/support-ai: the :secret path component is
// constant-time compared against BANNER_GEN_TOKEN; unset token → 503
// banner_gen_disabled (jobs still enqueue and wait); wrong secret →
// 404 so the route's existence isn't confirmable to scanners. Mounted
// under /webhooks/ so the CSRF plugin skips it.
//
// Claim protocol: GET /pending leases up to `limit` due jobs for
// LEASE_MINUTES (invisible to further polls), so a worker crash mid-
// generation self-heals when the lease expires. complete/fail require
// the caller to still be inside its lease window.

import type { FastifyInstance, FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import { loadEnv } from "@oddzilla/config";
import {
  boostedOddsConfig,
  categories,
  competitors,
  matches,
  sports,
  tournaments,
  zillaboostBannerImageJobs,
} from "@oddzilla/db";
import {
  BANNER_GEN_ALLOWED_MIMES,
  BANNER_GEN_MAX_IMAGE_BYTES,
  type BannerGenJob,
  type BannerGenPendingResponse,
} from "@oddzilla/types";
import {
  BadRequestError,
  NotFoundError,
  ServiceUnavailableError,
} from "../../lib/errors.js";

const LEASE_MINUTES = 15;
// A job that failed generation this many times flips to 'failed' and
// stops being offered — visible in the admin overview; re-ticking the
// option in the popup resets it. Backend-unreachable does NOT burn
// attempts (the worker doesn't claim jobs it can't process).
const MAX_ATTEMPTS = 24;
// Generation-failure backoff — matches the operator's "retry once per
// hour" cadence for anything that keeps failing.
const RETRY_BACKOFF_MINUTES = 60;

const pendingQuery = z.object({
  limit: z.coerce.number().int().min(1).max(10).default(3),
});

const completeBody = z.object({
  // Finished graphic as base64 (no data: prefix). Cap the ENCODED size
  // at 4/3 of the byte limit so we reject oversized payloads before
  // decoding them.
  imageBase64: z
    .string()
    .min(1)
    .max(Math.ceil((BANNER_GEN_MAX_IMAGE_BYTES * 4) / 3) + 4),
  mime: z.enum(BANNER_GEN_ALLOWED_MIMES),
});

const failBody = z.object({
  error: z.string().trim().min(1).max(2000),
});

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Build the per-scope entity context the worker's research + prompt
 * steps need. Every branch resolves down to human-readable names — the
 * worker never sees internal ids beyond the ruleId it echoes back.
 */
async function buildJobContext(
  app: FastifyInstance,
  rule: typeof boostedOddsConfig.$inferSelect,
): Promise<BannerGenJob["context"]> {
  const empty: BannerGenJob["context"] = {
    sportName: null,
    sportSlug: null,
    tournamentName: null,
    homeTeam: null,
    awayTeam: null,
    competitorName: null,
  };
  switch (rule.scope) {
    case "sport": {
      const [s] = await app.db
        .select({ name: sports.name, slug: sports.slug })
        .from(sports)
        .where(eq(sports.id, rule.sportId!))
        .limit(1);
      return s ? { ...empty, sportName: s.name, sportSlug: s.slug } : empty;
    }
    case "tournament": {
      const [t] = await app.db
        .select({
          name: tournaments.name,
          sportName: sports.name,
          sportSlug: sports.slug,
        })
        .from(tournaments)
        .innerJoin(categories, eq(categories.id, tournaments.categoryId))
        .innerJoin(sports, eq(sports.id, categories.sportId))
        .where(eq(tournaments.id, rule.tournamentId!))
        .limit(1);
      return t
        ? {
            ...empty,
            tournamentName: t.name,
            sportName: t.sportName,
            sportSlug: t.sportSlug,
          }
        : empty;
    }
    case "competitor": {
      const [c] = await app.db
        .select({
          name: competitors.name,
          sportName: sports.name,
          sportSlug: sports.slug,
        })
        .from(competitors)
        .innerJoin(sports, eq(sports.id, competitors.sportId))
        .where(eq(competitors.id, rule.competitorId!))
        .limit(1);
      return c
        ? {
            ...empty,
            competitorName: c.name,
            sportName: c.sportName,
            sportSlug: c.sportSlug,
          }
        : empty;
    }
    // match / market / outcome all resolve to the match's teams +
    // tournament + sport — the graphic advertises the fixture; which
    // market of it is boosted doesn't change the picture.
    case "match":
    case "market":
    case "outcome": {
      const matchIdExpr =
        rule.scope === "match"
          ? sql`${matches.id} = ${rule.matchId!}`
          : sql`${matches.id} = (SELECT mk.match_id FROM markets mk WHERE mk.id = ${rule.marketId!})`;
      const [m] = await app.db
        .select({
          homeTeam: matches.homeTeam,
          awayTeam: matches.awayTeam,
          tournamentName: tournaments.name,
          sportName: sports.name,
          sportSlug: sports.slug,
        })
        .from(matches)
        .innerJoin(tournaments, eq(tournaments.id, matches.tournamentId))
        .innerJoin(categories, eq(categories.id, tournaments.categoryId))
        .innerJoin(sports, eq(sports.id, categories.sportId))
        .where(matchIdExpr)
        .limit(1);
      return m
        ? {
            sportName: m.sportName,
            sportSlug: m.sportSlug,
            tournamentName: m.tournamentName,
            homeTeam: m.homeTeam,
            awayTeam: m.awayTeam,
            competitorName: null,
          }
        : empty;
    }
  }
}

export default async function bannerGenRoutes(app: FastifyInstance) {
  const token = loadEnv().BANNER_GEN_TOKEN;

  function assertAuth(request: FastifyRequest): void {
    if (!token) {
      throw new ServiceUnavailableError(
        "banner_gen_disabled",
        "banner_gen_disabled",
      );
    }
    const provided = (request.params as { secret?: string }).secret ?? "";
    if (!constantTimeEquals(provided, token)) {
      throw new NotFoundError("not_found", "not_found");
    }
  }

  function parseRuleId(request: FastifyRequest): string {
    const parsed = z
      .object({ ruleId: z.string().uuid() })
      .safeParse(request.params);
    if (!parsed.success) {
      throw new NotFoundError("job_not_found", "job_not_found");
    }
    return parsed.data.ruleId;
  }

  // ── Claim due jobs ─────────────────────────────────────────────────
  app.get(
    "/webhooks/banner-gen/:secret/pending",
    async (request): Promise<BannerGenPendingResponse> => {
      assertAuth(request);
      const { limit } = pendingQuery.parse(request.query);

      // Atomic claim: select due pending jobs (lease expired or never
      // leased, backoff elapsed) and stamp a fresh lease in one
      // statement, so two worker instances can't double-claim.
      const claimed = (await app.db.execute(sql`
        UPDATE zillaboost_banner_image_jobs j
           SET leased_until = now() + interval '${sql.raw(String(LEASE_MINUTES))} minutes',
               updated_at = now()
         WHERE j.rule_id IN (
                 SELECT rule_id FROM zillaboost_banner_image_jobs
                  WHERE status = 'pending'
                    AND next_attempt_at <= now()
                    AND (leased_until IS NULL OR leased_until < now())
                  ORDER BY next_attempt_at
                  LIMIT ${limit}
                  FOR UPDATE SKIP LOCKED
               )
        RETURNING j.rule_id, j.attempts
      `)) as unknown as Array<{ rule_id: string; attempts: number }>;

      const jobs: BannerGenJob[] = [];
      for (const row of claimed) {
        const [rule] = await app.db
          .select()
          .from(boostedOddsConfig)
          .where(eq(boostedOddsConfig.id, row.rule_id))
          .limit(1);
        // Rule deleted between enqueue and claim (FK cascade should
        // have removed the job, but belt-and-braces) — skip silently.
        if (!rule) continue;
        jobs.push({
          ruleId: rule.id,
          scope: rule.scope,
          boostPct: Number(rule.boostPct),
          endsAt: rule.endsAt?.toISOString() ?? null,
          attempts: row.attempts,
          context: await buildJobContext(app, rule),
        });
      }
      return { jobs, serverNow: new Date().toISOString() };
    },
  );

  // ── Upload the finished graphic ────────────────────────────────────
  app.post(
    "/webhooks/banner-gen/:secret/jobs/:ruleId/complete",
    async (request) => {
      assertAuth(request);
      const ruleId = parseRuleId(request);
      const body = completeBody.parse(request.body);
      const bytes = Buffer.from(body.imageBase64, "base64");
      if (bytes.length === 0 || bytes.length > BANNER_GEN_MAX_IMAGE_BYTES) {
        throw new BadRequestError("image_invalid", "image_invalid");
      }

      const updated = await app.db
        .update(zillaboostBannerImageJobs)
        .set({
          status: "done",
          imageData: bytes,
          imageMime: body.mime,
          generatedAt: new Date(),
          leasedUntil: null,
          lastError: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(zillaboostBannerImageJobs.ruleId, ruleId),
            // Only the current lease holder may complete — an expired
            // lease means the job was re-offered and someone else may
            // be rendering it.
            sql`${zillaboostBannerImageJobs.leasedUntil} >= now()`,
          ),
        )
        .returning({ ruleId: zillaboostBannerImageJobs.ruleId });
      if (updated.length === 0) {
        throw new NotFoundError("job_not_claimable", "job_not_claimable");
      }
      return { ok: true };
    },
  );

  // ── Report a generation failure ────────────────────────────────────
  // Counts an attempt and backs the job off RETRY_BACKOFF_MINUTES; at
  // MAX_ATTEMPTS it flips to 'failed' and stops being offered. The
  // worker calls this ONLY for real generation errors — when its local
  // backend is down it simply doesn't claim, so an off-for-a-week PC
  // burns zero attempts.
  app.post(
    "/webhooks/banner-gen/:secret/jobs/:ruleId/fail",
    async (request) => {
      assertAuth(request);
      const ruleId = parseRuleId(request);
      const body = failBody.parse(request.body);

      const updated = (await app.db.execute(sql`
        UPDATE zillaboost_banner_image_jobs
           SET attempts = attempts + 1,
               last_error = ${body.error},
               status = CASE WHEN attempts + 1 >= ${MAX_ATTEMPTS} THEN 'failed' ELSE 'pending' END,
               next_attempt_at = now() + interval '${sql.raw(String(RETRY_BACKOFF_MINUTES))} minutes',
               leased_until = NULL,
               updated_at = now()
         WHERE rule_id = ${ruleId}
           AND status = 'pending'
        RETURNING rule_id
      `)) as unknown as Array<{ rule_id: string }>;
      if (updated.length === 0) {
        throw new NotFoundError("job_not_found", "job_not_found");
      }
      return { ok: true };
    },
  );
}
