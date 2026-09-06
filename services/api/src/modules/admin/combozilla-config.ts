// /admin/combozilla-config — operator control of the lobby's prebuilt
// 3-fold carousel (migration 20260906T015446_combozilla_config).
//
//   GET    /admin/combozilla-config
//            { config, rules, preview } — the singleton, every scope rule
//            hydrated with names, and what the policy admits right now
//            grouped by sport → tournament.
//   PUT    /admin/combozilla-config
//            replace the singleton (master switch, eligible tiers,
//            untiered, multi-card sports).
//   PUT    /admin/combozilla-config/rules/:scope/:refId   { mode }
//            upsert one allow / block rule on a sport, category or
//            tournament.
//   DELETE /admin/combozilla-config/rules/:scope/:refId
//            drop the rule; the scope falls back to its parent / the tier
//            default.
//
// Admin-only. Every mutation writes admin_audit_log and busts the
// anonymous pool cache so the lobby reflects the change on its next
// render rather than after the TTL. Eligibility itself is resolved in
// lib/combozilla.ts — this module never restates the policy.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import {
  adminAuditLog,
  categories,
  combozillaConfig,
  combozillaScopeRules,
  sports,
  tournaments,
  type CombozillaConfig,
  type CombozillaRuleMode,
  type CombozillaRuleScope,
  type CombozillaScopeRule,
} from "@oddzilla/db";
import type {
  ComboZillaConfigDto,
  ComboZillaPreviewDto,
  ComboZillaRuleDto,
} from "@oddzilla/types/combozilla";
import { BadRequestError, NotFoundError } from "../../lib/errors.js";
import {
  COMBOZILLA_POOL_CACHE_KEY,
  COMBOZILLA_SINGLETON_ID,
  loadComboZillaConfig,
  loadComboZillaPreview,
  loadComboZillaRules,
} from "../../lib/combozilla.js";

const writeRateLimit = { rateLimit: { max: 60, timeWindow: "1 minute" } };

const putBody = z.object({
  enabled: z.boolean(),
  eligibleRiskTiers: z.array(z.number().int().min(1).max(10)).max(10),
  allowUntiered: z.boolean(),
  // Slugs are validated against the sports table below, not just by
  // shape — a typo here would silently cap a sport at one card.
  multiCardSportSlugs: z
    .array(z.string().trim().min(1).max(64))
    .max(100),
});

const ruleParams = z.object({
  scope: z.enum(["sport", "category", "tournament"]),
  refId: z.coerce.number().int().positive(),
});

const ruleBody = z.object({
  mode: z.enum(["allow", "block"]),
});

function configToDto(row: CombozillaConfig): ComboZillaConfigDto {
  return {
    enabled: row.enabled,
    eligibleRiskTiers: [...row.eligibleRiskTiers].sort((a, b) => a - b),
    allowUntiered: row.allowUntiered,
    multiCardSportSlugs: [...row.multiCardSportSlugs],
    updatedAt: row.updatedAt.toISOString(),
    updatedBy: row.updatedBy,
  };
}

/**
 * Hydrate rules with the names they point at. Three queries, one per
 * scope, because each scope joins a different depth of the tree; a rule
 * whose target vanished between the select and the join simply drops
 * out (the FK cascade will have removed it anyway).
 */
