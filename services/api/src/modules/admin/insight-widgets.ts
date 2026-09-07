// /admin/insight-widgets — the operator surface for ZillaTips and
// ZillaFacts (migration 20260907T093356_insight_widget_rules).
//
// Until 2026-09-07 neither widget had one: no page, no route, no record
// anywhere a person would look of whether it was on. Turning one off meant
// editing code, and the stopgap that preceded this table was a pair of env
// vars needing a container recreate.
//
// One module for both widgets, keyed by `:widget` in the path, because the
// two carry exactly the same settings. Resolution lives in
// lib/insight-widgets.ts — this file only reads and writes rows, and every
// mutation lands in admin_audit_log.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, eq, sql, isNull } from "drizzle-orm";
import {
  adminAuditLog,
  insightWidgetRules,
  sports,
  categories,
  tournaments,
  INSIGHT_WIDGETS,
  type InsightWidget,
} from "@oddzilla/db";
import { BadRequestError, NotFoundError } from "../../lib/errors.js";
import { loadInsightCascades, isFullyDisabled } from "../../lib/insight-widgets.js";

// Writes are rare and operator-driven; this only stops a stuck UI loop.
const writeRateLimit = { rateLimit: { max: 60, timeWindow: "1 minute" } };

const widgetParam = z.object({ widget: z.enum(INSIGHT_WIDGETS) });

const SCOPES = ["global", "sport", "category", "tournament", "market"] as const;
type Scope = (typeof SCOPES)[number];

const ruleParams = z.object({
  widget: z.enum(INSIGHT_WIDGETS),
  scope: z.enum(SCOPES),
  // "global" for the global row, otherwise the numeric id of the ref.
  refId: z.string().min(1).max(32),
});

const ruleBody = z.object({ enabled: z.boolean() });

/**
 * The ref columns for a scope. `global` carries none — the partial unique
 * index on (widget) WHERE scope='global' is what keeps it a singleton.
 */
function ruleRef(scope: Scope, refId: string) {
  if (scope === "global") return {};
  const n = Number.parseInt(refId, 10);
  if (!Number.isInteger(n) || n <= 0) {
    throw new BadRequestError("invalid_ref_id", "invalid_ref_id");
  }
  switch (scope) {
    case "sport":
      return { sportId: n };
    case "category":
      return { categoryId: n };
    case "tournament":
      return { tournamentId: n };
    case "market":
      return { providerMarketId: n };
  }
}

function ruleWhere(widget: InsightWidget, scope: Scope, refId: string) {
  const base = and(eq(insightWidgetRules.widget, widget), eq(insightWidgetRules.scope, scope));
  if (scope === "global") return and(base, isNull(insightWidgetRules.sportId));
  const n = Number.parseInt(refId, 10);
  switch (scope) {
    case "sport":
      return and(base, eq(insightWidgetRules.sportId, n));
    case "category":
      return and(base, eq(insightWidgetRules.categoryId, n));
    case "tournament":
      return and(base, eq(insightWidgetRules.tournamentId, n));
    case "market":
      return and(base, eq(insightWidgetRules.providerMarketId, n));
  }
}

/**
 * Refuse a rule that points at nothing.
 *
 * A market rule is the exception: `provider_market_id` has no table to
 * check against (it is a market TYPE, and a valid one may simply not be
 * quoted right now), so any positive integer is accepted. That is
 * deliberate — an operator should be able to pre-configure a market kind
 * ahead of a competition that offers it.
 */
async function assertRefExists(app: FastifyInstance, scope: Scope, refId: string) {
  if (scope === "global" || scope === "market") return;
  const n = Number.parseInt(refId, 10);
  const table = scope === "sport" ? sports : scope === "category" ? categories : tournaments;
  const [row] = await app.db.select({ id: table.id }).from(table).where(eq(table.id, n)).limit(1);
  if (!row) throw new NotFoundError(`${scope}_not_found`, `${scope}_not_found`);
}

interface RuleDto {
  scope: Scope;
  refId: string;
  label: string;
  sublabel: string | null;
  enabled: boolean;
  updatedAt: string;
}

