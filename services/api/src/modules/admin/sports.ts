// /admin/sports endpoints. Admin-only.
//
// Surface area:
//   GET    /admin/sports                paginated list with optional
//                                       ?q (name/slug search), ?missingLogo=1
//   PATCH  /admin/sports/:id            update logo_url / brand_color.
//                                       Mutations are audit-logged.
//
// Mirrors the /admin/competitors shape so the editor UI can be cloned with
// only minor field changes. Sports are a small set (≤ ~50 rows); we don't
// need a bulk endpoint here yet.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, asc, eq, isNull, sql, type SQL } from "drizzle-orm";
import { sports, adminAuditLog } from "@oddzilla/db";
import { NotFoundError } from "../../lib/errors.js";

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

export default async function adminSportsRoutes(app: FastifyInstance) {
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
      })
      .from(sports)
      .where(eq(sports.id, params.id))
      .limit(1);
    if (!before) throw new NotFoundError("sport_not_found", "sport_not_found");

    const patch: Partial<{ logoUrl: string | null; brandColor: string | null }> = {};
    if (body.logoUrl !== undefined) patch.logoUrl = body.logoUrl;
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
}
