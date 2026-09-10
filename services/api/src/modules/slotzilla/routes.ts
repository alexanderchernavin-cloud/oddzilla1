// SlotZilla — bettor-facing routes for the 15-second live-basketball
// slot (docs/SLOTZILLA.md).
//
//   GET  /slotzilla/live                      the games running now
//   GET  /slotzilla/games                     every covered fixture: live first,
//                                            then the day's kickoffs (the
//                                            /slotzilla section's selector)
//   GET  /slotzilla/matches/:matchId          the state a match page renders
//   POST /slotzilla/matches/:matchId/spins    place a spin
//   GET  /slotzilla/me/spins                  the bettor's history
//
// There is deliberately no cancel: a spin's windows are set the moment
// it is accepted, and withdrawing it once the clock has shown the first
// reel would be a free look.
//
// The rules and the wire types are @oddzilla/types/slotzilla; the money
// path is lib/slotzilla/service.ts. Frames: the Go service publishes
// `slotzilla_state` on `odds:match:{id}`; placement publishes
// `slotzilla_spin` on `user:{id}` after commit.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import {
  categories,
  matchSportradarIds,
  matches,
  slotzillaGames,
  sports,
  tournaments,
} from "@oddzilla/db";
import type { SlotzillaLiveGame } from "@oddzilla/types/slotzilla";
import { cached } from "../../lib/cache.js";
import {
  buildGameState,
  clockView,
  loadSpinPage,
  placeSpin,
  SR_BASKETBALL_SPORT_ID,
  spinToView,
} from "../../lib/slotzilla/service.js";

const LIVE_CACHE_KEY = "slotzilla:live:v1";
const LIVE_CACHE_TTL_SECONDS = 3;
const GAMES_CACHE_KEY = "slotzilla:games:v1";
const GAMES_CACHE_TTL_SECONDS = 5;

const matchParams = z.object({ matchId: z.coerce.bigint() });

const spinBody = z.object({
  currency: z.string().min(1).max(4),
  // Decimal string of micro units; the service parses it to bigint.
  stakeMicro: z.string().regex(/^\d{1,20}$/u),
  idempotencyKey: z.string().min(8).max(128),
  autoplay: z.boolean().optional(),
});

