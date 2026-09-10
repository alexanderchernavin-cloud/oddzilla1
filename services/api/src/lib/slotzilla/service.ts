// SlotZilla api-side service: the spin placement transaction, the game
// state a match page renders, and the wire serialisation both share.
//
// The pure parts — which block applies, where the clock is now, what a
// spin row looks like on the wire, which windows to show — are exported
// on their own and unit-tested; the DB-bound parts compose them.
//
// Money (invariants 1 + 4, contract "Money rules"): placement LOCKS the
// stake (`wallets.locked_micro += stake`, scoped by user AND currency)
// and writes one `wallet_ledger` row `slot_stake` keyed on the spin id,
// so the row-level unique index makes any replay a no-op. Settlement
// and voids are the Go service's (services/slotzilla) — except the
// admin void, which lives here in `voidOpenSpinsForGame` and applies
// the same rules in the same shape. RiskZilla's open liability is bumped
// for USDC only, in both directions, with the currency TRIMMED before the
// comparison because the column is CHAR(4).

import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import {
  matchSportradarIds,
  matches,
  slotzillaConfig,
  slotzillaGames,
  slotzillaPaytables,
  slotzillaSpins,
  srLiveEvents,
  users,
  walletLedger,
  wallets,
  SLOTZILLA_SINGLETON_ID,
  type DbClient,
  type SlotzillaConfig,
  type SlotzillaPaytable,
  type SlotzillaSpin,
} from "@oddzilla/db";
import { isCurrency } from "@oddzilla/types/currencies";
import {
  exposureMicro,
  firstWindowFor,
  isLineKey,
  isSlotSymbol,
  reelForWindow,
  roundWindows,
  windowStartOf,
  WINDOW_SECONDS,
  type PaytableLines,
  type ReelEvent,
  type SlotSymbol,
  type SlotTeam,
  type SlotzillaClock,
  type SlotzillaGameState,
  type SlotzillaGameStatus,
  type SlotzillaLimits,
  type SlotzillaPaytableView,
  type SlotzillaSpinBlock,
  type SlotzillaSpinRequest,
  type SlotzillaSpinView,
  type SlotzillaTimelineEvent,
  type SlotzillaWindow,
  type WsSlotzillaSpin,
  type WsSlotzillaState,
} from "@oddzilla/types/slotzilla";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ServiceUnavailableError,
  UnauthorizedError,
} from "../errors.js";
import { isUniqueViolation } from "../pg-errors.js";
import { loadBotControls, velocityCapFor } from "../riskzilla/bot-controls.js";
import { releaseOpenLiability } from "../riskzilla/open-liability.js";

const RISKZILLA_CURRENCY = "USDC";

/** Redis key the Go service writes the latest public frame to (EX 120). */
export const stateKey = (matchId: bigint | string): string => `slotzilla:state:${matchId}`;
/** Redis hash the Go service keeps for the backoffice status card. */
export const FEED_STATUS_KEY = "slotzilla:feed:status";

type SqlRunner = DbClient | Parameters<Parameters<DbClient["transaction"]>[0]>[0];

// ── Pure: clock ─────────────────────────────────────────────────────────

/**
 * Where the match clock is now, from the reading the service holds:
 * the stored seconds plus the whole wall-clock seconds since the
 * reading while running, the stored seconds while stopped.
 */
export function estimatedClockSeconds(
  clockSeconds: number | null,
  clockRunning: boolean,
  clockReadAtMs: number | null,
  nowMs: number,
): number | null {
  if (clockSeconds === null) return null;
  if (!clockRunning || clockReadAtMs === null) return clockSeconds;
  const elapsed = Math.max(0, Math.floor((nowMs - clockReadAtMs) / 1000));
  return clockSeconds + elapsed;
}

/** A reading older than the feed-dark threshold is not a reading. */
export function clockIsFresh(
  clockReadAtMs: number | null,
  nowMs: number,
  feedDarkVoidSeconds: number,
): boolean {
  if (clockReadAtMs === null) return false;
  return nowMs - clockReadAtMs < feedDarkVoidSeconds * 1000;
}

// ── Pure: block reasons ─────────────────────────────────────────────────

export interface BlockInput {
  enabled: boolean;
  hasUser: boolean;
  gameStatus: SlotzillaGameStatus;
  clockRunning: boolean;
  clockReadAtMs: number | null;
  nowMs: number;
  feedDarkVoidSeconds: number;
  hasOpenSpin: boolean;
}

/**
 * The first reason a spin cannot be placed, in the contract's order, or
 * null when it can. The order is what the storefront's copy relies on:
 * a signed-out bettor on a paused game is told to sign in, not that the
 * game is paused.
 */
export function spinBlockFor(input: BlockInput): SlotzillaSpinBlock | null {
  if (!input.enabled) return "disabled";
  if (!input.hasUser) return "sign_in";
  if (input.gameStatus === "paused") return "game_paused";
  if (input.gameStatus !== "live") return "game_not_live";
  if (
    !input.clockRunning ||
    !clockIsFresh(input.clockReadAtMs, input.nowMs, input.feedDarkVoidSeconds)
  ) {
    return "clock_stopped";
  }
  if (input.hasOpenSpin) return "open_spin";
  return null;
}