/** Hydrate rules with the names an operator recognises. */
async function listRules(app: FastifyInstance, widget: InsightWidget): Promise<RuleDto[]> {
  const rows = (await app.db.execute(sql`
    SELECT r.scope,
           r.sport_id, r.category_id, r.tournament_id, r.provider_market_id,
           r.enabled, r.updated_at,
           s.name  AS sport_name,
           c.name  AS category_name,  cs.name AS category_sport,
           t.name  AS tournament_name, tc.name AS tournament_category,
           md.name_template AS market_name
      FROM insight_widget_rules r
      LEFT JOIN sports s       ON s.id = r.sport_id
      LEFT JOIN categories c   ON c.id = r.category_id
      LEFT JOIN sports cs      ON cs.id = c.sport_id
      LEFT JOIN tournaments t  ON t.id = r.tournament_id
      LEFT JOIN categories tc  ON tc.id = t.category_id
      LEFT JOIN LATERAL (
        SELECT name_template FROM market_descriptions d
         WHERE d.provider_market_id = r.provider_market_id
           AND d.language = 'en'
         ORDER BY d.variant
         LIMIT 1
      ) md ON TRUE
     WHERE r.widget = ${widget}
     ORDER BY CASE r.scope
                WHEN 'global' THEN 0 WHEN 'sport' THEN 1 WHEN 'category' THEN 2
                WHEN 'tournament' THEN 3 ELSE 4 END,
              COALESCE(s.name, c.name, t.name, r.provider_market_id::text)
  `)) as unknown as Array<Record<string, unknown>>;

  return rows.map((r) => {
    const scope = r.scope as Scope;
    switch (scope) {
      case "sport":
        return dto(scope, String(r.sport_id), (r.sport_name as string) ?? "—", null, r);
      case "category":
        return dto(
          scope,
          String(r.category_id),
          (r.category_name as string) ?? "—",
          (r.category_sport as string) ?? null,
          r,
        );
      case "tournament":
        return dto(
          scope,
          String(r.tournament_id),
          (r.tournament_name as string) ?? "—",
          (r.tournament_category as string) ?? null,
          r,
        );
      case "market":
        return dto(
          scope,
          String(r.provider_market_id),
          (r.market_name as string) ?? `Market #${r.provider_market_id}`,
          `provider_market_id ${r.provider_market_id}`,
          r,
        );
      default:
        return dto(scope, "global", "Everywhere", null, r);
    }
  });
}

function dto(
  scope: Scope,
  refId: string,
  label: string,
  sublabel: string | null,
  r: Record<string, unknown>,
): RuleDto {
  return {
    scope,
    refId,
    label,
    sublabel,
    enabled: Boolean(r.enabled),
    updatedAt: (r.updated_at as Date).toISOString(),
  };
}

