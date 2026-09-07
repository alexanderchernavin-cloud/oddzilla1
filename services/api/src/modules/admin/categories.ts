// /admin/categories endpoints. Admin-only.
//
// Surface area:
//   GET   /admin/categories          list with optional ?sportId, ?q
//                                    (name search), ?hidden=1 filter
//   GET   /admin/categories/sports   sport-filter dropdown options
//   PATCH /admin/categories/:id      toggle hidden_from_lists.
//                                    Audit-logged.
//   POST  /admin/categories/:id/order pin / move / unpin within the
//                                    category's own sport. Audit-logged.
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
//
// `active` means something narrower and is not an operator control at
// all: fonbet-ingester retires a category that holds no tournament,
// which is what a spelling merge leaves behind (see
// store.DeactivateEmptyCategories). The list filters those out — they
// render nowhere on the storefront either — and they return on their own
// if Fonbet splits the competition again.
//
// What the ordering does (migration 0103): the sidebar's category
// buckets have always sorted alphabetically, so Football's tree opens on
// Albania. A pinned category carries a `display_order` and heads its
// sport's tree in that sequence; everything unpinned stays alphabetical
// behind it. The pinned set is stored as a dense 1..N sequence per
// sport and renumbered on every action — see lib/pin-order.ts for why
// the operation is a transform of the id list rather than arithmetic on
// one row.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, asc, eq, ilike, isNotNull, or, sql, type SQL } from "drizzle-orm";
import {
  categories,
  sports,
  tournaments,
  matches,
  adminAuditLog,
} from "@oddzilla/db";
import { NotFoundError } from "../../lib/errors.js";
import { reorderPinned, type PinAction } from "../../lib/pin-order.js";
import { bookableWindow } from "../../lib/catalog-predicates.js";

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

