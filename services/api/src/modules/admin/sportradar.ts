// /admin/sportradar — the Oddzilla ↔ Sportradar match mapping desk.
//
// Surface area:
//   GET    /admin/sportradar/summary                counts per state
//   GET    /admin/sportradar/mappings               review queue / search
//   GET    /admin/sportradar/sports                 sport filter options
//   PUT    /admin/sportradar/mappings/:matchId      set an id by hand
//   POST   /admin/sportradar/mappings/:matchId/confirm
//   POST   /admin/sportradar/mappings/:matchId/reject
//   DELETE /admin/sportradar/mappings/:matchId      drop the mapping
//   POST   /admin/sportradar/import                 paste fixtures, auto-match
//   POST   /admin/sportradar/sync                   fetch fixtures, auto-match
//
// Every mutation is audit-logged.
//
// The import endpoint is the workhorse: an operator pastes a batch of
// Sportradar fixtures for one sport, the matcher pairs them against our
// upcoming matches in that sport, and pairs that clear the auto-confirm
// bar land as `confirmed` while everything weaker lands as `candidate`
// for review. `dryRun` runs the whole thing and writes nothing, so the
// operator sees exactly what a real import would do first.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, asc, eq, gte, inArray, lte, sql, type SQL } from "drizzle-orm";
import {
  adminAuditLog,
  categories,
  matchSportradarIds,
  matches,
  sports,
  tournaments,
} from "@oddzilla/db";
import {
  SPORTRADAR_SPORT_IDS,
  sportradarSportIdFor,
} from "@oddzilla/types/sportradar";
import type { SportradarFixture } from "@oddzilla/types/sportradar";
import { BadRequestError, ConflictError, NotFoundError } from "../../lib/errors.js";
import { parseFixturesInput } from "../../lib/sportradar/fixtures-input.js";
import { createStatsFixtureSource } from "../../lib/sportradar/fixture-source.js";
import { proposeMappings, type OddzillaFixture } from "../../lib/sportradar/matcher.js";

const writeRateLimit = { rateLimit: { max: 60, timeWindow: "1 minute" } };
// An import walks every candidate pair in the batch; it is cheap but not
// free, and it writes. Tighter than the ordinary write budget.
const importRateLimit = { rateLimit: { max: 10, timeWindow: "1 minute" } };

/** How far back a match stays worth mapping. LMT is a LIVE tracker. */
const LOOKBACK_HOURS = 6;
/** How far ahead we bother pairing. Beyond this, kickoffs still move. */
const LOOKAHEAD_DAYS = 8;
/** Ceiling on one pasted batch — a day of one sport is a few hundred rows. */
const MAX_IMPORT_FIXTURES = 2000;

function importWindow(): { from: Date; to: Date } {
  const now = Date.now();
  return {
    from: new Date(now - LOOKBACK_HOURS * 3_600_000),
    to: new Date(now + LOOKAHEAD_DAYS * 86_400_000),
  };
}

