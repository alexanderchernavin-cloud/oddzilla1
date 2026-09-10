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

// ── Countdown display ───────────────────────────────────────────────────
//
// Everything the game is BUILT on is cumulative match-clock seconds: a
// window's identity is `window_from`, settlement compares against it, and
// the events carry the scout's own cumulative reading. None of that
// changes here. This is presentation only — basketball is played to a
// clock that counts DOWN inside a period, and showing a bettor "26:34"
// beside a tracker reading "3rd | 3:26" asks them to do arithmetic to
// know when their spin lands (operator's call, 2026-09-10).

/**
 * Length of a regulation period, in seconds.
 *
 * FIBA plays 4 x 10 minutes, which covers every competition SlotZilla
 * currently carries — the World Cup, the European and Mexican leagues,
 * the Asian and Australian clubs. The NBA's 12-minute quarters would need
 * this per competition, so if NBA coverage is ever added this constant is
 * the thing that has to become a lookup; the period LABEL comes from the
 * feed either way, so a wrong length here would misstate the time
 * remaining but never the quarter.
 */
export const PERIOD_SECONDS = 600;
/** FIBA overtime is five minutes. */
export const OVERTIME_SECONDS = 300;
/** FIBA and the NBA both play four regulation periods. */
export const REGULATION_PERIODS = 4;

/**
 * A competition's period structure, as Sportradar states it per match.
 * Every field optional: the feed does not always say, and a caller that
 * silently substituted FIBA's 4 x 10 for the NBA's 4 x 12 would misstate
 * every countdown by two minutes a quarter without anything looking
 * wrong — the quarter LABEL comes from the feed and would stay right.
 */
export interface SlotzillaPeriodFormat {
  periodSeconds?: number | null;
  overtimeSeconds?: number | null;
  regulationPeriods?: number | null;
}

export interface PeriodClock {
  /** 1-4 in regulation, 5+ for overtime. */
  period: number;
  /** Seconds left in that period, counting down. */
  remaining: number;
  /** True once past regulation. */
  overtime: boolean;
}

/**
 * Turn a cumulative match-clock reading into the period and the time
 * remaining in it.
 *
 * `feedPeriod` wins when supplied: the feed knows which quarter is being
 * played, and trusting arithmetic over it would relabel the whole strip
 * the moment a competition ran a different period length. The remaining
 * time is then clamped into the period, so a mismatch between the feed's
 * period and PERIOD_SECONDS degrades to a slightly wrong countdown rather
 * than a negative one.
 */
export function periodClock(
  cumulativeSeconds: number,
  feedPeriod?: number | null,
  format?: SlotzillaPeriodFormat | null,
): PeriodClock {
  const s = Math.max(0, Math.floor(cumulativeSeconds));
  // The feed's own format when it stated one, FIBA otherwise. Guarded
  // rather than trusted: a zero or negative length from a malformed
  // document would divide the whole clock into nothing.
  const periodLen =
    format?.periodSeconds && format.periodSeconds > 0 ? format.periodSeconds : PERIOD_SECONDS;
  const otLen =
    format?.overtimeSeconds && format.overtimeSeconds > 0
      ? format.overtimeSeconds
      : OVERTIME_SECONDS;
  const periods =
    format?.regulationPeriods && format.regulationPeriods > 0
      ? format.regulationPeriods
      : REGULATION_PERIODS;
  const regulation = periods * periodLen;

  if (s >= regulation) {
    const intoOt = s - regulation;
    const otIndex = Math.floor(intoOt / otLen);
    const elapsed = intoOt - otIndex * otLen;
    return {
      period: feedPeriod && feedPeriod > periods ? feedPeriod : periods + 1 + otIndex,
      remaining: Math.max(0, otLen - elapsed),
      overtime: true,
    };
  }

  const derived = Math.floor(s / periodLen) + 1;
  const period = feedPeriod && feedPeriod >= 1 && feedPeriod <= periods ? feedPeriod : derived;
  const elapsed = s - (period - 1) * periodLen;
  return {
    period,
    // Clamped both ways: the feed's period and our period length can
    // disagree, and neither a negative countdown nor one above the
    // period length is a thing a bettor should ever be shown.
    remaining: Math.min(periodLen, Math.max(0, periodLen - elapsed)),
    overtime: false,
  };
}