// ── Pure: windows ───────────────────────────────────────────────────────

/** How much match clock the fallback window build looks back over. */
export const WINDOW_LOOKBACK_SECONDS = 90;

/**
 * Windows from the stored events when the Redis frame is absent: the
 * fixed grid from `lookback` seconds behind the clock up to the window
 * the clock is in. `final` here reads the clock only — the grace timer
 * the service applies needs event arrival times this path does not
 * keep — so a fallback window can be marked final a few seconds early;
 * the spin itself settles on the service's judgement, never this one.
 */
export function windowsFromEvents(
  events: readonly ReelEvent[],
  clockSeconds: number,
  clockPastSeconds: number,
  lookback = WINDOW_LOOKBACK_SECONDS,
): SlotzillaWindow[] {
  const last = windowStartOf(Math.max(0, clockSeconds));
  const first = Math.max(0, windowStartOf(Math.max(0, clockSeconds - lookback)));
  const out: SlotzillaWindow[] = [];
  for (let from = first; from <= last; from += WINDOW_SECONDS) {
    const reel = reelForWindow(events, from);
    out.push({
      from,
      symbol: reel.symbol,
      team: reel.team,
      eventId: reel.eventId,
      final: clockSeconds >= from + WINDOW_SECONDS + clockPastSeconds,
    });
  }
  return out;
}

/** Shape-check a Redis frame written by the Go service; null on anything else. */
export function parseStateFrame(raw: string | null): WsSlotzillaState | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<WsSlotzillaState> | null;
    if (
      v &&
      v.type === "slotzilla_state" &&
      typeof v.matchId === "string" &&
      Array.isArray(v.windows) &&
      v.clock &&
      typeof v.clock === "object"
    ) {
      const windows = v.windows.filter(
        (w): w is SlotzillaWindow =>
          typeof w === "object" &&
          w !== null &&
          typeof (w as SlotzillaWindow).from === "number" &&
          isSlotSymbol((w as SlotzillaWindow).symbol),
      );
      return { ...(v as WsSlotzillaState), windows };
    }
  } catch {
    // Not ours — fall through to the computed path.
  }
  return null;
}

// ── Pure: serialisation ─────────────────────────────────────────────────

function asTeam(v: unknown): SlotTeam | null {
  return v === "home" || v === "away" ? v : null;
}

/** The stored paytable jsonb as typed lines, dropping anything malformed. */
export function paytableLinesOf(raw: unknown): PaytableLines {
  const out: PaytableLines = {};
  if (typeof raw !== "object" || raw === null) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (isLineKey(k) && typeof v === "number" && Number.isInteger(v) && v >= 0) out[k] = v;
  }
  return out;
}

export function paytableView(row: Pick<SlotzillaPaytable, "id" | "name" | "lines">): SlotzillaPaytableView {
  return { id: row.id.toString(), name: row.name, lines: paytableLinesOf(row.lines) };
}

export function limitsFromConfig(cfg: SlotzillaConfig): SlotzillaLimits {
  return {
    currencies: cfg.currencies,
    minStakeMicro: cfg.minStakeMicro.toString(),
    maxStakeMicro: cfg.maxStakeMicro.toString(),
    maxPayoutMicro: cfg.maxPayoutMicro.toString(),
    leadSeconds: cfg.leadSeconds,
    autoplayEnabled: cfg.autoplayEnabled,
  };
}

export function clockView(game: {
  clockSeconds: number | null;
  clockRunning: boolean;
  clockPeriod: number | null;
  clockReadAt: Date | null;
}): SlotzillaClock {
  return {
    seconds: game.clockSeconds,
    running: game.clockRunning,
    atMs: game.clockReadAt ? game.clockReadAt.getTime() : 0,
    period: game.clockPeriod,
  };
}

type SpinRow = Pick<
  SlotzillaSpin,
  | "id"
  | "matchId"
  | "currency"
  | "stakeMicro"
  | "windowFrom"
  | "reels"
  | "reelTeams"
  | "lineKey"
  | "multiplierX100"
  | "payoutMicro"
  | "status"
  | "voidReason"
  | "placedAt"
  | "settledAt"
>;

/** A spin row on the wire: bigints as decimal strings, reels null while open. */
export function spinToView(row: SpinRow): SlotzillaSpinView {
  const reels = row.reels ?? [];
  const teams = row.reelTeams ?? [];
  const reel = (i: number): SlotSymbol | null => {
    const v = reels[i];
    return isSlotSymbol(v) ? v : null;
  };
  return {
    id: row.id,
    matchId: row.matchId.toString(),
    currency: row.currency.trim(),
    stakeMicro: row.stakeMicro.toString(),
    windowFrom: row.windowFrom,
    windows: roundWindows(row.windowFrom),
    reels: [reel(0), reel(1), reel(2)],
    reelTeams: [asTeam(teams[0]), asTeam(teams[1]), asTeam(teams[2])],
    lineKey: isLineKey(row.lineKey) ? row.lineKey : null,
    multiplierX100: row.multiplierX100,
    payoutMicro: row.payoutMicro.toString(),
    status: row.status,
    voidReason: row.voidReason,
    placedAt: row.placedAt.toISOString(),
    settledAt: row.settledAt ? row.settledAt.toISOString() : null,
  };
}

