// /admin/custom-events — the operator's own book.
//
// Everything here writes ORDINARY catalog rows: a custom event is a
// `matches` row, its markets are `markets` rows and its prices are
// `market_outcomes` rows, exactly like anything Oddin or Fonbet sends.
// That is the design decision the whole feature rests on — it means the
// bet slip, RiskZilla, the bet-delay worker, cashout, ZillaBoost,
// community tickets and settlement all work on custom events with no
// changes, because none of them care which provider filled those tables.
//
// What marks a row as ours is the `cu:` URN prefix and the shared
// `provider_market_id` 2 000 000. The prefix matters beyond cosmetics:
// both feeds' catalog-wide flushes are scoped to their own prefix
// (CLAUDE.md invariant 10), so an Oddin outage suspending its whole offer
// leaves the operator's book untouched.
//
// Surface area:
//   GET    /admin/custom-events/structure          sport + categories + tournaments
//   POST   /admin/custom-events/categories         create
//   PATCH  /admin/custom-events/categories/:id     rename
//   DELETE /admin/custom-events/categories/:id     delete (must be empty)
//   POST   /admin/custom-events/tournaments        create
//   PATCH  /admin/custom-events/tournaments/:id    rename
//   DELETE /admin/custom-events/tournaments/:id    delete (must be empty)
//   GET    /admin/custom-events/events             list
//   POST   /admin/custom-events/events             create
//   GET    /admin/custom-events/events/:id         detail + markets + exposure
//   PATCH  /admin/custom-events/events/:id         edit
//   DELETE /admin/custom-events/events/:id         delete (no tickets)
//   POST   /admin/custom-events/events/:id/markets create market
//   PATCH  /admin/custom-events/markets/:id        edit name / pricing / outcomes
//   POST   /admin/custom-events/markets/:id/status open / suspend
//   POST   /admin/custom-events/markets/:id/settle settle with results
//   POST   /admin/custom-events/markets/:id/cancel void the market
//   DELETE /admin/custom-events/markets/:id        delete (no tickets)
//
// Every mutation is audit-logged.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  adminAuditLog,
  categories,
  customMarketConfig,
  customOutcomeConfig,
  marketOutcomes,
  markets,
  matches,
  sports,
  ticketSelections,
  tournaments,
} from "@oddzilla/db";
import {
  CUSTOM_PROVIDER_MARKET_ID,
  CUSTOM_SPORT_SLUG,
  bookKey,
  priceCustomMarket,
} from "@oddzilla/types/custom-events";
import { canonical, hash as specifiersHash } from "@oddzilla/types/specifiers";
import { BadRequestError, NotFoundError } from "../../lib/errors.js";
import {
  customSpecifiers,
  loadExposureByOutcome,
  publishMarketStatus,
  repriceMarket,
} from "../../lib/custom-events/pricing.js";
import { randomBytes } from "node:crypto";

const writeRateLimit = { rateLimit: { max: 60, timeWindow: "1 minute" } };

/** Redis stream the settlement service consumes. Same one Fonbet uses. */
function settlementStream(): string {
  return process.env.SETTLEMENT_EXTERNAL_STREAM || "settlement.external";
}

const nameSchema = z.string().trim().min(1).max(120);
const probabilitySchema = z.number().positive().max(100);

const outcomeSchema = z.object({
  /** Present when editing an existing outcome; absent when adding one. */
  outcomeId: z.string().trim().min(1).max(64).optional(),
  label: nameSchema,
  /**
   * The operator's own view, as a percentage. Not required to sum to 100
   * — the pricing normalises, because 60/30/20 is what a human types.
   */
  probability: probabilitySchema,
});

const marketBody = z.object({
  name: nameSchema,
  overroundBp: z.number().int().min(0).max(5000),
  liabilityTrading: z.boolean().default(false),
  liabilityStrengthBp: z.number().int().min(0).max(10000).default(3000),
  liabilityMaxShiftBp: z.number().int().min(0).max(10000).default(1500),
  outcomes: z.array(outcomeSchema).min(2).max(24),
});

const eventBody = z.object({
  tournamentId: z.number().int().positive(),
  homeTeam: nameSchema,
  awayTeam: nameSchema,
  scheduledAt: z.string().datetime().nullable().optional(),
  bestOf: z.number().int().min(1).max(9).nullable().optional(),
});

const eventPatchBody = eventBody.partial().extend({
  status: z.enum(["not_started", "live", "closed", "cancelled", "suspended"]).optional(),
});

const settleBody = z.object({
  results: z
    .array(
      z.object({
        outcomeId: z.string().trim().min(1),
        result: z.enum(["won", "lost", "void", "half_won", "half_lost"]),
      }),
    )
    .min(2),
});

function slugify(name: string, fallback: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return base.length > 0 ? base : fallback;
}

/**
 * Outcome ids for a market of N outcomes.
 *
 * 2- and 3-outcome markets get Oddin's canonical "1" / "2" / "3", which
 * is not cosmetic: `loadMatchWinnerOdds` pairs a list card's inline price
 * off exactly those ids, so a two- or three-way custom market shows a
 * price on the lobby and sport-page cards for free.
 *
 * Anything wider gets `o1..oN` precisely so it does NOT match. That
 * pairing renders home / away / draw and nothing else, so a five-way
 * market carrying ids 1..5 would appear on cards as a three-way slice of
 * itself — a book that does not add up, shown next to real ones.
 */
function outcomeIdsFor(count: number): string[] {
  if (count <= 3) return ["1", "2", "3"].slice(0, count);
  return Array.from({ length: count }, (_, i) => `o${i + 1}`);
}