/** "4:02" — the time remaining in the period the reading falls in. */
export function formatCountdown(
  cumulativeSeconds: number,
  feedPeriod?: number | null,
  format?: SlotzillaPeriodFormat | null,
): string {
  return formatMatchClock(periodClock(cumulativeSeconds, feedPeriod, format).remaining);
}

/**
 * A reel's label as a countdown: "4:25–4:21".
 *
 * Counting down means the END of the window has the SMALLER number, so
 * the range reads high-to-low. Writing it low-to-high would be tidier and
 * would say the window runs backwards.
 */
export function formatWindowCountdown(
  windowFrom: number,
  feedPeriod?: number | null,
  format?: SlotzillaPeriodFormat | null,
): string {
  const start = formatCountdown(windowFrom, feedPeriod, format);
  const end = formatCountdown(windowFrom + WINDOW_SECONDS - 1, feedPeriod, format);
  return `${start}–${end}`;
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
export interface SlotzillaClock extends SlotzillaPeriodFormat {
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
  /**
   * How stale a clock reading may be before a spin is refused. Carried to
   * the client so its local block mirror can apply the SAME rule the api
   * does — a stopped clock is placeable, a stale one is not — instead of
   * blocking on `running` and offering a spin the server would reject.
   */
  feedDarkVoidSeconds: number;
}

/**
 * Is a clock reading recent enough to place against?
 *
 * A STOPPED clock is fine — the match is telling us where it is, and a
 * spin's windows simply begin when play resumes. A STALE one is not: we
 * have lost track of the match, and the settler voids open spins for
 * exactly that reason.
 *
 * Shared so the api's authoritative gate and the storefront's local
 * mirror cannot drift; a mirror that blocks on something the server
 * allows hides a spin the bettor could have had, and one that allows
 * what the server blocks offers a spin that will be refused.
 */
export function clockIsFresh(
  clockReadAtMs: number | null,
  nowMs: number,
  feedDarkVoidSeconds: number,
): boolean {
  if (clockReadAtMs === null) return false;
  return nowMs - clockReadAtMs < feedDarkVoidSeconds * 1000;
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
  /**
   * A looping recording of a finished fixture rather than a live game.
   * The storefront MUST mark these, and placement refuses anything but OZ
   * on them: a loop is perfectly predictable once seen, so a real-money
   * spin would be a guaranteed-profit exploit rather than a bet.
   */
  demo: boolean;
  /**
   * The play-by-play the reels are derived from, oldest first, over the
   * window the panel draws. Present on the state so the timeline strip
   * needs no second request per poll.
   */
  timeline: SlotzillaTimelineEvent[];
}

/**
 * One event on the match timeline strip. `seconds` is the scout's own
 * cumulative match-clock reading — the same axis the windows are ranges
 * of — so the strip and the reels can never disagree about when
 * something happened.
 */
export interface SlotzillaTimelineEvent {
  id: string;
  /** The reel symbol, or null for an event that makes none (a rebound). */
  symbol: Exclude<SlotSymbol, "NONE"> | null;
  /** Sportradar's own event type, for the icon and the tooltip. */
  type: string;
  team: SlotTeam | null;
  seconds: number;
  period: number | null;
  /** Level-2 coverage only. */
  playerName: string | null;
  /** A correction disabled it; drawn faded rather than removed. */
  disabled: boolean;
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
  /** A looping recording — see the note on SlotzillaGameState.demo. */
  demo: boolean;
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
