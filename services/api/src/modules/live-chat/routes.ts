// /live-chat/* endpoints — Notion spec at
// notion.so/Live-match-chat-32e64f04f9b480d48b13d808dbce2366.
//
// Public reads:
//   GET  /live-chat/match/:matchId/room        — full room snapshot
//   GET  /live-chat/match/:matchId/my-bet      — authed: caller's open ticket
//
// Authed writes:
//   POST /live-chat/match/:matchId/messages    — send a chat message
//   POST /live-chat/match/:matchId/picks       — submit a home/draw/away pick
//   POST /live-chat/match/:matchId/reactions   — broadcast a reaction burst
//
// Read snapshots include `myPick` so the client knows whether to
// render the blurred-picks UI (Notion Epic 4 reveal-on-vote). The
// underlying live_chat_picks table is the source of truth for double-
// vote prevention; the Redis HASH at chat:picks:{matchId} is a
// counter cache, rebuilt from the DB on cold start.

import type { FastifyInstance } from "fastify";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  liveChatMessages,
  liveChatPicks,
  matches,
  users,
  tickets,
  ticketSelections,
  markets,
  marketOutcomes,
} from "@oddzilla/db";
import type {
  LiveChatBetPin,
  LiveChatCrowdPicks,
  LiveChatMatchSnapshot,
  LiveChatMessage,
  LiveChatRoomState,
  LiveChatSystemMessage,
  LiveChatUserMessage,
  PickOutcome,
  ReactionKind,
  SystemMessageKind,
} from "@oddzilla/types";
import { PICK_OUTCOMES, REACTION_KINDS } from "@oddzilla/types";
import {
  BadRequestError,
  NotFoundError,
  TooManyRequestsError,
} from "../../lib/errors.js";
import {
  MESSAGE_CACHE_SIZE,
  appendMessageToCache,
  consumeMessageQuota,
  consumeReactionQuota,
  incrementPickCounter,
  publishFrame,
  readCrowdPicks,
  readMessageCache,
  readViewerCount,
  warmMessageCache,
  warmPicksCache,
} from "./cache.js";

// Match URN is a bigint at the DB layer (matches.id is bigserial) but
// shipped over the wire as a decimal string per CLAUDE.md invariant 1.
// Pre-validate before the DB hit so a malformed param 400s cheap.
const MATCH_ID_RE = /^[1-9][0-9]{0,18}$/;

// Cap the batch viewer-count endpoint. A storefront /live page renders
// ~20-50 cards; 200 is comfortable headroom without inviting a scraper
// to fan-out the whole catalog through this surface.
const MAX_VIEWERS_BATCH = 200;

const messageBody = z.object({
  // 1-160 chars per Notion UC02. We trim whitespace before the length
  // check so a 160-space message doesn't pass.
  text: z.string().trim().min(1, "text_empty").max(160, "text_too_long"),
});

const pickBody = z.object({
  pick: z.enum(PICK_OUTCOMES),
});

const reactionBody = z.object({
  reaction: z.enum(REACTION_KINDS),
});