/** Keyset cursor over (placed_at DESC, id DESC). */
export function encodeSpinCursor(placedAt: Date, id: string): string {
  return Buffer.from(`${placedAt.toISOString()}|${id}`, "utf8").toString("base64url");
}

export function decodeSpinCursor(cursor: string | undefined): { placedAt: Date; id: string } | null {
  if (!cursor) return null;
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const idx = decoded.indexOf("|");
    if (idx <= 0) return null;
    const placedAt = new Date(decoded.slice(0, idx));
    const id = decoded.slice(idx + 1);
    if (Number.isNaN(placedAt.getTime()) || !id) return null;
    return { placedAt, id };
  } catch {
    return null;
  }
}

// ── DB: config and paytables ────────────────────────────────────────────

export async function loadConfig(db: SqlRunner): Promise<SlotzillaConfig> {
  const [row] = await db
    .select()
    .from(slotzillaConfig)
    .where(eq(slotzillaConfig.id, SLOTZILLA_SINGLETON_ID))
    .limit(1);
  if (row) return row;
  // The migration seeds the row; insert defensively for fresh / test DBs.
  const [inserted] = await db
    .insert(slotzillaConfig)
    .values({ id: SLOTZILLA_SINGLETON_ID })
    .onConflictDoNothing()
    .returning();
  if (inserted) return inserted;
  const [refetched] = await db
    .select()
    .from(slotzillaConfig)
    .where(eq(slotzillaConfig.id, SLOTZILLA_SINGLETON_ID))
    .limit(1);
  if (!refetched) throw new Error("slotzilla_config row missing after insert");
  return refetched;
}

export async function loadActivePaytable(db: SqlRunner): Promise<SlotzillaPaytable | null> {
  const [row] = await db
    .select()
    .from(slotzillaPaytables)
    .where(eq(slotzillaPaytables.active, true))
    .limit(1);
  return row ?? null;
}

export async function loadPaytableById(db: SqlRunner, id: bigint): Promise<SlotzillaPaytable | null> {
  const [row] = await db.select().from(slotzillaPaytables).where(eq(slotzillaPaytables.id, id)).limit(1);
  return row ?? null;
}

/** The paytable a spin on this game prices from: the game's pinned one, else the active one. */
export async function paytableForGame(
  db: SqlRunner,
  paytableId: bigint | null,
): Promise<SlotzillaPaytable | null> {
  if (paytableId !== null) {
    const pinned = await loadPaytableById(db, paytableId);
    if (pinned) return pinned;
  }
  return loadActivePaytable(db);
}

// ── DB: spins for a bettor ──────────────────────────────────────────────

export const RECENT_SPINS = 10;

export async function loadBettorSpinsForMatch(
  db: SqlRunner,
  userId: string,
  matchId: bigint,
): Promise<{ openSpin: SlotzillaSpinView | null; recentSpins: SlotzillaSpinView[] }> {
  const rows = await db
    .select()
    .from(slotzillaSpins)
    .where(and(eq(slotzillaSpins.userId, userId), eq(slotzillaSpins.matchId, matchId)))
    .orderBy(desc(slotzillaSpins.placedAt), desc(slotzillaSpins.id))
    .limit(RECENT_SPINS + 1);
  const open = rows.find((r) => r.status === "open") ?? null;
  const recent = rows.filter((r) => r.status !== "open").slice(0, RECENT_SPINS);
  return {
    openSpin: open ? spinToView(open) : null,
    recentSpins: recent.map(spinToView),
  };
}

export async function loadSpinPage(
  db: SqlRunner,
  where: { userId?: string; matchId?: bigint },
  cursor: string | undefined,
  limit: number,
): Promise<{ rows: SlotzillaSpin[]; nextCursor: string | null }> {
  const after = decodeSpinCursor(cursor);
  const conds = [];
  if (where.userId) conds.push(eq(slotzillaSpins.userId, where.userId));
  if (where.matchId !== undefined) conds.push(eq(slotzillaSpins.matchId, where.matchId));
  if (after) {
    conds.push(
      or(
        lt(slotzillaSpins.placedAt, after.placedAt),
        and(eq(slotzillaSpins.placedAt, after.placedAt), lt(slotzillaSpins.id, after.id)),
      )!,
    );
  }
  const rows = await db
    .select()
    .from(slotzillaSpins)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(slotzillaSpins.placedAt), desc(slotzillaSpins.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    rows: page,
    nextCursor: rows.length > limit && last ? encodeSpinCursor(last.placedAt, last.id) : null,
  };
}