async function hydrateRules(
  db: FastifyInstance["db"],
  rules: CombozillaScopeRule[],
): Promise<ComboZillaRuleDto[]> {
  const sportIds = rules.filter((r) => r.scope === "sport").map((r) => r.sportId!);
  const categoryIds = rules
    .filter((r) => r.scope === "category")
    .map((r) => r.categoryId!);
  const tournamentIds = rules
    .filter((r) => r.scope === "tournament")
    .map((r) => r.tournamentId!);

  const [sportRows, categoryRows, tournamentRows] = await Promise.all([
    sportIds.length
      ? db
          .select({ id: sports.id, slug: sports.slug, name: sports.name })
          .from(sports)
          .where(inArray(sports.id, sportIds))
      : Promise.resolve([]),
    categoryIds.length
      ? db
          .select({
            id: categories.id,
            name: categories.name,
            sportId: sports.id,
            sportSlug: sports.slug,
            sportName: sports.name,
          })
          .from(categories)
          .innerJoin(sports, eq(sports.id, categories.sportId))
          .where(inArray(categories.id, categoryIds))
      : Promise.resolve([]),
    tournamentIds.length
      ? db
          .select({
            id: tournaments.id,
            name: tournaments.name,
            riskTier: tournaments.riskTier,
            categoryId: categories.id,
            categoryName: categories.name,
            categoryIsDummy: categories.isDummy,
            sportId: sports.id,
            sportSlug: sports.slug,
            sportName: sports.name,
          })
          .from(tournaments)
          .innerJoin(categories, eq(categories.id, tournaments.categoryId))
          .innerJoin(sports, eq(sports.id, categories.sportId))
          .where(inArray(tournaments.id, tournamentIds))
      : Promise.resolve([]),
  ]);

  const sportById = new Map(sportRows.map((r) => [r.id, r]));
  const categoryById = new Map(categoryRows.map((r) => [r.id, r]));
  const tournamentById = new Map(tournamentRows.map((r) => [r.id, r]));

  const out: ComboZillaRuleDto[] = [];
  for (const r of rules) {
    const base = {
      id: r.id.toString(),
      scope: r.scope,
      mode: r.mode,
      updatedAt: r.updatedAt.toISOString(),
      updatedBy: r.updatedBy,
    };
    if (r.scope === "sport") {
      const s = sportById.get(r.sportId!);
      if (!s) continue;
      out.push({
        ...base,
        refId: s.id,
        name: s.name,
        sport: { id: s.id, slug: s.slug, name: s.name },
        category: null,
        riskTier: null,
      });
    } else if (r.scope === "category") {
      const c = categoryById.get(r.categoryId!);
      if (!c) continue;
      out.push({
        ...base,
        refId: c.id,
        name: c.name,
        sport: { id: c.sportId, slug: c.sportSlug, name: c.sportName },
        category: { id: c.id, name: c.name },
        riskTier: null,
      });
    } else {
      const t = tournamentById.get(r.tournamentId!);
      if (!t) continue;
      out.push({
        ...base,
        refId: t.id,
        name: t.name,
        sport: { id: t.sportId, slug: t.sportSlug, name: t.sportName },
        // Esports sit under one synthetic dummy category per sport; the
        // storefront draws no header for it, so neither does the rule.
        category: t.categoryIsDummy ? null : { id: t.categoryId, name: t.categoryName },
        riskTier: t.riskTier,
      });
    }
  }
  return out;
}

async function buildPreview(
  db: FastifyInstance["db"],
  cfg: CombozillaConfig,
  rules: CombozillaScopeRule[],
): Promise<ComboZillaPreviewDto> {
  if (!cfg.enabled) return { totalMatches: 0, sports: [] };
  const groups = await loadComboZillaPreview(db, cfg, rules);
  const bySport = new Map<number, ComboZillaPreviewDto["sports"][number]>();
  let total = 0;
  for (const g of groups) {
    total += g.matchCount;
    let s = bySport.get(g.sportId);
    if (!s) {
      s = { id: g.sportId, slug: g.sportSlug, name: g.sportName, matchCount: 0, tournaments: [] };
      bySport.set(g.sportId, s);
    }
    s.matchCount += g.matchCount;
    s.tournaments.push({
      id: g.tournamentId,
      name: g.tournamentName,
      categoryName: g.categoryName,
      riskTier: g.riskTier,
      matchCount: g.matchCount,
    });
  }
  return {
    totalMatches: total,
    sports: [...bySport.values()].sort((a, b) => b.matchCount - a.matchCount || a.name.localeCompare(b.name)),
  };
}

function ruleRef(scope: CombozillaRuleScope, refId: number) {
  return scope === "sport"
    ? { sportId: refId }
    : scope === "category"
      ? { categoryId: refId }
      : { tournamentId: refId };
}

function ruleWhere(scope: CombozillaRuleScope, refId: number) {
  return and(
    eq(combozillaScopeRules.scope, scope),
    scope === "sport"
      ? eq(combozillaScopeRules.sportId, refId)
      : scope === "category"
        ? eq(combozillaScopeRules.categoryId, refId)
        : eq(combozillaScopeRules.tournamentId, refId),
  );
}

/** Reject an id that points at nothing with a 404 instead of an FK 500. */
async function assertRefExists(
  db: FastifyInstance["db"],
  scope: CombozillaRuleScope,
  refId: number,
): Promise<void> {
  const [row] =
    scope === "sport"
      ? await db.select({ id: sports.id }).from(sports).where(eq(sports.id, refId)).limit(1)
      : scope === "category"
        ? await db
            .select({ id: categories.id })
            .from(categories)
            .where(eq(categories.id, refId))
            .limit(1)
        : await db
            .select({ id: tournaments.id })
            .from(tournaments)
            .where(eq(tournaments.id, refId))
            .limit(1);
  if (!row) throw new NotFoundError(`${scope}_not_found`, `${scope}_not_found`);
}

