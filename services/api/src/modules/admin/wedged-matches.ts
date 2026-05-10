// /admin/wedged-matches endpoints. Admin-only.
//
// "Wedged" = a match in the DB at `status='not_started'` with active
// markets, whose `scheduled_at` is more than 1 h in the past. These are
// matches that should have transitioned to `live` by now but never did
// — typically because Oddin stopped streaming `odds_change` for them
// during a service outage (postgres dead, AMQP disconnected) and
// recovery didn't carry their terminal `sport_event_status`. The
// 2026-05-09 disk-full incident produced 33 of these.
//
// Surface area:
//   GET   /admin/wedged-matches               list
//   POST  /admin/wedged-matches/:id/refresh   re-fetch one from Oddin REST
//   POST  /admin/wedged-matches/refresh-all   queue all for refresh
//
// Refresh works by firing `pg_notify('fixture_refresh', urn)` which the
// feed-ingester's runFixtureRefreshListener picks up and calls
// `RefreshFromFixture`. The fixture body's `status` attribute carries
// Oddin's authoritative current state (`closed` / `cancelled` / `live`
// / `not_started`); `UpsertMatch` applies it via the SQL guard that
// rejects regressions. Feed-ingester has a per-URN 5 min cooldown.
//
// Belt-and-braces on top of the suspend-before-recover flush in
// services/feed-ingester/cmd/feed-ingester/main.go: most wedged rows
// should be cleared on the next AMQP reconnect, but this page lets
// the operator clean up immediately without restarting the feed.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { adminAuditLog } from "@oddzilla/db";
import { NotFoundError } from "../../lib/errors.js";

interface WedgedRow {
  matchId: string;
  providerUrn: string | null;
  homeTeam: string;
  awayTeam: string;
  scheduledAt: string;
  sportSlug: string;
  sportName: string;
  tournamentName: string;
  activeMarkets: number;
  lastFeedMessageAt: string | null;
  lastFeedMessageKind: string | null;
  lastFeedMessageRoutingKey: string | null;
}

// Window: matches scheduled between 7 days ago and 1 hour ago. The
// upper bound (1 h past) catches matches that "should have" started by
// now but didn't transition — a 1 h grace covers late kickoffs without
// flagging matches that started 5 min ago. The 7 day floor matches the
// `feed_messages` retention window so `lastFeedMessage*` always has a
// chance of resolving.
const wedgedWindow = sql`
  m.status = 'not_started'
  AND m.scheduled_at < NOW() - INTERVAL '1 hour'
  AND m.scheduled_at > NOW() - INTERVAL '7 days'
  AND EXISTS (
    SELECT 1 FROM markets mk
     WHERE mk.match_id = m.id AND mk.status = 1
  )
`;

const writeRateLimit = {
  rateLimit: { max: 30, timeWindow: "1 minute" },
};