// ── DB: game state ──────────────────────────────────────────────────────

export async function buildGameState(
  app: FastifyInstance,
  matchId: bigint,
  userId: string | null,
  nowMs = Date.now(),
): Promise<SlotzillaGameState> {
  const [game] = await app.db
    .select()
    .from(slotzillaGames)
    .where(eq(slotzillaGames.matchId, matchId))
    .limit(1);
  if (!game) return buildCoveredState(app, matchId, userId, nowMs);

  const [cfg, paytable, frameRaw, bettor, fixture] = await Promise.all([
    loadConfig(app.db),
    paytableForGame(app.db, game.paytableId),
    app.redis.get(stateKey(matchId)).catch(() => null),
    userId
      ? loadBettorSpinsForMatch(app.db, userId, matchId)
      : Promise.resolve({ openSpin: null, recentSpins: [] }),
    app.db
      .select({ scheduledAt: matches.scheduledAt })
      .from(matches)
      .where(eq(matches.id, matchId))
      .limit(1),
  ]);

  const frame = parseStateFrame(frameRaw);
  let windows: SlotzillaWindow[];
  if (frame) {
    windows = frame.windows;
  } else if (game.clockSeconds !== null) {
    const clockNow = estimatedClockSeconds(
      game.clockSeconds,
      game.clockRunning,
      game.clockReadAt?.getTime() ?? null,
      nowMs,
    ) ?? game.clockSeconds;
    const since = Math.max(0, clockNow - WINDOW_LOOKBACK_SECONDS);
    const rows = await app.db
      .select({
        srEventId: srLiveEvents.srEventId,
        symbol: srLiveEvents.symbol,
        seconds: srLiveEvents.seconds,
        disabled: srLiveEvents.disabled,
        team: srLiveEvents.team,
      })
      .from(srLiveEvents)
      .where(
        and(
          eq(srLiveEvents.srMatchId, game.srMatchId),
          sql`${srLiveEvents.seconds} >= ${since}`,
        ),
      );
    const events: ReelEvent[] = rows.map((r) => ({
      symbol: isSlotSymbol(r.symbol) ? r.symbol : null,
      seconds: r.seconds,
      disabled: r.disabled,
      team: asTeam(r.team),
      eventId: r.srEventId.toString(),
    }));
    windows = windowsFromEvents(events, clockNow, cfg.clockPastSeconds);
  } else {
    windows = [];
  }

  // The strip beside the reels. Read from the same events the windows are
  // derived from, on the same match-clock axis, so the two can never
  // disagree about when something happened.
  const clockForStrip =
    game.clockSeconds === null
      ? null
      : (estimatedClockSeconds(
          game.clockSeconds,
          game.clockRunning,
          game.clockReadAt?.getTime() ?? null,
          nowMs,
        ) ?? game.clockSeconds);
  const timeline =
    clockForStrip === null ? [] : await loadTimeline(app.db, game.srMatchId, clockForStrip);

  const block = spinBlockFor({
    enabled: cfg.enabled,
    hasUser: userId !== null,
    gameStatus: game.status,
    clockRunning: game.clockRunning,
    clockReadAtMs: game.clockReadAt?.getTime() ?? null,
    nowMs,
    feedDarkVoidSeconds: cfg.feedDarkVoidSeconds,
    hasOpenSpin: bettor.openSpin !== null,
  });

  return {
    matchId: matchId.toString(),
    srMatchId: game.srMatchId.toString(),
    status: game.status,
    coverageLevel: game.coverageLevel,
    playerMode: game.coverageLevel === 2,
    clock: clockView(game),
    windowSeconds: WINDOW_SECONDS,
    windows,
    paytable: paytable
      ? paytableView(paytable)
      : { id: "0", name: "none", lines: {} },
    limits: limitsFromConfig(cfg),
    openSpin: bettor.openSpin,
    recentSpins: bettor.recentSpins,
    canSpin: block === null,
    spinBlock: block,
    scheduledAt: fixture[0]?.scheduledAt?.toISOString() ?? null,
    demo: game.isDemo,
    timeline,
  };
}

/**
 * How much match clock the timeline strip covers.
 *
 * Sized from the TRACK WIDTH, not from the reference design. The strip
 * lives in the panel's column, which measures ~400px on a desktop
 * viewport, and a mark is 16px — so about 22 marks fit without them
 * merging into a band. Measured on production 2026-09-10: a real game
 * runs ~0.13 drawable events per second of match clock, so 150 s lands
 * near 20 marks.
 *
 * Five minutes was the first cut, copying the reference's own window,
 * and it put 38 marks in that 400px with a 6.5px gap between neighbours
 * — legible only because they were nudged apart, and still reading as a
 * clump. The reference draws its five minutes across a full-width bar,
 * which is the part that does not transfer.
 */
export const TIMELINE_LOOKBACK_SECONDS = 150;