/** Oddin wire encoding for a settlement result. `mapOutcomeResult` in the settler is the reader. */
function wireResult(result: string): { result: string; voidFactor: string } {
  switch (result) {
    case "won":
      return { result: "1", voidFactor: "" };
    case "lost":
      return { result: "0", voidFactor: "" };
    case "void":
      return { result: "1", voidFactor: "1" };
    case "half_won":
      return { result: "1", voidFactor: "0.5" };
    case "half_lost":
      return { result: "0", voidFactor: "0.5" };
    default:
      throw new BadRequestError("unknown_result", `unknown result ${result}`);
  }
}

export default async function adminCustomEventsRoutes(app: FastifyInstance) {
  /** The Custom sport row. Seeded by the migration; 404 means someone deleted it. */
  async function customSport() {
    const [row] = await app.db
      .select({ id: sports.id, name: sports.name, slug: sports.slug })
      .from(sports)
      .where(eq(sports.slug, CUSTOM_SPORT_SLUG))
      .limit(1);
    if (!row) throw new NotFoundError();
    return row;
  }

  async function audit(
    tx: Parameters<Parameters<typeof app.db.transaction>[0]>[0],
    args: {
      adminId: string;
      action: string;
      targetType: string;
      targetId: string;
      before?: unknown;
      after?: unknown;
      ip?: string | null;
    },
  ) {
    await tx.insert(adminAuditLog).values({
      actorUserId: args.adminId,
      action: args.action,
      targetType: args.targetType,
      targetId: args.targetId,
      beforeJson: (args.before ?? null) as never,
      afterJson: (args.after ?? null) as never,
      ipInet: args.ip ?? null,
    });
  }

  /** Count open + settled tickets touching a market. Deletes are refused above zero. */
  async function ticketCountForMarkets(marketIds: bigint[]): Promise<number> {
    if (marketIds.length === 0) return 0;
    const [row] = await app.db
      .select({ n: sql<string>`COUNT(*)::text` })
      .from(ticketSelections)
      .where(inArray(ticketSelections.marketId, marketIds));
    return Number(row?.n ?? 0);
  }

  // ------------------------------------------------------------------
  // Structure: categories + tournaments under the Custom sport.
  // ------------------------------------------------------------------

  app.get("/admin/custom-events/structure", async (request) => {
    request.requireRole("admin");
    const sport = await customSport();
    const rows = await app.db
      .select({
        categoryId: categories.id,
        categoryName: categories.name,
        categorySlug: categories.slug,
        tournamentId: tournaments.id,
        tournamentName: tournaments.name,
        tournamentSlug: tournaments.slug,
        riskTier: tournaments.riskTier,
        eventCount: sql<string>`(
          SELECT COUNT(*)::text FROM ${matches} m
           WHERE m.tournament_id = ${tournaments.id}
        )`,
      })
      .from(categories)
      .leftJoin(tournaments, eq(tournaments.categoryId, categories.id))
      .where(eq(categories.sportId, sport.id))
      .orderBy(asc(categories.name), asc(tournaments.name));

    const byCategory = new Map<
      number,
      {
        id: number;
        name: string;
        slug: string;
        tournaments: Array<{
          id: number;
          name: string;
          slug: string;
          riskTier: number | null;
          eventCount: number;
        }>;
      }
    >();
    for (const r of rows) {
      let c = byCategory.get(r.categoryId);
      if (!c) {
        c = {
          id: r.categoryId,
          name: r.categoryName,
          slug: r.categorySlug,
          tournaments: [],
        };
        byCategory.set(r.categoryId, c);
      }
      if (r.tournamentId != null) {
        c.tournaments.push({
          id: r.tournamentId,
          name: r.tournamentName!,
          slug: r.tournamentSlug!,
          riskTier: r.riskTier,
          eventCount: Number(r.eventCount ?? 0),
        });
      }
    }
    return { sport, categories: Array.from(byCategory.values()) };
  });

  app.post("/admin/custom-events/categories", { config: writeRateLimit }, async (request) => {
    const admin = request.requireRole("admin");
    const body = z.object({ name: nameSchema }).parse(request.body);
    const sport = await customSport();
    const slug = slugify(body.name, `cat-${randomBytes(4).toString("hex")}`);

    let created: { id: number; name: string; slug: string } | null = null;
    await app.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(categories)
        .values({
          sportId: sport.id,
          providerUrn: `cu:category:${randomBytes(8).toString("hex")}`,
          slug,
          name: body.name,
        })
        .onConflictDoNothing()
        .returning({ id: categories.id, name: categories.name, slug: categories.slug });
      if (!row) {
        throw new BadRequestError(
          "category_exists",
          "A category with that name already exists here.",
        );
      }
      created = row;
      await audit(tx, {
        adminId: admin.id,
        action: "custom_event.category_create",
        targetType: "category",
        targetId: String(row.id),
        after: { name: row.name, slug: row.slug },
        ip: request.ip,
      });
    });
    return { category: created };
  });

  app.patch<{ Params: { id: string } }>(
    "/admin/custom-events/categories/:id",
    { config: writeRateLimit },
    async (request) => {
      const admin = request.requireRole("admin");
      const id = Number(request.params.id);
      if (!Number.isInteger(id) || id <= 0) throw new NotFoundError();
      const body = z.object({ name: nameSchema }).parse(request.body);
      const sport = await customSport();

      const [before] = await app.db
        .select({ id: categories.id, name: categories.name, sportId: categories.sportId })
        .from(categories)
        .where(eq(categories.id, id))
        .limit(1);
      // Scoped to the Custom sport on purpose: this endpoint must never
      // become a way to rename a feed category, which the ingester would
      // then overwrite on its next pass anyway.
      if (!before || before.sportId !== sport.id) throw new NotFoundError();

      await app.db.transaction(async (tx) => {
        await tx.update(categories).set({ name: body.name }).where(eq(categories.id, id));
        await audit(tx, {
          adminId: admin.id,
          action: "custom_event.category_rename",
          targetType: "category",
          targetId: String(id),
          before: { name: before.name },
          after: { name: body.name },
          ip: request.ip,
        });
      });
      return { category: { id, name: body.name } };
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/admin/custom-events/categories/:id",
    { config: writeRateLimit },
    async (request) => {
      const admin = request.requireRole("admin");
      const id = Number(request.params.id);
      if (!Number.isInteger(id) || id <= 0) throw new NotFoundError();
      const sport = await customSport();

      const [before] = await app.db
        .select({ id: categories.id, name: categories.name, sportId: categories.sportId })
        .from(categories)
        .where(eq(categories.id, id))
        .limit(1);
      if (!before || before.sportId !== sport.id) throw new NotFoundError();

      // Refused unless empty. Deleting a category CASCADES to its
      // tournaments, and `matches.tournament_id` carries no ON DELETE
      // action — so a category holding events would either fail at the
      // FK or, if that FK were ever relaxed, silently take real bettable
      // rows with it. Making the operator empty it first keeps the
      // decision explicit.
      const [held] = await app.db
        .select({ n: sql<string>`COUNT(*)::text` })
        .from(tournaments)
        .where(eq(tournaments.categoryId, id));
      if (Number(held?.n ?? 0) > 0) {
        throw new BadRequestError(
          "category_not_empty",
          "Delete or move the tournaments in this category first.",
        );
      }

      await app.db.transaction(async (tx) => {
        await tx.delete(categories).where(eq(categories.id, id));
        await audit(tx, {
          adminId: admin.id,
          action: "custom_event.category_delete",
          targetType: "category",
          targetId: String(id),
          before: { name: before.name },
          ip: request.ip,
        });
      });
      return { deleted: true };
    },
  );

  app.post("/admin/custom-events/tournaments", { config: writeRateLimit }, async (request) => {
    const admin = request.requireRole("admin");
    const body = z
      .object({ categoryId: z.number().int().positive(), name: nameSchema })
      .parse(request.body);
    const sport = await customSport();

    const [cat] = await app.db
      .select({ id: categories.id, sportId: categories.sportId })
      .from(categories)
      .where(eq(categories.id, body.categoryId))
      .limit(1);
    if (!cat || cat.sportId !== sport.id) throw new NotFoundError();

    let created: { id: number; name: string; slug: string } | null = null;
    await app.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(tournaments)
        .values({
          categoryId: body.categoryId,
          providerUrn: `cu:tournament:${randomBytes(8).toString("hex")}`,
          slug: slugify(body.name, `tour-${randomBytes(4).toString("hex")}`),
          name: body.name,
        })
        .returning({ id: tournaments.id, name: tournaments.name, slug: tournaments.slug });
      created = row!;
      await audit(tx, {
        adminId: admin.id,
        action: "custom_event.tournament_create",
        targetType: "tournament",
        targetId: String(row!.id),
        after: { name: row!.name, categoryId: body.categoryId },
        ip: request.ip,
      });
    });
    return { tournament: created };
  });

  app.patch<{ Params: { id: string } }>(
    "/admin/custom-events/tournaments/:id",
    { config: writeRateLimit },
    async (request) => {
      const admin = request.requireRole("admin");
      const id = Number(request.params.id);
      if (!Number.isInteger(id) || id <= 0) throw new NotFoundError();
      const body = z
        .object({
          name: nameSchema.optional(),
          categoryId: z.number().int().positive().optional(),
        })
        .parse(request.body);
      const sport = await customSport();

      const [before] = await app.db
        .select({
          id: tournaments.id,
          name: tournaments.name,
          categoryId: tournaments.categoryId,
          sportId: categories.sportId,
        })
        .from(tournaments)
        .innerJoin(categories, eq(categories.id, tournaments.categoryId))
        .where(eq(tournaments.id, id))
        .limit(1);
      if (!before || before.sportId !== sport.id) throw new NotFoundError();

      if (body.categoryId != null) {
        const [cat] = await app.db
          .select({ sportId: categories.sportId })
          .from(categories)
          .where(eq(categories.id, body.categoryId))
          .limit(1);
        if (!cat || cat.sportId !== sport.id) throw new NotFoundError();
      }

      await app.db.transaction(async (tx) => {
        await tx
          .update(tournaments)
          .set({
            ...(body.name != null ? { name: body.name } : {}),
            ...(body.categoryId != null ? { categoryId: body.categoryId } : {}),
          })
          .where(eq(tournaments.id, id));
        await audit(tx, {
          adminId: admin.id,
          action: "custom_event.tournament_update",
          targetType: "tournament",
          targetId: String(id),
          before: { name: before.name, categoryId: before.categoryId },
          after: body,
          ip: request.ip,
        });
      });
      return { tournament: { id, ...body } };
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/admin/custom-events/tournaments/:id",
    { config: writeRateLimit },
    async (request) => {
      const admin = request.requireRole("admin");
      const id = Number(request.params.id);
      if (!Number.isInteger(id) || id <= 0) throw new NotFoundError();
      const sport = await customSport();

      const [before] = await app.db
        .select({
          id: tournaments.id,
          name: tournaments.name,
          sportId: categories.sportId,
        })
        .from(tournaments)
        .innerJoin(categories, eq(categories.id, tournaments.categoryId))
        .where(eq(tournaments.id, id))
        .limit(1);
      if (!before || before.sportId !== sport.id) throw new NotFoundError();

      const [held] = await app.db
        .select({ n: sql<string>`COUNT(*)::text` })
        .from(matches)
        .where(eq(matches.tournamentId, id));
      if (Number(held?.n ?? 0) > 0) {
        throw new BadRequestError(
          "tournament_not_empty",
          "Delete the events in this tournament first.",
        );
      }

      await app.db.transaction(async (tx) => {
        await tx.delete(tournaments).where(eq(tournaments.id, id));
        await audit(tx, {
          adminId: admin.id,
          action: "custom_event.tournament_delete",
          targetType: "tournament",
          targetId: String(id),
          before: { name: before.name },
          ip: request.ip,
        });
      });
      return { deleted: true };
    },
  );

  // ------------------------------------------------------------------
  // Events.
  // ------------------------------------------------------------------

  app.get("/admin/custom-events/events", async (request) => {
    request.requireRole("admin");
    const q = z
      .object({
        tournamentId: z.coerce.number().int().positive().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(100),
      })
      .parse(request.query);
    const sport = await customSport();

    const rows = await app.db
      .select({
        id: matches.id,
        providerUrn: matches.providerUrn,
        homeTeam: matches.homeTeam,
        awayTeam: matches.awayTeam,
        scheduledAt: matches.scheduledAt,
        status: matches.status,
        tournamentId: tournaments.id,
        tournamentName: tournaments.name,
        categoryName: categories.name,
        riskTier: tournaments.riskTier,
        marketCount: sql<string>`(
          SELECT COUNT(*)::text FROM ${markets} mk
           WHERE mk.match_id = ${matches.id}
        )`,
      })
      .from(matches)
      .innerJoin(tournaments, eq(tournaments.id, matches.tournamentId))
      .innerJoin(categories, eq(categories.id, tournaments.categoryId))
      .where(
        and(
          eq(categories.sportId, sport.id),
          q.tournamentId ? eq(matches.tournamentId, q.tournamentId) : undefined,
        ),
      )
      .orderBy(desc(matches.scheduledAt), desc(matches.id))
      .limit(q.limit);

    return {
      events: rows.map((r) => ({
        id: r.id.toString(),
        providerUrn: r.providerUrn,
        homeTeam: r.homeTeam,
        awayTeam: r.awayTeam,
        scheduledAt: r.scheduledAt?.toISOString() ?? null,
        status: r.status,
        tournament: { id: r.tournamentId, name: r.tournamentName, riskTier: r.riskTier },
        categoryName: r.categoryName,
        marketCount: Number(r.marketCount ?? 0),
      })),
    };
  });

  app.post("/admin/custom-events/events", { config: writeRateLimit }, async (request) => {
    const admin = request.requireRole("admin");
    const body = eventBody.parse(request.body);
    const sport = await customSport();

    const [tour] = await app.db
      .select({ id: tournaments.id, sportId: categories.sportId })
      .from(tournaments)
      .innerJoin(categories, eq(categories.id, tournaments.categoryId))
      .where(eq(tournaments.id, body.tournamentId))
      .limit(1);
    if (!tour || tour.sportId !== sport.id) throw new NotFoundError();

    let created: { id: string; providerUrn: string } | null = null;
    await app.db.transaction(async (tx) => {
      // `provider_urn` is NOT NULL and UNIQUE, and we want it to read
      // `cu:match:<id>` for anyone grepping logs — so insert with a
      // throwaway unique value and rewrite it from the generated id in
      // the same transaction. Nobody outside this tx ever sees the
      // placeholder.
      const placeholder = `cu:match:tmp-${randomBytes(12).toString("hex")}`;
      const [row] = await tx
        .insert(matches)
        .values({
          tournamentId: body.tournamentId,
          providerUrn: placeholder,
          homeTeam: body.homeTeam,
          awayTeam: body.awayTeam,
          scheduledAt: body.scheduledAt ? new Date(body.scheduledAt) : null,
          bestOf: body.bestOf ?? null,
          status: "not_started",
        })
        .returning({ id: matches.id });
      const urn = `cu:match:${row!.id}`;
      await tx.update(matches).set({ providerUrn: urn }).where(eq(matches.id, row!.id));
      created = { id: row!.id.toString(), providerUrn: urn };
      await audit(tx, {
        adminId: admin.id,
        action: "custom_event.event_create",
        targetType: "match",
        targetId: row!.id.toString(),
        after: { ...body, providerUrn: urn },
        ip: request.ip,
      });
    });
    return { event: created };
  });

  app.get<{ Params: { id: string } }>(
    "/admin/custom-events/events/:id",
    async (request) => {
      request.requireRole("admin");
      const matchId = BigInt(request.params.id);
      const sport = await customSport();

      const [event] = await app.db
        .select({
          id: matches.id,
          providerUrn: matches.providerUrn,
          homeTeam: matches.homeTeam,
          awayTeam: matches.awayTeam,
          scheduledAt: matches.scheduledAt,
          status: matches.status,
          bestOf: matches.bestOf,
          tournamentId: tournaments.id,
          tournamentName: tournaments.name,
          riskTier: tournaments.riskTier,
          categoryName: categories.name,
          sportId: categories.sportId,
        })
        .from(matches)
        .innerJoin(tournaments, eq(tournaments.id, matches.tournamentId))
        .innerJoin(categories, eq(categories.id, tournaments.categoryId))
        .where(eq(matches.id, matchId))
        .limit(1);
      if (!event || event.sportId !== sport.id) throw new NotFoundError();

      const marketRows = await app.db
        .select({
          marketId: markets.id,
          name: markets.customName,
          status: markets.status,
          specifiersJson: markets.specifiersJson,
          overroundBp: customMarketConfig.overroundBp,
          liabilityTrading: customMarketConfig.liabilityTrading,
          liabilityStrengthBp: customMarketConfig.liabilityStrengthBp,
          liabilityMaxShiftBp: customMarketConfig.liabilityMaxShiftBp,
          liabilityPricedAt: customMarketConfig.liabilityPricedAt,
        })
        .from(markets)
        .innerJoin(customMarketConfig, eq(customMarketConfig.marketId, markets.id))
        .where(eq(markets.matchId, matchId))
        .orderBy(asc(markets.id));

      const marketIds = marketRows.map((m) => m.marketId);
      const [outcomeRows, baseRows] = await Promise.all([
        marketIds.length
          ? app.db
              .select({
                marketId: marketOutcomes.marketId,
                outcomeId: marketOutcomes.outcomeId,
                name: marketOutcomes.name,
                publishedOdds: marketOutcomes.publishedOdds,
                probability: marketOutcomes.probability,
                active: marketOutcomes.active,
                result: marketOutcomes.result,
              })
              .from(marketOutcomes)
              .where(inArray(marketOutcomes.marketId, marketIds))
          : Promise.resolve([]),
        marketIds.length
          ? app.db
              .select({
                marketId: customOutcomeConfig.marketId,
                outcomeId: customOutcomeConfig.outcomeId,
                baseProbability: customOutcomeConfig.baseProbability,
                sortOrder: customOutcomeConfig.sortOrder,
              })
              .from(customOutcomeConfig)
              .where(inArray(customOutcomeConfig.marketId, marketIds))
          : Promise.resolve([]),
      ]);

      // Exposure per market. Sequential rather than one query because a
      // custom event carries a handful of markets, and the per-market
      // helper is the same one the sweeper uses — one implementation of
      // "what do we owe here" beats a faster second copy.
      const exposureByMarket = new Map<string, Map<string, number>>();
      for (const id of marketIds) {
        exposureByMarket.set(id.toString(), await loadExposureByOutcome(app.db, id));
      }

      const baseByMarket = new Map<string, Map<string, { p: number; sort: number }>>();
      for (const b of baseRows) {
        const key = b.marketId.toString();
        const m = baseByMarket.get(key) ?? new Map();
        m.set(b.outcomeId, { p: Number(b.baseProbability), sort: b.sortOrder });
        baseByMarket.set(key, m);
      }

      const outcomesByMarket = new Map<string, typeof outcomeRows>();
      for (const o of outcomeRows) {
        const key = o.marketId.toString();
        const arr = outcomesByMarket.get(key) ?? [];
        arr.push(o);
        outcomesByMarket.set(key, arr);
      }

      return {
        event: {
          id: event.id.toString(),
          providerUrn: event.providerUrn,
          homeTeam: event.homeTeam,
          awayTeam: event.awayTeam,
          scheduledAt: event.scheduledAt?.toISOString() ?? null,
          status: event.status,
          bestOf: event.bestOf,
          tournament: {
            id: event.tournamentId,
            name: event.tournamentName,
            riskTier: event.riskTier,
          },
          categoryName: event.categoryName,
        },
        markets: marketRows.map((m) => {
          const key = m.marketId.toString();
          const base = baseByMarket.get(key) ?? new Map();
          const exposure = exposureByMarket.get(key) ?? new Map();
          const outs = (outcomesByMarket.get(key) ?? [])
            .slice()
            .sort(
              (a, b) =>
                (base.get(a.outcomeId)?.sort ?? 0) - (base.get(b.outcomeId)?.sort ?? 0) ||
                a.outcomeId.localeCompare(b.outcomeId),
            );
          const prices = outs
            .map((o) => Number(o.publishedOdds))
            .filter((v) => Number.isFinite(v) && v > 0);
          return {
            id: key,
            name: m.name,
            status: m.status,
            specifiers: canonical((m.specifiersJson ?? {}) as Record<string, string>),
            overroundBp: m.overroundBp,
            liabilityTrading: m.liabilityTrading,
            liabilityStrengthBp: m.liabilityStrengthBp,
            liabilityMaxShiftBp: m.liabilityMaxShiftBp,
            liabilityPricedAt: m.liabilityPricedAt?.toISOString() ?? null,
            /** What the operator actually shipped, rounding included. */
            bookKey: prices.length ? bookKey(prices) : null,
            outcomes: outs.map((o) => ({
              outcomeId: o.outcomeId,
              label: o.name,
              publishedOdds: o.publishedOdds,
              probability: o.probability,
              baseProbability: base.get(o.outcomeId)?.p ?? null,
              exposureMicro: String(Math.round(exposure.get(o.outcomeId) ?? 0)),
              active: o.active,
              result: o.result,
            })),
          };
        }),
      };
    },
  );

  app.patch<{ Params: { id: string } }>(
    "/admin/custom-events/events/:id",
    { config: writeRateLimit },
    async (request) => {
      const admin = request.requireRole("admin");
      const matchId = BigInt(request.params.id);
      const body = eventPatchBody.parse(request.body);
      const sport = await customSport();

      const [before] = await app.db
        .select({
          id: matches.id,
          homeTeam: matches.homeTeam,
          awayTeam: matches.awayTeam,
          scheduledAt: matches.scheduledAt,
          status: matches.status,
          sportId: categories.sportId,
        })
        .from(matches)
        .innerJoin(tournaments, eq(tournaments.id, matches.tournamentId))
        .innerJoin(categories, eq(categories.id, tournaments.categoryId))
        .where(eq(matches.id, matchId))
        .limit(1);
      if (!before || before.sportId !== sport.id) throw new NotFoundError();

      await app.db.transaction(async (tx) => {
        await tx
          .update(matches)
          .set({
            ...(body.homeTeam != null ? { homeTeam: body.homeTeam } : {}),
            ...(body.awayTeam != null ? { awayTeam: body.awayTeam } : {}),
            ...(body.tournamentId != null ? { tournamentId: body.tournamentId } : {}),
            ...(body.bestOf !== undefined ? { bestOf: body.bestOf } : {}),
            ...(body.scheduledAt !== undefined
              ? { scheduledAt: body.scheduledAt ? new Date(body.scheduledAt) : null }
              : {}),
            ...(body.status != null ? { status: body.status } : {}),
            updatedAt: new Date(),
          })
          .where(eq(matches.id, matchId));
        await audit(tx, {
          adminId: admin.id,
          action: "custom_event.event_update",
          targetType: "match",
          targetId: request.params.id,
          before: {
            homeTeam: before.homeTeam,
            awayTeam: before.awayTeam,
            status: before.status,
          },
          after: body,
          ip: request.ip,
        });
      });
      return { updated: true };
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/admin/custom-events/events/:id",
    { config: writeRateLimit },
    async (request) => {
      const admin = request.requireRole("admin");
      const matchId = BigInt(request.params.id);
      const sport = await customSport();

      const [before] = await app.db
        .select({
          id: matches.id,
          homeTeam: matches.homeTeam,
          awayTeam: matches.awayTeam,
          sportId: categories.sportId,
        })
        .from(matches)
        .innerJoin(tournaments, eq(tournaments.id, matches.tournamentId))
        .innerJoin(categories, eq(categories.id, tournaments.categoryId))
        .where(eq(matches.id, matchId))
        .limit(1);
      if (!before || before.sportId !== sport.id) throw new NotFoundError();

      const marketIds = (
        await app.db
          .select({ id: markets.id })
          .from(markets)
          .where(eq(markets.matchId, matchId))
      ).map((r) => r.id);

      // Never delete an event anyone has bet on. A ticket's leg points at
      // a market row, and settlement, bet history and community tickets
      // all read back through it — removing the row would strand real
      // money. Settle or cancel the markets instead.
      if ((await ticketCountForMarkets(marketIds)) > 0) {
        throw new BadRequestError(
          "event_has_bets",
          "This event has bets on it. Settle or cancel its markets instead of deleting it.",
        );
      }

      await app.db.transaction(async (tx) => {
        // markets → market_outcomes and the two custom_* tables all
        // cascade from here.
        await tx.delete(matches).where(eq(matches.id, matchId));
        await audit(tx, {
          adminId: admin.id,
          action: "custom_event.event_delete",
          targetType: "match",
          targetId: request.params.id,
          before: { homeTeam: before.homeTeam, awayTeam: before.awayTeam },
          ip: request.ip,
        });
      });
      return { deleted: true };
    },
  );

  // ------------------------------------------------------------------
  // Markets.
  // ------------------------------------------------------------------

  /** Assert a market id is a custom market and return its event. */
  async function requireCustomMarket(marketId: bigint) {
    const [row] = await app.db
      .select({
        marketId: markets.id,
        matchId: markets.matchId,
        providerMarketId: markets.providerMarketId,
        status: markets.status,
        name: markets.customName,
        specifiersJson: markets.specifiersJson,
        providerUrn: matches.providerUrn,
        sportId: categories.sportId,
      })
      .from(markets)
      .innerJoin(matches, eq(matches.id, markets.matchId))
      .innerJoin(tournaments, eq(tournaments.id, matches.tournamentId))
      .innerJoin(categories, eq(categories.id, tournaments.categoryId))
      .where(eq(markets.id, marketId))
      .limit(1);
    const sport = await customSport();
    if (
      !row ||
      row.sportId !== sport.id ||
      row.providerMarketId !== CUSTOM_PROVIDER_MARKET_ID
    ) {
      throw new NotFoundError();
    }
    return row;
  }

  app.post<{ Params: { id: string } }>(
    "/admin/custom-events/events/:id/markets",
    { config: writeRateLimit },
    async (request) => {
      const admin = request.requireRole("admin");
      const matchId = BigInt(request.params.id);
      const body = marketBody.parse(request.body);
      const sport = await customSport();

      const [event] = await app.db
        .select({ id: matches.id, sportId: categories.sportId })
        .from(matches)
        .innerJoin(tournaments, eq(tournaments.id, matches.tournamentId))
        .innerJoin(categories, eq(categories.id, tournaments.categoryId))
        .where(eq(matches.id, matchId))
        .limit(1);
      if (!event || event.sportId !== sport.id) throw new NotFoundError();

      // The specifier is what makes a SECOND market on this event
      // possible: identity is (match, provider_market_id, specifiers_hash)
      // and every custom market shares one provider_market_id.
      const key = randomBytes(6).toString("hex");
      const specs = customSpecifiers(key);
      const ids = outcomeIdsFor(body.outcomes.length);

      // Price before writing so an invalid book fails the request rather
      // than leaving a half-built market behind.
      const cells = priceCustomMarket({
        outcomes: body.outcomes.map((o, i) => ({
          outcomeId: ids[i]!,
          baseProbability: o.probability,
        })),
        overroundBp: body.overroundBp,
        liability: { enabled: false, strengthBp: 0, maxShiftBp: 0 },
      });

      let createdId = "";
      await app.db.transaction(async (tx) => {
        const [row] = await tx
          .insert(markets)
          .values({
            matchId,
            providerMarketId: CUSTOM_PROVIDER_MARKET_ID,
            specifiersJson: specs,
            specifiersHash: specifiersHash(specs),
            customName: body.name,
            // 1 = active. A market is created open; the operator can
            // suspend it from the same screen.
            status: 1,
          })
          .returning({ id: markets.id });
        const marketId = row!.id;
        createdId = marketId.toString();

        await tx.insert(marketOutcomes).values(
          body.outcomes.map((o, i) => ({
            marketId,
            outcomeId: ids[i]!,
            name: o.label,
            rawOdds: cells[i]!.rawOdds.toFixed(4),
            publishedOdds: cells[i]!.publishedOdds.toFixed(4),
            probability: cells[i]!.probability.toFixed(7),
            active: true,
          })),
        );
        await tx.insert(customMarketConfig).values({
          marketId,
          overroundBp: body.overroundBp,
          liabilityTrading: body.liabilityTrading,
          liabilityStrengthBp: body.liabilityStrengthBp,
          liabilityMaxShiftBp: body.liabilityMaxShiftBp,
        });
        await tx.insert(customOutcomeConfig).values(
          body.outcomes.map((o, i) => ({
            marketId,
            outcomeId: ids[i]!,
            baseProbability: cells[i]!.baseProbability.toFixed(7),
            sortOrder: i,
          })),
        );
        await audit(tx, {
          adminId: admin.id,
          action: "custom_event.market_create",
          targetType: "market",
          targetId: createdId,
          after: { matchId: matchId.toString(), name: body.name, specifiers: canonical(specs) },
          ip: request.ip,
        });
      });

      return { market: { id: createdId } };
    },
  );

  app.patch<{ Params: { id: string } }>(
    "/admin/custom-events/markets/:id",
    { config: writeRateLimit },
    async (request) => {
      const admin = request.requireRole("admin");
      const marketId = BigInt(request.params.id);
      const body = marketBody.parse(request.body);
      const market = await requireCustomMarket(marketId);

      const existing = await app.db
        .select({ outcomeId: marketOutcomes.outcomeId })
        .from(marketOutcomes)
        .where(eq(marketOutcomes.marketId, marketId));
      const existingIds = new Set(existing.map((e) => e.outcomeId));

      const supplied = body.outcomes.map((o) => o.outcomeId).filter(Boolean) as string[];
      const addsOrRemoves =
        supplied.length !== body.outcomes.length ||
        supplied.length !== existingIds.size ||
        supplied.some((id) => !existingIds.has(id));

      // Labels and probabilities can always be edited — repricing an open
      // market is the normal thing to do. Changing the SET of outcomes
      // cannot be, once bets exist: a ticket leg points at an
      // (market_id, outcome_id) pair, and removing one would leave a bet
      // on an outcome that no longer exists and can never settle.
      if (addsOrRemoves && (await ticketCountForMarkets([marketId])) > 0) {
        throw new BadRequestError(
          "market_has_bets",
          "This market has bets on it, so its outcomes can no longer be added or removed. Prices and labels can still be edited.",
        );
      }

      const ids = addsOrRemoves
        ? outcomeIdsFor(body.outcomes.length)
        : body.outcomes.map((o) => o.outcomeId!);

      await app.db.transaction(async (tx) => {
        await tx
          .update(markets)
          .set({ customName: body.name, updatedAt: new Date() })
          .where(eq(markets.id, marketId));
        await tx
          .update(customMarketConfig)
          .set({
            overroundBp: body.overroundBp,
            liabilityTrading: body.liabilityTrading,
            liabilityStrengthBp: body.liabilityStrengthBp,
            liabilityMaxShiftBp: body.liabilityMaxShiftBp,
            updatedAt: new Date(),
          })
          .where(eq(customMarketConfig.marketId, marketId));

        if (addsOrRemoves) {
          await tx.delete(marketOutcomes).where(eq(marketOutcomes.marketId, marketId));
          await tx
            .delete(customOutcomeConfig)
            .where(eq(customOutcomeConfig.marketId, marketId));
          await tx.insert(marketOutcomes).values(
            body.outcomes.map((o, i) => ({
              marketId,
              outcomeId: ids[i]!,
              name: o.label,
              active: true,
            })),
          );
        } else {
          for (const [i, o] of body.outcomes.entries()) {
            await tx
              .update(marketOutcomes)
              .set({ name: o.label })
              .where(
                and(
                  eq(marketOutcomes.marketId, marketId),
                  eq(marketOutcomes.outcomeId, ids[i]!),
                ),
              );
          }
          await tx
            .delete(customOutcomeConfig)
            .where(eq(customOutcomeConfig.marketId, marketId));
        }

        // Normalise here so the stored base probabilities always sum to
        // 1 — the repricing below reads them back and would otherwise
        // renormalise on every pass from a moving denominator.
        const total = body.outcomes.reduce((a, o) => a + o.probability, 0);
        await tx.insert(customOutcomeConfig).values(
          body.outcomes.map((o, i) => ({
            marketId,
            outcomeId: ids[i]!,
            baseProbability: (o.probability / total).toFixed(7),
            sortOrder: i,
          })),
        );

        await audit(tx, {
          adminId: admin.id,
          action: "custom_event.market_update",
          targetType: "market",
          targetId: request.params.id,
          before: { name: market.name },
          after: {
            name: body.name,
            overroundBp: body.overroundBp,
            liabilityTrading: body.liabilityTrading,
            outcomes: body.outcomes.length,
          },
          ip: request.ip,
        });
      });

      // One writer for prices — the same call the sweeper makes — so a
      // save and a liability pass can never disagree about the book.
      await repriceMarket(app, marketId);
      return { updated: true };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/admin/custom-events/markets/:id/status",
    { config: writeRateLimit },
    async (request) => {
      const admin = request.requireRole("admin");
      const marketId = BigInt(request.params.id);
      const body = z.object({ open: z.boolean() }).parse(request.body);
      const market = await requireCustomMarket(marketId);

      // Terminal markets are terminal. Re-opening a settled market would
      // put a decided outcome back on sale at a stale price — the exact
      // hazard CLAUDE.md invariant 9 exists to prevent for feed markets.
      if (market.status === -3 || market.status === -4) {
        throw new BadRequestError(
          "market_terminal",
          "This market is already settled or cancelled and cannot be reopened.",
        );
      }

      const status = body.open ? 1 : -1;
      await app.db.transaction(async (tx) => {
        await tx
          .update(markets)
          .set({ status, updatedAt: new Date() })
          .where(eq(markets.id, marketId));
        await audit(tx, {
          adminId: admin.id,
          action: body.open ? "custom_event.market_open" : "custom_event.market_suspend",
          targetType: "market",
          targetId: request.params.id,
          before: { status: market.status },
          after: { status },
          ip: request.ip,
        });
      });
      await publishMarketStatus(app, { matchId: market.matchId, marketId, status });
      return { status };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/admin/custom-events/markets/:id/settle",
    { config: writeRateLimit },
    async (request) => {
      const admin = request.requireRole("admin");
      const marketId = BigInt(request.params.id);
      const body = settleBody.parse(request.body);
      const market = await requireCustomMarket(marketId);

      const known = new Set(
        (
          await app.db
            .select({ outcomeId: marketOutcomes.outcomeId })
            .from(marketOutcomes)
            .where(eq(marketOutcomes.marketId, marketId))
        ).map((r) => r.outcomeId),
      );
      // Every outcome must be graded. A market settled with one missing
      // leaves any ticket on it stuck `accepted` forever — the stranded
      // shape /admin/unsettled exists to surface.
      const supplied = new Set(body.results.map((r) => r.outcomeId));
      if (supplied.size !== known.size || [...known].some((id) => !supplied.has(id))) {
        throw new BadRequestError(
          "results_incomplete",
          "Give a result for every outcome in this market.",
        );
      }

      // Settlement goes out on the provider-neutral Redis stream the
      // settlement service already consumes for Fonbet, so custom payouts
      // run through the same apply-once settler — market status, outcome
      // results, ticket settlement, wallet credits and the RiskZilla
      // liability release all happen there, exactly as for a feed market.
      const specs = (market.specifiersJson ?? {}) as Record<string, string>;
      const outcomes = body.results
        .slice()
        .sort((a, b) => a.outcomeId.localeCompare(b.outcomeId))
        .map((r) => {
          const w = wireResult(r.result);
          return { id: r.outcomeId, result: w.result, void_factor: w.voidFactor };
        });

      await app.redis.xadd(
        settlementStream(),
        "*",
        "type",
        "settle",
        "provider",
        "custom",
        "event_urn",
        market.providerUrn,
        "provider_market_id",
        String(CUSTOM_PROVIDER_MARKET_ID),
        "specifiers",
        canonical(specs),
        "ts",
        String(Date.now()),
        "outcomes",
        JSON.stringify(outcomes),
      );

      await app.db.transaction(async (tx) => {
        await audit(tx, {
          adminId: admin.id,
          action: "custom_event.market_settle",
          targetType: "market",
          targetId: request.params.id,
          after: { eventUrn: market.providerUrn, results: body.results },
          ip: request.ip,
        });
      });

      // The settler flips markets.status to -3 when it applies. Publishing
      // the lock now means open tabs stop offering the price immediately
      // rather than at the end of the stream round-trip.
      await publishMarketStatus(app, {
        matchId: market.matchId,
        marketId,
        status: -3,
      });
      return { queued: true };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/admin/custom-events/markets/:id/cancel",
    { config: writeRateLimit },
    async (request) => {
      const admin = request.requireRole("admin");
      const marketId = BigInt(request.params.id);
      const market = await requireCustomMarket(marketId);
      const specs = (market.specifiersJson ?? {}) as Record<string, string>;

      // Cancel refunds every stake on the market through the same settler
      // path a feed cancel takes.
      await app.redis.xadd(
        settlementStream(),
        "*",
        "type",
        "cancel",
        "provider",
        "custom",
        "event_urn",
        market.providerUrn,
        "provider_market_id",
        String(CUSTOM_PROVIDER_MARKET_ID),
        "specifiers",
        canonical(specs),
        "ts",
        String(Date.now()),
      );

      await app.db.transaction(async (tx) => {
        await audit(tx, {
          adminId: admin.id,
          action: "custom_event.market_cancel",
          targetType: "market",
          targetId: request.params.id,
          after: { eventUrn: market.providerUrn },
          ip: request.ip,
        });
      });
      await publishMarketStatus(app, {
        matchId: market.matchId,
        marketId,
        status: -4,
      });
      return { queued: true };
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/admin/custom-events/markets/:id",
    { config: writeRateLimit },
    async (request) => {
      const admin = request.requireRole("admin");
      const marketId = BigInt(request.params.id);
      const market = await requireCustomMarket(marketId);

      if ((await ticketCountForMarkets([marketId])) > 0) {
        throw new BadRequestError(
          "market_has_bets",
          "This market has bets on it. Settle or cancel it instead of deleting it.",
        );
      }

      await app.db.transaction(async (tx) => {
        await tx.delete(markets).where(eq(markets.id, marketId));
        await audit(tx, {
          adminId: admin.id,
          action: "custom_event.market_delete",
          targetType: "market",
          targetId: request.params.id,
          before: { name: market.name },
          ip: request.ip,
        });
      });
      await publishMarketStatus(app, {
        matchId: market.matchId,
        marketId,
        status: -1,
      });
      return { deleted: true };
    },
  );
}
