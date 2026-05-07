// /admin/avatars/* — admin-only avatar template management.
//
// The flow:
//   • Operators upload PNG/JPEG/WebP via POST /admin/avatars (multipart).
//     The bytes land in BYTEA on avatar_templates.image_data; image_path
//     stays NULL. Public list serves the bytes via /community/avatars/
//     :slug/image.
//   • Metadata edits (name, category, rarity, status, sort_order) go
//     through PATCH /admin/avatars/:id. The image bytes are never
//     editable in place — to swap an image, delete the old slug and
//     upload a new one. This keeps long-cache headers on the byte
//     serve sound.
//   • Soft delete via DELETE /admin/avatars/:id sets status='hidden'.
//     Existing equips keep working; the picker stops listing the row.
//     Hard delete isn't exposed — there's no business need and a
//     stray cascade would orphan equips.
//
// Every mutation writes to admin_audit_log (action: avatar.*) so we
// can trace who added or hid which template. Same pattern as
// /admin/users and /admin/deposits.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import {
  avatarTemplates,
  adminAuditLog,
  type AvatarTemplate,
} from "@oddzilla/db";
import type {
  AvatarTemplateAdminListResponse,
  AvatarTemplateAdminSummary,
  AvatarTemplatePatchRequest,
  AvatarRarity,
  AvatarStatus,
} from "@oddzilla/types";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../../lib/errors.js";
import { resolveAvatarUrl } from "../community/avatar-url.js";

// 5 MB upload cap — comfortable for 1024×1024 PNGs at the
// recommended quality, well below the body-size we'd want to risk
// holding in api memory. The multipart plugin enforces this at the
// stream layer; we don't need a manual check after readFile().
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
// Mirrors the PRD's "PNG, WebP, JPEG" allowlist. text/* and other
// surprising MIME types fall through to a 415.
const ALLOWED_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
]);
// Slug shape: lowercase alphanumerics + dashes/underscores. 3-64
// chars. Tightened from the seed pattern (kaiju-01) — admins free to
// pick categorical slugs ("sport-striker", "neon-orb-03") so long as
// they're URL-safe.
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{1,62}[a-z0-9]$/;

const RARITY_VALUES = ["common", "rare", "epic", "legendary"] as const;
const STATUS_VALUES = ["active", "hidden"] as const;

const patchBody = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    category: z.string().trim().min(1).max(40).optional(),
    rarity: z.enum(RARITY_VALUES).optional(),
    status: z.enum(STATUS_VALUES).optional(),
    sortOrder: z.number().int().min(0).max(10000).optional(),
  })
  .strict();

// Multipart upload form fields. The file part is consumed via
// request.file() — only the metadata fields show up here.
const uploadFields = z.object({
  slug: z.string().regex(SLUG_RE, "invalid_slug"),
  name: z.string().trim().min(1).max(80),
  category: z.string().trim().min(1).max(40).default("custom"),
  rarity: z.enum(RARITY_VALUES).default("common"),
});

const writeRateLimit = {
  rateLimit: { max: 30, timeWindow: "1 minute" },
};

// ─── Plugin: multipart support ──────────────────────────────────────────────
//
// Registered inside this module so the multipart route is the only
// surface that consumes it. attachFieldsToBody is OFF — we read the
// file stream + form fields explicitly via request.file() / parts().
// Cap matches MAX_UPLOAD_BYTES so the stream layer rejects oversize
// uploads before they hit our handler.

import multipart from "@fastify/multipart";