export default async function adminWedgedMatchesRoutes(app: FastifyInstance) {
  // List wedged matches plus their last feed_message so operators can
  // see whether Oddin went silent before or after the scheduled start.
  app.get("/admin/wedged-matches", async (request) => {
    request.requireRole("admin");
    const rows = (await app.db.execute(sql`
      SELECT
        m.id::text                                            AS match_id,
        m.provider_urn                                        AS provider_urn,
        m.home_team                                           AS home_team,
        m.away_team                                           AS away_team,
        m.scheduled_at                                        AS scheduled_at,
        s.slug                                                AS sport_slug,
        s.name                                                AS sport_name,
        t.name                                                AS tournament_name,
        (SELECT COUNT(*) FROM markets mk
          WHERE mk.match_id = m.id AND mk.status = 1)::int    AS active_markets,
        fm.received_at                                        AS last_feed_message_at,
        fm.kind                                               AS last_feed_message_kind,
        fm.routing_key                                        AS last_feed_message_routing_key
      FROM matches m
      JOIN tournaments t ON t.id = m.tournament_id
      JOIN categories c  ON c.id = t.category_id
      JOIN sports s      ON s.id = c.sport_id
      LEFT JOIN LATERAL (
        SELECT received_at, kind, routing_key
          FROM feed_messages
         WHERE match_id = m.id
         ORDER BY received_at DESC
         LIMIT 1
      ) fm ON TRUE
      WHERE ${wedgedWindow}
      ORDER BY m.scheduled_at DESC
      LIMIT 500
    `)) as unknown as Array<{
      match_id: string;
      provider_urn: string | null;
      home_team: string;
      away_team: string;
      scheduled_at: Date | string;
      sport_slug: string;
      sport_name: string;
      tournament_name: string;
      active_markets: number;
      last_feed_message_at: Date | string | null;
      last_feed_message_kind: string | null;
      last_feed_message_routing_key: string | null;
    }>;
    const list: WedgedRow[] = rows.map((r) => ({
      matchId: r.match_id,
      providerUrn: r.provider_urn,
      homeTeam: r.home_team,
      awayTeam: r.away_team,
      scheduledAt:
        r.scheduled_at instanceof Date
          ? r.scheduled_at.toISOString()
          : String(r.scheduled_at),
      sportSlug: r.sport_slug,
      sportName: r.sport_name,
      tournamentName: r.tournament_name,
      activeMarkets: r.active_markets,
      lastFeedMessageAt: r.last_feed_message_at
        ? r.last_feed_message_at instanceof Date
          ? r.last_feed_message_at.toISOString()
          : String(r.last_feed_message_at)
        : null,
      lastFeedMessageKind: r.last_feed_message_kind,
      lastFeedMessageRoutingKey: r.last_feed_message_routing_key,
    }));
    return { matches: list };
  });

  // Refresh a single wedged match. Fires pg_notify('fixture_refresh',
  // urn) which the feed-ingester picks up and runs through
  // RefreshFromFixture — the fixture body's `status` attribute is the
  // authoritative source of truth. 404s on unknown match id.
  app.post(
    "/admin/wedged-matches/:id/refresh",
    { config: writeRateLimit },
    async (request) => {
      const admin = request.requireRole("admin");
      const params = z
        .object({ id: z.coerce.bigint() })
        .parse(request.params);
      const rows = (await app.db.execute(sql`
        SELECT id::text AS id, provider_urn
          FROM matches
         WHERE id = ${params.id}
         LIMIT 1
      `)) as unknown as Array<{ id: string; provider_urn: string | null }>;
      const match = rows[0];
      if (!match) {
        throw new NotFoundError("match_not_found", "match_not_found");
      }
      if (!match.provider_urn) {
        // A match without a provider URN is a placeholder row Oddin
        // never confirmed; nothing to refresh from. Surface clearly
        // rather than silently no-op.
        throw new NotFoundError(
          "no_provider_urn",
          "match has no provider_urn",
        );
      }
      await app.db.execute(
        sql`SELECT pg_notify('fixture_refresh', ${match.provider_urn})`,
      );
      await app.db.insert(adminAuditLog).values({
        actorUserId: admin.id,
        action: "wedged_match.refresh",
        targetType: "matches",
        targetId: match.id,
        beforeJson: null,
        afterJson: { providerUrn: match.provider_urn },
        ipInet: request.ip ?? null,
      });
      return { ok: true, providerUrn: match.provider_urn };
    },
  );

  // Refresh every currently-wedged match. Feed-ingester's per-URN
  // cooldown (5 min) absorbs the burst safely. Returns the URN count
  // queued so operators can verify.
  app.post(
    "/admin/wedged-matches/refresh-all",
    { config: writeRateLimit },
    async (request) => {
      const admin = request.requireRole("admin");
      const rows = (await app.db.execute(sql`
        SELECT m.provider_urn AS urn
          FROM matches m
         WHERE ${wedgedWindow}
           AND m.provider_urn IS NOT NULL
      `)) as unknown as Array<{ urn: string }>;
      const urns = rows.map((r) => r.urn);
      // pg_notify in a loop — each NOTIFY is its own statement. Could
      // collapse into a single SELECT pg_notify(...) FROM matches but
      // the loop keeps the log signal one-per-URN at the feed-ingester
      // side which is easier to debug.
      for (const urn of urns) {
        await app.db.execute(sql`SELECT pg_notify('fixture_refresh', ${urn})`);
      }
      await app.db.insert(adminAuditLog).values({
        actorUserId: admin.id,
        action: "wedged_match.refresh_all",
        targetType: "matches",
        targetId: `count:${urns.length}`,
        beforeJson: null,
        afterJson: { count: urns.length },
        ipInet: request.ip ?? null,
      });
      return { ok: true, count: urns.length };
    },
  );
}