const liveChatRoutes = async (app: FastifyInstance) => {
  // Cheaper than a global rate limiter for the chat surface — the
  // hot path is the message POST and we already gate it inside the
  // handler via consumeMessageQuota (per-user, Redis-backed). The
  // route-level limit catches anonymous flooding of the snapshot
  // endpoint.
  const readRateLimit = {
    rateLimit: { max: 120, timeWindow: "1 minute" },
  };
  const writeRateLimit = {
    rateLimit: { max: 60, timeWindow: "1 minute" },
  };

  // ─── GET /live-chat/match/:matchId/room ───────────────────────────────────
  app.get<{ Params: { matchId: string } }>(
    "/live-chat/match/:matchId/room",
    { config: readRateLimit },
    async (request): Promise<LiveChatRoomState> => {
      const matchId = parseMatchId(request.params.matchId);
      const userId = request.user?.id ?? null;

      // 1. Resolve the match (404 if it doesn't exist). We allow
      //    closed/cancelled rooms read-only so post-match chatter
      //    settles and history remains visible.
      const [match] = await app.db
        .select({
          id: matches.id,
          homeTeam: matches.homeTeam,
          awayTeam: matches.awayTeam,
          status: matches.status,
          liveScore: matches.liveScore,
        })
        .from(matches)
        .where(eq(matches.id, BigInt(matchId)))
        .limit(1);
      if (!match) throw new NotFoundError("match_not_found");

      // 2. Messages — Redis first, then DB fallback. On cache cold
      //    start we re-hydrate the cache so the next read is hot.
      let messages = await readMessageCache(app.redis, matchId);
      if (messages.length === 0) {
        messages = await loadMessagesFromDb(app, matchId);
        await warmMessageCache(app.redis, matchId, messages);
      }

      // 3. Crowd picks — Redis HASH first; on a cold start a quick
      //    GROUP BY rebuilds the counter and warms the cache. The
      //    user's own pick gates the reveal UX so we ALWAYS query it
      //    from the DB (Redis doesn't know per-user state for picks).
      let crowdPicks = await readCrowdPicks(app.redis, matchId);
      if (crowdPicks.totalVotes === 0) {
        const counts = await loadPickCountsFromDb(app, matchId);
        await warmPicksCache(app.redis, matchId, counts);
        crowdPicks = {
          ...counts,
          totalVotes: counts.home + counts.draw + counts.away,
        };
      }
      const myPick = userId ? await loadMyPick(app, matchId, userId) : null;

      // 4. BetPin — only when authed and the user has an open or
      //    settled ticket on this match. Combo / system / tippot
      //    tickets are surfaced same as singles; the UI handles
      //    them with the outcomeLabel field.
      const betPin = userId ? await loadBetPin(app, matchId, userId) : null;

      // 5. Viewer count — ws-gateway maintains chat:viewers:{matchId}
      //    in Redis whenever chatMatchRefs changes. Reads 0 on cold
      //    start; the first subscriber will publish a delta.
      const viewerCount = await readViewerCount(app.redis, matchId);

      return {
        matchId,
        match: matchSnapshot(match),
        viewerCount,
        myPick,
        // Reveal-on-vote rule — Notion Epic 4. The blur is a UI
        // affordance; the server enforces by withholding the data.
        crowdPicks: myPick ? crowdPicks : null,
        messages,
        betPin,
      };
    },
  );

  // ─── POST /live-chat/match/:matchId/messages ──────────────────────────────
  app.post<{ Params: { matchId: string }; Body: unknown }>(
    "/live-chat/match/:matchId/messages",
    { config: writeRateLimit },
    async (request): Promise<{ message: LiveChatUserMessage }> => {
      const user = request.requireAuth();
      const matchId = parseMatchId(request.params.matchId);
      const { text } = messageBody.parse(request.body);

      // Per-user quota in Redis. Returning 429 lets the client back
      // off and visually flag the limit without retrying.
      const ok = await consumeMessageQuota(app.redis, user.id);
      if (!ok) throw new TooManyRequestsError("chat_rate_limited");

      // Match must exist; closed/cancelled rooms reject new posts.
      // Pre-match chatter is allowed (Notion Epic 7 simulator has
      // bots messaging before kickoff).
      const [match] = await app.db
        .select({ id: matches.id, status: matches.status })
        .from(matches)
        .where(eq(matches.id, BigInt(matchId)))
        .limit(1);
      if (!match) throw new NotFoundError("match_not_found");
      if (match.status === "closed" || match.status === "cancelled") {
        throw new BadRequestError("match_chat_closed", "match_chat_closed");
      }

      // Caller's nickname is needed to render the message client-side.
      // Reject if the caller hasn't picked one (community onboarding
      // gates this elsewhere — the UI shouldn't show the input until
      // the nickname is set, but we re-check server-side).
      const [profile] = await app.db
        .select({ nickname: users.nickname })
        .from(users)
        .where(eq(users.id, user.id))
        .limit(1);
      if (!profile?.nickname) {
        throw new BadRequestError("nickname_required", "nickname_required");
      }

      const inserted = await app.db
        .insert(liveChatMessages)
        .values({
          matchId: BigInt(matchId),
          kind: "user",
          userId: user.id,
          text,
        })
        .returning({
          id: liveChatMessages.id,
          createdAt: liveChatMessages.createdAt,
        });
      const row = inserted[0];
      if (!row) {
        // Should never happen — INSERT without ON CONFLICT always
        // returns the inserted row. Surface as 500 rather than send
        // a silently-malformed message frame.
        throw new BadRequestError("message_insert_failed");
      }

      const message: LiveChatUserMessage = {
        id: row.id.toString(),
        matchId,
        kind: "user",
        userId: user.id,
        nickname: profile.nickname,
        avatarInitials: avatarInitials(profile.nickname),
        text,
        createdAt: row.createdAt.toISOString(),
      };

      await appendMessageToCache(app.redis, matchId, message);
      await publishFrame(app.redis, {
        type: "chat_message",
        matchId,
        message,
      });

      return { message };
    },
  );

  // ─── POST /live-chat/match/:matchId/picks ─────────────────────────────────
  app.post<{ Params: { matchId: string }; Body: unknown }>(
    "/live-chat/match/:matchId/picks",
    { config: writeRateLimit },
    async (
      request,
    ): Promise<{ myPick: PickOutcome; crowdPicks: LiveChatCrowdPicks }> => {
      const user = request.requireAuth();
      const matchId = parseMatchId(request.params.matchId);
      const { pick } = pickBody.parse(request.body);

      // Match must exist. Picks remain submittable through FT so
      // late joiners can still see the reveal.
      const [match] = await app.db
        .select({ id: matches.id })
        .from(matches)
        .where(eq(matches.id, BigInt(matchId)))
        .limit(1);
      if (!match) throw new NotFoundError("match_not_found");

      // ON CONFLICT DO NOTHING — the second submit is a no-op
      // (Notion UC03 exception). Returning rows tells us whether the
      // counter cache should be bumped.
      const inserted = await app.db
        .insert(liveChatPicks)
        .values({
          matchId: BigInt(matchId),
          userId: user.id,
          pick,
        })
        .onConflictDoNothing({
          target: [liveChatPicks.matchId, liveChatPicks.userId],
        })
        .returning({ pick: liveChatPicks.pick });

      let crowdPicks: LiveChatCrowdPicks;
      if (inserted.length > 0) {
        crowdPicks = await incrementPickCounter(app.redis, matchId, pick);
        // Real-time fan-out to other viewers' picks bars.
        await publishFrame(app.redis, {
          type: "chat_picks_update",
          matchId,
          crowdPicks,
        });
      } else {
        // Duplicate vote: still return current counters so the
        // client can render the reveal without re-fetching the room.
        crowdPicks = await readCrowdPicks(app.redis, matchId);
        if (crowdPicks.totalVotes === 0) {
          const counts = await loadPickCountsFromDb(app, matchId);
          await warmPicksCache(app.redis, matchId, counts);
          crowdPicks = {
            ...counts,
            totalVotes: counts.home + counts.draw + counts.away,
          };
        }
      }

      // The caller's own pick is whatever exists in the DB — for the
      // duplicate-vote case the original pick wins, NOT the new one.
      const existingPick =
        inserted.length > 0
          ? pick
          : ((await loadMyPick(app, matchId, user.id)) ?? pick);

      return { myPick: existingPick, crowdPicks };
    },
  );

  // ─── POST /live-chat/match/:matchId/reactions ─────────────────────────────
  app.post<{ Params: { matchId: string }; Body: unknown }>(
    "/live-chat/match/:matchId/reactions",
    { config: writeRateLimit },
    async (request, reply): Promise<void> => {
      const user = request.requireAuth();
      const matchId = parseMatchId(request.params.matchId);
      const { reaction } = reactionBody.parse(request.body);

      const ok = await consumeReactionQuota(app.redis, user.id);
      if (!ok) throw new TooManyRequestsError("reaction_rate_limited");

      // Match existence check is cheap and prevents reaction bombing
      // of bogus matchIds (which would still publish to a channel
      // with no subscribers, but burn Redis CPU).
      const [match] = await app.db
        .select({ id: matches.id, status: matches.status })
        .from(matches)
        .where(eq(matches.id, BigInt(matchId)))
        .limit(1);
      if (!match) throw new NotFoundError("match_not_found");
      if (match.status === "closed" || match.status === "cancelled") {
        throw new BadRequestError(
          "match_chat_closed",
          "match_chat_closed",
        );
      }

      const [profile] = await app.db
        .select({ nickname: users.nickname })
        .from(users)
        .where(eq(users.id, user.id))
        .limit(1);
      if (!profile?.nickname) {
        throw new BadRequestError("nickname_required", "nickname_required");
      }

      // burstId is server-stamped so a misbehaving client can't
      // collapse other users' bursts by reusing an id. Random uuid
      // suffix keeps it short enough for the wire (typeof crypto.
      // randomUUID is available on Node 22).
      await publishFrame(app.redis, {
        type: "chat_reaction",
        matchId,
        userId: user.id,
        nickname: profile.nickname,
        reaction: reaction as ReactionKind,
        burstId: crypto.randomUUID(),
      });

      reply.code(204).send();
    },
  );

  // ─── GET /live-chat/viewers?matchIds=1,2,3 ─────────────────────────────────
  //
  // Batch viewer-count lookup powering the "N watching" pill on the
  // storefront list pages. Reads chat:viewers:{matchId} keys (set by
  // ws-gateway whenever chatMatchRefs flips above/below zero) in a
  // single MGET. Anonymous; viewer counts are non-sensitive
  // aggregate data and gating this would force every list-page mount
  // to redirect through /login.
  app.get<{ Querystring: { matchIds?: string } }>(
    "/live-chat/viewers",
    { config: readRateLimit },
    async (request): Promise<{ counts: Record<string, number> }> => {
      const raw = request.query.matchIds ?? "";
      if (raw === "") return { counts: {} };

      const ids = raw.split(",").map((s) => s.trim()).filter((s) => s !== "");
      if (ids.length > MAX_VIEWERS_BATCH) {
        throw new BadRequestError("too_many_match_ids", "too_many_match_ids");
      }
      for (const id of ids) {
        if (!MATCH_ID_RE.test(id)) {
          throw new BadRequestError("match_id_invalid", "match_id_invalid");
        }
      }
      if (ids.length === 0) return { counts: {} };

      // De-duplicate so a caller passing the same id twice doesn't
      // waste a slot in the MGET batch.
      const unique = Array.from(new Set(ids));
      const keys = unique.map((id) => `chat:viewers:${id}`);
      const raws = await app.redis.mget(...keys);
      const counts: Record<string, number> = {};
      for (let i = 0; i < unique.length; i++) {
        const matchId = unique[i]!;
        const value = raws[i];
        const n = value == null ? 0 : Number(value);
        counts[matchId] = Number.isFinite(n) && n > 0 ? n : 0;
      }
      return { counts };
    },
  );

  // ─── GET /live-chat/match/:matchId/my-bet ─────────────────────────────────
  app.get<{ Params: { matchId: string } }>(
    "/live-chat/match/:matchId/my-bet",
    { config: readRateLimit },
    async (request): Promise<{ betPin: LiveChatBetPin | null }> => {
      const user = request.requireAuth();
      const matchId = parseMatchId(request.params.matchId);
      const betPin = await loadBetPin(app, matchId, user.id);
      return { betPin };
    },
  );
};

