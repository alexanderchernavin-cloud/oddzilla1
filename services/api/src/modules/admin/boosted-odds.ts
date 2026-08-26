// /admin/boosted-odds — Custom Boosted Odds management (migration 0085).
//
// The backoffice renders the same sport → tournament → match → market
// hierarchy the storefront shows (plus a Teams branch per sport) and
// lets an operator attach a boost rule to any node: boost % (Netwinstable
// key delta, same math as ZillaFlash), optional end time, optional Min
// Risk Score (bettors below the threshold see standard prices).
//
// One rule per (scope, ref) — PUT upserts, DELETE removes. Every
// mutation writes admin_audit_log.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, asc, desc, eq, ilike, inArray, sql } from "drizzle-orm";
import {
  adminAuditLog,
  boostedOddsConfig,
  categories,
  competitorProfiles,
  competitors,
  marketDescriptions,
  markets,
  matches,
  playerProfiles,
  sports,
  tournaments,
} from "@oddzilla/db";
import { BadRequestError, NotFoundError } from "../../lib/errors.js";
import { substituteTemplate, type OutcomeProfiles } from "../../lib/market-naming.js";

interface RuleDto {
  id: string;
  scope: "sport" | "tournament" | "match" | "competitor" | "market";
  boostPct: number;
  endsAt: string | null;
  minRiskScore: number | null;
  updatedAt: string;
}

function toRuleDto(r: typeof boostedOddsConfig.$inferSelect): RuleDto {
  return {
    id: r.id,
    scope: r.scope,
    boostPct: Number(r.boostPct),
    endsAt: r.endsAt?.toISOString() ?? null,
    minRiskScore: r.minRiskScore !== null ? Number(r.minRiskScore) : null,
    updatedAt: r.updatedAt.toISOString(),
  };
}

const scopeSchema = z.enum(["sport", "tournament", "match", "competitor", "market"]);

const putBody = z.object({
  scope: scopeSchema,
  // sport/tournament/competitor ids are integers; match/market are
  // bigints — accept a digit string and coerce per scope below.
  refId: z.string().regex(/^\d+$/),
  boostPct: z.number().gt(0).max(50),
  endsAt: z.string().datetime({ offset: true }).nullable().optional(),
  minRiskScore: z.number().min(0.01).max(10).nullable().optional(),
});

function scopeColumn(scope: z.infer<typeof scopeSchema>) {
  switch (scope) {
    case "sport":
      return boostedOddsConfig.sportId;
    case "tournament":
      return boostedOddsConfig.tournamentId;
    case "match":
      return boostedOddsConfig.matchId;
    case "competitor":
      return boostedOddsConfig.competitorId;
    case "market":
      return boostedOddsConfig.marketId;
  }
}

