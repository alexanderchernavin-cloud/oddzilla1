// SlotZilla — the 15-second live-basketball slot game.
//
// Everything in this module is PURE: the symbol a Sportradar event maps
// to, which symbol a 5-second window shows, which paytable line three
// reels form, what a line pays, and the calibrator that fits multipliers
// to a return target. The api evaluates spins with it, the storefront
// renders reels with it, and the backoffice previews paytables with it,
// so they cannot disagree. The Go service (services/slotzilla) carries a
// port of the same rules — per the one-Go-module-per-service rule — and
// both are pinned against docs/fixtures/slotzilla-rules.json.
//
// The measurements behind the constants are in docs/SLOTZILLA.md.
//
// Import via the `@oddzilla/types/slotzilla` subpath, never the barrel
// (apps/web pulls values from here; see the barrel-imports footgun).

// ── Symbols ─────────────────────────────────────────────────────────────

/** The six reel symbols, highest value first. */
export const SLOT_SYMBOLS = ["P3", "P2", "FT", "MISS", "FOUL", "NONE"] as const;
export type SlotSymbol = (typeof SLOT_SYMBOLS)[number];

/** Higher wins a window: a 3-pointer beats a 2-pointer beats a free throw beats a miss beats a foul beats nothing. */
export const SYMBOL_RANK: Readonly<Record<SlotSymbol, number>> = {
  P3: 6,
  P2: 5,
  FT: 4,
  MISS: 3,
  FOUL: 2,
  NONE: 1,
};

export function isSlotSymbol(v: unknown): v is SlotSymbol {
  return typeof v === "string" && (SLOT_SYMBOLS as readonly string[]).includes(v);
}

/**
 * The symbol a Sportradar timeline event contributes, or null when the
 * event makes no symbol (rebounds, turnovers, timeouts, clock events —
 * everything the v1 reels ignore). `goal` is any scored basket and
 * carries `points` 1 / 2 / 3; a goal with an unknown point value is
 * deliberately null rather than guessed, so a feed change can never pay
 * a 2-pointer as a 3-pointer.
 */
export function symbolForEvent(e: {
  type: string;
  points?: number | null;
}): Exclude<SlotSymbol, "NONE"> | null {
  switch (e.type) {
    case "goal":
      if (e.points === 3) return "P3";
      if (e.points === 2) return "P2";
      if (e.points === 1) return "FT";
      return null;
    case "attempt_missed":
      return "MISS";
    case "foul":
      return "FOUL";
    default:
      return null;
  }
}

// ── Windows and rounds ──────────────────────────────────────────────────

/** Each reel watches this many seconds of match clock. */
export const WINDOW_SECONDS = 5;
/** A spin is this many consecutive windows. */
export const ROUND_WINDOWS = 3;
export const ROUND_SECONDS = WINDOW_SECONDS * ROUND_WINDOWS;

/** The window (its start second) that a match-clock reading falls in. */
export function windowStartOf(clockSeconds: number): number {
  return Math.floor(clockSeconds / WINDOW_SECONDS) * WINDOW_SECONDS;
}

/**
 * Where a spin's first window opens: the first 5-second mark of the match
 * clock at least `leadSeconds` after the reading we hold. Operator's
 * rule, 2026-09-09 — Betby's 38:33 becomes our 38:35 — and it is what
 * makes every window one of a fixed set on the match, so its symbol is
 * derived once and shared by every spin that covers it.
 */
export function firstWindowFor(clockSeconds: number, leadSeconds: number): number {
  const earliest = clockSeconds + leadSeconds;
  return Math.ceil(earliest / WINDOW_SECONDS) * WINDOW_SECONDS;
}

/** The three window starts of a spin that opens at `windowFrom`. */
export function roundWindows(windowFrom: number): [number, number, number] {
  return [windowFrom, windowFrom + WINDOW_SECONDS, windowFrom + 2 * WINDOW_SECONDS];
}

/** The match-clock second after which a spin's last window is complete. */
export function roundEnd(windowFrom: number): number {
  return windowFrom + ROUND_SECONDS;
}