// --- helpers ----------------------------------------------------------------
//
// Exported for unit testing in helpers.test.ts. None of these are part
// of the public route surface; the export only crosses the module
// boundary so the test runner can import them.

export function parseMatchId(raw: string): string {
  if (!MATCH_ID_RE.test(raw)) {
    throw new BadRequestError("match_id_invalid", "match_id_invalid");
  }
  return raw;
}

export function avatarInitials(nickname: string): string {
  // Two-letter initials, uppercase. Falls back to the first non-
  // alphanumeric stripped pair so handles like "_alex" still render.
  const stripped = nickname.replace(/[^A-Za-z0-9]/g, "");
  return (stripped.slice(0, 2) || nickname.slice(0, 2)).toUpperCase();
}

export function matchSnapshot(match: {
  homeTeam: string;
  awayTeam: string;
  status: "not_started" | "live" | "closed" | "cancelled" | "suspended";
  liveScore: unknown;
}): LiveChatMatchSnapshot {
  // liveScore is `jsonb` — Oddin pushes structured payloads here. We
  // don't yet know the exact shape across all sports, so the parse
  // is defensive: pull anything that looks like a numeric score,
  // fall back to 0-0. Phase C will refine this once the watcher
  // owns the canonical snapshot.
  let homeScore = 0;
  let awayScore = 0;
  let clock = "";
  if (match.liveScore && typeof match.liveScore === "object") {
    const ls = match.liveScore as Record<string, unknown>;
    const home = Number(ls.home ?? ls.h ?? 0);
    const away = Number(ls.away ?? ls.a ?? 0);
    homeScore = Number.isFinite(home) ? home : 0;
    awayScore = Number.isFinite(away) ? away : 0;
    if (typeof ls.clock === "string") clock = ls.clock;
  }
  const status =
    match.status === "live"
      ? "live"
      : match.status === "closed"
        ? "fulltime"
        : match.status === "cancelled"
          ? "fulltime"
          : match.status === "suspended"
            ? "suspended"
            : "not_started";
  return { score: { home: homeScore, away: awayScore }, clock, status };
}

