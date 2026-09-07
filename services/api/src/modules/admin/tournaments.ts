// /admin/tournaments endpoints. Admin-only.
//
// Surface area:
//   GET    /admin/tournaments                 paginated list. Filters:
//                                             ?sportId, ?categoryId, ?q
//                                             (name search), ?tier (1..10
//                                             or "unset"), ?source
//                                             (auto|zagi|manual),
//                                             ?missingLogo=1, ?active.
//                                             Sort: ?sort= default | name |
//                                             sport | category | tier |
//                                             source, with ?dir=asc|desc.
//   GET    /admin/tournaments/sports          sport-filter dropdown options
//   GET    /admin/tournaments/categories      category-filter options for
//                                             one sport (?sportId)
//   PATCH  /admin/tournaments/:id             update logo_url / brand_color.
//                                             Mutations are audit-logged.
//   POST   /admin/tournaments/:id/logo        multipart upload — accepts
//                                             SVG / PNG / JPEG / WebP up
//                                             to 1 MB. Same shape as
//                                             /admin/sports + /admin/
//                                             competitors.
//   DELETE /admin/tournaments/:id/logo        clear bytes + URL in one tx.
//   POST   /admin/tournaments/:id/order       pin / move / unpin within
//                                             the tournament's own
//                                             category. Audit-logged.
//   GET    /admin/tournaments/zagi-status     risk-tier review backlog +
//                                             whether ZillaAGI is wired up.
//   POST   /admin/tournaments/zagi-review     run a review pass now
//                                             (?dryRun for a preview).
//                                             Audit-logged.
//
// Risk tier (migrations 0094 + 0106): `risk_tier` sets RiskZilla's
// per-match liability budget, and a NULL prices at the STRICTEST tier —
// so an untiered tournament is never dangerous, just invisible and
// under-traded. Three provenances now, carried by `risk_tier_source`:
// `manual` (an operator typed it; locked against the feed), `zagi`
// (ZillaAGI reviewed it), and `auto` — which means feed-assigned OR
// never looked at, and is therefore the queue.
//
// What the ordering does (migration 0104): tournaments sort by Oddin's
// risk_tier, then live count, then match count, then name. That is a fine
// default and a poor merchandising position — it cannot put the league an
// operator leads with at the top of its country. A pinned tournament
// heads its category's bucket; everything unpinned keeps the old rule
// behind it. Scope is the CATEGORY because that is the bucket the rows
// render in; esports tournaments all sit under one synthetic dummy
// category per sport, which is also how the storefront draws them.
//
// Tournament rows ship without branding from the Oddin feed — the
// admin manages it manually here. Storefront integration: the sidebar
// tournament sub-tree picks up logo_url; missing rows fall back to the
// sport's logo.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, asc, eq, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import { tournaments, categories, sports, adminAuditLog } from "@oddzilla/db";
import { BadRequestError, NotFoundError } from "../../lib/errors.js";
import { reorderPinned, type PinAction } from "../../lib/pin-order.js";
import { assignRiskTiers, riskTierBacklog } from "../../lib/zagi/risk-tier.js";
import {
  logoBacklog,
  resolveTournamentLogos,
} from "../../lib/tournament-logos/resolver.js";
import multipart from "@fastify/multipart";

const MAX_UPLOAD_BYTES = 1 * 1024 * 1024;
const ALLOWED_MIME = new Set([
  "image/svg+xml",
  "image/png",
  "image/jpeg",
  "image/webp",
]);

function buildTournamentLogoUrl(id: number, version: number): string {
  return `/api/tournaments/${id}/logo?v=${version}`;
}

const orderBody = z.object({
  action: z.enum(["top", "up", "down", "clear"]),
});

const writeRateLimit = {
  rateLimit: { max: 30, timeWindow: "1 minute" },
};

