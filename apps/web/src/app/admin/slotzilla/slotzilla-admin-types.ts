// Response shapes of the `/admin/slotzilla/*` routes AS THIS PAGE ASSUMES
// THEM. The api module (services/api/src/modules/admin/slotzilla.ts) was
// written concurrently against the same contract, so the two were never
// typechecked against each other: if a field is named differently there,
// this file is the ONE place to reconcile — every tab imports from here
// and nothing else in the page names a wire key.
//
// Conventions assumed from the contract: bigints travel as decimal
// strings (invariant 1), keys are camelCase, timestamps are ISO strings,
// and a list may arrive bare (`[...]`) or wrapped (`{games: [...]}`) —
// the `unwrap*` helpers at the bottom accept both, so a wrapping choice
// on the api side does not blank a tab.

import type {
  LineKey,
  PaytableLines,
  SlotSymbol,
  SlotTeam,
  SlotzillaGameStatus,
  SlotzillaSpinStatus,
} from "@oddzilla/types/slotzilla";

// ── Config (singleton row of slotzilla_config) ──────────────────────────

export interface SlotzillaConfigDto {
  enabled: boolean;
  /** Subset of ["USDC", "OZ"]. */
  currencies: string[];
  /** Return-to-player target, basis points (9700 = 97%). */
  rtpTargetBp: number;
  leadSeconds: number;
  clockPastSeconds: number;
  graceSeconds: number;
  feedDarkVoidSeconds: number;
  minStakeMicro: string;
  maxStakeMicro: string;
  maxPayoutMicro: string;
  matchLiabilityCapMicro: string;
  returnAlarmMarginBp: number;
  returnAlarmMinSpins: number;
  autoplayEnabled: boolean;
  updatedAt: string;
}

/** Body of `PUT /admin/slotzilla/config` — the same keys minus `updatedAt`. */
export type SlotzillaConfigUpdate = Omit<SlotzillaConfigDto, "updatedAt">;

// ── Paytables ───────────────────────────────────────────────────────────

export interface SlotzillaPaytableDto {
  /** bigserial; tolerated as a number in case the api serialises it that way. */
  id: string | number;
  name: string;
  lines: PaytableLines;
  fittedRtpBp: number | null;
  corpusNote: string | null;
  active: boolean;
  updatedAt: string;
}

export interface SlotzillaFitRequest {
  baseId?: string;
  targetBp?: number;
  coverageLevel?: number;
}

export interface SlotzillaFitResponse {
  lines: PaytableLines;
  factor: number;
  fittedBp: number;
  corpus: {
    matches: number;
    rounds: number;
    /** Share of rounds per line key (0..1). */
    byLine: Partial<Record<LineKey, number>>;
  };
}

// ── Games ───────────────────────────────────────────────────────────────

export interface SlotzillaGameClockDto {
  seconds: number | null;
  running: boolean;
  period: number | null;
  /** ISO time the service last read the clock. */
  readAt: string | null;
}

export interface SlotzillaGameTotalsDto {
  stakeMicro: string;
  payoutMicro: string;
  /** payout / stake in basis points; null when no stake yet. */
  returnBp: number | null;
}

export interface SlotzillaAdminGameDto {
  matchId: string;
  srMatchId: string;
  homeTeam: string;
  awayTeam: string;
  tournament: string | null;
  status: SlotzillaGameStatus;
  /** Sportradar coverage level; 2 = players on events. */
  coverageLevel: number | null;
  clock: SlotzillaGameClockDto;
  feedLagMs: number | null;
  spinsCount: number;
  totals: Partial<Record<"USDC" | "OZ", SlotzillaGameTotalsDto>>;
  /** Realised return above target + margin over at least min spins. */
  alarm: boolean;
  pausedAt: string | null;
  note: string | null;
}

// ── Spin log ────────────────────────────────────────────────────────────