const listQuery = z.object({
  // `unmapped` is the interesting default view for an operator starting
  // out; `candidate` is the review queue once an import has run.
  status: z
    .enum(["all", "unmapped", "candidate", "confirmed", "rejected"])
    .default("candidate"),
  sportId: z.coerce.number().int().positive().optional(),
  q: z.string().trim().max(128).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

const putBody = z.object({
  srMatchId: z.coerce.number().int().positive().max(999_999_999_999),
  // Optional: defaults to the sport's own Sportradar id. Present so an
  // operator can override a sport we map differently from Sportradar.
  srSportId: z.coerce.number().int().positive().max(32767).optional(),
});

const importBody = z
  .object({
    sportSlug: z.string().trim().min(1).max(64),
    text: z.string().max(2_000_000).optional(),
    dryRun: z.boolean().default(false),
  })
  .refine((b) => (b.text ?? "").trim().length > 0, {
    message: "text is required",
    path: ["text"],
  });

const syncBody = z.object({
  // Omitted = sweep every sport the tracker covers.
  sportSlug: z.string().trim().min(1).max(64).optional(),
  dryRun: z.boolean().default(false),
});

const matchIdParam = z.object({ matchId: z.coerce.bigint() });

export default async function adminSportradarRoutes(app: FastifyInstance) {
  // ── Summary ───────────────────────────────────────────────────────
  app.get("/admin/sportradar/summary", async (request) => {
    request.requireRole("admin");
    const { from, to } = importWindow();

    const [counts] = await app.db
      .select({
        candidate: sql<string>`COUNT(*) FILTER (WHERE ${matchSportradarIds.status} = 'candidate')::text`,
        confirmed: sql<string>`COUNT(*) FILTER (WHERE ${matchSportradarIds.status} = 'confirmed')::text`,
        rejected: sql<string>`COUNT(*) FILTER (WHERE ${matchSportradarIds.status} = 'rejected')::text`,
      })
      .from(matchSportradarIds);

    // "Mappable but unmapped" is the number that tells an operator
    // whether the tracker is actually covering the offer: matches in an
    // LMT-supported sport, inside the window, with no row at all.
    const supportedSlugs = Object.keys(SPORTRADAR_SPORT_IDS);
    const [{ unmapped } = { unmapped: "0" }] = await app.db
      .select({ unmapped: sql<string>`COUNT(*)::text` })
      .from(matches)
      .innerJoin(tournaments, eq(tournaments.id, matches.tournamentId))
      .innerJoin(categories, eq(categories.id, tournaments.categoryId))
      .innerJoin(sports, eq(sports.id, categories.sportId))
      .where(
        and(
          inArray(sports.slug, supportedSlugs),
          inArray(matches.status, ["not_started", "live"]),
          gte(matches.scheduledAt, from),
          lte(matches.scheduledAt, to),
          sql`NOT EXISTS (SELECT 1 FROM ${matchSportradarIds} s WHERE s.match_id = ${matches.id})`,
        ),
      );

    return {
      candidate: Number(counts?.candidate ?? 0),
      confirmed: Number(counts?.confirmed ?? 0),
      rejected: Number(counts?.rejected ?? 0),
      unmapped: Number(unmapped),
      lmtSports: supportedSlugs.length,
    };
  });

  // ── Sport filter options ──────────────────────────────────────────
  app.get("/admin/sportradar/sports", async (request) => {
    request.requireRole("admin");
    const rows = await app.db
      .select({ id: sports.id, slug: sports.slug, name: sports.name })
      .from(sports)
      .where(eq(sports.active, true))
      .orderBy(asc(sports.name));
    return {
      sports: rows.map((s) => ({
        ...s,
        srSportId: sportradarSportIdFor(s.slug),
      })),
    };
  });

  // ── Review queue / search ─────────────────────────────────────────
  app.get("/admin/sportradar/mappings", async (request) => {
    request.requireRole("admin");
    const q = listQuery.parse(request.query);
    const { from, to } = importWindow();

    const filters: SQL[] = [];
    if (q.sportId) filters.push(eq(categories.sportId, q.sportId));
    if (q.q) {
      const like = `%${q.q.replace(/[\\%_]/gu, (c) => `\\${c}`)}%`;
      filters.push(
        sql`(${matches.homeTeam} ILIKE ${like} OR ${matches.awayTeam} ILIKE ${like})`,
      );
    }

    if (q.status === "unmapped") {
      // Only worth showing for sports the tracker actually covers, and
      // only inside the window an operator can act on.
      filters.push(
        sql`${matchSportradarIds.matchId} IS NULL`,
        inArray(sports.slug, Object.keys(SPORTRADAR_SPORT_IDS)),
        inArray(matches.status, ["not_started", "live"]),
        gte(matches.scheduledAt, from),
        lte(matches.scheduledAt, to),
      );
    } else if (q.status !== "all") {
      filters.push(eq(matchSportradarIds.status, q.status));
    } else {
      filters.push(sql`${matchSportradarIds.matchId} IS NOT NULL`);
    }

    const where = filters.length > 0 ? and(...filters) : sql`TRUE`;

    const [rows, [total]] = await Promise.all([
      app.db
        .select({
          matchId: matches.id,
          providerUrn: matches.providerUrn,
          homeTeam: matches.homeTeam,
          awayTeam: matches.awayTeam,
          scheduledAt: matches.scheduledAt,
          matchStatus: matches.status,
          sportId: sports.id,
          sportSlug: sports.slug,
          sportName: sports.name,
          tournamentName: tournaments.name,
          srMatchId: matchSportradarIds.srMatchId,
          srSportId: matchSportradarIds.srSportId,
          mapStatus: matchSportradarIds.status,
          source: matchSportradarIds.source,
          confidence: matchSportradarIds.confidence,
          evidence: matchSportradarIds.evidence,
          reviewedAt: matchSportradarIds.reviewedAt,
        })
        .from(matches)
        .innerJoin(tournaments, eq(tournaments.id, matches.tournamentId))
        .innerJoin(categories, eq(categories.id, tournaments.categoryId))
        .innerJoin(sports, eq(sports.id, categories.sportId))
        .leftJoin(matchSportradarIds, eq(matchSportradarIds.matchId, matches.id))
        .where(where)
        // Weakest candidates first: the review queue should open on the
        // pairs most likely to be wrong, not the ones already obvious.
        .orderBy(asc(matchSportradarIds.confidence), asc(matches.scheduledAt))
        .limit(q.pageSize)
        .offset((q.page - 1) * q.pageSize),
      app.db
        .select({ count: sql<string>`COUNT(*)::text` })
        .from(matches)
        .innerJoin(tournaments, eq(tournaments.id, matches.tournamentId))
        .innerJoin(categories, eq(categories.id, tournaments.categoryId))
        .innerJoin(sports, eq(sports.id, categories.sportId))
        .leftJoin(matchSportradarIds, eq(matchSportradarIds.matchId, matches.id))
        .where(where),
    ]);

    return {
      page: q.page,
      pageSize: q.pageSize,
      total: Number(total?.count ?? 0),
      rows: rows.map((r) => ({
        matchId: r.matchId.toString(),
        providerUrn: r.providerUrn,
        // The provider half of the mapping, spelled out rather than left
        // encoded in the URN — this screen exists to show all three ids.
        provider: r.providerUrn.startsWith("fb:") ? "fonbet" : "oddin",
        providerMatchId: r.providerUrn.slice(9),
        homeTeam: r.homeTeam,
        awayTeam: r.awayTeam,
        scheduledAt: r.scheduledAt?.toISOString() ?? null,
        matchStatus: r.matchStatus,
        sportId: r.sportId,
        sportSlug: r.sportSlug,
        sportName: r.sportName,
        tournamentName: r.tournamentName,
        lmtSupported: sportradarSportIdFor(r.sportSlug) !== null,
        srMatchId: r.srMatchId === null ? null : Number(r.srMatchId),
        srSportId: r.srSportId,
        mapStatus: r.mapStatus,
        source: r.source,
        confidence: r.confidence === null ? null : Number(r.confidence),
        evidence: r.evidence,
        reviewedAt: r.reviewedAt?.toISOString() ?? null,
      })),
    };
  });

  // ── Set a mapping by hand ─────────────────────────────────────────
  app.put(
    "/admin/sportradar/mappings/:matchId",
    { config: writeRateLimit },
    async (request) => {
      const admin = request.requireRole("admin");
      const { matchId } = matchIdParam.parse(request.params);
      const body = putBody.parse(request.body);

      const [row] = await app.db
        .select({ id: matches.id, sportSlug: sports.slug })
        .from(matches)
        .innerJoin(tournaments, eq(tournaments.id, matches.tournamentId))
        .innerJoin(categories, eq(categories.id, tournaments.categoryId))
        .innerJoin(sports, eq(sports.id, categories.sportId))
        .where(eq(matches.id, matchId))
        .limit(1);
      if (!row) throw new NotFoundError("match_not_found", "match_not_found");

      const srSportId = body.srSportId ?? sportradarSportIdFor(row.sportSlug);
      if (srSportId === null) {
        throw new BadRequestError(
          `the Live Match Tracker has no sport id for "${row.sportSlug}" — pass srSportId explicitly to override`,
          "sport_not_covered_by_lmt",
        );
      }

      const [before] = await app.db
        .select()
        .from(matchSportradarIds)
        .where(eq(matchSportradarIds.matchId, matchId))
        .limit(1);

      try {
        await app.db.transaction(async (tx) => {
          await tx
            .insert(matchSportradarIds)
            .values({
              matchId,
              srMatchId: BigInt(body.srMatchId),
              srSportId,
              status: "confirmed",
              source: "admin",
              confidence: null,
              evidence: null,
              reviewedByUserId: admin.id,
              reviewedAt: new Date(),
            })
            .onConflictDoUpdate({
              target: matchSportradarIds.matchId,
              set: {
                srMatchId: BigInt(body.srMatchId),
                srSportId,
                status: "confirmed",
                source: "admin",
                // A hand-typed id carries no matcher confidence, and
                // leaving a stale score behind would misrepresent it.
                confidence: null,
                evidence: null,
                reviewedByUserId: admin.id,
                reviewedAt: new Date(),
                updatedAt: new Date(),
              },
            });
          await tx.insert(adminAuditLog).values({
            actorUserId: admin.id,
            action: "sportradar.mapping_set",
            targetType: "match",
            targetId: matchId.toString(),
            beforeJson: before
              ? { srMatchId: before.srMatchId.toString(), status: before.status }
              : null,
            afterJson: { srMatchId: String(body.srMatchId), srSportId, status: "confirmed" },
            ipInet: request.ip ?? null,
          });
        });
      } catch (err) {
        throw asSrIdConflict(err, body.srMatchId);
      }

      return { ok: true, matchId: matchId.toString(), srMatchId: body.srMatchId, srSportId };
    },
  );

  // ── Confirm / reject a candidate ──────────────────────────────────
  for (const decision of ["confirm", "reject"] as const) {
    app.post(
      `/admin/sportradar/mappings/:matchId/${decision}`,
      { config: writeRateLimit },
      async (request) => {
        const admin = request.requireRole("admin");
        const { matchId } = matchIdParam.parse(request.params);
        const status = decision === "confirm" ? "confirmed" : "rejected";

        const [before] = await app.db
          .select()
          .from(matchSportradarIds)
          .where(eq(matchSportradarIds.matchId, matchId))
          .limit(1);
        if (!before) throw new NotFoundError("mapping_not_found", "mapping_not_found");

        try {
          await app.db.transaction(async (tx) => {
            await tx
              .update(matchSportradarIds)
              .set({
                status,
                reviewedByUserId: admin.id,
                reviewedAt: new Date(),
                updatedAt: new Date(),
              })
              .where(eq(matchSportradarIds.matchId, matchId));
            await tx.insert(adminAuditLog).values({
              actorUserId: admin.id,
              action: `sportradar.mapping_${decision}`,
              targetType: "match",
              targetId: matchId.toString(),
              beforeJson: { status: before.status, srMatchId: before.srMatchId.toString() },
              afterJson: { status, srMatchId: before.srMatchId.toString() },
              ipInet: request.ip ?? null,
            });
          });
        } catch (err) {
          throw asSrIdConflict(err, Number(before.srMatchId));
        }

        return { ok: true, matchId: matchId.toString(), status };
      },
    );
  }

  // ── Drop a mapping ────────────────────────────────────────────────
  app.delete(
    "/admin/sportradar/mappings/:matchId",
    { config: writeRateLimit },
    async (request) => {
      const admin = request.requireRole("admin");
      const { matchId } = matchIdParam.parse(request.params);

      const [before] = await app.db
        .select()
        .from(matchSportradarIds)
        .where(eq(matchSportradarIds.matchId, matchId))
        .limit(1);
      if (!before) throw new NotFoundError("mapping_not_found", "mapping_not_found");

      await app.db.transaction(async (tx) => {
        await tx
          .delete(matchSportradarIds)
          .where(eq(matchSportradarIds.matchId, matchId));
        await tx.insert(adminAuditLog).values({
          actorUserId: admin.id,
          action: "sportradar.mapping_delete",
          targetType: "match",
          targetId: matchId.toString(),
          beforeJson: {
            srMatchId: before.srMatchId.toString(),
            status: before.status,
            source: before.source,
          },
          afterJson: null,
          ipInet: request.ip ?? null,
        });
      });

      return { ok: true };
    },
  );

  // ── Import a batch and auto-match ─────────────────────────────────
  app.post(
    "/admin/sportradar/import",
    { config: importRateLimit },
    async (request) => {
      const admin = request.requireRole("admin");
      const body = importBody.parse(request.body);

      const srSportId = sportradarSportIdFor(body.sportSlug);
      if (srSportId === null) {
        throw new BadRequestError(
          `the Live Match Tracker has no coverage for "${body.sportSlug}"`,
          "sport_not_covered_by_lmt",
        );
      }

      const parsed = parseFixturesInput(body.text ?? "", srSportId);
      if (parsed.fixtures.length === 0) {
        throw new BadRequestError(
          parsed.errors[0]?.reason ?? "no fixtures found in the pasted text",
          "no_fixtures_parsed",
        );
      }
      if (parsed.fixtures.length > MAX_IMPORT_FIXTURES) {
        throw new BadRequestError(
          `${parsed.fixtures.length} fixtures exceeds the ${MAX_IMPORT_FIXTURES} per-import limit`,
          "too_many_fixtures",
        );
      }

      return matchAndPersist(app, {
        sportSlug: body.sportSlug,
        fixtures: parsed.fixtures,
        dryRun: body.dryRun,
        adminId: admin.id,
        ip: request.ip ?? null,
        action: "sportradar.import",
        parseErrors: parsed.errors.slice(0, 20),
      });
    },
  );

  // ── Pull fixtures from Sportradar and auto-match ──────────────────
  //
  // Same pipeline as the paste import, with the fixtures fetched rather
  // than typed. Unlike the gated LMT feed, Sportradar's statistics host
  // answers ordinary server-to-server requests, so this needs no
  // credential — see lib/sportradar/fixture-source.ts.
  app.post(
    "/admin/sportradar/sync",
    { config: importRateLimit },
    async (request) => {
      const admin = request.requireRole("admin");
      const body = syncBody.parse(request.body);

      const slugs =
        body.sportSlug === undefined
          ? Object.keys(SPORTRADAR_SPORT_IDS)
          : [body.sportSlug];

      const source = createStatsFixtureSource();
      const perSport: Array<Record<string, unknown>> = [];
      const fetchErrors: string[] = [];
      let written = 0;
      let autoConfirmed = 0;
      let proposed = 0;

      for (const slug of slugs) {
        const srSportId = sportradarSportIdFor(slug);
        if (srSportId === null) {
          if (body.sportSlug !== undefined) {
            throw new BadRequestError(
              `the Live Match Tracker has no coverage for "${slug}"`,
              "sport_not_covered_by_lmt",
            );
          }
          continue;
        }

        // Only fetch the days our own open matches actually fall on —
        // one request per (sport, day), and none at all for a sport with
        // nothing to map.
        const days = await openMatchDays(app, slug);
        if (days.length === 0) continue;

        const fixtures: SportradarFixture[] = [];
        for (const day of days) {
          try {
            fixtures.push(...(await source.fetchDay(srSportId, day)));
          } catch (err) {
            // One bad day must not abandon the rest of the sweep.
            fetchErrors.push(`${slug} ${day}: ${(err as Error).message}`);
          }
        }
        if (fixtures.length === 0) continue;

        const result = await matchAndPersist(app, {
          sportSlug: slug,
          fixtures,
          dryRun: body.dryRun,
          adminId: admin.id,
          ip: request.ip ?? null,
          action: "sportradar.sync",
          parseErrors: [],
        });
        written += result.written ?? 0;
        autoConfirmed += result.wouldAutoConfirm;
        proposed += result.proposed;
        perSport.push({
          sportSlug: slug,
          days: days.length,
          fixturesFetched: fixtures.length,
          matchesConsidered: result.matchesConsidered,
          proposed: result.proposed,
          autoConfirmed: result.wouldAutoConfirm,
          queuedForReview: result.queuedForReview,
          written: result.written ?? 0,
        });
      }

      return {
        dryRun: body.dryRun,
        sports: perSport,
        proposed,
        autoConfirmed,
        written,
        fetchErrors: fetchErrors.slice(0, 20),
      };
    },
  );
}

/**
 * The distinct UTC days our own open matches for a sport fall on, so the
 * sweep fetches exactly the Sportradar days it can use.
 */
async function openMatchDays(
  app: FastifyInstance,
  sportSlug: string,
): Promise<string[]> {
  const { from, to } = importWindow();
  const rows = await app.db
    .select({ day: sql<string>`DISTINCT to_char(${matches.scheduledAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')` })
    .from(matches)
    .innerJoin(tournaments, eq(tournaments.id, matches.tournamentId))
    .innerJoin(categories, eq(categories.id, tournaments.categoryId))
    .innerJoin(sports, eq(sports.id, categories.sportId))
    .where(
      and(
        eq(sports.slug, sportSlug),
        inArray(matches.status, ["not_started", "live"]),
        gte(matches.scheduledAt, from),
        lte(matches.scheduledAt, to),
      ),
    );
  return rows.map((r) => r.day).sort();
}

interface PersistResult {
  dryRun: boolean;
  fixturesParsed: number;
  parseErrors: Array<{ line: number; reason: string; raw: string }>;
  matchesConsidered: number;
  proposed: number;
  wouldAutoConfirm: number;
  queuedForReview: number;
  unmatched: number;
  preview: Array<Record<string, unknown>>;
  written?: number;
  skippedTaken?: number;
}

/**
 * Pair a batch of Sportradar fixtures against our open matches for one
 * sport and persist the result. Shared by the paste import and the
 * fetch-based sync so the two can never drift in what they accept.
 */
async function matchAndPersist(
  app: FastifyInstance,
  opts: {
    sportSlug: string;
    fixtures: SportradarFixture[];
    dryRun: boolean;
    adminId: string;
    ip: string | null;
    action: string;
    parseErrors: Array<{ line: number; reason: string; raw: string }>;
  },
): Promise<PersistResult> {
  const srSportId = sportradarSportIdFor(opts.sportSlug);
  if (srSportId === null) {
    throw new BadRequestError(
      `the Live Match Tracker has no coverage for "${opts.sportSlug}"`,
      "sport_not_covered_by_lmt",
    );
  }

  const { from, to } = importWindow();
  // Candidates: our matches in this sport, inside the window, that no
  // human has already ruled on. An `admin`-sourced row or a rejection
  // is a decision — the matcher does not get to overwrite either.
  const ourRows = await app.db
    .select({
      matchId: matches.id,
      homeTeam: matches.homeTeam,
      awayTeam: matches.awayTeam,
      scheduledAt: matches.scheduledAt,
    })
    .from(matches)
    .innerJoin(tournaments, eq(tournaments.id, matches.tournamentId))
    .innerJoin(categories, eq(categories.id, tournaments.categoryId))
    .innerJoin(sports, eq(sports.id, categories.sportId))
    .leftJoin(matchSportradarIds, eq(matchSportradarIds.matchId, matches.id))
    .where(
      and(
        eq(sports.slug, opts.sportSlug),
        inArray(matches.status, ["not_started", "live"]),
        gte(matches.scheduledAt, from),
        lte(matches.scheduledAt, to),
        sql`(${matchSportradarIds.matchId} IS NULL OR (${matchSportradarIds.source} = 'auto' AND ${matchSportradarIds.status} = 'candidate'))`,
      ),
    );

  const ourFixtures: OddzillaFixture[] = ourRows.map((r) => ({
    matchId: r.matchId.toString(),
    srSportId,
    scheduledAt: r.scheduledAt,
    homeTeam: r.homeTeam,
    awayTeam: r.awayTeam,
  }));

  const proposals = proposeMappings(ourFixtures, opts.fixtures);
  const autoCount = proposals.filter((p) => p.autoConfirm).length;

  const preview = proposals.slice(0, 50).map((p) => {
    const ours = ourRows.find((r) => r.matchId.toString() === p.matchId);
    return {
      matchId: p.matchId,
      homeTeam: ours?.homeTeam ?? "",
      awayTeam: ours?.awayTeam ?? "",
      srMatchId: p.srMatchId,
      srHomeTeam: p.evidence.srHomeTeam,
      srAwayTeam: p.evidence.srAwayTeam,
      confidence: p.confidence,
      autoConfirm: p.autoConfirm,
      sidesSwapped: p.evidence.sidesSwapped,
    };
  });

  const summary: PersistResult = {
    dryRun: opts.dryRun,
    fixturesParsed: opts.fixtures.length,
    parseErrors: opts.parseErrors,
    matchesConsidered: ourFixtures.length,
    proposed: proposals.length,
    wouldAutoConfirm: autoCount,
    queuedForReview: proposals.length - autoCount,
    unmatched: ourFixtures.length - proposals.length,
    preview,
  };

  if (opts.dryRun || proposals.length === 0) return summary;

  let written = 0;
  let skippedTaken = 0;
  await app.db.transaction(async (tx) => {
    for (const p of proposals) {
      // A Sportradar fixture already claimed by a DIFFERENT match —
      // typically one an operator confirmed by hand — is left alone.
      // The partial unique index would reject the insert anyway;
      // checking first turns a failed batch into a reported skip.
      const [taken] = await tx
        .select({ matchId: matchSportradarIds.matchId })
        .from(matchSportradarIds)
        .where(
          and(
            eq(matchSportradarIds.srMatchId, BigInt(p.srMatchId)),
            sql`${matchSportradarIds.status} <> 'rejected'`,
            sql`${matchSportradarIds.matchId} <> ${BigInt(p.matchId)}`,
          ),
        )
        .limit(1);
      if (taken) {
        skippedTaken += 1;
        continue;
      }

      await tx
        .insert(matchSportradarIds)
        .values({
          matchId: BigInt(p.matchId),
          srMatchId: BigInt(p.srMatchId),
          srSportId: p.srSportId,
          status: p.autoConfirm ? "confirmed" : "candidate",
          source: "auto",
          confidence: p.confidence.toFixed(3),
          evidence: p.evidence,
        })
        .onConflictDoUpdate({
          target: matchSportradarIds.matchId,
          set: {
            srMatchId: BigInt(p.srMatchId),
            srSportId: p.srSportId,
            status: p.autoConfirm ? "confirmed" : "candidate",
            source: "auto",
            confidence: p.confidence.toFixed(3),
            evidence: p.evidence,
            updatedAt: new Date(),
          },
          // Belt and braces alongside the query above: never let an
          // automatic pass overwrite a human decision.
          setWhere: sql`${matchSportradarIds.source} = 'auto' AND ${matchSportradarIds.status} = 'candidate'`,
        });
      written += 1;
    }

    await tx.insert(adminAuditLog).values({
      actorUserId: opts.adminId,
      action: opts.action,
      targetType: "sport",
      targetId: opts.sportSlug,
      beforeJson: null,
      afterJson: {
        fixtures: opts.fixtures.length,
        proposed: proposals.length,
        autoConfirmed: autoCount,
        written,
        skippedTaken,
      },
      ipInet: opts.ip,
    });
  });

  return { ...summary, written, skippedTaken };
}

/**
 * Turn the partial-unique violation on `sr_match_id` into a typed 409.
 * Without this the operator gets a bare 500 for the entirely ordinary
 * mistake of pasting an id that already belongs to another match.
 */
function asSrIdConflict(err: unknown, srMatchId: number): unknown {
  const code = (err as { code?: string } | null)?.code;
  if (code === "23505") {
    return new ConflictError(
      `Sportradar match ${srMatchId} is already mapped to another Oddzilla match`,
      "sportradar_id_already_mapped",
    );
  }
  return err;
}
