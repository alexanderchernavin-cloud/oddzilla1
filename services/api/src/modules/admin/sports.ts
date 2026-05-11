// /admin/sports endpoints. Admin-only.
//
// Surface area:
//   GET    /admin/sports                  paginated list with optional
//                                         ?q (name/slug search), ?missingLogo=1
//   PATCH  /admin/sports/:id              update logo_url / brand_color.
//                                         Mutations are audit-logged.
//   POST   /admin/sports/:id/logo         multipart upload — accepts
//                                         image/svg+xml | image/png |
//                                         image/jpeg | image/webp (≤1 MB).
//                                         Bytes land on sports.logo_data;
//                                         logo_url is auto-set to
//                                         /api/sports/<slug>/logo?v=<unix-ms>
//                                         so the storefront's existing
//                                         <img src> path picks the upload up
//                                         and a re-upload busts the
//                                         browser cache via the ?v param.
//   DELETE /admin/sports/:id/logo         clear logo_data + logo_mime +
//                                         logo_url in one transaction.
//
// Mirrors the /admin/competitors + /admin/avatars shapes so the editor UI
// can be cloned with only minor field changes. Sports are a small set
// (≤ ~50 rows); we don't need a bulk endpoint here yet.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, asc, eq, isNull, sql, type SQL } from "drizzle-orm";
import { sports, adminAuditLog } from "@oddzilla/db";
import { BadRequestError, NotFoundError } from "../../lib/errors.js";
import multipart from "@fastify/multipart";

// 1 MB upload cap. Sport icons are small — 256×256 PNG @ ~80% quality
// lands well under 200 KB; 1 MB gives slack for chunky SVGs without
// inviting megabyte-class uploads. The multipart plugin enforces the
// limit at the stream layer so an oversize upload is aborted before it
// balloons api memory.
const MAX_UPLOAD_BYTES = 1 * 1024 * 1024;
// Accepted MIME types. SVG kept first because it's the ideal format
// for icon artwork (vector, smallest, scales perfectly); raster
// formats are accepted as-is (true PNG→SVG vectorisation is lossy and
// out of scope) and stored with their original mime.
const ALLOWED_MIME = new Set([
  "image/svg+xml",
  "image/png",
  "image/jpeg",
  "image/webp",
]);