const hexColor = z
  .string()
  .trim()
  .max(7)
  .regex(/^#[0-9A-Fa-f]{6}$/u, "brand_color must look like #RRGGBB")
  .nullable();

const logoUrlSchema = z
  .string()
  .trim()
  .max(2048)
  .refine(
    (v) => v.startsWith("http://") || v.startsWith("https://") || v.startsWith("/"),
    "logo_url must be an http(s) URL or absolute path",
  )
  .nullable();

// Sort keys are an allowlist mapped to columns below — never a column
// name off the query string.
const SORT_KEYS = ["default", "name", "sport", "category", "tier", "source"] as const;

const listQuery = z.object({
  q: z.string().trim().max(128).optional(),
  sportId: z.coerce.number().int().positive().optional(),
  categoryId: z.coerce.number().int().positive().optional(),
  // "unset" is a first-class choice, not the absence of a filter: an
  // untiered tournament is the one an operator most often wants to find.
  tier: z
    .union([z.coerce.number().int().min(1).max(10), z.literal("unset")])
    .optional(),
  source: z.enum(["auto", "zagi", "manual"]).optional(),
  sort: z.enum(SORT_KEYS).default("default"),
  dir: z.enum(["asc", "desc"]).default("asc"),
  missingLogo: z
    .union([z.literal("1"), z.literal("true"), z.literal("0"), z.literal("false")])
    .optional()
    .transform((v) => v === "1" || v === "true"),
  active: z
    .union([z.literal("1"), z.literal("true"), z.literal("0"), z.literal("false")])
    .optional()
    .transform((v) => (v == null ? undefined : v === "1" || v === "true")),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

// Manual risk tier (migration 0094). A number assigns the tier AND locks
// the row so feed-ingester's REST refresh cannot overwrite it; null
// unlocks it (the current value stays until the next automatic refresh
// replaces it). Range mirrors RiskZilla's per-tier settings (1..10).
const riskTierSchema = z.union([z.number().int().min(1).max(10), z.null()]);

const patchBody = z
  .object({
    logoUrl: z.union([logoUrlSchema, z.literal("").transform(() => null)]).optional(),
    brandColor: z
      .union([hexColor, z.literal("").transform(() => null)])
      .optional(),
    riskTier: riskTierSchema.optional(),
  })
  .refine(
    (v) => v.logoUrl !== undefined || v.brandColor !== undefined || v.riskTier !== undefined,
    { message: "at least one field is required" },
  );

interface TournamentRow {
  id: number;
  sportId: number;
  sportSlug: string;
  sportName: string;
  categoryId: number;
  categoryName: string;
  slug: string;
  name: string;
  riskTier: number | null;
  riskTierLocked: boolean;
  riskTierSource: string;
  riskTierNote: string | null;
  active: boolean;
  logoUrl: string | null;
  brandColor: string | null;
}

const zagiReviewBody = z.object({
  // Held open for the duration of the model calls, so the interactive
  // cap is well below the sweeper's: 200 rows is ~8 requests at roughly
  // 15 s each. The backlog drains across several clicks or on its own.
  limit: z.coerce.number().int().min(1).max(200).default(50),
  sportId: z.coerce.number().int().positive().optional(),
  dryRun: z.boolean().optional(),
});

const logoFetchBody = z.object({
  // Lower cap than the tier review: Liquipedia's 2 s floor means a
  // tournament can take ten seconds of wall clock on its own.
  limit: z.coerce.number().int().min(1).max(60).default(20),
  sportId: z.coerce.number().int().positive().optional(),
  dryRun: z.boolean().optional(),
});

export default async function adminTournamentsRoutes(app: FastifyInstance) {
  await app.register(multipart, {
    limits: {
      fileSize: MAX_UPLOAD_BYTES,
      files: 1,
      fields: 5,
      fieldSize: 1024,
    },
  });

  // ── List ──────────────────────────────────────────────────────────
  app.get("/admin/tournaments", async (request) => {
    request.requireRole("admin");
    const q = listQuery.parse(request.query);

    const filters: SQL[] = [];
    if (q.sportId) filters.push(eq(categories.sportId, q.sportId));
    if (q.q) {
      const like = `%${q.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      filters.push(
        sql`(${tournaments.name} ILIKE ${like} OR ${tournaments.slug} ILIKE ${like})`,
      );
    }
    if (q.categoryId) filters.push(eq(tournaments.categoryId, q.categoryId));
    if (q.tier === "unset") filters.push(isNull(tournaments.riskTier));
    else if (typeof q.tier === "number") filters.push(eq(tournaments.riskTier, q.tier));
    if (q.source) filters.push(eq(tournaments.riskTierSource, q.source));
    if (q.missingLogo) filters.push(isNull(tournaments.logoUrl));
    if (q.active !== undefined) filters.push(eq(tournaments.active, q.active));

    const where = filters.length > 0 ? and(...filters) : sql`TRUE`;

    // Explicit allowlist → column. The default keeps the pin-order view:
    // sport, then country, then pinned rows in operator order, then name,
    // which is the sequence the reorder arrows act in and therefore the
    // only one an operator can reason about while pinning.
    const dir = q.dir === "desc" ? sql`DESC` : sql`ASC`;
    const orderBy: SQL[] =
      q.sort === "default"
        ? [
            sql`${sports.slug} ASC`,
            sql`${categories.name} ASC`,
            sql`${tournaments.displayOrder} ASC NULLS LAST`,
            sql`${tournaments.name} ASC`,
          ]
        : [
            q.sort === "name"
              ? sql`${tournaments.name} ${dir}`
              : q.sort === "sport"
                ? sql`${sports.slug} ${dir}`
                : q.sort === "category"
                  ? sql`${categories.name} ${dir}`
                  : q.sort === "source"
                    ? sql`${tournaments.riskTierSource} ${dir}`
                    : // Untiered rows sort to the end whichever way the
                      // column is pointed — "no tier" is not a low tier
                      // or a high one, and burying it under either end
                      // would hide the rows most worth finding.
                      sql`${tournaments.riskTier} ${dir} NULLS LAST`,
            // Stable tiebreak, so paging through a sorted list cannot
            // show the same row twice or skip one.
            sql`${tournaments.name} ASC`,
            sql`${tournaments.id} ASC`,
          ];

    const [rows, totalRows, missingRows] = await Promise.all([
      app.db
        .select({
          id: tournaments.id,
          sportId: categories.sportId,
          sportSlug: sports.slug,
          sportName: sports.name,
          categoryId: tournaments.categoryId,
          categoryName: categories.name,
          slug: tournaments.slug,
          name: tournaments.name,
          riskTier: tournaments.riskTier,
          riskTierLocked: tournaments.riskTierLocked,
          riskTierSource: tournaments.riskTierSource,
          riskTierNote: tournaments.riskTierNote,
          displayOrder: tournaments.displayOrder,
          active: tournaments.active,
          logoUrl: tournaments.logoUrl,
          brandColor: tournaments.brandColor,
        })
        .from(tournaments)
        .innerJoin(categories, eq(categories.id, tournaments.categoryId))
        .innerJoin(sports, eq(sports.id, categories.sportId))
        .where(where)
        .orderBy(...orderBy)
        .limit(q.limit)
        .offset(q.offset),
      app.db
        .select({ total: sql<string>`COUNT(*)::text` })
        .from(tournaments)
        .innerJoin(categories, eq(categories.id, tournaments.categoryId))
        .where(where),
      app.db
        .select({ c: sql<string>`COUNT(*)::text` })
        .from(tournaments)
        .where(isNull(tournaments.logoUrl)),
    ]);

    const total = Number(totalRows[0]?.total ?? "0");
    const missingLogoCount = Number(missingRows[0]?.c ?? "0");

    return {
      total,
      missingLogoCount,
      limit: q.limit,
      offset: q.offset,
      tournaments: rows satisfies TournamentRow[],
    };
  });

  // ── Sport filter dropdown options ──────────────────────────────────
  app.get("/admin/tournaments/sports", async (request) => {
    request.requireRole("admin");
    const rows = await app.db
      .select({
        id: sports.id,
        slug: sports.slug,
        name: sports.name,
        tournamentCount: sql<string>`COUNT(${tournaments.id})::text`,
        missingLogoCount: sql<string>`COUNT(${tournaments.id}) FILTER (WHERE ${tournaments.logoUrl} IS NULL)::text`,
      })
      .from(sports)
      .leftJoin(categories, eq(categories.sportId, sports.id))
      .leftJoin(tournaments, eq(tournaments.categoryId, categories.id))
      .where(eq(sports.active, true))
      .groupBy(sports.id, sports.slug, sports.name)
      .orderBy(asc(sports.slug));

    return {
      sports: rows.map((r) => ({
        id: r.id,
        slug: r.slug,
        name: r.name,
        tournamentCount: Number(r.tournamentCount),
        missingLogoCount: Number(r.missingLogoCount),
      })),
    };
  });

  // ── Category filter options ───────────────────────────────────────
  //
  // Scoped to one sport on purpose. Football alone carries a couple of
  // hundred country buckets, so an unscoped list would be a dropdown
  // nobody can use and a payload nobody needs.
  app.get("/admin/tournaments/categories", async (request) => {
    request.requireRole("admin");
    const { sportId } = z
      .object({ sportId: z.coerce.number().int().positive().optional() })
      .parse(request.query);
    if (!sportId) return { categories: [] };

    const rows = await app.db
      .select({
        id: categories.id,
        name: categories.name,
        tournamentCount: sql<string>`COUNT(${tournaments.id})::text`,
      })
      .from(categories)
      .leftJoin(tournaments, eq(tournaments.categoryId, categories.id))
      .where(eq(categories.sportId, sportId))
      .groupBy(categories.id, categories.name)
      .having(sql`COUNT(${tournaments.id}) > 0`)
      .orderBy(asc(categories.name));

    return {
      categories: rows.map((r) => ({
        id: r.id,
        name: r.name,
        tournamentCount: Number(r.tournamentCount),
      })),
    };
  });

  // ─── ZillaAGI risk-tier review ──────────────────────────────────────
  //
  // Two routes: what is left to review, and review some of it now. The
  // background sweeper runs the same pipeline every 30 minutes, so these
  // exist for an operator who wants it immediately or wants to see what
  // the model would do before it does it.

  app.get("/admin/tournaments/zagi-status", async (request) => {
    request.requireRole("admin");
    return riskTierBacklog(app);
  });

  app.post(
    "/admin/tournaments/zagi-review",
    // Each call is minutes of model time; this is not a button to lean on.
    { config: { rateLimit: { max: 20, timeWindow: "1 hour" } } },
    async (request) => {
      const admin = request.requireRole("admin");
      const body = zagiReviewBody.parse(request.body ?? {});

      const result = await assignRiskTiers(app, {
        limit: body.limit,
        dryRun: body.dryRun ?? false,
        ...(body.sportId ? { sportId: body.sportId } : {}),
      });

      if (result.errors.includes("zagi_not_configured")) {
        throw new BadRequestError(
          "zagi_not_configured",
          "ZillaAGI is not configured — set ZAGI_API_KEY and ZAGI_BASE_URL.",
        );
      }

      // A dry run changes nothing, so it is not an auditable event.
      if (!result.dryRun && result.assigned > 0) {
        await app.db.insert(adminAuditLog).values({
          actorUserId: admin.id,
          action: "tournament.zagi_review",
          targetType: "sport",
          targetId: body.sportId ? String(body.sportId) : "*",
          beforeJson: { eligible: result.eligible },
          afterJson: {
            model: result.model,
            reviewed: result.reviewed,
            assigned: result.assigned,
            clamped: result.clamped,
            undecided: result.undecided,
            batches: result.batches,
            limit: body.limit,
          },
          ipInet: request.ip ?? null,
        });
      }

      // The tournament sub-tree is cached per sport for 10 s and orders
      // by risk_tier, so a review that moved tiers must not be invisible
      // for the TTL.
      const touched = result.proposals.map((p) => p.tournamentId);
      if (!result.dryRun && result.assigned > 0 && touched.length > 0) {
        const owners = await app.db
          .select({ sportId: categories.sportId })
          .from(tournaments)
          .innerJoin(categories, eq(categories.id, tournaments.categoryId))
          .where(inArray(tournaments.id, touched));
        await Promise.all(
          [...new Set(owners.map((r) => r.sportId))].map((id) =>
            app.redis.del(`catalog:tournaments:v1:${id}`).catch(() => null),
          ),
        );
      }

      return result;
    },
  );

  // ─── Automatic logo sourcing ────────────────────────────────────────
  //
  // Fills the marks neither feed carries. Preview first: a wrong crest —
  // the women's competition on a men's league, or a team badge on a
  // tournament — is worse than a blank one, so the guards in
  // lib/tournament-logos refuse far more than they accept and an
  // operator should see what a run would do before it does it.

  app.get("/admin/tournaments/logo-status", async (request) => {
    request.requireRole("admin");
    return logoBacklog(app);
  });

  app.post(
    "/admin/tournaments/logo-fetch",
    // Liquipedia is rate-limited to one call every 2 s and every
    // tournament costs several, so a run is minutes of wall clock.
    { config: { rateLimit: { max: 10, timeWindow: "1 hour" } } },
    async (request) => {
      const admin = request.requireRole("admin");
      const body = logoFetchBody.parse(request.body ?? {});

      const result = await resolveTournamentLogos(app, {
        limit: body.limit,
        dryRun: body.dryRun ?? false,
        ...(body.sportId ? { sportId: body.sportId } : {}),
      });

      if (result.errors.includes("zagi_not_configured")) {
        throw new BadRequestError(
          "zagi_not_configured",
          "ZillaAGI is not configured — set ZAGI_API_KEY and ZAGI_BASE_URL.",
        );
      }

      if (!result.dryRun && result.applied > 0) {
        await app.db.insert(adminAuditLog).values({
          actorUserId: admin.id,
          action: "tournament.logo_fetch",
          targetType: "sport",
          targetId: body.sportId ? String(body.sportId) : "*",
          beforeJson: { eligible: result.eligible },
          afterJson: {
            model: result.model,
            named: result.named,
            declined: result.declined,
            unmatched: result.unmatched,
            applied: result.applied,
            sources: result.proposals.reduce<Record<string, number>>((acc, p) => {
              acc[p.source] = (acc[p.source] ?? 0) + 1;
              return acc;
            }, {}),
          },
          ipInet: request.ip ?? null,
        });
      }

      return result;
    },
  );

  // ── Update ────────────────────────────────────────────────────────
  app.patch("/admin/tournaments/:id", async (request) => {
    const admin = request.requireRole("admin");
    const params = z
      .object({ id: z.coerce.number().int().positive() })
      .parse(request.params);
    const body = patchBody.parse(request.body);

    const [before] = await app.db
      .select({
        id: tournaments.id,
        slug: tournaments.slug,
        name: tournaments.name,
        logoUrl: tournaments.logoUrl,
        brandColor: tournaments.brandColor,
        logoMime: tournaments.logoMime,
        riskTier: tournaments.riskTier,
        riskTierLocked: tournaments.riskTierLocked,
        riskTierSource: tournaments.riskTierSource,
        riskTierReviewedAt: tournaments.riskTierReviewedAt,
      })
      .from(tournaments)
      .where(eq(tournaments.id, params.id))
      .limit(1);
    if (!before) {
      throw new NotFoundError("tournament_not_found", "tournament_not_found");
    }

    const patch: Partial<{
      logoUrl: string | null;
      brandColor: string | null;
      logoData: Buffer | null;
      logoMime: string | null;
      riskTier: number | null;
      riskTierLocked: boolean;
      riskTierSource: string;
      riskTierNote: string | null;
    }> = {};
    if (body.riskTier !== undefined) {
      if (body.riskTier === null) {
        // Back to automatic: keep whatever tier is there, let the next
        // REST refresh own it again. The label follows the value rather
        // than the lock — if ZillaAGI picked this number, saying "auto"
        // here would credit the feed with a decision it never made.
        patch.riskTierLocked = false;
        patch.riskTierSource = before.riskTierReviewedAt ? "zagi" : "auto";
      } else {
        patch.riskTier = body.riskTier;
        patch.riskTierLocked = true;
        patch.riskTierSource = "manual";
        // A ZillaAGI justification explains one particular NUMBER.
        // Replacing the number makes the note a lie, so it goes. But
        // posting the tier that is already stored is an ENDORSEMENT (the
        // green check on /admin/tournaments does exactly that), and
        // there the note still describes the tier that is still there —
        // and it is the only record anywhere of why that tier is what it
        // is. Override drops it; confirmation keeps it.
        if (body.riskTier !== before.riskTier) patch.riskTierNote = null;
      }
    }
    if (body.logoUrl !== undefined) {
      patch.logoUrl = body.logoUrl;
      const isByteServeUrl =
        body.logoUrl != null && body.logoUrl.startsWith(`/api/tournaments/${before.id}/logo`);
      if (!isByteServeUrl && before.logoMime !== null) {
        patch.logoData = null;
        patch.logoMime = null;
      }
    }
    if (body.brandColor !== undefined) patch.brandColor = body.brandColor;

    await app.db.transaction(async (tx) => {
      await tx
        .update(tournaments)
        .set(patch)
        .where(eq(tournaments.id, params.id));
      await tx.insert(adminAuditLog).values({
        actorUserId: admin.id,
        action: "tournament.update",
        targetType: "tournament",
        targetId: params.id.toString(),
        beforeJson: {
          logoUrl: before.logoUrl,
          brandColor: before.brandColor,
          logoMime: before.logoMime,
          riskTier: before.riskTier,
          riskTierLocked: before.riskTierLocked,
          riskTierSource: before.riskTierSource,
        },
        afterJson: {
          slug: before.slug,
          name: before.name,
          logoUrl: patch.logoUrl,
          brandColor: patch.brandColor,
          ...(patch.logoMime !== undefined ? { logoMime: patch.logoMime } : {}),
          ...(patch.riskTier !== undefined ? { riskTier: patch.riskTier } : {}),
          ...(patch.riskTierLocked !== undefined
            ? { riskTierLocked: patch.riskTierLocked }
            : {}),
          ...(patch.riskTierSource !== undefined
            ? { riskTierSource: patch.riskTierSource }
            : {}),
        },
        ipInet: request.ip ?? null,
      });
    });

    return { ok: true, id: params.id };
  });

  // ── Logo upload ───────────────────────────────────────────────────
  app.post<{ Params: { id: string } }>(
    "/admin/tournaments/:id/logo",
    { config: writeRateLimit },
    async (request, reply) => {
      const admin = request.requireRole("admin");
      const params = z
        .object({ id: z.coerce.number().int().positive() })
        .parse(request.params);

      const file = await request.file();
      if (!file) throw new BadRequestError("file_required", "file_required");
      if (!ALLOWED_MIME.has(file.mimetype)) {
        throw new BadRequestError(
          "unsupported_mime",
          "Upload must be SVG, PNG, JPEG, or WebP",
        );
      }
      const buffer = await file.toBuffer();
      if (file.file.truncated) {
        throw new BadRequestError("file_too_large", "file_too_large");
      }
      if (buffer.length === 0) {
        throw new BadRequestError("file_empty", "file_empty");
      }

      const [before] = await app.db
        .select({
          id: tournaments.id,
          slug: tournaments.slug,
          name: tournaments.name,
          logoUrl: tournaments.logoUrl,
          logoMime: tournaments.logoMime,
        })
        .from(tournaments)
        .where(eq(tournaments.id, params.id))
        .limit(1);
      if (!before) {
        throw new NotFoundError("tournament_not_found", "tournament_not_found");
      }

      const version = Date.now();
      const newLogoUrl = buildTournamentLogoUrl(before.id, version);

      await app.db.transaction(async (tx) => {
        await tx
          .update(tournaments)
          .set({
            logoData: buffer,
            logoMime: file.mimetype,
            logoUrl: newLogoUrl,
          })
          .where(eq(tournaments.id, params.id));
        await tx.insert(adminAuditLog).values({
          actorUserId: admin.id,
          action: "tournament.logo_upload",
          targetType: "tournament",
          targetId: params.id.toString(),
          beforeJson: {
            logoUrl: before.logoUrl,
            logoMime: before.logoMime,
          },
          afterJson: {
            slug: before.slug,
            name: before.name,
            logoUrl: newLogoUrl,
            mime: file.mimetype,
            bytes: buffer.length,
          },
          ipInet: request.ip ?? null,
        });
      });

      reply.code(200);
      return { ok: true, id: params.id, logoUrl: newLogoUrl };
    },
  );

  // ── Logo remove ───────────────────────────────────────────────────
  app.delete<{ Params: { id: string } }>(
    "/admin/tournaments/:id/logo",
    { config: writeRateLimit },
    async (request) => {
      const admin = request.requireRole("admin");
      const params = z
        .object({ id: z.coerce.number().int().positive() })
        .parse(request.params);

      const [before] = await app.db
        .select({
          id: tournaments.id,
          slug: tournaments.slug,
          name: tournaments.name,
          logoUrl: tournaments.logoUrl,
          logoMime: tournaments.logoMime,
        })
        .from(tournaments)
        .where(eq(tournaments.id, params.id))
        .limit(1);
      if (!before) {
        throw new NotFoundError("tournament_not_found", "tournament_not_found");
      }

      await app.db.transaction(async (tx) => {
        await tx
          .update(tournaments)
          .set({ logoData: null, logoMime: null, logoUrl: null })
          .where(eq(tournaments.id, params.id));
        await tx.insert(adminAuditLog).values({
          actorUserId: admin.id,
          action: "tournament.logo_remove",
          targetType: "tournament",
          targetId: params.id.toString(),
          beforeJson: {
            logoUrl: before.logoUrl,
            logoMime: before.logoMime,
          },
          afterJson: {
            slug: before.slug,
            name: before.name,
            logoUrl: null,
            logoMime: null,
          },
          ipInet: request.ip ?? null,
        });
      });

      return { ok: true, id: params.id };
    },
  );

  // ─── Category ordering ───────────────────────────────────────────────
  //
  // Pin / move / unpin one tournament within its OWN category. Same
  // transform and the same one-statement, primary-key-ordered lock as the
  // sports and categories twins — see lib/pin-order.ts and
  // admin/categories.ts for why both are shaped that way.
  app.post(
    "/admin/tournaments/:id/order",
    { config: writeRateLimit },
    async (request) => {
      const admin = request.requireRole("admin");
      const params = z
        .object({ id: z.coerce.number().int().positive() })
        .parse(request.params);
      const { action } = orderBody.parse(request.body) as { action: PinAction };

      // category_id and the labels are immutable for the life of the row,
      // so reading them unlocked lets the transaction take every lock in
      // one statement.
      const [scope] = await app.db
        .select({
          categoryId: tournaments.categoryId,
          name: tournaments.name,
          slug: tournaments.slug,
        })
        .from(tournaments)
        .where(eq(tournaments.id, params.id))
        .limit(1);
      if (!scope) {
        throw new NotFoundError("tournament_not_found", "tournament_not_found");
      }

      let before: number | null = null;
      let after: number | null = null;

      await app.db.transaction(async (tx) => {
        const locked = await tx
          .select({ id: tournaments.id, displayOrder: tournaments.displayOrder })
          .from(tournaments)
          .where(
            and(
              eq(tournaments.categoryId, scope.categoryId),
              or(
                eq(tournaments.id, params.id),
                isNotNull(tournaments.displayOrder),
              ),
            ),
          )
          .orderBy(asc(tournaments.id))
          .for("update");

        const target = locked.find((r) => r.id === params.id);
        if (!target) {
          throw new NotFoundError("tournament_not_found", "tournament_not_found");
        }
        before = target.displayOrder;

        const pinned = locked
          .filter((r) => r.displayOrder != null)
          .sort((a, b) => a.displayOrder! - b.displayOrder! || a.id - b.id)
          .map((r) => r.id);

        const next = reorderPinned(pinned, params.id, action);
        const position = next.indexOf(params.id);
        after = position === -1 ? null : position + 1;

        await tx
          .update(tournaments)
          .set({ displayOrder: null })
          .where(
            and(
              eq(tournaments.categoryId, scope.categoryId),
              isNotNull(tournaments.displayOrder),
            ),
          );

        for (const [i, tournamentId] of next.entries()) {
          await tx
            .update(tournaments)
            .set({ displayOrder: i + 1 })
            .where(eq(tournaments.id, tournamentId));
        }

        await tx.insert(adminAuditLog).values({
          actorUserId: admin.id,
          action: "tournament.order_update",
          targetType: "tournament",
          targetId: String(params.id),
          beforeJson: { displayOrder: before },
          afterJson: {
            slug: scope.slug,
            name: scope.name,
            categoryId: scope.categoryId,
            operation: action,
            displayOrder: after,
            pinnedOrder: next,
          },
          ipInet: request.ip ?? null,
        });
      });

      // The sidebar tree is cached per sport for 10 s; bust the sport this
      // category belongs to so the reorder is not invisible for the TTL.
      const [owner] = await app.db
        .select({ sportId: categories.sportId })
        .from(categories)
        .where(eq(categories.id, scope.categoryId))
        .limit(1);
      if (owner) {
        await app.redis
          .del(`catalog:tournaments:v1:${owner.sportId}`)
          .catch(() => null);
      }

      return { id: params.id, displayOrder: after };
    },
  );
}