export default async function adminInsightWidgetsRoutes(app: FastifyInstance) {
  // Config for one widget: every rule plus the derived "is it off
  // everywhere" the page renders its red banner from.
  app.get("/admin/insight-widgets/:widget", async (request) => {
    request.requireRole("admin");
    const { widget } = widgetParam.parse(request.params);
    const [rules, cascades] = await Promise.all([
      listRules(app, widget),
      loadInsightCascades(app.db),
    ]);
    return {
      widget,
      fullyDisabled: isFullyDisabled(cascades[widget]),
      globalEnabled: cascades[widget].global ?? false,
      rules,
    };
  });

  app.put(
    "/admin/insight-widgets/:widget/rules/:scope/:refId",
    { config: writeRateLimit },
    async (request) => {
      const admin = request.requireRole("admin");
      const { widget, scope, refId } = ruleParams.parse(request.params);
      const { enabled } = ruleBody.parse(request.body);
      await assertRefExists(app, scope, refId);

      const [before] = await app.db
        .select()
        .from(insightWidgetRules)
        .where(ruleWhere(widget, scope, refId))
        .limit(1);

      await app.db.transaction(async (tx) => {
        if (before) {
          await tx
            .update(insightWidgetRules)
            .set({ enabled, updatedBy: admin.id, updatedAt: new Date() })
            .where(eq(insightWidgetRules.id, before.id));
        } else {
          await tx
            .insert(insightWidgetRules)
            .values({ widget, scope, ...ruleRef(scope, refId), enabled, updatedBy: admin.id });
        }
        await tx.insert(adminAuditLog).values({
          actorUserId: admin.id,
          action: before ? "insight_widget.rule_update" : "insight_widget.rule_create",
          targetType: "insight_widget_rules",
          targetId: `${widget}:${scope}:${refId}`,
          beforeJson: before ? { enabled: before.enabled } : null,
          afterJson: { widget, scope, refId, enabled },
          ipInet: request.ip ?? null,
        });
      });

      const cascades = await loadInsightCascades(app.db);
      return {
        widget,
        fullyDisabled: isFullyDisabled(cascades[widget]),
        globalEnabled: cascades[widget].global ?? false,
        rules: await listRules(app, widget),
      };
    },
  );

  app.delete(
    "/admin/insight-widgets/:widget/rules/:scope/:refId",
    { config: writeRateLimit },
    async (request) => {
      const admin = request.requireRole("admin");
      const { widget, scope, refId } = ruleParams.parse(request.params);
      // The global row is the cascade's floor — deleting it would make the
      // resolver fail closed with nothing on screen explaining why. Flip
      // it instead.
      if (scope === "global") {
        throw new BadRequestError("global_rule_not_removable", "global_rule_not_removable");
      }

      const [before] = await app.db
        .select()
        .from(insightWidgetRules)
        .where(ruleWhere(widget, scope, refId))
        .limit(1);
      if (!before) throw new NotFoundError("rule_not_found", "rule_not_found");

      await app.db.transaction(async (tx) => {
        await tx.delete(insightWidgetRules).where(eq(insightWidgetRules.id, before.id));
        await tx.insert(adminAuditLog).values({
          actorUserId: admin.id,
          action: "insight_widget.rule_delete",
          targetType: "insight_widget_rules",
          targetId: `${widget}:${scope}:${refId}`,
          beforeJson: { widget, scope, refId, enabled: before.enabled },
          afterJson: null,
          ipInet: request.ip ?? null,
        });
      });

      const cascades = await loadInsightCascades(app.db);
      return {
        widget,
        fullyDisabled: isFullyDisabled(cascades[widget]),
        globalEnabled: cascades[widget].global ?? false,
        rules: await listRules(app, widget),
      };
    },
  );

  // ── Pickers ─────────────────────────────────────────────────────────
  // Deliberately scoped downward (categories of a sport, tournaments of a
  // category): football alone carries ~200 country buckets, so a flat list
  // is unusable — the same reason /admin/tournaments scopes its filters.

  app.get("/admin/insight-widgets/options/sports", async (request) => {
    request.requireRole("admin");
    const rows = await app.db
      .select({ id: sports.id, name: sports.name, kind: sports.kind })
      .from(sports)
      .where(eq(sports.active, true))
      .orderBy(sports.name);
    return { sports: rows };
  });

  app.get("/admin/insight-widgets/options/categories", async (request) => {
    request.requireRole("admin");
    const { sportId } = z.object({ sportId: z.coerce.number().int() }).parse(request.query);
    const rows = await app.db
      .select({ id: categories.id, name: categories.name })
      .from(categories)
      .where(and(eq(categories.sportId, sportId), eq(categories.isDummy, false)))
      .orderBy(categories.name);
    return { categories: rows };
  });

  app.get("/admin/insight-widgets/options/tournaments", async (request) => {
    request.requireRole("admin");
    const q = z
      .object({
        sportId: z.coerce.number().int().optional(),
        categoryId: z.coerce.number().int().optional(),
      })
      .parse(request.query);
    if (q.sportId === undefined && q.categoryId === undefined) {
      throw new BadRequestError("scope_required", "scope_required");
    }
    const rows = await app.db
      .select({ id: tournaments.id, name: tournaments.name, categoryName: categories.name })
      .from(tournaments)
      .innerJoin(categories, eq(categories.id, tournaments.categoryId))
      .where(
        q.categoryId !== undefined
          ? eq(tournaments.categoryId, q.categoryId)
          : eq(categories.sportId, q.sportId!),
      )
      .orderBy(tournaments.name)
      .limit(500);
    return { tournaments: rows };
  });

  // Market TYPES currently quoted, optionally narrowed to one sport.
  // Bounded to markets on open matches: the whole markets table is ~17M
  // rows, and a picker wants what is on offer, not every id ever seen.
  app.get("/admin/insight-widgets/options/markets", async (request) => {
    request.requireRole("admin");
    const { sportId } = z
      .object({ sportId: z.coerce.number().int().optional() })
      .parse(request.query);
    const rows = (await app.db.execute(sql`
      SELECT mk.provider_market_id AS id,
             COALESCE(
               (SELECT d.name_template FROM market_descriptions d
                 WHERE d.provider_market_id = mk.provider_market_id
                   AND d.language = 'en'
                 ORDER BY d.variant LIMIT 1),
               'Market #' || mk.provider_market_id::text
             ) AS name,
             COUNT(*)::int AS markets
        FROM markets mk
        JOIN matches m ON m.id = mk.match_id
        JOIN tournaments t ON t.id = m.tournament_id
        JOIN categories c ON c.id = t.category_id
       WHERE m.status IN ('not_started', 'live')
         ${sportId === undefined ? sql`` : sql`AND c.sport_id = ${sportId}`}
       GROUP BY mk.provider_market_id
       ORDER BY COUNT(*) DESC
       LIMIT 300
    `)) as unknown as Array<{ id: number; name: string; markets: number }>;
    return { markets: rows };
  });
}