// HEX colour validator: #RRGGBB. Empty input is collapsed to null so
// admins can clear the field without us synthesising a CHECK violation.
const hexColor = z
  .string()
  .trim()
  .max(7)
  .regex(/^#[0-9A-Fa-f]{6}$/u, "brand_color must look like #RRGGBB")
  .nullable();

// URL validator. http(s) URLs or absolute paths starting with "/" so
// admins can later self-host under apps/web/public/. Empty string → null.
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
  missingLogo: z
    .union([z.literal("1"), z.literal("true"), z.literal("0"), z.literal("false")])
    .optional()
    .transform((v) => v === "1" || v === "true"),
  active: z
    .union([z.literal("1"), z.literal("true"), z.literal("0"), z.literal("false")])
    .optional()
    .transform((v) => (v == null ? undefined : v === "1" || v === "true")),
  limit: z.coerce.number().int().min(1).max(200).default(100),
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

interface SportRow {
  id: number;
  provider: string;
  providerUrn: string;
  slug: string;
  name: string;
  kind: string;
  active: boolean;
  logoUrl: string | null;
  brandColor: string | null;
}

// Build the storefront-facing URL we stamp onto sports.logo_url after a
// successful upload. The ?v param is the upload timestamp so a re-upload
// busts any cached <img src=…> the storefront has from a previous load
// — the byte-serve route ignores the param.
function buildLogoUrl(slug: string, version: number): string {
  return `/api/sports/${slug}/logo?v=${version}`;
}

const writeRateLimit = {
  rateLimit: { max: 30, timeWindow: "1 minute" },
};

// Must match the key used by /catalog/sports in modules/catalog/routes.ts.
// Kept inline rather than re-exported to avoid a sideways module dep —
// if a future cache invalidation surface grows we can centralise both.
const SPORTS_CATALOG_CACHE_KEY = "catalog:sports:v1";

export default async function adminSportsRoutes(app: FastifyInstance) {
  // Multipart support is local to this scope so the existing JSON-body
  // routes (GET /admin/sports, PATCH /admin/sports/:id) keep their
  // default parsing. Mirrors the pattern in admin/avatars.ts. Cap files
  // at MAX_UPLOAD_BYTES so the stream layer rejects oversize uploads
  // before they hit handler memory.
  await app.register(multipart, {
    limits: {
      fileSize: MAX_UPLOAD_BYTES,
      files: 1,
      fields: 5,
      fieldSize: 1024,
    },
  });

  app.get("/admin/sports", async (request) => {
    request.requireRole("admin");
    const q = listQuery.parse(request.query);

    const filters: SQL[] = [];
    if (q.q) {
      const like = `%${q.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      filters.push(
        sql`(${sports.name} ILIKE ${like} OR ${sports.slug} ILIKE ${like})`,
      );
    }
    if (q.missingLogo) filters.push(isNull(sports.logoUrl));
    if (q.active !== undefined) filters.push(eq(sports.active, q.active));

    const where = filters.length > 0 ? and(...filters) : sql`TRUE`;

    const [rows, totalRows] = await Promise.all([
      app.db
        .select({
          id: sports.id,
          provider: sports.provider,
          providerUrn: sports.providerUrn,
          slug: sports.slug,
          name: sports.name,
          kind: sports.kind,
          active: sports.active,
          logoUrl: sports.logoUrl,
          brandColor: sports.brandColor,
        })
        .from(sports)
        .where(where)
        .orderBy(asc(sports.slug))
        .limit(q.limit)
        .offset(q.offset),
      app.db
        .select({ total: sql<string>`COUNT(*)::text` })
        .from(sports)
        .where(where),
    ]);
    const total = Number(totalRows[0]?.total ?? "0");
    const missingLogoCount = Number(
      (
        await app.db
          .select({ c: sql<string>`COUNT(*)::text` })
          .from(sports)
          .where(isNull(sports.logoUrl))
      )[0]?.c ?? "0",
    );

    return {
      total,
      missingLogoCount,
      limit: q.limit,
      offset: q.offset,
      sports: rows satisfies SportRow[],
    };
  });

  app.patch("/admin/sports/:id", async (request) => {
    const admin = request.requireRole("admin");
    const params = z
      .object({ id: z.coerce.number().int().positive() })
      .parse(request.params);
    const body = patchBody.parse(request.body);

    const [before] = await app.db
      .select({
        id: sports.id,
        slug: sports.slug,
        name: sports.name,
        logoUrl: sports.logoUrl,
        brandColor: sports.brandColor,
        logoMime: sports.logoMime,
      })
      .from(sports)
      .where(eq(sports.id, params.id))
      .limit(1);
    if (!before) throw new NotFoundError("sport_not_found", "sport_not_found");

    const patch: Partial<{
      logoUrl: string | null;
      brandColor: string | null;
      logoData: Buffer | null;
      logoMime: string | null;
    }> = {};
    if (body.logoUrl !== undefined) {
      patch.logoUrl = body.logoUrl;
      // If the operator pastes a non-byte-serve URL (or clears it), the
      // previously uploaded bytes are now orphaned — wipe them in the
      // same transaction so logo_data/logo_mime never get stale relative
      // to logo_url. The upload endpoint is the only path that writes
      // them in the other direction.
      const isByteServeUrl =
        body.logoUrl != null && body.logoUrl.startsWith(`/api/sports/${before.slug}/logo`);
      if (!isByteServeUrl && before.logoMime !== null) {
        patch.logoData = null;
        patch.logoMime = null;
      }
    }
    if (body.brandColor !== undefined) patch.brandColor = body.brandColor;

    await app.db.transaction(async (tx) => {
      await tx.update(sports).set(patch).where(eq(sports.id, params.id));
      await tx.insert(adminAuditLog).values({
        actorUserId: admin.id,
        action: "sport.update",
        targetType: "sport",
        targetId: params.id.toString(),
        beforeJson: {
          logoUrl: before.logoUrl,
          brandColor: before.brandColor,
          logoMime: before.logoMime,
        },
        afterJson: {
          slug: before.slug,
          name: before.name,
          // Audit captures intent: only metadata, never bytes.
          ...{
            logoUrl: patch.logoUrl,
            brandColor: patch.brandColor,
            ...(patch.logoMime !== undefined ? { logoMime: patch.logoMime } : {}),
          },
        },
        ipInet: request.ip ?? null,
      });
    });

    // /catalog/sports is cached 60s; bust on every admin sport mutation so
    // a logo or brand-color edit shows up on the storefront immediately.
    await app.redis.del(SPORTS_CATALOG_CACHE_KEY).catch(() => null);

    return { ok: true, id: params.id };
  });

  // ─── Logo upload ─────────────────────────────────────────────────────────
  //
  // Multipart form with a single file part. The MIME-type allowlist is
  // enforced both here (zod-style assertion) and at the DB CHECK
  // (sports_logo_mime_allowed) so a future direct-DB write can't quietly
  // enable an unsupported format. After a successful write the row's
  // logo_url is stamped to the byte-serve URL so the storefront's
  // existing logoUrl-based <img> path picks the upload up.
  app.post<{ Params: { id: string } }>(
    "/admin/sports/:id/logo",
    { config: writeRateLimit },
    async (request, reply) => {
      const admin = request.requireRole("admin");
      const params = z
        .object({ id: z.coerce.number().int().positive() })
        .parse(request.params);

      const file = await request.file();
      if (!file) {
        throw new BadRequestError("file_required", "file_required");
      }
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
          id: sports.id,
          slug: sports.slug,
          name: sports.name,
          logoUrl: sports.logoUrl,
          logoMime: sports.logoMime,
        })
        .from(sports)
        .where(eq(sports.id, params.id))
        .limit(1);
      if (!before) throw new NotFoundError("sport_not_found", "sport_not_found");

      const version = Date.now();
      const newLogoUrl = buildLogoUrl(before.slug, version);

      await app.db.transaction(async (tx) => {
        await tx
          .update(sports)
          .set({
            logoData: buffer,
            logoMime: file.mimetype,
            logoUrl: newLogoUrl,
          })
          .where(eq(sports.id, params.id));
        await tx.insert(adminAuditLog).values({
          actorUserId: admin.id,
          action: "sport.logo_upload",
          targetType: "sport",
          targetId: params.id.toString(),
          beforeJson: {
            logoUrl: before.logoUrl,
            logoMime: before.logoMime,
          },
          // Bytes are not in the audit row — only metadata. Audit log
          // is for accountability, not byte-for-byte history.
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

      // See PATCH handler note: bust the /catalog/sports cache so the
      // new logo URL surfaces on the next storefront layout render.
      await app.redis.del(SPORTS_CATALOG_CACHE_KEY).catch(() => null);

      reply.code(200);
      return { ok: true, id: params.id, logoUrl: newLogoUrl };
    },
  );

  // ─── Logo remove ─────────────────────────────────────────────────────────
  //
  // Idempotent: clearing an already-clear row is a no-op + audit row.
  // Wipes both the bytes and the auto-generated URL so the storefront
  // falls back to the bundled /public/sports/<slug>.svg → glyph chain.
  // Admins who want to keep an external URL after dropping the upload
  // should follow up with a PATCH; the inverse flow (URL → upload) goes
  // through POST /admin/sports/:id/logo which overwrites both columns.
  app.delete<{ Params: { id: string } }>(
    "/admin/sports/:id/logo",
    { config: writeRateLimit },
    async (request) => {
      const admin = request.requireRole("admin");
      const params = z
        .object({ id: z.coerce.number().int().positive() })
        .parse(request.params);

      const [before] = await app.db
        .select({
          id: sports.id,
          slug: sports.slug,
          name: sports.name,
          logoUrl: sports.logoUrl,
          logoMime: sports.logoMime,
        })
        .from(sports)
        .where(eq(sports.id, params.id))
        .limit(1);
      if (!before) throw new NotFoundError("sport_not_found", "sport_not_found");

      await app.db.transaction(async (tx) => {
        await tx
          .update(sports)
          .set({ logoData: null, logoMime: null, logoUrl: null })
          .where(eq(sports.id, params.id));
        await tx.insert(adminAuditLog).values({
          actorUserId: admin.id,
          action: "sport.logo_remove",
          targetType: "sport",
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

      // See PATCH handler note: bust the /catalog/sports cache so the
      // logo removal surfaces on the next storefront layout render.
      await app.redis.del(SPORTS_CATALOG_CACHE_KEY).catch(() => null);

      return { ok: true, id: params.id };
    },
  );
}