/**
 * Event types the strip does NOT draw: the clock's own machinery and the
 * feed's bookkeeping, which are not things the match did.
 *
 * `timerunning` is the one that matters — the scout logs a start/stop on
 * every whistle, and on a real fixture it was 19 of the 46 marks in a
 * five-minute window, crowding the plays it sits between while telling a
 * bettor nothing. Measured on production 2026-09-10: dropping this set
 * takes a typical window from 46 marks to ~27, which is the density the
 * reference design shows.
 *
 * Kept deliberately as a DENY list rather than an allow list of plays: a
 * type we have not seen yet is far more likely to be a play worth
 * drawing than a new kind of bookkeeping, and an unknown play drawn as a
 * neutral mark is a much smaller error than a play silently missing.
 */
const TIMELINE_EXCLUDED_TYPES = new Set([
  "timerunning",
  "timeinfo",
  "possession",
  "ballcoordinates",
  "players_on_pitch",
  "players_warming_up",
  "match_about_to_start",
  "match_started",
  "periodscore",
  "videoreview",
]);

/**
 * The events behind the strip, oldest first.
 *
 * Everything the match DID is returned, not only the events that make a
 * symbol: a rebound or a timeout is part of what the match looks like,
 * and the strip is the one surface that shows the match rather than the
 * reels. Clock machinery is excluded (see above). The reel derivation is
 * unaffected either way — it reads symbols, and an event with none
 * contributes nothing to a window.
 */
async function loadTimeline(
  db: DbClient,
  srMatchId: bigint,
  clockSeconds: number,
): Promise<SlotzillaTimelineEvent[]> {
  const since = Math.max(0, clockSeconds - TIMELINE_LOOKBACK_SECONDS);
  const rows = await db
    .select({
      srEventId: srLiveEvents.srEventId,
      symbol: srLiveEvents.symbol,
      type: srLiveEvents.type,
      team: srLiveEvents.team,
      seconds: srLiveEvents.seconds,
      period: srLiveEvents.period,
      playerName: srLiveEvents.playerName,
      disabled: srLiveEvents.disabled,
    })
    .from(srLiveEvents)
    .where(
      and(
        eq(srLiveEvents.srMatchId, srMatchId),
        sql`${srLiveEvents.seconds} >= ${since}`,
        // Never draw ahead of the clock. On a demo game the whole
        // recording is stored from the first tick, so without this the
        // strip would show the rest of the match before it is played.
        sql`${srLiveEvents.seconds} <= ${clockSeconds}`,
      ),
    )
    .orderBy(srLiveEvents.seconds, srLiveEvents.srEventId);

  return rows
    .filter((r) => !TIMELINE_EXCLUDED_TYPES.has(r.type))
    .map((r) => ({
      id: r.srEventId.toString(),
      // The column's CHECK never stores NONE — an event that makes no
      // symbol stores NULL — but isSlotSymbol admits it, so narrow here
      // rather than widen the wire type to a value it cannot carry.
      symbol: isSlotSymbol(r.symbol) && r.symbol !== "NONE" ? r.symbol : null,
      type: r.type,
      team: asTeam(r.team),
      seconds: r.seconds,
      period: r.period,
      playerName: r.playerName,
      disabled: r.disabled,
    }));
}

/** Sportradar's sport id for basketball — the only sport the game covers. */
export const SR_BASKETBALL_SPORT_ID = 2;

/**
 * The state of a COVERED fixture the service has not opened yet.
 *
 * `services/slotzilla` creates the game row about an hour before
 * tip-off, but the panel mounts on coverage — a confirmed Sportradar
 * basketball mapping on a match that has not finished — so a bettor who
 * lands on the page earlier sees the game as scheduled rather than
 * nothing (operator's call, 2026-09-10). No clock, no windows, no spin:
 * the block is `game_not_live` (or `disabled` / `sign_in`, in the api's
 * usual order), and the kickoff rides `scheduledAt` for the copy.
 */
async function buildCoveredState(
  app: FastifyInstance,
  matchId: bigint,
  userId: string | null,
  nowMs: number,
): Promise<SlotzillaGameState> {
  const [covered] = await app.db
    .select({
      srMatchId: matchSportradarIds.srMatchId,
      scheduledAt: matches.scheduledAt,
    })
    .from(matchSportradarIds)
    .innerJoin(matches, eq(matches.id, matchSportradarIds.matchId))
    .where(
      and(
        eq(matchSportradarIds.matchId, matchId),
        eq(matchSportradarIds.status, "confirmed"),
        eq(matchSportradarIds.srSportId, SR_BASKETBALL_SPORT_ID),
        inArray(matches.status, ["not_started", "live"]),
      ),
    )
    .limit(1);
  if (!covered) throw new NotFoundError("slotzilla_game_not_found", "slotzilla_game_not_found");

  const [cfg, paytable, bettor] = await Promise.all([
    loadConfig(app.db),
    loadActivePaytable(app.db),
    userId
      ? loadBettorSpinsForMatch(app.db, userId, matchId)
      : Promise.resolve({ openSpin: null, recentSpins: [] }),
  ]);
  const block = spinBlockFor({
    enabled: cfg.enabled,
    hasUser: userId !== null,
    gameStatus: "scheduled",
    clockRunning: false,
    clockReadAtMs: null,
    nowMs,
    feedDarkVoidSeconds: cfg.feedDarkVoidSeconds,
    hasOpenSpin: bettor.openSpin !== null,
  });
  return {
    matchId: matchId.toString(),
    srMatchId: covered.srMatchId.toString(),
    status: "scheduled",
    coverageLevel: null,
    playerMode: false,
    clock: { seconds: null, running: false, atMs: nowMs, period: null },
    windowSeconds: WINDOW_SECONDS,
    windows: [],
    paytable: paytable ? paytableView(paytable) : { id: "0", name: "none", lines: {} },
    limits: limitsFromConfig(cfg),
    openSpin: bettor.openSpin,
    recentSpins: bettor.recentSpins,
    canSpin: false,
    spinBlock: block,
    scheduledAt: covered.scheduledAt?.toISOString() ?? null,
    // A covered fixture the service has not opened has no game row, and a
    // demo game always has one — so this branch is never a demo, and
    // there is no play-by-play to draw yet.
    demo: false,
    timeline: [],
  };
}