export default async function adminCombozillaConfigRoutes(app: FastifyInstance) {
  const bustPoolCache = () =>
    app.redis.del(COMBOZILLA_POOL_CACHE_KEY).catch(() => null);

  app.get("/admin/combozilla-config", async (request) => {
    request.requireRole("admin");
    const [cfg, rules] = await Promise.all([
      loadComboZillaConfig(app.db),
      loadComboZillaRules(app.db),
    ]);
    const [hydrated, preview] = await Promise.all([
      hydrateRules(app.db, rules),
      buildPreview(app.db, cfg, rules),
    ]);
    return { config: configToDto(cfg), rules: hydrated, preview };
  });

  app.put(
    "/admin/combozilla-config",
    { config: writeRateLimit },
    async (request) => {
      const admin = request.requireRole("admin");
      const body = putBody.parse(request.body);

      const tiers = Array.from(new Set(body.eligibleRiskTiers)).sort((a, b) => a - b);
      const slugs = Array.from(new Set(body.multiCardSportSlugs));
      if (slugs.length > 0) {
        const known = await app.db
          .select({ slug: sports.slug })
          .from(sports)
          .where(inArray(sports.slug, slugs));
        const knownSet = new Set(known.map((r) => r.slug));
        const unknown = slugs.filter((s) => !knownSet.has(s));
        if (unknown.length > 0) {
          throw new BadRequestError(
            "unknown_sport_slug",
            `unknown sport slug: ${unknown.join(", ")}`,
          );
        }
      }

      const before = await loadComboZillaConfig(app.db);
      const updated = await app.db.transaction(async (tx) => {
        const [row] = await tx
          .update(combozillaConfig)
          .set({
            enabled: body.enabled,
            eligibleRiskTiers: tiers,
            allowUntiered: body.allowUntiered,
            multiCardSportSlugs: slugs,
            updatedBy: admin.id,
            updatedAt: new Date(),
          })
          .where(eq(combozillaConfig.id, COMBOZILLA_SINGLETON_ID))
          .returning();
        if (!row) throw new Error("combozilla_config update returned no row");
        await tx.insert(adminAuditLog).values({
          actorUserId: admin.id,
          action: "combozilla_config.update",
          targetType: "combozilla_config",
          targetId: COMBOZILLA_SINGLETON_ID,
          beforeJson: configToDto(before) as unknown as Record<string, unknown>,
          afterJson: configToDto(row) as unknown as Record<string, unknown>,
          ipInet: request.ip ?? null,
        });
        return row;
      });
      await bustPoolCache();
      return configToDto(updated);
    },
  );

  app.put(
    "/admin/combozilla-config/rules/:scope/:refId",
    { config: writeRateLimit },
    async (request) => {
      const admin = request.requireRole("admin");
      const { scope, refId } = ruleParams.parse(request.params);
      const { mode } = ruleBody.parse(request.body) as { mode: CombozillaRuleMode };
      await assertRefExists(app.db, scope, refId);

      const [before] = await app.db
        .select()
        .from(combozillaScopeRules)
        .where(ruleWhere(scope, refId))
        .limit(1);

      const row = await app.db.transaction(async (tx) => {
        const [updated] = before
          ? await tx
              .update(combozillaScopeRules)
              .set({ mode, updatedBy: admin.id, updatedAt: new Date() })
              .where(eq(combozillaScopeRules.id, before.id))
              .returning()
          : await tx
              .insert(combozillaScopeRules)
              .values({ scope, ...ruleRef(scope, refId), mode, updatedBy: admin.id })
              .returning();
        if (!updated) throw new Error("combozilla rule upsert returned no row");
        await tx.insert(adminAuditLog).values({
          actorUserId: admin.id,
          action: before ? "combozilla.rule_update" : "combozilla.rule_create",
          targetType: "combozilla_scope_rules",
          targetId: `${scope}:${refId}`,
          beforeJson: before ? { mode: before.mode } : null,
          afterJson: { scope, refId, mode },
          ipInet: request.ip ?? null,
        });
        return updated;
      });
      await bustPoolCache();
      const [dto] = await hydrateRules(app.db, [row]);
      if (!dto) throw new NotFoundError(`${scope}_not_found`, `${scope}_not_found`);
      return dto;
    },
  );

  app.delete(
    "/admin/combozilla-config/rules/:scope/:refId",
    { config: writeRateLimit },
    async (request) => {
      const admin = request.requireRole("admin");
      const { scope, refId } = ruleParams.parse(request.params);

      const [before] = await app.db
        .select()
        .from(combozillaScopeRules)
        .where(ruleWhere(scope, refId))
        .limit(1);
      if (!before) throw new NotFoundError("rule_not_found", "rule_not_found");

      await app.db.transaction(async (tx) => {
        await tx.delete(combozillaScopeRules).where(eq(combozillaScopeRules.id, before.id));
        await tx.insert(adminAuditLog).values({
          actorUserId: admin.id,
          action: "combozilla.rule_delete",
          targetType: "combozilla_scope_rules",
          targetId: `${scope}:${refId}`,
          beforeJson: { scope, refId, mode: before.mode },
          afterJson: null,
          ipInet: request.ip ?? null,
        });
      });
      await bustPoolCache();
      return { ok: true };
    },
  );
}
