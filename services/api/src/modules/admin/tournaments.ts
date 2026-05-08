// /admin/tournaments endpoints. Admin-only.
//
// Surface area:
//   GET    /admin/tournaments                 paginated list with optional
//                                             ?sportId, ?q (name search),
//                                             ?missingLogo=1 filter
//   GET    /admin/tournaments/sports          sport-filter dropdown options
//   PATCH  /admin/tournaments/:id             update logo_url / brand_color.
//                                             Mutations are audit-logged.
//   POST   /admin/tournaments/:id/logo        multipart upload — accepts
//                                             SVG / PNG / JPEG / WebP up
//                                             to 1 MB. Same shape as
//                                             /admin/sports + /admin/
//                                             competitors.
//   DELETE /admin/tournaments/:id/logo        clear bytes + URL in one tx.
//
// Tournament rows ship without branding from the Oddin feed — the
// admin manages it manually here. Storefront integration: the sidebar
// tournament sub-tree picks up logo_url; missing rows fall back to the
// sport's logo.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, asc, eq, isNull, sql, type SQL } from "drizzle-orm";
import { tournaments, categories, sports, adminAuditLog } from "@oddzilla/db";
import { BadRequestError, NotFoundError } from "../../lib/errors.js";
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

const listQuery = z.object({
  q: z.string().trim().max(128).optional(),
  sportId: z.coerce.number().int().positive().optional(),
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
  })
  .refine((v) => v.logoUrl !== undefined || v.brandColor !== undefined, {
    message: "at least one field is required",
  });

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
  active: boolean;
  logoUrl: string | null;
  brandColor: string | null;
}

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
    if (q.missingLogo) filters.push(isNull(tournaments.logoUrl));
    if (q.active !== undefined) filters.push(eq(tournaments.active, q.active));

    const where = filters.length > 0 ? and(...filters) : sql`TRUE`;

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
          active: tournaments.active,
          logoUrl: tournaments.logoUrl,
          brandColor: tournaments.brandColor,
        })
        .from(tournaments)
        .innerJoin(categories, eq(categories.id, tournaments.categoryId))
        .innerJoin(sports, eq(sports.id, categories.sportId))
        .where(where)
        .orderBy(asc(sports.slug), asc(tournaments.name))
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
    }> = {};
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
        },
        afterJson: {
          slug: before.slug,
          name: before.name,
          logoUrl: patch.logoUrl,
          brandColor: patch.brandColor,
          ...(patch.logoMime !== undefined ? { logoMime: patch.logoMime } : {}),
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
}