/** `mm:ss` of a cumulative match-clock reading. */
export function formatMatchClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r < 10 ? "0" : ""}${r}`;
}

/** The inclusive label a reel wears: "38:35–38:39". */
export function formatWindowLabel(windowFrom: number): string {
  return `${formatMatchClock(windowFrom)}–${formatMatchClock(windowFrom + WINDOW_SECONDS - 1)}`;
}

// ── Reels ───────────────────────────────────────────────────────────────

export type SlotTeam = "home" | "away";

/** The slice of a stored event the reel derivation reads. */
export interface ReelEvent {
  symbol: SlotSymbol | null;
  /** Cumulative match-clock second the scout logged the event at. */
  seconds: number;
  disabled?: boolean;
  team?: SlotTeam | null;
  /** Sportradar's event id, as a string so bigint survives JSON. */
  eventId?: string | null;
}

export interface Reel {
  symbol: SlotSymbol;
  team: SlotTeam | null;
  eventId: string | null;
}

/**
 * The reel for one window: the highest-ranked enabled event whose clock
 * reading falls inside [windowFrom, windowFrom + 5). Ties break on the
 * earlier event, then the lower id, so the answer is deterministic
 * whatever order the events arrive in. A window with nothing in it is
 * NONE, which is a symbol like any other and pays from the paytable.
 */
export function reelForWindow(events: readonly ReelEvent[], windowFrom: number): Reel {
  let best: (ReelEvent & { symbol: SlotSymbol }) | null = null;
  const to = windowFrom + WINDOW_SECONDS;
  for (const e of events) {
    if (!e.symbol || e.disabled) continue;
    if (e.seconds < windowFrom || e.seconds >= to) continue;
    if (best === null) {
      best = e as ReelEvent & { symbol: SlotSymbol };
      continue;
    }
    const r = SYMBOL_RANK[e.symbol];
    const rb = SYMBOL_RANK[best.symbol];
    if (r > rb) {
      best = e as ReelEvent & { symbol: SlotSymbol };
    } else if (r === rb) {
      if (e.seconds < best.seconds) best = e as ReelEvent & { symbol: SlotSymbol };
      else if (e.seconds === best.seconds && compareIds(e.eventId, best.eventId) < 0) {
        best = e as ReelEvent & { symbol: SlotSymbol };
      }
    }
  }
  if (!best) return { symbol: "NONE", team: null, eventId: null };
  return { symbol: best.symbol, team: best.team ?? null, eventId: best.eventId ?? null };
}

function compareIds(a: string | null | undefined, b: string | null | undefined): number {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  // Numeric ids compared by length then lexically, which orders decimal
  // strings numerically without a bigint parse.
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The three reels of a spin from the events it can see. */
export function reelsForRound(events: readonly ReelEvent[], windowFrom: number): [Reel, Reel, Reel] {
  const [a, b, c] = roundWindows(windowFrom);
  return [reelForWindow(events, a), reelForWindow(events, b), reelForWindow(events, c)];
}

// ── Lines ───────────────────────────────────────────────────────────────

/** `any2:<symbol>` = exactly two reels on the symbol; `all3:<symbol>` = all three. */
export type LineKey = `any2:${SlotSymbol}` | `all3:${SlotSymbol}`;

export const LINE_KEYS: readonly LineKey[] = SLOT_SYMBOLS.flatMap((s) => [
  `all3:${s}` as LineKey,
  `any2:${s}` as LineKey,
]);

export function isLineKey(v: unknown): v is LineKey {
  return typeof v === "string" && (LINE_KEYS as readonly string[]).includes(v);
}

/**
 * The paytable line three reels form, or null when all three differ.
 * With three reels, "exactly two the same" is unambiguous — there is
 * never a second pair to choose over.
 */
export function evaluateLine(reels: readonly [SlotSymbol, SlotSymbol, SlotSymbol]): LineKey | null {
  const [a, b, c] = reels;
  if (a === b && b === c) return `all3:${a}`;
  if (a === b) return `any2:${a}`;
  if (b === c) return `any2:${b}`;
  if (a === c) return `any2:${a}`;
  return null;
}

// ── Paytable and money ──────────────────────────────────────────────────

/**
 * Multipliers in HUNDREDTHS (x100): 50 = ×0.5, 3500 = ×35. Integers so
 * that a payout is exact bigint arithmetic on the micro stake and the
 * editor never round-trips a float. A line absent from the table pays
 * nothing.
 */
export type PaytableLines = Partial<Record<LineKey, number>>;

/** stake × multiplier, floored to the micro unit. */
export function payoutMicro(stakeMicro: bigint, multiplierX100: number): bigint {
  if (!Number.isInteger(multiplierX100) || multiplierX100 < 0) {
    throw new RangeError(`multiplierX100 must be a non-negative integer, got ${multiplierX100}`);
  }
  return (stakeMicro * BigInt(multiplierX100)) / 100n;
}

export function maxMultiplierX100(lines: PaytableLines): number {
  let max = 0;
  for (const v of Object.values(lines)) if (typeof v === "number" && v > max) max = v;
  return max;
}

/**
 * The worst case the book carries on one spin: stake × the top line,
 * bounded by the operator's max payout per spin. This is what the api
 * adds to RiskZilla's open liability for USDC and what the per-match cap
 * is checked against.
 */
export function exposureMicro(
  stakeMicro: bigint,
  lines: PaytableLines,
  maxPayoutMicro: bigint,
): bigint {
  const raw = payoutMicro(stakeMicro, maxMultiplierX100(lines));
  return raw < maxPayoutMicro ? raw : maxPayoutMicro;
}

/** Format a x100 multiplier for display: 50 → "0.5", 3500 → "35". */
export function formatMultiplier(x100: number): string {
  const whole = Math.floor(x100 / 100);
  const frac = x100 % 100;
  if (frac === 0) return String(whole);
  const f = frac < 10 ? `0${frac}` : String(frac);
  return `${whole}.${f.replace(/0$/u, "")}`;
}

/**
 * The indicative v1 paytable from docs/SLOTZILLA.md: Betby's grid shape
 * with six symbols, the NONE rows at Betby's ×0.5 / ×1, the play rows
 * scaled to the operator's 97% on the measured rounds, and the All-3
 * lines nobody has observed at Betby's ratios under the payout cap. The
 * calibrator replaces every number once the corpus exists; this is what
 * a fresh database seeds.
 */
export const DEFAULT_PAYTABLE_LINES: Readonly<PaytableLines> = {
  "any2:P3": 3500,
  "all3:P3": 50000,
  "any2:P2": 1800,
  "all3:P2": 20000,
  "any2:FT": 2200,
  "all3:FT": 25000,
  "any2:MISS": 900,
  "all3:MISS": 5500,
  "any2:FOUL": 500,
  "all3:FOUL": 1800,
  "any2:NONE": 50,
  "all3:NONE": 100,
};

/** Lines the calibrator holds fixed: empty reels give half back / money back and never more. */
export const FIXED_LINES: readonly LineKey[] = ["any2:NONE", "all3:NONE"];

// ── Calibrator ──────────────────────────────────────────────────────────

export type RoundReels = readonly [SlotSymbol, SlotSymbol, SlotSymbol];

/** Share of rounds landing on each line (0..1), from a corpus of spin-anchored rounds. */
export function lineFrequencies(rounds: readonly RoundReels[]): Record<LineKey, number> {
  const counts = Object.fromEntries(LINE_KEYS.map((k) => [k, 0])) as Record<LineKey, number>;
  for (const r of rounds) {
    const line = evaluateLine(r);
    if (line) counts[line] += 1;
  }
  const n = rounds.length;
  if (n === 0) return counts;
  for (const k of LINE_KEYS) counts[k] = counts[k] / n;
  return counts;
}

/**
 * Every spin-anchored 15-second round a sequence of window symbols
 * allows, sliding by one window. Rounds anchor at the bettor's spin, so
 * every window start is a possible first window and the calibrator must
 * count them all, not a fixed grid of thirds.
 */
export function slidingRounds(windowSymbols: readonly SlotSymbol[]): RoundReels[] {
  const out: RoundReels[] = [];
  for (let i = 0; i + ROUND_WINDOWS <= windowSymbols.length; i++) {
    out.push([windowSymbols[i]!, windowSymbols[i + 1]!, windowSymbols[i + 2]!]);
  }
  return out;
}

/** Expected return in basis points (9700 = 97%) of a paytable against measured line frequencies. */
export function expectedReturnBp(lines: PaytableLines, freq: Record<LineKey, number>): number {
  let ret = 0;
  for (const k of LINE_KEYS) {
    const m = lines[k];
    if (typeof m === "number") ret += (freq[k] ?? 0) * (m / 100);
  }
  return Math.round(ret * 10_000);
}

/**
 * Scale the non-fixed lines of `base` by one factor so the paytable
 * returns `targetBp` against `freq`, holding `fixed` lines exactly. The
 * fixed lines' contribution is subtracted first; if they alone exceed the
 * target the factor floors at 0 and the play rows pay nothing, which the
 * caller must treat as "target unreachable" rather than ship.
 */
export function fitLinesToTarget(
  base: PaytableLines,
  freq: Record<LineKey, number>,
  targetBp: number,
  fixed: readonly LineKey[] = FIXED_LINES,
): { lines: PaytableLines; factor: number; fittedBp: number } {
  const fixedSet = new Set(fixed);
  let fixedReturn = 0;
  let scalableReturn = 0;
  for (const k of LINE_KEYS) {
    const m = base[k];
    if (typeof m !== "number") continue;
    const contrib = (freq[k] ?? 0) * (m / 100);
    if (fixedSet.has(k)) fixedReturn += contrib;
    else scalableReturn += contrib;
  }
  const target = targetBp / 10_000;
  const factor = scalableReturn > 0 ? Math.max(0, (target - fixedReturn) / scalableReturn) : 0;
  const lines: PaytableLines = {};
  for (const k of LINE_KEYS) {
    const m = base[k];
    if (typeof m !== "number") continue;
    lines[k] = fixedSet.has(k) ? m : Math.round(m * factor);
  }
  return { lines, factor, fittedBp: expectedReturnBp(lines, freq) };
}

// ── Wire shapes ─────────────────────────────────────────────────────────

export type SlotzillaGameStatus = "scheduled" | "live" | "paused" | "ended" | "voided";
export type SlotzillaSpinStatus = "open" | "won" | "lost" | "void";

/** The match clock as the service last read it; the browser advances it locally while `running`. */
export interface SlotzillaClock {
  /** Cumulative match-clock seconds, null before tip-off. */
  seconds: number | null;
  running: boolean;
  /** Unix ms the reading was taken. */
  atMs: number;
  period: number | null;
}

/** One 5-second window's symbol, shared by every spin that covers it. */
export interface SlotzillaWindow {
  from: number;
  symbol: SlotSymbol;
  team: SlotTeam | null;
  eventId: string | null;
  /** True once the clock is past the window and its grace has elapsed; the symbol no longer changes. */
  final: boolean;
}

export interface SlotzillaSpinView {
  id: string;
  matchId: string;
  currency: string;
  stakeMicro: string;
  windowFrom: number;
  windows: [number, number, number];
  /** null per reel until its window has a symbol worth showing. */
  reels: [SlotSymbol | null, SlotSymbol | null, SlotSymbol | null];
  reelTeams: [SlotTeam | null, SlotTeam | null, SlotTeam | null];
  lineKey: LineKey | null;
  multiplierX100: number | null;
  payoutMicro: string;
  status: SlotzillaSpinStatus;
  voidReason: string | null;
  placedAt: string;
  settledAt: string | null;
}

export interface SlotzillaLimits {
  currencies: string[];
  minStakeMicro: string;
  maxStakeMicro: string;
  maxPayoutMicro: string;
  leadSeconds: number;
  autoplayEnabled: boolean;
}

export interface SlotzillaPaytableView {
  id: string;
  name: string;
  lines: PaytableLines;
}

export type SlotzillaSpinBlock =
  | "game_not_live"
  | "clock_stopped"
  | "game_paused"
  | "open_spin"
  | "sign_in"
  | "disabled";

export interface SlotzillaGameState {
  matchId: string;
  srMatchId: string;
  status: SlotzillaGameStatus;
  coverageLevel: number | null;
  /** Level-2 coverage: scorers and assists are on the events. */
  playerMode: boolean;
  clock: SlotzillaClock;
  windowSeconds: number;
  /** The most recent windows the service holds, oldest first. */
  windows: SlotzillaWindow[];
  paytable: SlotzillaPaytableView;
  limits: SlotzillaLimits;
  openSpin: SlotzillaSpinView | null;
  recentSpins: SlotzillaSpinView[];
  canSpin: boolean;
  spinBlock: SlotzillaSpinBlock | null;
  /** Kickoff, ISO-8601; what a `scheduled` game shows in place of a clock. */
  scheduledAt?: string | null;
}

/**
 * A game on the list: every basketball fixture the game COVERS (a
 * confirmed Sportradar mapping), live ones first. A fixture the service
 * has not opened yet is `scheduled` with a null clock and its kickoff.
 */
export interface SlotzillaLiveGame {
  matchId: string;
  /** Sportradar's match id, for the tracker beside the game. */
  srMatchId: string;
  status: SlotzillaGameStatus;
  homeTeam: string;
  awayTeam: string;
  tournament: string | null;
  sportSlug: string;
  clock: SlotzillaClock;
  score: { home: number | null; away: number | null };
  playerMode: boolean;
  /** Kickoff, ISO-8601. */
  scheduledAt: string | null;
}

export interface SlotzillaSpinRequest {
  currency: string;
  stakeMicro: string;
  idempotencyKey: string;
  autoplay?: boolean;
}

/** Public frame on `odds:match:{id}`: the clock and the shared windows. */
export interface WsSlotzillaState {
  type: "slotzilla_state";
  matchId: string;
  status: SlotzillaGameStatus;
  clock: SlotzillaClock;
  windows: SlotzillaWindow[];
  ts: number;
}

/** Per-bettor frame on `user:{id}`: a spin changed (reels filled, settled, voided). */
export interface WsSlotzillaSpin {
  type: "slotzilla_spin";
  spin: SlotzillaSpinView;
  ts: number;
}