// ── DB: placement ───────────────────────────────────────────────────────

function pgConstraint(err: unknown): string | null {
  if (err === null || typeof err !== "object") return null;
  const e = err as { constraint_name?: unknown; constraint?: unknown; cause?: unknown };
  if (typeof e.constraint_name === "string") return e.constraint_name;
  if (typeof e.constraint === "string") return e.constraint;
  return e.cause ? pgConstraint(e.cause) : null;
}

/**
 * Best-effort per-bettor frame on `user:{id}`. Called AFTER the
 * transaction commits so a frame can never describe a spin that rolled
 * back; a Redis blip costs the frame, not the spin — the storefront
 * re-reads state every 15 s anyway.
 */
export async function publishSpinFrame(
  app: FastifyInstance,
  userId: string,
  spin: SlotzillaSpinView,
): Promise<void> {
  const frame: WsSlotzillaSpin = { type: "slotzilla_spin", spin, ts: Date.now() };
  try {
    await app.redis.publish(`user:${userId}`, JSON.stringify(frame));
  } catch (err) {
    app.log.warn({ err, userId, spinId: spin.id }, "slotzilla: spin frame publish failed");
  }
}

export interface PlaceSpinInput {
  userId: string;
  matchId: bigint;
  request: SlotzillaSpinRequest;
}