const historyQuery = z.object({
  cursor: z.string().max(256).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

function scoreOf(liveScore: unknown): { home: number | null; away: number | null } {
  if (typeof liveScore !== "object" || liveScore === null) return { home: null, away: null };
  const s = liveScore as { home?: unknown; away?: unknown };
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return { home: num(s.home), away: num(s.away) };
}

export default async function slotzillaRoutes(app: FastifyInstance) {
  // ── Live list ─────────────────────────────────────────────────────────
  app.get(
    "/slotzilla/live",
    { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
    async () => {
      const load = async (): Promise<{ games: SlotzillaLiveGame[] }> => {
        const rows = await app.db
          .select({
            matchId: slotzillaGames.matchId,
            srMatchId: slotzillaGames.srMatchId,
            status: slotzillaGames.status,
            coverageLevel: slotzillaGames.coverageLevel,
            clockSeconds: slotzillaGames.clockSeconds,
            clockRunning: slotzillaGames.clockRunning,
            clockPeriod: slotzillaGames.clockPeriod,
            clockReadAt: slotzillaGames.clockReadAt,
            homeTeam: matches.homeTeam,
            awayTeam: matches.awayTeam,
            liveScore: matches.liveScore,
            scheduledAt: matches.scheduledAt,
            tournament: tournaments.name,
            sportSlug: sports.slug,
          })
          .from(slotzillaGames)
          .innerJoin(matches, eq(matches.id, slotzillaGames.matchId))
          .innerJoin(tournaments, eq(tournaments.id, matches.tournamentId))
          .innerJoin(categories, eq(categories.id, tournaments.categoryId))
          .innerJoin(sports, eq(sports.id, categories.sportId))
          .where(inArray(slotzillaGames.status, ["live", "paused"]))
          .orderBy(desc(slotzillaGames.clockReadAt))
          .limit(100);
        return {
          games: rows.map((r) => ({
            matchId: r.matchId.toString(),
            srMatchId: r.srMatchId.toString(),
            status: r.status,
            homeTeam: r.homeTeam,
            awayTeam: r.awayTeam,
            tournament: r.tournament,
            sportSlug: r.sportSlug,
            clock: clockView(r),
            score: scoreOf(r.liveScore),
            playerMode: r.coverageLevel === 2,
            scheduledAt: r.scheduledAt?.toISOString() ?? null,
          })),
        };
      };
      return cached(app.redis, LIVE_CACHE_KEY, LIVE_CACHE_TTL_SECONDS, load);
    },
  );

  // ── Covered games (the /slotzilla section's selector) ─────────────────
  // Every basketball fixture with a CONFIRMED Sportradar mapping that has
  // not finished, from six hours back (a long game still running) to a
  // day and a half ahead. A fixture the service has not opened yet is
  // listed as `scheduled` — the same coverage rule the match page mounts
  // the panel on, so the two surfaces never disagree about what is
  // playable. Live and paused games first, then by kickoff.
  app.get(
    "/slotzilla/games",
    { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
    async () => {
      const load = async (): Promise<{ games: SlotzillaLiveGame[] }> => {
        const rows = await app.db
          .select({
            matchId: matches.id,
            srMatchId: matchSportradarIds.srMatchId,
            status: slotzillaGames.status,
            coverageLevel: slotzillaGames.coverageLevel,
            clockSeconds: slotzillaGames.clockSeconds,
            clockRunning: slotzillaGames.clockRunning,
            clockPeriod: slotzillaGames.clockPeriod,
            clockReadAt: slotzillaGames.clockReadAt,
            homeTeam: matches.homeTeam,
            awayTeam: matches.awayTeam,
            liveScore: matches.liveScore,
            scheduledAt: matches.scheduledAt,
            tournament: tournaments.name,
            sportSlug: sports.slug,
          })
          .from(matchSportradarIds)
          .innerJoin(matches, eq(matches.id, matchSportradarIds.matchId))
          .innerJoin(tournaments, eq(tournaments.id, matches.tournamentId))
          .innerJoin(categories, eq(categories.id, tournaments.categoryId))
          .innerJoin(sports, eq(sports.id, categories.sportId))
          .leftJoin(slotzillaGames, eq(slotzillaGames.matchId, matches.id))
          .where(
            and(
              eq(matchSportradarIds.status, "confirmed"),
              eq(matchSportradarIds.srSportId, SR_BASKETBALL_SPORT_ID),
              inArray(matches.status, ["not_started", "live"]),
              sql`${matches.scheduledAt} BETWEEN now() - interval '6 hours' AND now() + interval '36 hours'`,
              or(
                isNull(slotzillaGames.status),
                inArray(slotzillaGames.status, ["scheduled", "live", "paused"]),
              ),
            ),
          )
          .orderBy(
            sql`CASE WHEN ${slotzillaGames.status} IN ('live', 'paused') THEN 0 ELSE 1 END`,
            desc(slotzillaGames.clockReadAt),
            asc(matches.scheduledAt),
          )
          .limit(100);
        return {
          games: rows.map((r) => ({
            matchId: r.matchId.toString(),
            srMatchId: r.srMatchId.toString(),
            status: r.status ?? "scheduled",
            homeTeam: r.homeTeam,
            awayTeam: r.awayTeam,
            tournament: r.tournament,
            sportSlug: r.sportSlug,
            clock: clockView({
              clockSeconds: r.clockSeconds ?? null,
              clockRunning: r.clockRunning ?? false,
              clockPeriod: r.clockPeriod ?? null,
              clockReadAt: r.clockReadAt ?? null,
            }),
            score: scoreOf(r.liveScore),
            playerMode: r.coverageLevel === 2,
            scheduledAt: r.scheduledAt?.toISOString() ?? null,
          })),
        };
      };
      return cached(app.redis, GAMES_CACHE_KEY, GAMES_CACHE_TTL_SECONDS, load);
    },
  );

  // ── Game state for a match page ───────────────────────────────────────
  app.get(
    "/slotzilla/matches/:matchId",
    { config: { rateLimit: { max: 300, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const { matchId } = matchParams.parse(request.params);
      // Carries the bettor's own spins — never shared, never cached.
      reply.header("cache-control", "private, no-store");
      return buildGameState(app, matchId, request.user?.id ?? null);
    },
  );

  // ── Place a spin ──────────────────────────────────────────────────────
  app.post(
    "/slotzilla/matches/:matchId/spins",
    { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const user = request.requireAuth();
      const { matchId } = matchParams.parse(request.params);
      const body = spinBody.parse(request.body);
      const { spin } = await placeSpin(app, {
        userId: user.id,
        matchId,
        request: body,
      });
      reply.header("cache-control", "private, no-store");
      // 200 for a fresh placement AND for a replayed idempotency key,
      // which answers with the spin it made the first time — the same
      // convention POST /bets follows.
      return spin;
    },
  );

  // ── Bettor history ────────────────────────────────────────────────────
  app.get(
    "/slotzilla/me/spins",
    { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const user = request.requireAuth();
      const q = historyQuery.parse(request.query);
      const page = await loadSpinPage(app.db, { userId: user.id }, q.cursor, q.limit);
      reply.header("cache-control", "private, no-store");
      return { spins: page.rows.map(spinToView), nextCursor: page.nextCursor };
    },
  );
}