async function loadMessagesFromDb(
  app: FastifyInstance,
  matchId: string,
): Promise<LiveChatMessage[]> {
  // Newest-first read with the index, then reverse for the UI.
  const rows = await app.db
    .select({
      id: liveChatMessages.id,
      kind: liveChatMessages.kind,
      userId: liveChatMessages.userId,
      text: liveChatMessages.text,
      systemKind: liveChatMessages.systemKind,
      payload: liveChatMessages.payload,
      createdAt: liveChatMessages.createdAt,
      nickname: users.nickname,
    })
    .from(liveChatMessages)
    .leftJoin(users, eq(users.id, liveChatMessages.userId))
    .where(eq(liveChatMessages.matchId, BigInt(matchId)))
    .orderBy(desc(liveChatMessages.createdAt), desc(liveChatMessages.id))
    .limit(MESSAGE_CACHE_SIZE);

  const reversed = rows.slice().reverse();
  return reversed.flatMap<LiveChatMessage>((r) => {
    if (r.kind === "user") {
      // Skip orphaned user messages whose author was hard-deleted
      // (userId becomes null via ON DELETE SET NULL). The DB CHECK
      // prevents this on insert, but the SET NULL path can produce
      // them post-deletion.
      if (!r.userId || !r.nickname) return [];
      const msg: LiveChatUserMessage = {
        id: r.id.toString(),
        matchId,
        kind: "user",
        userId: r.userId,
        nickname: r.nickname,
        avatarInitials: avatarInitials(r.nickname),
        text: r.text,
        createdAt: r.createdAt.toISOString(),
      };
      return [msg];
    }
    const sys: LiveChatSystemMessage = {
      id: r.id.toString(),
      matchId,
      kind: "system",
      systemKind: (r.systemKind ?? "goal") as SystemMessageKind,
      text: r.text,
      payload:
        r.payload && typeof r.payload === "object"
          ? (r.payload as LiveChatSystemMessage["payload"])
          : null,
      createdAt: r.createdAt.toISOString(),
    };
    return [sys];
  });
}

