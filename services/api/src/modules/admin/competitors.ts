// /admin/competitors endpoints. Admin-only.
//
// Surface area:
//   GET    /admin/competitors                  paginated list with optional
//                                              ?sportId, ?q (name search),
//                                              ?missingLogo=1 filter
//   PATCH  /admin/competitors/:id              update logo_url / brand_color /
//                                              abbreviation. Mutations are
//                                              audit-logged.
//   POST   /admin/competitors/bulk-logos       set logo_url for many slugs at
//                                              once (used by the seed script).
//   POST   /admin/competitors/:id/logo         multipart upload — accepts
//                                              SVG / PNG / JPEG / WebP up to
//                                              1 MB. Bytes land on
//                                              competitors.logo_data + auto-
//                                              stamps logo_url to a /api/
//                                              competitors/<id>/logo URL so
//                                              the storefront renders it
//                                              without code changes.
//   DELETE /admin/competitors/:id/logo         clear logo_data + logo_mime +
//                                              logo_url in one transaction.
//
// Why the bulk endpoint? The user asked for logos for all teams scoped per
// discipline. Pasting URLs row-by-row through the UI is fine for tweaks but
// painful for the initial backfill — the bulk endpoint consumes the seed
// JSON shipped under packages/db/seeds/competitor-logos/ in one round-trip.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, asc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { competitors, sports, adminAuditLog } from "@oddzilla/db";
import { BadRequestError, NotFoundError } from "../../lib/errors.js";
import multipart from "@fastify/multipart";

// Mirrors admin/sports.ts. Kept as separate constants per file so a
// future change to one allowlist doesn't silently widen the other.
const MAX_UPLOAD_BYTES = 1 * 1024 * 1024;
const ALLOWED_MIME = new Set([
  "image/svg+xml",
  "image/png",
  "image/jpeg",
  "image/webp",
]);

function buildCompetitorLogoUrl(id: number, version: number): string {
  return `/api/competitors/${id}/logo?v=${version}`;
}

const writeRateLimit = {
  rateLimit: { max: 30, timeWindow: "1 minute" },
};