export async function placeSpin(
  app: FastifyInstance,
  input: PlaceSpinInput,
  nowMs = Date.now(),
): Promise<{ spin: SlotzillaSpinView; created: boolean }> {
  const { userId, matchId, request } = input;
  let stake: bigint;
  try {
    stake = BigInt(request.stakeMicro);
  } catch {
    throw new BadRequestError("invalid_stake", "invalid_stake");
  }
  if (stake <= 0n) throw new BadRequestError("stake_must_be_positive", "stake_must_be_positive");

  const findExisting = async (db: SqlRunner) => {
    const [row] = await db
      .select()
      .from(slotzillaSpins)
      .where(
        and(
          eq(slotzillaSpins.userId, userId),
          eq(slotzillaSpins.idempotencyKey, request.idempotencyKey),
        ),
      )
      .limit(1);
    return row ?? null;
  };

  let result: { spin: SlotzillaSpinView; created: boolean };
  try {
    result = await app.db.transaction(async (tx) => {
      // ── Idempotency short-circuit ──────────────────────────────────
      const existing = await findExisting(tx);
      if (existing) return { spin: spinToView(existing), created: false };

      // ── Lock the user row (serialises this bettor's placements) ────
      const [user] = await tx
        .select({
          id: users.id,
          status: users.status,
          globalLimitMicro: users.globalLimitMicro,
          riskScore: users.riskScore,
        })
        .from(users)
        .where(eq(users.id, userId))
        .for("update")
        .limit(1);
      if (!user) throw new UnauthorizedError();
      if (user.status !== "active") {
        throw new ForbiddenError("account_not_active", "account_not_active");
      }

      const cfg = await loadConfig(tx);
      if (!cfg.enabled) throw new BadRequestError("disabled", "disabled");

      const currency = request.currency;
      if (!isCurrency(currency) || !cfg.currencies.includes(currency)) {
        throw new BadRequestError("currency_not_allowed", "currency_not_allowed");
      }
      if (stake < cfg.minStakeMicro) throw new BadRequestError("stake_below_min", "stake_below_min");
      if (stake > cfg.maxStakeMicro) throw new BadRequestError("stake_above_max", "stake_above_max");
      if (user.globalLimitMicro > 0n && stake > user.globalLimitMicro) {
        throw new BadRequestError("exceeds_global_limit", "exceeds_global_limit");
      }

      // ── Lock the (user, currency) wallet ───────────────────────────
      const [wallet] = await tx
        .select()
        .from(wallets)
        .where(and(eq(wallets.userId, userId), eq(wallets.currency, currency)))
        .for("update")
        .limit(1);
      if (!wallet) throw new NotFoundError("wallet_not_found", "wallet_not_found");
      if (stake > wallet.balanceMicro - wallet.lockedMicro) {
        throw new BadRequestError("insufficient_balance", "insufficient_balance");
      }

      // ── Lock the game row: the per-match cap and the totals hang off it
      const [game] = await tx
        .select()
        .from(slotzillaGames)
        .where(eq(slotzillaGames.matchId, matchId))
        .for("update")
        .limit(1);
      if (!game) throw new NotFoundError("slotzilla_game_not_found", "slotzilla_game_not_found");

      // A demo game is a LOOPING RECORDING, so it takes play money only.
      //
      // This is not a policy preference, it is the one thing that makes
      // the demo safe to run permanently: the loop repeats a finished
      // match, so after a single cycle a bettor knows every future
      // window's symbols exactly and can spin only on the ones that pay.
      // That is a guaranteed profit, not a bet.
      //
      // Deliberately NOT expressed through slotzilla_config.currencies —
      // that is an operator setting, and no operator setting should be
      // able to point real money at a known outcome. The check sits here,
      // inside the placement transaction and after the row lock, because
      // this is the last point before the wallet is debited.
      if (game.isDemo && currency !== "OZ") {
        throw new BadRequestError("demo_game_oz_only", "demo_game_oz_only");
      }

      const [openSpin] = await tx
        .select({ id: slotzillaSpins.id })
        .from(slotzillaSpins)
        .where(
          and(
            eq(slotzillaSpins.userId, userId),
            eq(slotzillaSpins.matchId, matchId),
            eq(slotzillaSpins.status, "open"),
          ),
        )
        .limit(1);

      const clockReadAtMs = game.clockReadAt?.getTime() ?? null;
      const block = spinBlockFor({
        enabled: cfg.enabled,
        hasUser: true,
        gameStatus: game.status,
        clockRunning: game.clockRunning,
        clockReadAtMs,
        nowMs,
        feedDarkVoidSeconds: cfg.feedDarkVoidSeconds,
        hasOpenSpin: openSpin !== undefined,
      });
      if (block === "open_spin") throw new ConflictError("open_spin", "open_spin");
      if (block) throw new BadRequestError(block, block);

      // ── Paytable + exposure ────────────────────────────────────────
      const paytable = await paytableForGame(tx, game.paytableId);
      if (!paytable) {
        throw new ServiceUnavailableError("slotzilla_no_paytable", "slotzilla_no_paytable");
      }
      const lines = paytableLinesOf(paytable.lines);
      const exposure = exposureMicro(stake, lines, cfg.maxPayoutMicro);

      // ── Per-match liability cap over every open spin on the game ──
      const [capRow] = (await tx.execute(sql`
        SELECT COALESCE(SUM(exposure_micro), 0)::text AS open_exposure
          FROM slotzilla_spins
         WHERE match_id = ${matchId.toString()}::bigint
           AND status = 'open'
      `)) as unknown as Array<{ open_exposure: string }>;
      const openExposure = BigInt(capRow?.open_exposure ?? "0");
      if (openExposure + exposure > cfg.matchLiabilityCapMicro) {
        throw new BadRequestError("slot_match_limit", "slot_match_limit");
      }

      // ── Velocity: trailing-minute spin count against the RiskZilla cap
      // RiskzillaEngine.evaluateVelocity counts TICKETS and wants market
      // legs a spin does not have, so the same cap is applied here to
      // the spin table directly, scaled by risk score the same way.
      const controls = await loadBotControls(tx);
      if (controls.velocityEnabled) {
        const cap = velocityCapFor(controls.maxBetsPerMinute, Number(user.riskScore));
        const [velRow] = (await tx.execute(sql`
          SELECT COUNT(*)::int AS spins
            FROM slotzilla_spins
           WHERE user_id = ${userId}::uuid
             AND placed_at >= now() - INTERVAL '60 seconds'
        `)) as unknown as Array<{ spins: number | string }>;
        if (Number(velRow?.spins ?? 0) + 1 > cap) {
          throw new BadRequestError(
            "velocity_bets_per_minute_exceeded",
            "velocity_bets_per_minute_exceeded",
          );
        }
      }

      // ── Window ─────────────────────────────────────────────────────
      const clockNow = estimatedClockSeconds(
        game.clockSeconds,
        game.clockRunning,
        clockReadAtMs,
        nowMs,
      );
      if (clockNow === null) throw new BadRequestError("clock_stopped", "clock_stopped");
      const windowFrom = firstWindowFor(clockNow, cfg.leadSeconds);

      // ── Insert the spin ────────────────────────────────────────────
      const [inserted] = await tx
        .insert(slotzillaSpins)
        .values({
          userId,
          matchId,
          currency,
          stakeMicro: stake,
          exposureMicro: exposure,
          paytableId: paytable.id,
          windowFrom,
          autoplay: request.autoplay === true,
          idempotencyKey: request.idempotencyKey,
        })
        .returning();
      if (!inserted) throw new Error("slotzilla_spins insert returned no row");

      // ── Lock the stake + ledger ────────────────────────────────────
      await tx
        .update(wallets)
        .set({ lockedMicro: sql`${wallets.lockedMicro} + ${stake}`, updatedAt: new Date() })
        .where(and(eq(wallets.userId, userId), eq(wallets.currency, currency)));
      await tx.insert(walletLedger).values({
        userId,
        currency,
        deltaMicro: -stake,
        type: "slot_stake",
        refType: "slotzilla_spin",
        refId: inserted.id,
        memo: null,
      });

      // ── RiskZilla open liability (USDC only) ───────────────────────
      if (currency.trim() === RISKZILLA_CURRENCY && exposure > 0n) {
        await tx.execute(sql`
          UPDATE riskzilla_bank_state
             SET open_liability_micro = open_liability_micro + ${exposure.toString()}::bigint,
                 updated_at = NOW()
           WHERE id = 'default'
        `);
      }

      // ── Game totals ────────────────────────────────────────────────
      await tx
        .update(slotzillaGames)
        .set({
          spinsCount: sql`${slotzillaGames.spinsCount} + 1`,
          ...(currency === "USDC"
            ? { usdcStakeMicro: sql`${slotzillaGames.usdcStakeMicro} + ${stake}` }
            : { ozStakeMicro: sql`${slotzillaGames.ozStakeMicro} + ${stake}` }),
          updatedAt: new Date(),
        })
        .where(eq(slotzillaGames.matchId, matchId));

      return { spin: spinToView(inserted), created: true };
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      const constraint = pgConstraint(err) ?? "";
      if (constraint.includes("idempotency")) {
        // Lost the race against our own retry — the winner's row is the answer.
        const existing = await findExisting(app.db);
        if (existing) return { spin: spinToView(existing), created: false };
      }
      throw new ConflictError("open_spin", "open_spin");
    }
    throw err;
  }

  if (result.created) await publishSpinFrame(app, userId, result.spin);
  return result;
}

// ── DB: voids (admin path; the Go service owns the automatic ones) ──────

export interface VoidedSpin {
  userId: string;
  view: SlotzillaSpinView;
}

/**
 * Void every open spin on a game inside the caller's transaction, per
 * the Money rules: `locked_micro -= stake` (balance untouched), one
 * `slot_refund` ledger row keyed on the spin (no-op on replay), the
 * USDC open liability released, the stake taken back off the game's
 * totals. Returns what was voided so the caller can publish frames
 * after commit.
 */
export async function voidOpenSpinsForGame(
  tx: SqlRunner,
  matchId: bigint,
  reason: string,
): Promise<VoidedSpin[]> {
  const open = await tx
    .select()
    .from(slotzillaSpins)
    .where(and(eq(slotzillaSpins.matchId, matchId), eq(slotzillaSpins.status, "open")))
    .for("update");
  const out: VoidedSpin[] = [];
  const now = new Date();
  for (const spin of open) {
    const [updated] = await tx
      .update(slotzillaSpins)
      .set({ status: "void", voidReason: reason, settledAt: now })
      .where(and(eq(slotzillaSpins.id, spin.id), eq(slotzillaSpins.status, "open")))
      .returning();
    if (!updated) continue;
    await tx
      .update(wallets)
      .set({
        lockedMicro: sql`${wallets.lockedMicro} - ${spin.stakeMicro}`,
        updatedAt: now,
      })
      .where(and(eq(wallets.userId, spin.userId), eq(wallets.currency, spin.currency)));
    await tx.execute(sql`
      INSERT INTO wallet_ledger (user_id, currency, delta_micro, type, ref_type, ref_id, memo)
      VALUES (${spin.userId}::uuid, ${spin.currency}, ${spin.stakeMicro.toString()}::bigint,
              'slot_refund', 'slotzilla_spin', ${spin.id}, ${reason})
      ON CONFLICT (type, ref_type, ref_id) WHERE ref_id IS NOT NULL DO NOTHING
    `);
    await releaseOpenLiability(tx, spin.currency, spin.exposureMicro);
    const isUsdc = spin.currency.trim() === "USDC";
    await tx
      .update(slotzillaGames)
      .set(
        isUsdc
          ? { usdcStakeMicro: sql`${slotzillaGames.usdcStakeMicro} - ${spin.stakeMicro}`, updatedAt: now }
          : { ozStakeMicro: sql`${slotzillaGames.ozStakeMicro} - ${spin.stakeMicro}`, updatedAt: now },
      )
      .where(eq(slotzillaGames.matchId, matchId));
    out.push({ userId: spin.userId, view: spinToView(updated) });
  }
  return out;
}

/** Realised return in basis points, or null with no stake. */
export function returnBp(stakeMicro: bigint, payoutMicro: bigint): number | null {
  if (stakeMicro <= 0n) return null;
  return Number((payoutMicro * 10_000n) / stakeMicro);
}