async function loadPickCountsFromDb(
  app: FastifyInstance,
  matchId: string,
): Promise<{ home: number; draw: number; away: number }> {
  const rows = await app.db
    .select({
      pick: liveChatPicks.pick,
      count: sql<number>`count(*)::int`,
    })
    .from(liveChatPicks)
    .where(eq(liveChatPicks.matchId, BigInt(matchId)))
    .groupBy(liveChatPicks.pick);

  const out = { home: 0, draw: 0, away: 0 };
  for (const r of rows) {
    if (r.pick === "home" || r.pick === "draw" || r.pick === "away") {
      out[r.pick] = Number(r.count);
    }
  }
  return out;
}

async function loadMyPick(
  app: FastifyInstance,
  matchId: string,
  userId: string,
): Promise<PickOutcome | null> {
  const [row] = await app.db
    .select({ pick: liveChatPicks.pick })
    .from(liveChatPicks)
    .where(
      and(
        eq(liveChatPicks.matchId, BigInt(matchId)),
        eq(liveChatPicks.userId, userId),
      ),
    )
    .limit(1);
  if (!row) return null;
  if (row.pick === "home" || row.pick === "draw" || row.pick === "away") {
    return row.pick;
  }
  return null;
}

// Exported for direct integration testing in integration.test.ts —
// otherwise a regression in the JOIN against
// tickets / ticket_selections / markets / market_outcomes would only
// surface through Fastify.inject, which would need full auth setup.
// Not part of the public route surface.
export async function loadBetPin(
  app: FastifyInstance,
  matchId: string,
  userId: string,
): Promise<LiveChatBetPin | null> {
  // Single bet, on a market belonging to this match. Combos surface
  // separately (a combo card needs every leg's status to be useful,
  // which is a richer object than BetPin v1 expects). The user's
  // most recent qualifying ticket wins; rare to have multiple.
  const [row] = await app.db
    .select({
      ticketId: tickets.id,
      status: tickets.status,
      currency: tickets.currency,
      stakeMicro: tickets.stakeMicro,
      potentialPayoutMicro: tickets.potentialPayoutMicro,
      odds: ticketSelections.oddsAtPlacement,
      outcomeId: ticketSelections.outcomeId,
      outcomeName: marketOutcomes.name,
      providerMarketId: markets.providerMarketId,
      placedAt: tickets.placedAt,
    })
    .from(tickets)
    .innerJoin(ticketSelections, eq(ticketSelections.ticketId, tickets.id))
    .innerJoin(markets, eq(markets.id, ticketSelections.marketId))
    .leftJoin(
      marketOutcomes,
      and(
        eq(marketOutcomes.marketId, markets.id),
        eq(marketOutcomes.outcomeId, ticketSelections.outcomeId),
      ),
    )
    .where(
      and(
        eq(tickets.userId, userId),
        eq(tickets.betType, "single"),
        eq(markets.matchId, BigInt(matchId)),
      ),
    )
    .orderBy(desc(tickets.placedAt))
    .limit(1);
  if (!row) return null;

  // Map ticket_status enum → BetPin.status. 'pending_delay' is a
  // transient state (sub-second) — collapse to 'pending' so the UI
  // doesn't flicker through it. 'rejected' tickets never see the
  // match so we don't render them.
  const status: LiveChatBetPin["status"] =
    row.status === "accepted" || row.status === "pending_delay"
      ? "pending"
      : row.status === "settled"
        ? row.potentialPayoutMicro > 0n
          ? "won"
          : "lost"
        : row.status === "voided"
          ? "void"
          : row.status === "cashed_out"
            ? "cashed_out"
            : "pending";

  if (row.status === "rejected") return null;

  // oddsAtPlacement is a decimal string like "2.5000". Convert to
  // x10000 integer for the wire format, matching how BetBuilder
  // already carries combined odds (CLAUDE.md).
  const oddsX10000 = Math.round(Number(row.odds) * 10000);

  return {
    ticketId: row.ticketId,
    outcomeLabel: row.outcomeName ?? row.outcomeId,
    oddsX10000,
    stakeMicro: row.stakeMicro.toString(),
    potentialWinMicro: row.potentialPayoutMicro.toString(),
    currency: row.currency,
    status,
    pickedSide: derivePickedSide(row.providerMarketId, row.outcomeId),
  };
}

// Maps (providerMarketId, outcomeId) → home/draw/away for markets
// where the outcome IDs follow a known geometric convention. Oddin's
// match-winner market (`provider_market_id = 1`) uses outcome IDs
// "1" / "X" / "2" verbatim — that's the only shape V1 recognises.
// Returns null for every other market type so the UI degrades to the
// raw outcome label (and the live-status colour reverts to pending).
//
// Future extensions:
//   - provider_market_id = 4 (map winner): outcomes are team URNs;
//     "home" / "away" derivation requires a join against
//     home_team_urn / away_team_urn. Same shape, more plumbing.
//   - 2-way markets (BTTS, totals): not a home/away axis; pickedSide
//     stays null and the UI shows the raw label.
//
// Exported for direct unit testing.
export function derivePickedSide(
  providerMarketId: number | null,
  outcomeId: string,
): "home" | "draw" | "away" | null {
  if (providerMarketId !== 1) return null;
  if (outcomeId === "1") return "home";
  if (outcomeId === "X") return "draw";
  if (outcomeId === "2") return "away";
  return null;
}

export default liveChatRoutes;