export default async function adminAvatarRoutes(app: FastifyInstance) {
  await app.register(multipart, {
    limits: {
      fileSize: MAX_UPLOAD_BYTES,
      files: 1,
      // Form fields ride alongside the file part; cap counts so a
      // pathological client can't OOM the parser.
      fields: 20,
      fieldSize: 1024,
    },
  });

  // ─── Admin list ──────────────────────────────────────────────────────────
  //
  // Returns active + hidden in one shot. Operators read this to find
  // the row they want to edit/hide; the user-facing picker uses the
  // public /community/avatars endpoint which filters to active only.
  app.get(
    "/admin/avatars",
    async (request): Promise<AvatarTemplateAdminListResponse> => {
      request.requireRole("admin");
      const rows = await app.db
        .select({
          id: avatarTemplates.id,
          slug: avatarTemplates.slug,
          name: avatarTemplates.name,
          category: avatarTemplates.category,
          rarity: avatarTemplates.rarity,
          status: avatarTemplates.status,
          sortOrder: avatarTemplates.sortOrder,
          imagePath: avatarTemplates.imagePath,
          createdAt: avatarTemplates.createdAt,
        })
        .from(avatarTemplates)
        .orderBy(
          // Active first (so the most relevant rows render at the top
          // of the admin grid), then sort_order, then alpha.
          sql`${avatarTemplates.status} = 'hidden'`,
          avatarTemplates.sortOrder,
          avatarTemplates.name,
        );

      const templates: AvatarTemplateAdminSummary[] = rows.map((r) => ({
        id: r.id,
        slug: r.slug,
        name: r.name,
        category: r.category,
        rarity: r.rarity as AvatarRarity,
        status: r.status as AvatarStatus,
        sortOrder: r.sortOrder,
        imageUrl: resolveAvatarUrl({ slug: r.slug, imagePath: r.imagePath }),
        createdAt: r.createdAt.toISOString(),
        // Static seeds carry image_path; uploads have it NULL. The
        // grid uses this to disable the "replace bytes" affordance on
        // seed rows where the bytes live on disk and not in the DB.
        source: r.imagePath ? "seed" : "upload",
      }));

      return { templates };
    },
  );

  // ─── Upload ──────────────────────────────────────────────────────────────
  //
  // Multipart: one file part + form fields { slug, name, category,
  // rarity }. Slug must be unique (DB constraint reinforces with a 23505
  // → 409). The handler reads the file stream into a Buffer; the
  // multipart plugin's fileSize limit aborts oversize streams before
  // they balloon the buffer.
  app.post(
    "/admin/avatars",
    { config: writeRateLimit },
    async (request, reply) => {
      const admin = request.requireRole("admin");

      const file = await request.file();
      if (!file) {
        throw new BadRequestError("file_required", "file_required");
      }
      if (!ALLOWED_MIME.has(file.mimetype)) {
        // 415 would be more idiomatic but we're consistent with the
        // 400-driven validation pattern across the rest of the API.
        throw new BadRequestError(
          "unsupported_mime",
          "unsupported_mime",
        );
      }

      // Form fields arrive as { fieldname: { value: '...' } } objects
      // when attachFieldsToBody is off. Coerce to plain {k:v} for zod.
      const rawFields = Object.fromEntries(
        Object.entries(file.fields)
          .filter(([k]) => k !== file.fieldname)
          .map(([k, v]) => [
            k,
            typeof (v as { value?: unknown })?.value === "string"
              ? (v as { value: string }).value
              : v,
          ]),
      );
      const fields = uploadFields.parse(rawFields);

      // Stream → Buffer. multipart's truncated flag goes high when
      // fileSize trips, which we check post-read so the error message
      // is clear (the stream itself just silently EOFs at the limit).
      const buffer = await file.toBuffer();
      if (file.file.truncated) {
        throw new BadRequestError("file_too_large", "file_too_large");
      }
      if (buffer.length === 0) {
        throw new BadRequestError("file_empty", "file_empty");
      }

      try {
        const inserted = await app.db.transaction(async (tx) => {
          const [row] = await tx
            .insert(avatarTemplates)
            .values({
              slug: fields.slug,
              name: fields.name,
              category: fields.category,
              rarity: fields.rarity,
              imageData: buffer,
              imageMime: file.mimetype,
              createdBy: admin.id,
            })
            .returning({
              id: avatarTemplates.id,
              slug: avatarTemplates.slug,
              name: avatarTemplates.name,
              category: avatarTemplates.category,
              rarity: avatarTemplates.rarity,
              status: avatarTemplates.status,
              sortOrder: avatarTemplates.sortOrder,
              imagePath: avatarTemplates.imagePath,
              createdAt: avatarTemplates.createdAt,
            });
          // INSERT ... RETURNING always emits one row in the success
          // path; the assert documents the invariant for TS strict
          // narrowing. A truly missing row would mean a Postgres
          // error already surfaced in the catch.
          if (!row) throw new Error("avatar insert returned no row");

          await tx.insert(adminAuditLog).values({
            actorUserId: admin.id,
            action: "avatar.upload",
            targetType: "avatar_template",
            targetId: row.id,
            beforeJson: null,
            // Bytes are not in the audit row — only metadata. Audit
            // log is for accountability, not byte-for-byte history.
            afterJson: {
              slug: row.slug,
              name: row.name,
              category: row.category,
              rarity: row.rarity,
              mime: file.mimetype,
              bytes: buffer.length,
            },
            ipInet: request.ip ?? null,
          });

          return row;
        });

        const summary: AvatarTemplateAdminSummary = {
          id: inserted.id,
          slug: inserted.slug,
          name: inserted.name,
          category: inserted.category,
          rarity: inserted.rarity as AvatarRarity,
          status: inserted.status as AvatarStatus,
          sortOrder: inserted.sortOrder,
          imageUrl: resolveAvatarUrl({
            slug: inserted.slug,
            imagePath: inserted.imagePath,
          }),
          createdAt: inserted.createdAt.toISOString(),
          source: "upload",
        };
        reply.code(201);
        return summary;
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictError("slug_taken", "slug_taken");
        }
        throw err;
      }
    },
  );

  // ─── Patch metadata ──────────────────────────────────────────────────────
  app.patch<{ Params: { id: string } }>(
    "/admin/avatars/:id",
    { config: writeRateLimit },
    async (request) => {
      const admin = request.requireRole("admin");
      const params = z
        .object({ id: z.string().uuid() })
        .parse(request.params);
      const body: AvatarTemplatePatchRequest = patchBody.parse(request.body);

      if (Object.keys(body).length === 0) {
        throw new BadRequestError("no_changes", "no_changes");
      }

      const [existing] = await app.db
        .select()
        .from(avatarTemplates)
        .where(eq(avatarTemplates.id, params.id))
        .limit(1);
      if (!existing) throw new NotFoundError();

      // Build before/after for audit. Only fields actually present in
      // the patch land here, matching the /admin/users pattern.
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      const patch: Partial<AvatarTemplate> = {};
      for (const k of Object.keys(body) as (keyof AvatarTemplatePatchRequest)[]) {
        const next = body[k];
        if (next === undefined) continue;
        const prev = existing[k as keyof AvatarTemplate];
        if (prev !== next) {
          before[k] = prev;
          after[k] = next;
          (patch as Record<string, unknown>)[k] = next;
        }
      }
      if (Object.keys(after).length === 0) {
        throw new BadRequestError("no_changes", "no_changes");
      }

      await app.db.transaction(async (tx) => {
        await tx
          .update(avatarTemplates)
          .set(patch)
          .where(eq(avatarTemplates.id, params.id));
        await tx.insert(adminAuditLog).values({
          actorUserId: admin.id,
          action: "avatar.update",
          targetType: "avatar_template",
          targetId: params.id,
          beforeJson: before,
          afterJson: after,
          ipInet: request.ip ?? null,
        });
      });

      return { ok: true, changed: Object.keys(after) };
    },
  );

  // ─── Soft delete ─────────────────────────────────────────────────────────
  //
  // Sets status='hidden'. Existing equips keep their avatar (FK is
  // ON DELETE SET NULL, but soft-delete leaves the FK intact); the
  // picker drops the row. Hard delete isn't exposed — operators who
  // really want a row gone can DELETE the user FK first then issue an
  // explicit SQL DELETE; the audit trail captures the intent path.
  app.delete<{ Params: { id: string } }>(
    "/admin/avatars/:id",
    { config: writeRateLimit },
    async (request) => {
      const admin = request.requireRole("admin");
      const params = z
        .object({ id: z.string().uuid() })
        .parse(request.params);

      const [existing] = await app.db
        .select({
          id: avatarTemplates.id,
          status: avatarTemplates.status,
        })
        .from(avatarTemplates)
        .where(eq(avatarTemplates.id, params.id))
        .limit(1);
      if (!existing) throw new NotFoundError();

      if (existing.status === "hidden") {
        return { ok: true, alreadyHidden: true };
      }

      await app.db.transaction(async (tx) => {
        await tx
          .update(avatarTemplates)
          .set({ status: "hidden" })
          .where(eq(avatarTemplates.id, params.id));
        await tx.insert(adminAuditLog).values({
          actorUserId: admin.id,
          action: "avatar.hide",
          targetType: "avatar_template",
          targetId: params.id,
          beforeJson: { status: "active" },
          afterJson: { status: "hidden" },
          ipInet: request.ip ?? null,
        });
      });

      return { ok: true };
    },
  );
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "23505"
  );
}