// HEX colour validator: #RRGGBB with case-insensitive hex digits. Empty
// string is converted to null so the admin UI can clear the field by
// submitting a blank input without us synthesising a CHECK violation.
const hexColor = z
  .string()
  .trim()
  .max(7)
  .regex(/^#[0-9A-Fa-f]{6}$/u, "brand_color must look like #RRGGBB")
  .nullable();

// URL validator. We accept any http/https URL and also relative paths
// starting with "/" (so admins can later self-host under apps/web/public/
// without re-validating). Empty string → null.
const logoUrlSchema = z
  .string()
  .trim()
  .max(2048)
  .refine(
    (v) => v.startsWith("http://") || v.startsWith("https://") || v.startsWith("/"),
    "logo_url must be an http(s) URL or absolute path",
  )
  .nullable();

const listQuery = z.object({
  q: z.string().trim().max(128).optional(),
  sportId: z.coerce.number().int().positive().optional(),
  // 1/true → only rows missing logo_url; useful for the admin to sweep
  // teams that still need a logo.
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

const patchBody = z
  .object({
    logoUrl: z.union([logoUrlSchema, z.literal("").transform(() => null)]).optional(),
    brandColor: z
      .union([hexColor, z.literal("").transform(() => null)])
      .optional(),
    abbreviation: z
      .union([z.string().trim().max(16), z.literal("").transform(() => null)])
      .optional(),
  })
  .refine(
    (v) =>
      v.logoUrl !== undefined ||
      v.brandColor !== undefined ||
      v.abbreviation !== undefined,
    { message: "at least one field is required" },
  );

const bulkBody = z.object({
  // Match by sport slug + competitor slug — both stable and human-meaningful.
  // (We can't rely on competitor.id at seed time since IDs aren't stable
  // across environments.)
  entries: z
    .array(
      z.object({
        sportSlug: z.string().min(1).max(64),
        competitorSlug: z.string().min(1).max(96),
        logoUrl: logoUrlSchema,
        brandColor: hexColor.optional(),
      }),
    )
    .min(1)
    // Capped at 100 (was 500). Each entry runs a SELECT + UPDATE inside
    // the same transaction; with N=500 the loop holds row locks on
    // competitors for tens of seconds and stalls feed-ingester's
    // automap upserts during peak match windows. Operators with larger
    // batches can issue multiple back-to-back requests — the audit
    // row pairs with each call.
    .max(100),
});

interface CompetitorRow {
  id: number;
  sportId: number;
  sportSlug: string;
  sportName: string;
  slug: string;
  name: string;
  abbreviation: string | null;
  logoUrl: string | null;
  brandColor: string | null;
  active: boolean;
  providerUrn: string | null;
}

export default async function adminCompetitorsRoutes(app: FastifyInstance) {
  // Multipart support is local to this scope so JSON-body routes keep
  // their default parsing. Mirrors admin/sports.ts and admin/avatars.ts.
  await app.register(multipart, {
    limits: {
      fileSize: MAX_UPLOAD_BYTES,
      files: 1,
      fields: 5,
      fieldSize: 1024,
    },
  });

  // ── List ──────────────────────────────────────────────────────────
  app.get("/admin/competitors", async (request) => {
    request.requireRole("admin");
    const q = listQuery.parse(request.query);

    const filters: SQL[] = [];
    if (q.sportId) filters.push(eq(competitors.sportId, q.sportId));
    if (q.q) {
      const like = `%${q.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      const orExpr = sql`(${competitors.name} ILIKE ${like} OR ${competitors.slug} ILIKE ${like} OR ${competitors.abbreviation} ILIKE ${like})`;
      filters.push(orExpr);
    }
    if (q.missingLogo) filters.push(isNull(competitors.logoUrl));
    if (q.active !== undefined) filters.push(eq(competitors.active, q.active));

    const where = filters.length > 0 ? and(...filters) : sql`TRUE`;

    // Two queries: count + page. The list view shows a total so the admin
    // knows how many teams are still missing logos.
    const [rows, totalRows] = await Promise.all([
      app.db
        .select({
          id: competitors.id,
          sportId: competitors.sportId,
          sportSlug: sports.slug,
          sportName: sports.name,
          slug: competitors.slug,
          name: competitors.name,
          abbreviation: competitors.abbreviation,
          logoUrl: competitors.logoUrl,
          brandColor: competitors.brandColor,
          active: competitors.active,
          providerUrn: competitors.providerUrn,
        })
        .from(competitors)
        .innerJoin(sports, eq(sports.id, competitors.sportId))
        .where(where)
        .orderBy(asc(sports.slug), asc(competitors.name))
        .limit(q.limit)
        .offset(q.offset),
      app.db
        .select({ total: sql<string>`COUNT(*)::text` })
        .from(competitors)
        .innerJoin(sports, eq(sports.id, competitors.sportId))
        .where(where),
    ]);
    const total = Number(totalRows[0]?.total ?? "0");

    return {
      total,
      limit: q.limit,
      offset: q.offset,
      competitors: rows satisfies CompetitorRow[],
    };
  });

  // ── Sport options for the filter dropdown ─────────────────────────
  app.get("/admin/competitors/sports", async (request) => {
    request.requireRole("admin");
    const rows = await app.db
      .select({
        id: sports.id,
        slug: sports.slug,
        name: sports.name,
        teamCount: sql<string>`COUNT(${competitors.id})::text`,
        missingLogoCount: sql<string>`COUNT(${competitors.id}) FILTER (WHERE ${competitors.logoUrl} IS NULL)::text`,
      })
      .from(sports)
      .leftJoin(competitors, eq(competitors.sportId, sports.id))
      .where(eq(sports.active, true))
      .groupBy(sports.id, sports.slug, sports.name)
      .orderBy(asc(sports.slug));

    return {
      sports: rows.map((r) => ({
        id: r.id,
        slug: r.slug,
        name: r.name,
        teamCount: Number(r.teamCount),
        missingLogoCount: Number(r.missingLogoCount),
      })),
    };
  });

  // ── Single competitor (used by the edit drawer) ───────────────────
  app.get("/admin/competitors/:id", async (request) => {
    request.requireRole("admin");
    const params = z
      .object({ id: z.coerce.number().int().positive() })
      .parse(request.params);

    const [row] = await app.db
      .select({
        id: competitors.id,
        sportId: competitors.sportId,
        sportSlug: sports.slug,
        sportName: sports.name,
        slug: competitors.slug,
        name: competitors.name,
        abbreviation: competitors.abbreviation,
        logoUrl: competitors.logoUrl,
        brandColor: competitors.brandColor,
        active: competitors.active,
        providerUrn: competitors.providerUrn,
      })
      .from(competitors)
      .innerJoin(sports, eq(sports.id, competitors.sportId))
      .where(eq(competitors.id, params.id))
      .limit(1);
    if (!row) throw new NotFoundError("competitor_not_found", "competitor_not_found");

    return { competitor: row };
  });

  // ── Update ────────────────────────────────────────────────────────
  app.patch("/admin/competitors/:id", async (request) => {
    const admin = request.requireRole("admin");
    const params = z
      .object({ id: z.coerce.number().int().positive() })
      .parse(request.params);
    const body = patchBody.parse(request.body);

    const [before] = await app.db
      .select({
        id: competitors.id,
        sportId: competitors.sportId,
        slug: competitors.slug,
        name: competitors.name,
        abbreviation: competitors.abbreviation,
        logoUrl: competitors.logoUrl,
        brandColor: competitors.brandColor,
        logoMime: competitors.logoMime,
      })
      .from(competitors)
      .where(eq(competitors.id, params.id))
      .limit(1);
    if (!before) throw new NotFoundError("competitor_not_found", "competitor_not_found");

    const patch: Partial<{
      logoUrl: string | null;
      brandColor: string | null;
      abbreviation: string | null;
      logoData: Buffer | null;
      logoMime: string | null;
    }> = {};
    if (body.logoUrl !== undefined) {
      patch.logoUrl = body.logoUrl;
      // Same orphan-bytes guard as admin/sports.ts: when logo_url is
      // pasted as something other than the byte-serve URL (or cleared),
      // wipe logo_data/logo_mime so the columns don't drift apart.
      const isByteServeUrl =
        body.logoUrl != null && body.logoUrl.startsWith(`/api/competitors/${before.id}/logo`);
      if (!isByteServeUrl && before.logoMime !== null) {
        patch.logoData = null;
        patch.logoMime = null;
      }
    }
    if (body.brandColor !== undefined) patch.brandColor = body.brandColor;
    if (body.abbreviation !== undefined) patch.abbreviation = body.abbreviation;

    await app.db.transaction(async (tx) => {
      await tx
        .update(competitors)
        .set(patch)
        .where(eq(competitors.id, params.id));

      await tx.insert(adminAuditLog).values({
        actorUserId: admin.id,
        action: "competitor.update",
        targetType: "competitor",
        targetId: params.id.toString(),
        beforeJson: {
          logoUrl: before.logoUrl,
          brandColor: before.brandColor,
          abbreviation: before.abbreviation,
        },
        afterJson: {
          slug: before.slug,
          name: before.name,
          ...patch,
        },
        ipInet: request.ip ?? null,
      });
    });

    return { ok: true, id: params.id };
  });

  // ── Bulk logo set (drives the seed script) ────────────────────────
  // Idempotent: rows with no matching (sport_slug, competitor_slug) pair
  // are reported back as `missing` so the operator can see what didn't
  // land. brand_color is optional per row.
  app.post(
    "/admin/competitors/bulk-logos",
    {
      // 100 entries × ~2 KiB-each-with-logo-URL puts the realistic
      // body around 200 KiB; 512 KiB gives slack without inviting a
      // megabyte upload. Global bodyLimit (server.ts) is 64 KiB.
      bodyLimit: 512 * 1024,
    },
    async (request) => {
    const admin = request.requireRole("admin");
    const body = bulkBody.parse(request.body);

    // Collect distinct sport slugs for one round-trip.
    const sportSlugs = Array.from(new Set(body.entries.map((e) => e.sportSlug)));
    const sportRows = await app.db
      .select({ id: sports.id, slug: sports.slug })
      .from(sports)
      .where(inArray(sports.slug, sportSlugs));
    const sportIdBySlug = new Map(sportRows.map((s) => [s.slug, s.id]));

    const updated: Array<{ sportSlug: string; competitorSlug: string }> = [];
    const missing: Array<{ sportSlug: string; competitorSlug: string; reason: string }> = [];

    await app.db.transaction(async (tx) => {
      for (const entry of body.entries) {
        const sportId = sportIdBySlug.get(entry.sportSlug);
        if (!sportId) {
          missing.push({
            sportSlug: entry.sportSlug,
            competitorSlug: entry.competitorSlug,
            reason: "sport_not_found",
          });
          continue;
        }

        // Match the competitor by exact slug. Per-sport scope keeps the
        // same slug from colliding across disciplines. We use eq(), not
        // ilike(), because slugs are lowercase/dash-separated by
        // construction — and ilike() would interpret `%` and `_` in
        // attacker-supplied (or careless-operator-supplied) slugs as
        // wildcards, allowing a single bulk entry like `competitorSlug:"%"`
        // to overwrite the first-by-id competitor in the sport.
        const [match] = await tx
          .select({
            id: competitors.id,
            logoUrl: competitors.logoUrl,
            brandColor: competitors.brandColor,
          })
          .from(competitors)
          .where(
            and(
              eq(competitors.sportId, sportId),
              eq(competitors.slug, entry.competitorSlug.toLowerCase()),
            ),
          )
          .limit(1);

        if (!match) {
          missing.push({
            sportSlug: entry.sportSlug,
            competitorSlug: entry.competitorSlug,
            reason: "competitor_not_found",
          });
          continue;
        }

        const patch: Partial<{ logoUrl: string | null; brandColor: string | null }> = {
          logoUrl: entry.logoUrl,
        };
        if (entry.brandColor !== undefined) patch.brandColor = entry.brandColor;

        await tx
          .update(competitors)
          .set(patch)
          .where(eq(competitors.id, match.id));

        updated.push({
          sportSlug: entry.sportSlug,
          competitorSlug: entry.competitorSlug,
        });
      }

      await tx.insert(adminAuditLog).values({
        actorUserId: admin.id,
        action: "competitor.bulk_logos",
        targetType: "competitor",
        targetId: null,
        beforeJson: null,
        afterJson: {
          updatedCount: updated.length,
          missingCount: missing.length,
          missing,
        },
        ipInet: request.ip ?? null,
      });
    });

    return { updatedCount: updated.length, missingCount: missing.length, updated, missing };
  });

  // ── Logo upload ───────────────────────────────────────────────────
  app.post<{ Params: { id: string } }>(
    "/admin/competitors/:id/logo",
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
          id: competitors.id,
          slug: competitors.slug,
          name: competitors.name,
          logoUrl: competitors.logoUrl,
          logoMime: competitors.logoMime,
        })
        .from(competitors)
        .where(eq(competitors.id, params.id))
        .limit(1);
      if (!before) throw new NotFoundError("competitor_not_found", "competitor_not_found");

      const version = Date.now();
      const newLogoUrl = buildCompetitorLogoUrl(before.id, version);

      await app.db.transaction(async (tx) => {
        await tx
          .update(competitors)
          .set({
            logoData: buffer,
            logoMime: file.mimetype,
            logoUrl: newLogoUrl,
          })
          .where(eq(competitors.id, params.id));
        await tx.insert(adminAuditLog).values({
          actorUserId: admin.id,
          action: "competitor.logo_upload",
          targetType: "competitor",
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
    "/admin/competitors/:id/logo",
    { config: writeRateLimit },
    async (request) => {
      const admin = request.requireRole("admin");
      const params = z
        .object({ id: z.coerce.number().int().positive() })
        .parse(request.params);

      const [before] = await app.db
        .select({
          id: competitors.id,
          slug: competitors.slug,
          name: competitors.name,
          logoUrl: competitors.logoUrl,
          logoMime: competitors.logoMime,
        })
        .from(competitors)
        .where(eq(competitors.id, params.id))
        .limit(1);
      if (!before) throw new NotFoundError("competitor_not_found", "competitor_not_found");

      await app.db.transaction(async (tx) => {
        await tx
          .update(competitors)
          .set({ logoData: null, logoMime: null, logoUrl: null })
          .where(eq(competitors.id, params.id));
        await tx.insert(adminAuditLog).values({
          actorUserId: admin.id,
          action: "competitor.logo_remove",
          targetType: "competitor",
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
}