const orderBody = z.object({
  action: z.enum(["top", "up", "down", "clear"]),
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
        and(
          eq(categories.sportId, sports.id),
          eq(categories.isDummy, false),
          eq(categories.active, true),
        ),
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
      // Retired rows. `categories.active` had no reader anywhere in the
      // system until this filter — fonbet-ingester's
      // DeactivateEmptyCategories is its only writer, and it sets FALSE
      // only for a category holding no tournament at all, which the
      // storefront already renders nowhere (the sidebar builds its
      // buckets from the tournaments endpoint). Without the filter the
      // sweep would be invisible and the row would keep its line here
      // forever, which is the whole point of retiring it. EnsureCategory
      // sets active = TRUE on conflict, so a category Fonbet brings back
      // returns to this list on the next cycle.
      eq(categories.active, true),
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
         AND ${bookableWindow("m")}
    )`;

    const [rows, totalRows, hiddenRows] = await Promise.all([
      app.db
        .select({
          id: categories.id,
          name: categories.name,
          slug: categories.slug,
          hiddenFromLists: categories.hiddenFromLists,
          displayOrder: categories.displayOrder,
          sportId: sports.id,
          sportName: sports.name,
          sportSlug: sports.slug,
          bookableCount,
        })
        .from(categories)
        .innerJoin(sports, eq(sports.id, categories.sportId))
        .where(where)
        // Mirrors what the storefront renders: pinned categories head
        // their sport in operator order, the rest stay alphabetical. An
        // admin reading a row's arrows has to see them in the sequence
        // they will take effect in, or "up" points somewhere else.
        .orderBy(
          asc(sports.name),
          sql`${categories.displayOrder} ASC NULLS LAST`,
          asc(categories.name),
        )
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
          and(
            eq(categories.hiddenFromLists, true),
            eq(categories.isDummy, false),
            eq(categories.active, true),
          ),
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
        displayOrder: r.displayOrder,
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

  // Pin / move / unpin one category within its OWN sport.
  //
  // Scope is the sport, not the whole table: a category only ever
  // renders inside one sport's sidebar tree, so "second from the top"
  // is a statement about Football, and a global sequence would make
  // every sport's ordering contend for the same integers.
  //
  // Dummy categories are refused rather than silently ignored. Oddin's
  // auto-mapper files every esports tournament under one synthetic
  // category which the storefront renders WITHOUT a header — there is no
  // bucket for a position to be a position of, and the list endpoint
  // already excludes them, so an id reaching here is a bug or a hand-
  // rolled request, and both deserve an error.
  app.post<{ Params: { id: string } }>(
    "/admin/categories/:id/order",
    { config: writeRateLimit },
    async (request) => {
      const admin = request.requireRole("admin");
      const id = Number(request.params.id);
      if (!Number.isInteger(id) || id <= 0) throw new NotFoundError();
      const { action } = orderBody.parse(request.body) as { action: PinAction };

      let sportId = 0;
      let before: number | null = null;
      let after: number | null = null;

      // Which sport we're operating in, read outside the transaction.
      // Both fields are immutable for the life of the row — a category
      // never changes sport and `is_dummy` is set at creation — so
      // reading them unlocked costs nothing and lets the transaction
      // below take all of its locks in ONE statement.
      const [scope] = await app.db
        .select({
          sportId: categories.sportId,
          isDummy: categories.isDummy,
          active: categories.active,
          name: categories.name,
          slug: categories.slug,
        })
        .from(categories)
        .where(eq(categories.id, id))
        .limit(1);
      // A retired category is not listed above, so this is unreachable
      // through the UI; refused anyway because a pin is a position in the
      // dense 1..N sequence this endpoint maintains, and a row nobody can
      // see holding a slot would put the visible list and the stored
      // sequence permanently out of step.
      if (!scope || scope.isDummy || !scope.active) throw new NotFoundError();
      sportId = scope.sportId;

      await app.db.transaction(async (tx) => {
        // The target plus the sport's whole pinned set, locked in ONE
        // statement ordered by primary key.
        //
        // Both halves of that matter. One statement, because locking the
        // target and then the set is two acquisitions in an order that
        // depends on which row the operator clicked — two admins working
        // on the same sport would take the same rows in opposite orders
        // and one would die on a deadlock. By id, because that gives
        // every session the same acquisition order regardless of what
        // the pin positions currently are.
        const locked = await tx
          .select({ id: categories.id, displayOrder: categories.displayOrder })
          .from(categories)
          .where(
            and(
              eq(categories.sportId, scope.sportId),
              eq(categories.isDummy, false),
              or(eq(categories.id, id), isNotNull(categories.displayOrder)),
            ),
          )
          .orderBy(asc(categories.id))
          .for("update");

        const target = locked.find((r) => r.id === id);
        if (!target) throw new NotFoundError();
        before = target.displayOrder;

        // Re-sort the locked rows into display order for the transform;
        // the lock order above was about deadlock avoidance, not this.
        const pinned = locked
          .filter((r) => r.displayOrder != null)
          .sort((a, b) => a.displayOrder! - b.displayOrder! || a.id - b.id)
          .map((r) => r.id);

        const next = reorderPinned(pinned, id, action);
        const position = next.indexOf(id);
        after = position === -1 ? null : position + 1;

        // Renumber: clear the sport's pins, then stamp the new sequence.
        // Clearing first means a row dropped from the list needs no
        // special case.
        //
        // The stamp is a loop rather than one UPDATE ... CASE on purpose.
        // A pinned set is a handful of rows — the operator's leading
        // countries, not the catalogue — so the round trips are noise
        // inside a transaction that already holds the locks, and going
        // through the query builder keeps the column's type known
        // instead of leaning on Postgres to infer it for a CASE whose
        // every branch is a bound parameter.
        await tx
          .update(categories)
          .set({ displayOrder: null })
          .where(
            and(
              eq(categories.sportId, scope.sportId),
              // Matches the locked set exactly, so the clear never
              // touches a row this transaction doesn't hold.
              eq(categories.isDummy, false),
              isNotNull(categories.displayOrder),
            ),
          );

        for (const [i, categoryId] of next.entries()) {
          await tx
            .update(categories)
            .set({ displayOrder: i + 1 })
            .where(eq(categories.id, categoryId));
        }

        await tx.insert(adminAuditLog).values({
          actorUserId: admin.id,
          action: "category.order_update",
          targetType: "category",
          targetId: String(id),
          beforeJson: { displayOrder: before },
          afterJson: {
            slug: scope.slug,
            name: scope.name,
            sportId: scope.sportId,
            operation: action,
            displayOrder: after,
            pinnedOrder: next,
          },
          ipInet: request.ip ?? null,
        });
      });

      // The sidebar tree is cached per sport for 10 s. Busting it makes
      // an operator's reorder visible on the next page load instead of
      // leaving them wondering whether the click registered.
      await app.redis.del(`catalog:tournaments:v1:${sportId}`).catch(() => null);

      return { id, sportId, displayOrder: after };
    },
  );
}
