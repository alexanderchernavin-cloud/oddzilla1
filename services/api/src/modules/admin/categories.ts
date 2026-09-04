// /admin/categories endpoints. Admin-only.
//
// Surface area:
//   GET   /admin/categories          list with optional ?sportId, ?q
//                                    (name search), ?hidden=1 filter
//   GET   /admin/categories/sports   sport-filter dropdown options
//   PATCH /admin/categories/:id      toggle hidden_from_lists.
//                                    Audit-logged.
//
// What the toggle does (migration 0102): a flagged category is dropped
// from every match list a bettor gets WITHOUT asking — the lobby, /live,
// /upcoming, the sport-page default view and the per-sport live badge —
// while staying in the sidebar tree, where selecting it (or one of its
// tournaments) shows every match under it.
//
// The case it exists for: Fonbet files EA FC simulations
// ("FC 26. ESportsBattle. La Liga. 2x4 min.") under the real Football
// sport, so 165 of Football's ~210 bookable matches were computer-played
// 2x4-minute games sitting above the actual football offer. Same shape
// for NBA 2K26 under Basketball and NHL 26 under Ice Hockey.
//
// Deliberately NOT `categories.active = false`: these matches are real,
// bettable and settle normally. This is a merchandising decision, not a
// kill switch, and keeping the two apart means an operator can undo one
// without touching the other.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, asc, eq, ilike, sql, type SQL } from "drizzle-orm";
import {
  categories,
  sports,
  tournaments,
  matches,
  adminAuditLog,
} from "@oddzilla/db";
import { NotFoundError } from "../../lib/errors.js";

const writeRateLimit = {
  rateLimit: { max: 30, timeWindow: "1 minute" },
};

const listQuery = z.object({
  q: z.string().trim().max(128).optional(),
  sportId: z.coerce.number().int().positive().optional(),
  hidden: z
    .union([z.literal("1"), z.literal("true"), z.literal("0"), z.literal("false")])
    .optional()
    .transform((v) => (v == null ? undefined : v === "1" || v === "true")),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

const patchBody = z.object({
  hiddenFromLists: z.boolean(),
});

export default async function adminCategoriesRoutes(app: FastifyInstance) {
  // Sport options for the filter dropdown. Only sports that actually own
  // a non-dummy category — an empty dropdown entry is a dead end.
  app.get("/admin/categories/sports", async (request) => {
    request.requireRole("admin");
    const rows = await app.db
      .selectDistinct({ id: sports.id, name: sports.name, slug: sports.slug })
      .from(sports)
      .innerJoin(
        categories,
        and(eq(categories.sportId, sports.id), eq(categories.isDummy, false)),
      )
      .orderBy(asc(sports.name));
    return { sports: rows };
  });

  app.get("/admin/categories", async (request) => {
    request.requireRole("admin");
    const q = listQuery.parse(request.query);

    const filters: (SQL | undefined)[] = [
      q.sportId ? eq(categories.sportId, q.sportId) : undefined,
      q.q ? ilike(categories.name, `%${q.q}%`) : undefined,
      q.hidden === undefined ? undefined : eq(categories.hiddenFromLists, q.hidden),
      // Oddin's auto-mapper files every esports tournament under one
      // synthetic dummy category. It is never a merchandising unit (the
      // storefront doesn't even render a header for it), so listing it
      // here would only offer a toggle that blanks an entire esport by
      // accident.
      eq(categories.isDummy, false),
    ];
    const where = and(...filters.filter(Boolean));

    // Match counts make the decision legible: "FC 26 — 165 bookable" is
    // the whole argument for flagging it, and a category sitting at 0 is
    // not worth an operator's attention. Counted with the same
    // live/upcoming shape the storefront lists use, minus the active-market
    // check — a rough sizing signal, not a catalog read on a hot path.
    const bookableCount = sql<string>`(
      SELECT COUNT(*)::text
        FROM ${tournaments} t
        JOIN ${matches} m ON m.tournament_id = t.id
       WHERE t.category_id = ${categories.id}
         AND (
           m.status = 'live'
           OR (m.status = 'not_started'
               AND m.scheduled_at > NOW() - INTERVAL '6 hours')
         )
    )`;

    const [rows, totalRows, hiddenRows] = await Promise.all([
      app.db
        .select({
          id: categories.id,
          name: categories.name,
          slug: categories.slug,
          hiddenFromLists: categories.hiddenFromLists,
          sportId: sports.id,
          sportName: sports.name,
          sportSlug: sports.slug,
          bookableCount,
        })
        .from(categories)
        .innerJoin(sports, eq(sports.id, categories.sportId))
        .where(where)
        .orderBy(asc(sports.name), asc(categories.name))
        .limit(q.limit)
        .offset(q.offset),
      app.db
        .select({ total: sql<string>`COUNT(*)::text` })
        .from(categories)
        .innerJoin(sports, eq(sports.id, categories.sportId))
        .where(where),
      app.db
        .select({ hiddenCount: sql<string>`COUNT(*)::text` })
        .from(categories)
        .where(
          and(eq(categories.hiddenFromLists, true), eq(categories.isDummy, false)),
        ),
    ]);

    return {
      total: Number(totalRows[0]?.total ?? 0),
      hiddenCount: Number(hiddenRows[0]?.hiddenCount ?? 0),
      limit: q.limit,
      offset: q.offset,
      categories: rows.map((r) => ({
        id: r.id,
        name: r.name,
        slug: r.slug,
        hiddenFromLists: r.hiddenFromLists,
        bookableCount: Number(r.bookableCount),
        sport: { id: r.sportId, name: r.sportName, slug: r.sportSlug },
      })),
    };
  });

  app.patch<{ Params: { id: string } }>(
    "/admin/categories/:id",
    { config: writeRateLimit },
    async (request) => {
      const admin = request.requireRole("admin");
      const id = Number(request.params.id);
      if (!Number.isInteger(id) || id <= 0) throw new NotFoundError();
      const body = patchBody.parse(request.body);

      const [before] = await app.db
        .select({
          id: categories.id,
          slug: categories.slug,
          name: categories.name,
          hiddenFromLists: categories.hiddenFromLists,
        })
        .from(categories)
        .where(eq(categories.id, id))
        .limit(1);
      if (!before) throw new NotFoundError();

      let after = before;
      await app.db.transaction(async (tx) => {
        const [updated] = (await tx
          .update(categories)
          .set({ hiddenFromLists: body.hiddenFromLists })
          .where(eq(categories.id, id))
          .returning({
            id: categories.id,
            slug: categories.slug,
            name: categories.name,
            hiddenFromLists: categories.hiddenFromLists,
          })) as [typeof before];
        after = updated;
        await tx.insert(adminAuditLog).values({
          actorUserId: admin.id,
          action: "category.visibility_update",
          targetType: "category",
          targetId: String(id),
          beforeJson: { hiddenFromLists: before.hiddenFromLists },
          afterJson: {
            slug: before.slug,
            name: before.name,
            hiddenFromLists: updated.hiddenFromLists,
          },
          ipInet: request.ip ?? null,
        });
      });

      return { category: after };
    },
  );
}