export default async function adminBoostedOddsRoutes(app: FastifyInstance) {
  // ── Active rules overview ──────────────────────────────────────────
  // Flat list of every rule with a human label per scope — powers the
  // summary table above the tree.
  app.get("/admin/boosted-odds/rules", async (request) => {
    request.requireRole("admin");
    const rows = await app.db
      .select()
      .from(boostedOddsConfig)
      .orderBy(desc(boostedOddsConfig.updatedAt));

    // Batch label lookups per scope.
    const sportIds = rows.filter((r) => r.scope === "sport").map((r) => r.sportId!);
    const tournamentIds = rows
      .filter((r) => r.scope === "tournament")
      .map((r) => r.tournamentId!);
    const matchIds = rows.filter((r) => r.scope === "match").map((r) => r.matchId!);
    const competitorIds = rows
      .filter((r) => r.scope === "competitor")
      .map((r) => r.competitorId!);
    const marketIds = rows.filter((r) => r.scope === "market").map((r) => r.marketId!);

    const [sportRows, tournamentRows, matchRows, competitorRows, marketRows] =
      await Promise.all([
        sportIds.length
          ? app.db
              .select({ id: sports.id, name: sports.name })
              .from(sports)
              .where(inArray(sports.id, sportIds))
          : [],
        tournamentIds.length
          ? app.db
              .select({ id: tournaments.id, name: tournaments.name })
              .from(tournaments)
              .where(inArray(tournaments.id, tournamentIds))
          : [],
        matchIds.length
          ? app.db
              .select({
                id: matches.id,
                homeTeam: matches.homeTeam,
                awayTeam: matches.awayTeam,
              })
              .from(matches)
              .where(inArray(matches.id, matchIds))
          : [],
        competitorIds.length
          ? app.db
              .select({ id: competitors.id, name: competitors.name })
              .from(competitors)
              .where(inArray(competitors.id, competitorIds))
          : [],
        marketIds.length
          ? app.db
              .select({
                id: markets.id,
                providerMarketId: markets.providerMarketId,
                homeTeam: matches.homeTeam,
                awayTeam: matches.awayTeam,
              })
              .from(markets)
              .innerJoin(matches, eq(matches.id, markets.matchId))
              .where(inArray(markets.id, marketIds))
          : [],
      ]);
    const sportName = new Map(sportRows.map((r) => [r.id, r.name]));
    const tournamentName = new Map(tournamentRows.map((r) => [r.id, r.name]));
    const matchName = new Map(
      matchRows.map((r) => [r.id.toString(), `${r.homeTeam} vs ${r.awayTeam}`]),
    );
    const competitorName = new Map(competitorRows.map((r) => [r.id, r.name]));
    const marketName = new Map(
      marketRows.map((r) => [
        r.id.toString(),
        `Market #${r.providerMarketId} — ${r.homeTeam} vs ${r.awayTeam}`,
      ]),
    );

    return {
      rules: rows.map((r) => ({
        ...toRuleDto(r),
        refId:
          r.scope === "sport"
            ? String(r.sportId)
            : r.scope === "tournament"
              ? String(r.tournamentId)
              : r.scope === "match"
                ? r.matchId!.toString()
                : r.scope === "competitor"
                  ? String(r.competitorId)
                  : r.marketId!.toString(),
        label:
          r.scope === "sport"
            ? (sportName.get(r.sportId!) ?? `Sport #${r.sportId}`)
            : r.scope === "tournament"
              ? (tournamentName.get(r.tournamentId!) ?? `Tournament #${r.tournamentId}`)
              : r.scope === "match"
                ? (matchName.get(r.matchId!.toString()) ?? `Match #${r.matchId}`)
                : r.scope === "competitor"
                  ? (competitorName.get(r.competitorId!) ?? `Team #${r.competitorId}`)
                  : (marketName.get(r.marketId!.toString()) ?? `Market row #${r.marketId}`),
      })),
    };
  });

  // ── Tree: sports ───────────────────────────────────────────────────
  app.get("/admin/boosted-odds/sports", async (request) => {
    request.requireRole("admin");
    const rows = await app.db
      .select({
        id: sports.id,
        slug: sports.slug,
        name: sports.name,
        ruleRow: boostedOddsConfig,
      })
      .from(sports)
      .leftJoin(
        boostedOddsConfig,
        and(
          eq(boostedOddsConfig.scope, "sport"),
          eq(boostedOddsConfig.sportId, sports.id),
        ),
      )
      .where(eq(sports.active, true))
      .orderBy(asc(sports.name));
    return {
      entries: rows.map((r) => ({
        id: r.id,
        slug: r.slug,
        name: r.name,
        rule: r.ruleRow ? toRuleDto(r.ruleRow) : null,
      })),
    };
  });

  // ── Tree: tournaments under a sport ────────────────────────────────
  app.get("/admin/boosted-odds/sports/:sportId/tournaments", async (request) => {
    request.requireRole("admin");
    const { sportId } = z
      .object({ sportId: z.coerce.number().int().positive() })
      .parse(request.params);
    const rows = await app.db
      .select({
        id: tournaments.id,
        name: tournaments.name,
        riskTier: tournaments.riskTier,
        startAt: tournaments.startAt,
        endAt: tournaments.endAt,
        ruleRow: boostedOddsConfig,
      })
      .from(tournaments)
      .innerJoin(categories, eq(categories.id, tournaments.categoryId))
      .leftJoin(
        boostedOddsConfig,
        and(
          eq(boostedOddsConfig.scope, "tournament"),
          eq(boostedOddsConfig.tournamentId, tournaments.id),
        ),
      )
      .where(and(eq(categories.sportId, sportId), eq(tournaments.active, true)))
      .orderBy(asc(tournaments.name));
    return {
      entries: rows.map((r) => ({
        id: r.id,
        name: r.name,
        riskTier: r.riskTier,
        startAt: r.startAt?.toISOString() ?? null,
        endAt: r.endAt?.toISOString() ?? null,
        rule: r.ruleRow ? toRuleDto(r.ruleRow) : null,
      })),
    };
  });

  // ── Tree: teams under a sport ──────────────────────────────────────
  app.get("/admin/boosted-odds/sports/:sportId/teams", async (request) => {
    request.requireRole("admin");
    const { sportId } = z
      .object({ sportId: z.coerce.number().int().positive() })
      .parse(request.params);
    const { q } = z
      .object({ q: z.string().trim().max(80).optional() })
      .parse(request.query);
    const conds = [eq(competitors.sportId, sportId)];
    if (q && q.length > 0) {
      conds.push(ilike(competitors.name, `%${q.replaceAll("%", "\\%")}%`));
    }
    const rows = await app.db
      .select({
        id: competitors.id,
        name: competitors.name,
        abbreviation: competitors.abbreviation,
        ruleRow: boostedOddsConfig,
      })
      .from(competitors)
      .leftJoin(
        boostedOddsConfig,
        and(
          eq(boostedOddsConfig.scope, "competitor"),
          eq(boostedOddsConfig.competitorId, competitors.id),
        ),
      )
      .where(and(...conds))
      // Teams with a rule sort first so existing boosts are visible
      // without paging through the whole roster.
      .orderBy(sql`${boostedOddsConfig.id} IS NULL`, asc(competitors.name))
      .limit(300);
    return {
      entries: rows.map((r) => ({
        id: r.id,
        name: r.name,
        abbreviation: r.abbreviation,
        rule: r.ruleRow ? toRuleDto(r.ruleRow) : null,
      })),
    };
  });

  // ── Tree: matches under a tournament ───────────────────────────────
  app.get(
    "/admin/boosted-odds/tournaments/:tournamentId/matches",
    async (request) => {
      request.requireRole("admin");
      const { tournamentId } = z
        .object({ tournamentId: z.coerce.number().int().positive() })
        .parse(request.params);
      const rows = await app.db
        .select({
          id: matches.id,
          homeTeam: matches.homeTeam,
          awayTeam: matches.awayTeam,
          scheduledAt: matches.scheduledAt,
          status: matches.status,
          ruleRow: boostedOddsConfig,
        })
        .from(matches)
        .leftJoin(
          boostedOddsConfig,
          and(
            eq(boostedOddsConfig.scope, "match"),
            eq(boostedOddsConfig.matchId, matches.id),
          ),
        )
        .where(
          and(
            eq(matches.tournamentId, tournamentId),
            inArray(matches.status, ["not_started", "live"]),
          ),
        )
        .orderBy(asc(matches.scheduledAt))
        .limit(300);
      return {
        entries: rows.map((r) => ({
          id: r.id.toString(),
          homeTeam: r.homeTeam,
          awayTeam: r.awayTeam,
          scheduledAt: r.scheduledAt?.toISOString() ?? null,
          status: r.status,
          rule: r.ruleRow ? toRuleDto(r.ruleRow) : null,
        })),
      };
    },
  );

  // ── Tree: markets under a match ────────────────────────────────────
  // Labels resolve through the same market_descriptions templates the
  // storefront uses (English, teams substituted, URN specifier values
  // resolved through the profile tables) so the operator sees "Map 2
  // winner", not "Market #4".
  app.get("/admin/boosted-odds/matches/:matchId/markets", async (request) => {
    request.requireRole("admin");
    const { matchId } = z
      .object({ matchId: z.coerce.bigint() })
      .parse(request.params);

    const [match] = await app.db
      .select({
        id: matches.id,
        homeTeam: matches.homeTeam,
        awayTeam: matches.awayTeam,
      })
      .from(matches)
      .where(eq(matches.id, matchId))
      .limit(1);
    if (!match) throw new NotFoundError("match_not_found", "match_not_found");

    const marketRows = await app.db
      .select({
        id: markets.id,
        providerMarketId: markets.providerMarketId,
        specifiersJson: markets.specifiersJson,
        status: markets.status,
        ruleRow: boostedOddsConfig,
      })
      .from(markets)
      .leftJoin(
        boostedOddsConfig,
        and(
          eq(boostedOddsConfig.scope, "market"),
          eq(boostedOddsConfig.marketId, markets.id),
        ),
      )
      .where(and(eq(markets.matchId, matchId), eq(markets.status, 1)))
      .orderBy(asc(markets.providerMarketId), asc(markets.id));

    const providerIds = Array.from(
      new Set(marketRows.map((m) => m.providerMarketId)),
    );
    const descRows = providerIds.length
      ? await app.db
          .select({
            providerMarketId: marketDescriptions.providerMarketId,
            variant: marketDescriptions.variant,
            nameTemplate: marketDescriptions.nameTemplate,
          })
          .from(marketDescriptions)
          .where(
            and(
              inArray(marketDescriptions.providerMarketId, providerIds),
              eq(marketDescriptions.language, "en"),
            ),
          )
      : [];
    const descMap = new Map<string, string>();
    for (const d of descRows) {
      descMap.set(`${d.providerMarketId}:${d.variant}`, d.nameTemplate);
    }

    // Player / competitor URNs inside specifier values ({entity} slots).
    const competitorUrns = new Set<string>();
    const playerUrns = new Set<string>();
    for (const m of marketRows) {
      const specs = (m.specifiersJson ?? {}) as Record<string, string>;
      for (const v of Object.values(specs)) {
        if (typeof v !== "string") continue;
        if (v.startsWith("od:competitor:")) competitorUrns.add(v);
        else if (v.startsWith("od:player:")) playerUrns.add(v);
      }
    }
    const [competitorProfileRows, playerProfileRows] = await Promise.all([
      competitorUrns.size
        ? app.db
            .select({ urn: competitorProfiles.urn, name: competitorProfiles.name })
            .from(competitorProfiles)
            .where(inArray(competitorProfiles.urn, Array.from(competitorUrns)))
        : [],
      playerUrns.size
        ? app.db
            .select({ urn: playerProfiles.urn, name: playerProfiles.name })
            .from(playerProfiles)
            .where(inArray(playerProfiles.urn, Array.from(playerUrns)))
        : [],
    ]);
    const profiles: OutcomeProfiles = {
      competitors: new Map(competitorProfileRows.map((r) => [r.urn, r.name])),
      players: new Map(playerProfileRows.map((r) => [r.urn, r.name])),
    };
    const teams = { homeTeam: match.homeTeam, awayTeam: match.awayTeam };

    return {
      match: {
        id: match.id.toString(),
        homeTeam: match.homeTeam,
        awayTeam: match.awayTeam,
      },
      entries: marketRows.map((m) => {
        const specs = (m.specifiersJson ?? {}) as Record<string, string>;
        const variant = typeof specs.variant === "string" ? specs.variant : "";
        const template =
          descMap.get(`${m.providerMarketId}:${variant}`) ??
          descMap.get(`${m.providerMarketId}:`) ??
          `Market #${m.providerMarketId}`;
        return {
          id: m.id.toString(),
          providerMarketId: m.providerMarketId,
          label: substituteTemplate(template, specs, teams, profiles),
          rule: m.ruleRow ? toRuleDto(m.ruleRow) : null,
        };
      }),
    };
  });

  // ── Upsert a rule ──────────────────────────────────────────────────
  app.put("/admin/boosted-odds/rules", async (request) => {
    const admin = request.requireRole("admin");
    const body = putBody.parse(request.body);
    const endsAt = body.endsAt ? new Date(body.endsAt) : null;
    if (endsAt && endsAt.getTime() <= Date.now()) {
      throw new BadRequestError("ends_at_in_past", "ends_at_in_past");
    }

    // Verify the referenced entity exists — clearer 404 than an FK 500.
    const refIdInt = Number.parseInt(body.refId, 10);
    const refIdBig = BigInt(body.refId);
    const exists = async (): Promise<boolean> => {
      switch (body.scope) {
        case "sport": {
          const [r] = await app.db
            .select({ id: sports.id })
            .from(sports)
            .where(eq(sports.id, refIdInt))
            .limit(1);
          return !!r;
        }
        case "tournament": {
          const [r] = await app.db
            .select({ id: tournaments.id })
            .from(tournaments)
            .where(eq(tournaments.id, refIdInt))
            .limit(1);
          return !!r;
        }
        case "match": {
          const [r] = await app.db
            .select({ id: matches.id })
            .from(matches)
            .where(eq(matches.id, refIdBig))
            .limit(1);
          return !!r;
        }
        case "competitor": {
          const [r] = await app.db
            .select({ id: competitors.id })
            .from(competitors)
            .where(eq(competitors.id, refIdInt))
            .limit(1);
          return !!r;
        }
        case "market": {
          const [r] = await app.db
            .select({ id: markets.id })
            .from(markets)
            .where(eq(markets.id, refIdBig))
            .limit(1);
          return !!r;
        }
      }
    };
    if (!(await exists())) {
      throw new NotFoundError("ref_not_found", "ref_not_found");
    }

    const col = scopeColumn(body.scope);
    const refValue: number | bigint =
      body.scope === "match" || body.scope === "market" ? refIdBig : refIdInt;

    const result = await app.db.transaction(async (tx) => {
      const [before] = await tx
        .select()
        .from(boostedOddsConfig)
        .where(and(eq(boostedOddsConfig.scope, body.scope), eq(col, refValue as never)))
        .limit(1);
      const values = {
        boostPct: body.boostPct.toFixed(2),
        endsAt,
        minRiskScore:
          body.minRiskScore != null ? body.minRiskScore.toFixed(3) : null,
        updatedBy: admin.id,
        updatedAt: new Date(),
      };
      const [row] = before
        ? await tx
            .update(boostedOddsConfig)
            .set(values)
            .where(eq(boostedOddsConfig.id, before.id))
            .returning()
        : await tx
            .insert(boostedOddsConfig)
            .values({
              scope: body.scope,
              sportId: body.scope === "sport" ? refIdInt : null,
              tournamentId: body.scope === "tournament" ? refIdInt : null,
              matchId: body.scope === "match" ? refIdBig : null,
              competitorId: body.scope === "competitor" ? refIdInt : null,
              marketId: body.scope === "market" ? refIdBig : null,
              ...values,
            })
            .returning();
      if (!row) throw new Error("boosted odds upsert returned no row");
      await tx.insert(adminAuditLog).values({
        actorUserId: admin.id,
        action: before ? "boosted_odds.rule_update" : "boosted_odds.rule_create",
        targetType: "boosted_odds_config",
        targetId: `${body.scope}:${body.refId}`,
        beforeJson: before
          ? (toRuleDto(before) as unknown as Record<string, unknown>)
          : null,
        afterJson: toRuleDto(row) as unknown as Record<string, unknown>,
        ipInet: request.ip ?? null,
      });
      return row;
    });

    return { rule: toRuleDto(result) };
  });

  // ── Delete a rule ──────────────────────────────────────────────────
  app.delete("/admin/boosted-odds/rules/:id", async (request) => {
    const admin = request.requireRole("admin");
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    await app.db.transaction(async (tx) => {
      const [before] = await tx
        .select()
        .from(boostedOddsConfig)
        .where(eq(boostedOddsConfig.id, id))
        .limit(1);
      if (!before) throw new NotFoundError("rule_not_found", "rule_not_found");
      await tx.delete(boostedOddsConfig).where(eq(boostedOddsConfig.id, id));
      await tx.insert(adminAuditLog).values({
        actorUserId: admin.id,
        action: "boosted_odds.rule_delete",
        targetType: "boosted_odds_config",
        targetId: id,
        beforeJson: toRuleDto(before) as unknown as Record<string, unknown>,
        afterJson: null,
        ipInet: request.ip ?? null,
      });
    });
    return { ok: true };
  });
}