export interface SlotzillaAdminSpinDto {
  id: string;
  userId?: string;
  userEmail?: string | null;
  nickname?: string | null;
  currency: string;
  stakeMicro: string;
  windowFrom: number;
  windows?: [number, number, number];
  reels: Array<SlotSymbol | null> | null;
  reelTeams?: Array<SlotTeam | null> | null;
  lineKey: LineKey | null;
  multiplierX100: number | null;
  payoutMicro: string;
  status: SlotzillaSpinStatus;
  voidReason: string | null;
  autoplay?: boolean;
  placedAt: string;
  settledAt: string | null;
}

export interface SlotzillaSpinLogResponse {
  spins: SlotzillaAdminSpinDto[];
  nextCursor?: string | null;
}

// ── Feed status (Redis hash slotzilla:feed:status + counts) ─────────────

export interface SlotzillaFeedStatusDto {
  online?: boolean;
  updatedUnix: number | null;
  games: number;
  liveGames: number;
  openSpins: number;
  lastFetchUnix: number | null;
  lastError: string | null;
  pollMs: number | null;
}

// ── Corpus ──────────────────────────────────────────────────────────────

export interface SlotzillaCorpusSummaryDto {
  matches: number;
  events: number;
  rounds: number;
  /** Per line key: a share of rounds (0..1) or, tolerated, a raw count. */
  byLine: Partial<Record<LineKey, number>>;
}

export interface SlotzillaCorpusFetchRequest {
  from: string;
  to: string;
  srSportId?: number;
  maxMatches?: number;
}

/** Counts the fetch returns; the exact key set is the api's, so render whatever numbers arrive. */
export type SlotzillaCorpusFetchResponse = Record<string, unknown>;

// ── Unwrapping (bare vs wrapped responses) ──────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** `{config: T}` or `T` → `T`; anything else → null. */
export function unwrapObject<T>(raw: unknown, key: string): T | null {
  if (!isRecord(raw)) return null;
  const inner = raw[key];
  if (isRecord(inner)) return inner as T;
  return raw as T;
}

/** `{key: T[]}` or `T[]` → `T[]`; anything else → an empty list. */
export function unwrapList<T>(raw: unknown, key: string): T[] {
  if (Array.isArray(raw)) return raw as T[];
  if (isRecord(raw) && Array.isArray(raw[key])) return raw[key] as T[];
  return [];
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * The status hash comes out of Redis as strings; coerce every field so a
 * "12" never reaches a comparison as text. Accepts both camelCase and the
 * hash's own snake_case field names.
 */
export function normaliseFeedStatus(raw: unknown): SlotzillaFeedStatusDto | null {
  const r = unwrapObject<Record<string, unknown>>(raw, "status");
  if (!r) return null;
  const pick = (camel: string, snake: string): unknown =>
    r[camel] !== undefined ? r[camel] : r[snake];
  const online = pick("online", "online");
  return {
    online: typeof online === "boolean" ? online : undefined,
    updatedUnix: num(pick("updatedUnix", "updated_unix")),
    games: num(pick("games", "games")) ?? 0,
    liveGames: num(pick("liveGames", "live_games")) ?? 0,
    openSpins: num(pick("openSpins", "open_spins")) ?? 0,
    lastFetchUnix: num(pick("lastFetchUnix", "last_fetch_unix")),
    lastError: (() => {
      const e = pick("lastError", "last_error");
      return typeof e === "string" && e.length > 0 ? e : null;
    })(),
    pollMs: num(pick("pollMs", "poll_ms")),
  };
}

export function normaliseCorpusSummary(raw: unknown): SlotzillaCorpusSummaryDto | null {
  const r = unwrapObject<Record<string, unknown>>(raw, "summary");
  if (!r) return null;
  const byLine = isRecord(r.byLine) ? (r.byLine as Partial<Record<LineKey, number>>) : {};
  return {
    matches: num(r.matches) ?? 0,
    events: num(r.events) ?? 0,
    rounds: num(r.rounds) ?? 0,
    byLine,
  };
}
