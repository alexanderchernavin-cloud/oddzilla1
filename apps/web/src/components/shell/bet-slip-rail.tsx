"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { fromMicro, toMicro } from "@oddzilla/types/money";
import { SUPPORTED_CURRENCIES, type Currency } from "@oddzilla/types/currencies";
// Runtime imports MUST come from the /products subpath (mirrors the
// currencies workaround) — Next.js webpack can't resolve ".js" imports
// re-exported from the package root because the package ships TS source.
// Type-only `BetMeta` etc go through the bare path since they're erased.
import { parseProbability, priceTiple, priceTippot } from "@oddzilla/types/products";
import type { TippotTier } from "@oddzilla/types/products";
import {
  computeCombiBoost,
  type CombiBoostTier,
  type CombiBoostConfigLive,
} from "@oddzilla/types/combi-boost";
import { useCombiBoostConfig } from "@/lib/combi-boost-config";
import type {
  BetBuilderQuoteAcceptedResponse,
  BetBuilderQuoteResponse,
} from "@oddzilla/types";
import { useBetSlip, type SlipMode } from "@/lib/bet-slip";
import {
  useLiveMarketStatusForMatches,
  useLiveOddsForMatches,
} from "@/lib/use-live-odds";
import { useTicketStream } from "@/lib/use-ticket-stream";
import { clientApi, ApiFetchError } from "@/lib/api-client";
import { I } from "@/components/ui/icons";
import { Button } from "@/components/ui/primitives";
import { SportGlyph } from "@/components/ui/sport-glyph";
import { useMobileDrawers } from "./mobile-drawer-context";
import { UserControls } from "./user-controls";
import { useWallets } from "@/lib/wallets";
import { useTranslations } from "@/lib/i18n";
import { RailMatchPanel } from "@/components/widgets/rail-match-panel";
import type {
  SlipSelection,
  TicketListResponse,
  TicketStatus,
  TicketSummary,
  WsTicketFrame,
} from "@oddzilla/types";

// Strip any `{specifier}` placeholders that didn't get resolved upstream.
// Defensive against legacy localStorage entries (legs added before the
// engine label-substitution fix landed) and against any future market
// row whose specifiers don't fully populate the description template.
// Doubled spaces and orphan dashes left behind by the strip are cleaned
// up so the result reads naturally.
function stripUnresolvedPlaceholders(s: string): string {
  return s
    .replace(/\{[a-z0-9_]+\}/gi, "")
    .replace(/\s+-\s*$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// Default product margins for the client-side preview. The server is
// authoritative — it loads bet_product_config and computes the effective
// margin as `(1 + base) × (1 + per_leg)^N − 1`. These constants mirror
// the migration 0017 + 0018 defaults so the preview matches a freshly-
// deployed prod config; admin overrides aren't pushed to the client.
const PREVIEW_TIPLE_BASE_BP = 1500;
const PREVIEW_TIPLE_PER_LEG_BP = 0;
const PREVIEW_TIPPOT_BASE_BP = 0;
const PREVIEW_TIPPOT_PER_LEG_BP = 500;

function effectiveMarginBp(baseBp: number, perLegBp: number, n: number): number {
  return Math.round(
    ((1 + baseBp / 10000) * Math.pow(1 + perLegBp / 10000, n) - 1) * 10000,
  );
}

const DRIFT_ERROR_MESSAGE = "The odds moved since you clicked. Try again.";
const SUSPENDED_ERROR_MESSAGE = "This market is suspended. Try again in a moment.";

// Live countdown to an absolute timestamp. Returns whole seconds remaining,
// clamped at 0. Re-renders every second while > 0 and stops the interval
// once the deadline passes (avoids needless re-renders for tickets that
// have already promoted to accepted). Returns null when `iso` is falsy
// so callers can branch without an extra guard.
function useSecondsUntil(iso: string | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!iso) return;
    const target = new Date(iso).getTime();
    if (!Number.isFinite(target) || target <= Date.now()) return;
    const id = window.setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (t >= target) window.clearInterval(id);
    }, 1000);
    return () => window.clearInterval(id);
  }, [iso]);
  if (!iso) return null;
  const target = new Date(iso).getTime();
  if (!Number.isFinite(target)) return null;
  return Math.max(0, Math.ceil((target - now) / 1000));
}

type RailTab = "slip" | "history";

interface BetSlipRailProps {
  signedIn: boolean;
  user?: { email: string; displayName: string | null; role: string };
}

export function BetSlipRail({ signedIn, user }: BetSlipRailProps) {
  const slip = useBetSlip();
  const selections = slip.selections;
  const currency = slip.currency;
  const { closeAll } = useMobileDrawers();
  const router = useRouter();
  const { optimisticDeduct: optimisticDeductWallet } = useWallets();
  const t = useTranslations("betSlip");
  const [stakeInput, setStakeInput] = useState("10");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The most recent placement. Lives across the bet-delay window so the
  // slip can render the countdown / drift / suspended state inline and
  // the post-acceptance success card. WS ticket frames mutate
  // `placedTicket.status` in place — pending_delay → accepted clears the
  // slip + switches to history, pending_delay → rejected keeps the slip
  // populated so the bettor can re-place with the freshly-updated odds.
  const [placedTicket, setPlacedTicket] = useState<TicketSummary | null>(null);
  // Bettor opt-in for the live-bet acceptance delay window. Persisted in
  // localStorage so the choice survives reloads. When true the API sets
  // the same flag on the ticket; the bet-delay worker re-prices the
  // ticket at the latest odds instead of rejecting on drift (single +
  // combo only).
  const [acceptOddsChanges, setAcceptOddsChangesState] = useState(false);
  const [activeTab, setActiveTab] = useState<RailTab>("slip");

  useEffect(() => {
    try {
      if (window.localStorage.getItem("oz.acceptOddsChanges") === "1") {
        setAcceptOddsChangesState(true);
      }
    } catch {
      // localStorage unavailable — default to false.
    }
  }, []);
  const setAcceptOddsChanges = useCallback((v: boolean) => {
    setAcceptOddsChangesState(v);
    try {
      window.localStorage.setItem("oz.acceptOddsChanges", v ? "1" : "0");
    } catch {
      // ignore
    }
  }, []);

  // Drop the post-placement view as soon as the user starts a new slip
  // — otherwise the success / rejection card would shadow new picks
  // indefinitely. Pending placements stay sticky so a user clicking
  // around the site during the wait window still sees the countdown.
  useEffect(() => {
    if (
      selections.length > 0 &&
      placedTicket &&
      placedTicket.status !== "pending_delay"
    ) {
      setPlacedTicket(null);
    }
  }, [selections.length, placedTicket]);

  // Rail-level ticket-frame subscription. When the bet-delay worker
  // resolves the ticket we either clear the slip + switch to history
  // (accepted — the slip is done) or keep the slip populated (rejected
  // — user can edit + retry). The HistoryPane has its own subscription
  // for live list updates; the two run independently.
  useTicketStream(
    useCallback((frame) => {
      setPlacedTicket((prev) => {
        if (!prev || prev.id !== frame.ticketId) return prev;
        if (frame.status === "accepted") {
          slip.clear();
          setActiveTab("history");
          // Refresh wallets/server data so any debit/refund settles.
          router.refresh();
          // Drop the pending card — the new ticket lives in History now.
          return null;
        }
        if (frame.status === "rejected") {
          // Stake was refunded by the worker. Reconcile balances. Slip
          // selections stay populated so the bettor can re-place with
          // the latest pendingOdds (the WS odds ticks have been flowing
          // into `s.pendingOdds` all along, so a one-click "Accept odds
          // change" + Place bet is the typical retry path).
          router.refresh();
          return {
            ...prev,
            status: "rejected",
            rejectReason: frame.rejectReason ?? "rejected",
          };
        }
        // Other terminal statuses (settled / voided / cashed_out) can't
        // reach a pending ticket, but pass them through for completeness.
        return { ...prev, status: frame.status };
      });
    }, [slip, router]),
  );

  // When a new selection is added (count goes up) while the user is on the
  // history tab, jump back to the slip so the freshly clicked pick is
  // visible. Manual tab switches without selection changes are preserved.
  const prevSelectionCount = useRef(selections.length);
  useEffect(() => {
    if (selections.length > prevSelectionCount.current && activeTab === "history") {
      setActiveTab("slip");
    }
    prevSelectionCount.current = selections.length;
  }, [selections.length, activeTab]);

  // Subscribe to live odds for every match in the slip. When a tick
  // arrives we refresh the stored selection in place — that way the user
  // submits the latest published odds and the server-side drift check
  // (5% tolerance) doesn't fire under normal price drift. Any "odds moved"
  // error is also cleared as soon as we apply a fresh tick so the user
  // doesn't see a stale message after the auto-update.
  const slipMatchIds = useMemo(() => {
    const ids = new Set<string>();
    for (const s of selections) ids.add(s.matchId);
    return [...ids];
  }, [selections]);
  const liveTicks = useLiveOddsForMatches(slipMatchIds);
  // Market-level status — the server rejects POST /bets when
  // markets.status !== 1, regardless of how live the outcome looks.
  // Outcome ticks alone don't carry this (Oddin frequently leaves
  // `<outcome active="1">` with the last price on a suspended market),
  // so without this subscription a leg on a settled / cancelled /
  // suspended market keeps appearing live in the slip and placement
  // dead-ends at `market_not_active`.
  const liveMarketStatuses = useLiveMarketStatusForMatches(slipMatchIds);
  useEffect(() => {
    let appliedAny = false;
    for (const s of selections) {
      const tick = liveTicks[`${s.marketId}:${s.outcomeId}`];
      if (!tick) continue;
      const prevActive = s.active ?? true;
      const nextProb = tick.probability ?? s.probability;
      // Skip the update only when EVERY tracked field matches. Under the
      // old condition (odds + probability) an outcome could flip
      // active=false at the same odds and the slip would never notice,
      // so the user clicked Place bet against a dead market and ate
      // the server's market_not_active rejection.
      if (
        tick.publishedOdds === s.odds &&
        nextProb === s.probability &&
        tick.active === prevActive
      ) {
        continue;
      }
      slip.updateOdds(
        s.marketId,
        s.outcomeId,
        tick.publishedOdds,
        tick.probability,
        tick.active,
      );
      appliedAny = true;
    }
    if (appliedAny) {
      setError((prev) =>
        prev === DRIFT_ERROR_MESSAGE || prev === SUSPENDED_ERROR_MESSAGE
          ? null
          : prev,
      );
    }
  }, [liveTicks, selections, slip]);

  // Forward market-status transitions into the slip — flips s.active
  // independently of outcome ticks so legs on settled / cancelled /
  // suspended markets lock immediately, and unlock again on
  // reactivation (rollback or Oddin resuming a -1 market).
  useEffect(() => {
    for (const s of selections) {
      const statusTick = liveMarketStatuses[s.marketId];
      if (!statusTick) continue;
      slip.setMarketStatus(s.marketId, statusTick.status);
    }
  }, [liveMarketStatuses, selections, slip]);

  // Once any selection is flagged inactive (either by the WS tick path
  // above or stamped at click time by the caller), surface the
  // suspended state in the rail. Single (1 leg) tickets can't proceed
  // when their only leg is dead — but ≥2-leg products (combo / tiple /
  // tippot / betbuilder) are still placeable as long as at least one
  // active leg remains; the submit handler intercepts and asks the
  // user whether to drop the suspended legs first.
  const suspendedCount = selections.reduce(
    (n, s) => (s.active === false ? n + 1 : n),
    0,
  );
  const activeCount = selections.length - suspendedCount;
  const hasSuspendedSelection = suspendedCount > 0;
  const allSuspended = selections.length > 0 && activeCount === 0;
  // True when the place-bet click should pop the "remove suspended
  // legs?" prompt instead of submitting. Intentionally only ≥2 legs:
  // single-mode (1 leg, suspended) just stays disabled.
  const needsSuspendedConfirm =
    hasSuspendedSelection && activeCount >= 1 && selections.length >= 2;
  // Inline confirm panel state. Cleared automatically when the user
  // resolves the suspension (manually removes a leg, or odds come back).
  const [pendingSuspendedConfirm, setPendingSuspendedConfirm] =
    useState(false);
  useEffect(() => {
    if (!hasSuspendedSelection && pendingSuspendedConfirm) {
      setPendingSuspendedConfirm(false);
    }
  }, [hasSuspendedSelection, pendingSuspendedConfirm]);
  const removeSuspendedSelections = useCallback(() => {
    for (const s of selections) {
      if (s.active === false) slip.remove(s.marketId, s.outcomeId);
    }
  }, [selections, slip]);
  // Whenever any selection has a `pendingOdds` set (the WS tick differs
  // from the user-accepted price), the Place-bet button is replaced by
  // an explicit "Accept odds change" step. Clicking it copies pending
  // → odds and the button reverts to Place bet.
  const hasPendingOdds = selections.some((s) => s.pendingOdds != null);

  // Effective product mode. Single is forced when there's only one
  // selection regardless of last-stored mode. tiple/tippot need ≥2.
  // BetBuilder is special — it can show with a single leg (the toggle
  // is on the match page; the rail renders the in-progress quote
  // until the user adds the second leg).
  const effectiveMode: SlipMode = useMemo(() => {
    if (slip.mode === "betbuilder" && slip.betbuilderMatchId) {
      return "betbuilder";
    }
    if (selections.length <= 1) return "single";
    if (slip.mode === "single") return "combo";
    return slip.mode;
  }, [selections.length, slip.mode, slip.betbuilderMatchId]);

  // ── BetBuilder quote refresh ─────────────────────────────────────
  // Whenever the leg set changes while we're in builder mode, request
  // a fresh combined-odds quote from /betbuilder/match/:id/quote. The
  // server in turn calls Oddin's OBB SessionCreate. The cached quote
  // (slip.betbuilderQuote) is what the rail shows + what gets submitted.
  const isBetBuilder = effectiveMode === "betbuilder";
  const builderMatchId = slip.betbuilderMatchId;
  // Stable signature of the leg set so the effect only fires on change.
  const builderLegSig = useMemo(() => {
    if (!isBetBuilder || !builderMatchId) return "";
    const sameMatch = selections.filter((s) => s.matchId === builderMatchId);
    return sameMatch
      .map((s) => `${s.marketId}:${s.outcomeId}`)
      .sort()
      .join("|");
  }, [isBetBuilder, builderMatchId, selections]);
  const [builderError, setBuilderError] = useState<string | null>(null);
  // `slip.betbuilderQuote` is consumed inside the effect so that a
  // freshly-nulled quote (e.g. after acceptPendingOdds promotes drift
  // in builder mode without changing the leg set) re-triggers the
  // fetch. Without this dep the effect would skip the re-quote
  // because `builderLegSig` is unchanged.
  const currentQuote = slip.betbuilderQuote;
  useEffect(() => {
    if (!isBetBuilder || !builderMatchId || builderLegSig === "") {
      // Either not in builder mode or empty leg list — clear quote.
      slip.setBetbuilderQuote(null);
      return;
    }
    // Already have a fresh quote for this leg set — nothing to do.
    if (currentQuote) return;
    const sameMatch = selections.filter((s) => s.matchId === builderMatchId);
    let cancelled = false;
    setBuilderError(null);
    (async () => {
      try {
        const resp = await clientApi<BetBuilderQuoteResponse>(
          `/betbuilder/match/${builderMatchId}/quote`,
          {
            method: "POST",
            body: JSON.stringify({
              selections: sameMatch.map((s) => ({
                marketId: s.marketId,
                outcomeId: s.outcomeId,
              })),
            }),
          },
        );
        if (cancelled) return;
        if (resp.status === "rejected") {
          setBuilderError(
            resp.message ||
              "BetBuilder couldn't combine these selections. Remove one and try again.",
          );
          slip.setBetbuilderQuote(null);
        } else {
          slip.setBetbuilderQuote(resp);
        }
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiFetchError && err.body.error === "betbuilder_disabled") {
          setBuilderError("BetBuilder is unavailable.");
        } else if (err instanceof ApiFetchError) {
          setBuilderError(err.body.message || "Couldn't quote BetBuilder. Try again.");
        } else {
          setBuilderError("Couldn't quote BetBuilder. Try again.");
        }
        slip.setBetbuilderQuote(null);
      }
    })();
    return () => {
      cancelled = true;
    };
    // builderLegSig captures everything material to the leg set;
    // currentQuote covers the accept-odds-in-builder-mode case where
    // the quote gets nulled without the leg list changing. The rest
    // of the deps are stable references managed by the slip store.
    // (The `react-hooks/exhaustive-deps` rule is not configured in
    // this repo's ESLint, so a `// eslint-disable-next-line` for it
    // would fail Next.js's lint pass with "Definition for rule …
    // not found".)
  }, [isBetBuilder, builderMatchId, builderLegSig, currentQuote]);

  // Combined odds = product of all selection odds (combo accumulator).
  // Used for single + combo display.
  const combinedOdds = useMemo(() => {
    if (selections.length === 0) return 0;
    return selections.reduce((acc, s) => acc * Number(s.odds || 0), 1);
  }, [selections]);

  // Combi Boost preview. The server re-runs computeCombiBoost at
  // placement and freezes the multiplier into bet_meta — this is just a
  // live preview for the user as they add legs. Config comes from
  // /catalog/combi-boost-config (admin-tunable).
  const boostCfg = useCombiBoostConfig();
  const combiBoost = useMemo(
    () => computeCombiBoost(selections.map((s) => s.odds), boostCfg),
    [selections, boostCfg],
  );

  // Tiple/Tippot quotes — only computable when every selection carries a
  // probability. Server prices authoritatively at placement; this is
  // strictly preview.
  const probabilityArr = useMemo<number[] | null>(() => {
    if (selections.length < 2) return null;
    const out: number[] = [];
    for (const s of selections) {
      if (!s.probability) return null;
      try {
        const p = parseProbability(s.probability);
        if (!(p > 0 && p < 1)) return null;
        out.push(p);
      } catch {
        return null;
      }
    }
    return out;
  }, [selections]);

  const tipleQuote = useMemo(() => {
    if (effectiveMode !== "tiple" || !probabilityArr) return null;
    try {
      const eff = effectiveMarginBp(
        PREVIEW_TIPLE_BASE_BP,
        PREVIEW_TIPLE_PER_LEG_BP,
        probabilityArr.length,
      );
      return priceTiple(probabilityArr, eff);
    } catch {
      return null;
    }
  }, [effectiveMode, probabilityArr]);

  const tippotQuote = useMemo(() => {
    if (effectiveMode !== "tippot" || !probabilityArr) return null;
    try {
      const eff = effectiveMarginBp(
        PREVIEW_TIPPOT_BASE_BP,
        PREVIEW_TIPPOT_PER_LEG_BP,
        probabilityArr.length,
      );
      return priceTippot(probabilityArr, eff);
    } catch {
      return null;
    }
  }, [effectiveMode, probabilityArr]);

  const builderQuote: BetBuilderQuoteAcceptedResponse | null =
    slip.betbuilderQuote;

  const potentialReturn = useMemo(() => {
    const stake = Number(stakeInput);
    if (!Number.isFinite(stake) || stake <= 0) return 0;
    if (effectiveMode === "betbuilder") {
      if (!builderQuote) return 0;
      const o = Number(builderQuote.combinedOdds);
      if (!Number.isFinite(o) || o <= 0) return 0;
      return stake * o;
    }
    if (effectiveMode === "tiple" && tipleQuote) {
      return stake * Number(tipleQuote.offeredOdds);
    }
    if (effectiveMode === "tippot" && tippotQuote) {
      const top = tippotQuote.tiers[tippotQuote.tiers.length - 1];
      return top ? stake * Number(top.multiplier) : 0;
    }
    if (combinedOdds <= 0) return 0;
    // Combo mode applies the Combi Boost multiplier; single mode (one
    // ticket per leg) doesn't. The server enforces the same rule at
    // placement, so the displayed potential return is what the user
    // will actually be credited on a winning ticket.
    const boostMul = effectiveMode === "combo" ? combiBoost.multiplier : 1.0;
    return stake * combinedOdds * boostMul;
  }, [stakeInput, combinedOdds, effectiveMode, tipleQuote, tippotQuote, builderQuote, combiBoost]);

  // Show a whole-number amount without trailing ".00"; keep up to
  // 2 decimals otherwise, trimming trailing zeros (e.g. "14.5" not "14.50").
  const formatAmount = (n: number): string => {
    if (!Number.isFinite(n) || n <= 0) return "0";
    return n.toFixed(2).replace(/\.?0+$/, "");
  };

  const isCombo = effectiveMode === "combo";
  const isTiple = effectiveMode === "tiple";
  const isTippot = effectiveMode === "tippot";
  const isBetBuilderMode = effectiveMode === "betbuilder";
  const isMulti = selections.length >= 2;
  const productPriceMissing = (isTiple || isTippot) && probabilityArr === null;
  // BetBuilder needs at least 2 legs and an accepted quote. Show a
  // calmer "build your selections" line when there's only one leg.
  const builderNeedsLegs = isBetBuilderMode && selections.length < 2;
  const builderQuoteMissing =
    isBetBuilderMode && selections.length >= 2 && !builderQuote && !builderError;

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (selections.length === 0) return;
    // Intercept: if any leg is unavailable but at least one active leg
    // is still present, ask the user before submitting whether to drop
    // the suspended ones — submitting them would just dead-end against
    // market_not_active / outcome_not_active. Single-leg suspensions
    // (activeCount === 0) hit the disabled-button gate above, so we
    // never reach this branch with nothing to bet on.
    if (needsSuspendedConfirm) {
      setError(null);
      setPendingSuspendedConfirm(true);
      return;
    }
    setError(null);
    // Clear any sticky post-placement card (e.g. a previous rejection
    // banner) before the new POST lands.
    setPlacedTicket(null);

    let stakeMicro: string;
    try {
      const micro = toMicro(stakeInput);
      if (micro <= 0n) {
        setError("Stake must be positive.");
        return;
      }
      stakeMicro = micro.toString();
    } catch {
      setError("Invalid stake.");
      return;
    }

    setSubmitting(true);
    try {
      const idempotencyKey = crypto.randomUUID();
      // BetBuilder needs the OBB session round-tripped from the latest
      // quote. Block placement when no quote has landed yet (the rail
      // disables the button below, but defence in depth).
      if (effectiveMode === "betbuilder") {
        if (!builderQuote) {
          setError("Wait for the BetBuilder quote to load.");
          return;
        }
        if (selections.length < 2) {
          setError("BetBuilder needs at least 2 selections.");
          return;
        }
      }
      const res = await clientApi<{ ticket: TicketSummary }>("/bets", {
        method: "POST",
        body: JSON.stringify({
          stakeMicro,
          idempotencyKey,
          currency,
          // Send explicit betType so the server knows to apply tiple/
          // tippot/betbuilder pricing — without this, ≥2 legs default
          // to "combo".
          betType: effectiveMode,
          selections: selections.map((s) => ({
            marketId: s.marketId,
            outcomeId: s.outcomeId,
            odds: s.odds,
            // Forward the ZillaFlash offer id when the leg came from a
            // boosted offer; server re-validates the id + boosted odds
            // and shaves -2 s off the live-bet acceptance delay.
            ...(s.zillaFlashOfferId
              ? { zillaFlashOfferId: s.zillaFlashOfferId }
              : null),
          })),
          // Bettor opt-in for the bet-delay window. Server gates the
          // effect to single + combo; sending for other modes is a
          // harmless no-op.
          acceptOddsChanges,
          ...(effectiveMode === "betbuilder" && builderQuote
            ? {
                betBuilder: {
                  sessionId: builderQuote.sessionId,
                  expectedOddsX10000: builderQuote.oddsX10000,
                  selectionIds: builderQuote.selectionIds,
                },
              }
            : null),
        }),
      });
      setPlacedTicket(res.ticket);
      // Optimistic balance deduct so the top-bar pill + any other
      // wallet consumers reflect the new available balance immediately.
      // For singles the server places one ticket per selection at
      // `stakeMicro` each (total debit = stakeMicro × N); other modes
      // produce one ticket at `stakeMicro` total. The api stays
      // authoritative — a rejected placement (e.g. drift, insufficient
      // funds on a second tab) shows up as an ApiFetchError above and
      // the next /wallet refresh (settlement WS frame or a navigation)
      // reconciles. We've already returned by this branch so the deduct
      // only applies on confirmed-accepted placements.
      const totalDebitMicro =
        effectiveMode === "single"
          ? BigInt(stakeMicro) * BigInt(selections.length)
          : BigInt(stakeMicro);
      optimisticDeductWallet(currency, totalDebitMicro);
      router.refresh();
      if (res.ticket.status === "pending_delay") {
        // Live-bet acceptance delay is running. Keep the slip populated
        // so the bettor can watch their legs tick (drift + suspended
        // pills appear automatically via the existing pendingOdds /
        // s.active wiring); stay on the slip tab so the countdown is
        // visible right above the legs. The WS ticket-frame subscription
        // up top transitions to history on `accepted` / surfaces the
        // reject reason on `rejected`.
        return;
      }
      // No delay — the bet was accepted at placement. Clear the slip
      // and surface the new ticket in History.
      slip.clear();
      setActiveTab("history");
    } catch (err) {
      setError(err instanceof ApiFetchError ? mapError(err) : "Placement failed.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <aside
      className="oz-rail"
      style={{
        gridArea: "rail",
        borderLeft: "1px solid var(--hairline)",
        background: "var(--bg)",
        display: "flex",
        flexDirection: "column",
        position: "sticky",
        // Desktop layout removed the top-bar grid row (the user
        // controls live in the rail header now), so the rail sticks
        // to the very top of the viewport. On tablet + mobile the
        // bottom-sheet @media rules in globals.css override `position`
        // / `top` entirely.
        top: 0,
        maxHeight: "100vh",
        // Widget panels and long histories can exceed the viewport-bounded
        // sticky aside — let the entire rail column scroll as one. The
        // selections list inside still has its own overflow so a mid-slip
        // scroll doesn't push the form out of view.
        overflowY: "auto",
        // Hard-clip horizontal overflow at the rail's edge. Without this
        // the COMBI BOOST 8-cell progress bar (and other inner grids
        // sized off natural content width) can leak past the drawer's
        // right edge on narrower phones. Drawer-as-modal must never
        // bleed past the viewport — set the boundary here so it's
        // enforced regardless of which child overflows.
        overflowX: "hidden",
        // Belt + suspenders: pin width so a child can't push the rail
        // itself wider than its grid track / fixed-position rect.
        maxWidth: "100%",
        minWidth: 0,
      }}
    >
      {/* Drag handle — only visible when the rail is rendered as a
          mobile bottom sheet; CSS handles the breakpoint. */}
      <span className="oz-rail-handle" aria-hidden="true" />
      {/*
        User controls (theme / bell / wallet / avatar) — desktop only.
        On tablet + mobile the rail is a bottom-sheet and the twin
        <UserControls variant="topbar" /> in the top bar carries this
        cluster; `.oz-rail-controls` is hidden under 1100px in
        globals.css so the duplicate copy never reaches the DOM.
        Padding + border are applied on `.oz-rail-controls` directly
        so hiding the cluster also collapses the strip.
      */}
      <UserControls signedIn={signedIn} user={user} variant="rail" />
      <div
        style={{
          padding: "10px 16px 8px",
          display: "flex",
          flexDirection: "column",
          gap: 6,
          borderBottom: "1px solid var(--hairline)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <RailTabs
            active={activeTab}
            onChange={setActiveTab}
            slipCount={selections.length}
          />
          <div style={{ flex: 1 }} />
          {activeTab === "slip" && selections.length > 0 && (
            <button
              type="button"
              onClick={slip.clear}
              style={{
                background: 0,
                border: 0,
                color: "var(--fg-muted)",
                fontSize: 12,
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              {t("clearSlip")}
            </button>
          )}
          <button
            type="button"
            onClick={closeAll}
            className="oz-rail-close"
            aria-label={t("title")}
            style={{
              width: 28,
              height: 28,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              background: "var(--surface-2)",
              border: "1px solid var(--border)",
              borderRadius: 999,
              color: "var(--fg-muted)",
              cursor: "pointer",
              padding: 0,
              marginLeft: 4,
            }}
          >
            <I.Close size={12} />
          </button>
        </div>
        {activeTab === "slip" && selections.length > 0 && (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span
              className="mono"
              style={{
                fontSize: 10.5,
                padding: "2px 8px",
                background: isMulti ? "var(--fg)" : "var(--surface-2)",
                color: isMulti ? "var(--bg)" : "var(--fg-muted)",
                border: isMulti
                  ? "1px solid var(--fg)"
                  : "1px solid var(--border)",
                borderRadius: 999,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                fontWeight: 600,
              }}
            >
              {effectiveMode === "single"
                ? t("single")
                : `${effectiveMode} · ${selections.length}`}
            </span>
          </div>
        )}
      </div>

      {activeTab === "history" ? (
        <HistoryPane highlightTicketId={placedTicket?.id ?? null} />
      ) : (
        <>
      <div
        className="oz-rail-slip-list"
        style={{
          minHeight: 0,
          overflow: "auto",
          padding: "8px 14px 6px",
          display: "flex",
          flexDirection: "column",
          gap: 6,
        }}
      >
        {placedTicket && placedTicket.status === "accepted" ? (
          // Accepted at placement (no live-delay window). The pending /
          // rejected branches below render the slip + a banner instead;
          // this is the immediate-acceptance success card.
          <PlacedTicketCard
            ticketId={placedTicket.id}
            status={placedTicket.status}
            notBeforeTs={placedTicket.notBeforeTs}
            tBetPlaced={t("betPlaced")}
            tBetQueued={t("betQueued")}
            tAcceptingIn={(s: number) => t("acceptingIn", { seconds: s })}
            tLiveDelayNote={t("liveDelayNote")}
            tTicket={t("ticket")}
            tViewMyBets={t("viewMyBets")}
          />
        ) : selections.length === 0 ? (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 8,
              textAlign: "center",
              padding: "12px 20px 20px",
              color: "var(--fg-muted)",
            }}
          >
            <div
              style={{
                width: 44,
                height: 44,
                borderRadius: 999,
                background: "var(--surface-2)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "var(--fg-dim)",
              }}
            >
              <I.Ticket size={18} />
            </div>
            <div
              className="display"
              style={{ fontSize: 15, color: "var(--fg)", letterSpacing: "-0.01em" }}
            >
              {t("empty")}
            </div>
            <div
              style={{
                fontSize: 12,
                color: "var(--fg-muted)",
                maxWidth: 220,
                lineHeight: 1.5,
              }}
            >
              {t("emptyHint")}
            </div>
          </div>
        ) : (
          <>
            {placedTicket && placedTicket.status === "pending_delay" ? (
              <PendingPlacementBanner
                notBeforeTs={placedTicket.notBeforeTs}
                acceptOddsChanges={placedTicket.acceptOddsChanges}
                ticketId={placedTicket.id}
                t={t}
              />
            ) : placedTicket && placedTicket.status === "rejected" ? (
              <RejectedPlacementBanner
                reason={placedTicket.rejectReason}
                onDismiss={() => setPlacedTicket(null)}
              />
            ) : null}
            {selections.map((s) => (
              <SelectionCard
                key={`${s.marketId}:${s.outcomeId}`}
                selection={s}
                onRemove={() => slip.remove(s.marketId, s.outcomeId)}
              />
            ))}
          </>
        )}
      </div>

      {selections.length > 0 &&
      placedTicket?.status === "pending_delay" ? (
        // Pending — replace the form (Place button + stake input) with a
        // status indicator. The bettor can't edit the slip while the
        // worker is deciding; the WS frame will either accept (slip
        // clears + history opens) or reject (slip stays + bettor edits
        // and re-places).
        <PendingPlacementFooter notBeforeTs={placedTicket.notBeforeTs} t={t} />
      ) : selections.length > 0 &&
        (!placedTicket || placedTicket.status === "rejected") && (
        <form
          onSubmit={onSubmit}
          style={{
            padding: "10px 16px 14px",
            borderTop: "1px solid var(--hairline)",
            display: "flex",
            flexDirection: "column",
            // Without this, the form competes with the prematch widget
            // below for vertical space and the Place button can drop
            // below the fold on shorter viewports.
            flexShrink: 0,
            gap: 8,
          }}
        >
          {isMulti && !isBetBuilderMode && (
            <ModeSelector
              mode={effectiveMode}
              n={selections.length}
              onChange={(m) => slip.setMode(m)}
            />
          )}

          {isBetBuilderMode && (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 6,
                padding: "8px 10px",
                background: "var(--surface-2)",
                border: "1px solid var(--border)",
                borderRadius: 10,
                fontSize: 12,
                color: "var(--fg-muted)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span
                  className="mono"
                  style={{
                    fontSize: 10,
                    letterSpacing: "0.08em",
                    textTransform: "uppercase",
                    fontWeight: 700,
                    color: "var(--fg)",
                  }}
                >
                  BetBuilder
                </span>
                <span style={{ flex: 1 }} />
                <button
                  type="button"
                  onClick={() => slip.setBetbuilderMatch(null)}
                  style={{
                    background: 0,
                    border: 0,
                    color: "var(--fg-muted)",
                    cursor: "pointer",
                    fontSize: 11,
                    fontFamily: "inherit",
                    textDecoration: "underline",
                  }}
                >
                  Turn off
                </button>
              </div>
              {builderNeedsLegs ? (
                <span style={{ lineHeight: 1.4 }}>
                  Add a second selection from this match to get a combined
                  BetBuilder price.
                </span>
              ) : builderQuoteMissing ? (
                <span style={{ lineHeight: 1.4 }}>Loading combined odds…</span>
              ) : builderError ? (
                <span style={{ color: "var(--negative)", lineHeight: 1.4 }}>
                  {builderError}
                </span>
              ) : builderQuote ? (
                <div
                  style={{
                    display: "flex",
                    alignItems: "baseline",
                    justifyContent: "space-between",
                  }}
                >
                  <span>Combined · {selections.length} legs · same match</span>
                  <span
                    className="mono tnum"
                    style={{ fontSize: 14, fontWeight: 600, color: "var(--fg)" }}
                  >
                    {builderQuote.combinedOdds}
                  </span>
                </div>
              ) : null}
            </div>
          )}

          {isCombo && (
            <div
              style={{
                display: "flex",
                alignItems: "baseline",
                justifyContent: "space-between",
                fontSize: 12,
                color: "var(--fg-muted)",
              }}
            >
              <span>Combo · {selections.length} legs</span>
              <span className="mono tnum" style={{ fontSize: 14, fontWeight: 600, color: "var(--fg)" }}>
                {/* Floor-truncate to 2dp, matching the project-wide odds
                    convention (settlement, applyMargin, ComboZilla card
                    display). toFixed(2) would round half-up — e.g.
                    1.62 × 1.65 × 1.50 × 1.02 = 4.0897 rounds to 4.09
                    but the card shows 4.08, and the engine pays the
                    floored value. */}
                {(Math.floor(combinedOdds * combiBoost.multiplier * 100) / 100).toFixed(2)}
              </span>
            </div>
          )}

          {isCombo && selections.length >= 2 && boostCfg.enabled && (
            <CombiBoostPanel
              eligibleLegCount={combiBoost.eligibleLegCount}
              currentTier={combiBoost.currentTier}
              nextTier={combiBoost.nextTier}
              legsToNext={combiBoost.legsToNextTier}
              ineligibleLegCount={selections.length - combiBoost.eligibleLegCount}
              config={boostCfg}
            />
          )}

          <CurrencyTabs
            value={currency}
            onChange={(c) => slip.setCurrency(c)}
          />

          {isTiple && (
            <div
              style={{
                display: "flex",
                alignItems: "baseline",
                justifyContent: "space-between",
                fontSize: 12,
                color: "var(--fg-muted)",
              }}
            >
              <span>Tiple · any leg wins</span>
              <span className="mono tnum" style={{ fontSize: 14, fontWeight: 600, color: "var(--fg)" }}>
                {tipleQuote ? tipleQuote.offeredOdds : "—"}
              </span>
            </div>
          )}

          {isTippot && tippotQuote && (
            <TippotTierTable tiers={tippotQuote.tiers} stake={Number(stakeInput)} />
          )}

          {productPriceMissing && (
            <div
              role="status"
              style={{
                fontSize: 11,
                color: "var(--fg-muted)",
                lineHeight: 1.45,
                background: "var(--surface-2)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                padding: "8px 10px",
              }}
            >
              Pricing computed at submit — one or more selections is missing
              its implied probability.
            </div>
          )}

          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "0 12px",
              height: 38,
              background: "var(--surface-2)",
              border: "1px solid var(--border)",
              borderRadius: 10,
            }}
          >
            <span style={{ fontSize: 12, color: "var(--fg-muted)", flexShrink: 0 }}>
              Stake
            </span>
            <input
              value={stakeInput}
              onChange={(e) => setStakeInput(e.target.value.replace(/[^\d.]/g, ""))}
              onFocus={(e) => e.currentTarget.select()}
              className="mono tnum"
              inputMode="decimal"
              style={{
                flex: 1,
                minWidth: 0,
                width: 0,
                border: 0,
                background: "transparent",
                outline: "none",
                fontFamily: "var(--font-mono)",
                fontSize: 14,
                fontWeight: 600,
                color: "var(--fg)",
                textAlign: "right",
              }}
            />
            <span
              className="mono"
              style={{ fontSize: 12, color: "var(--fg-muted)", flexShrink: 0 }}
            >
              {currency}
            </span>
          </div>

          <div style={{ display: "flex", gap: 6 }}>
            {[10, 25, 50, 100].map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setStakeInput(String(v))}
                style={{
                  flex: 1,
                  height: 26,
                  fontSize: 12,
                  background: "transparent",
                  border: "1px solid var(--border)",
                  borderRadius: 999,
                  cursor: "pointer",
                  color: "var(--fg-muted)",
                  fontFamily: "var(--font-mono)",
                  fontWeight: 500,
                }}
              >
                {v}
              </button>
            ))}
          </div>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "6px 0",
              borderTop: "1px dashed var(--border)",
              borderBottom: "1px dashed var(--border)",
              gap: 10,
            }}
          >
            <span style={{ fontSize: 12, color: "var(--fg-muted)", flexShrink: 0 }}>
              Potential winning
            </span>
            <div
              style={{
                display: "flex",
                alignItems: "baseline",
                gap: 6,
                minWidth: 0,
              }}
            >
              <span
                className="display tnum"
                style={{ fontSize: 18, fontWeight: 500, letterSpacing: "-0.02em" }}
              >
                {formatAmount(potentialReturn)}
              </span>
              <span
                className="mono"
                style={{ fontSize: 12, color: "var(--fg-muted)", flexShrink: 0 }}
              >
                {currency}
              </span>
            </div>
          </div>

          {error && (
            <div
              role="alert"
              style={{ fontSize: 12, color: "var(--negative)", lineHeight: 1.45 }}
            >
              {error}
            </div>
          )}

          {/* Suspended-leg banner. Two flavours:
                - Every leg is dead (or the only leg of a single is
                  dead): hard block; the place button is also disabled.
                  Surface a Remove-suspended action so the user can
                  clear and start fresh.
                - Some active legs remain: softer "N selection(s)
                  unavailable" with an inline Remove action. The submit
                  handler intercepts and asks for confirmation before
                  placing. */}
          {!error && hasSuspendedSelection && !pendingSuspendedConfirm && (
            <div
              role="status"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontSize: 12,
                color: "var(--negative)",
                lineHeight: 1.45,
              }}
            >
              <span style={{ flex: 1 }}>
                {allSuspended
                  ? selections.length === 1
                    ? SUSPENDED_ERROR_MESSAGE
                    : "All selections are unavailable."
                  : `${suspendedCount} ${suspendedCount === 1 ? "selection is" : "selections are"} unavailable.`}
              </span>
              <button
                type="button"
                onClick={removeSuspendedSelections}
                style={{
                  background: 0,
                  border: "1px solid color-mix(in oklab, var(--negative) 35%, var(--border))",
                  color: "var(--negative)",
                  fontFamily: "var(--font-mono)",
                  fontSize: 11,
                  letterSpacing: "0.04em",
                  padding: "3px 9px",
                  borderRadius: 999,
                  cursor: "pointer",
                  flexShrink: 0,
                }}
              >
                {suspendedCount === 1 ? "Remove" : `Remove ${suspendedCount}`}
              </button>
            </div>
          )}

          {/* Confirm panel: shown after the user clicked Place bet on a
              slip that still has suspended legs. Replaces the place
              button until they decide. Confirm drops every suspended
              leg from the slip — the rail then re-renders with only
              active legs, the user clicks Place bet again and submits
              normally. (We deliberately do NOT auto-place after remove
              so the user gets one last look at the cleaned slip + the
              recomputed potential winning before committing.) */}
          {pendingSuspendedConfirm ? (
            <div
              role="alertdialog"
              aria-label="Confirm removing unavailable selections"
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 8,
                padding: "10px 12px",
                background: "var(--surface-2)",
                border: "1px solid color-mix(in oklab, var(--negative) 30%, var(--border))",
                borderRadius: 10,
              }}
            >
              <div style={{ fontSize: 12.5, lineHeight: 1.5, color: "var(--fg)" }}>
                {suspendedCount === 1
                  ? "1 selection is unavailable."
                  : `${suspendedCount} selections are unavailable.`}{" "}
                Remove{" "}
                {suspendedCount === 1 ? "it" : "them"} and continue with the{" "}
                remaining {activeCount}?
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <Button
                  variant="ghost"
                  size="sm"
                  type="button"
                  onClick={() => setPendingSuspendedConfirm(false)}
                  style={{ flex: 1 }}
                >
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  type="button"
                  onClick={() => {
                    removeSuspendedSelections();
                    setPendingSuspendedConfirm(false);
                  }}
                  style={{ flex: 1 }}
                >
                  Remove {suspendedCount === 1 ? "it" : `${suspendedCount}`}
                </Button>
              </div>
            </div>
          ) : (
            <>
              {/* When odds drift differs from the user-accepted price, the
                  primary action becomes "Accept odds change" — type=button
                  so the form doesn't submit, and onClick promotes pending →
                  odds. After that the button reverts to its Place-bet form
                  (or right back to Accept if a fresh tick has already
                  landed, which is the right thing — drift is real). */}
              <Button
                variant="primary"
                size="lg"
                type={hasPendingOdds ? "button" : "submit"}
                onClick={
                  hasPendingOdds
                    ? () => slip.acceptPendingOdds()
                    : undefined
                }
                disabled={
                  submitting ||
                  builderNeedsLegs ||
                  builderQuoteMissing ||
                  (isBetBuilderMode && !!builderError) ||
                  allSuspended
                }
                style={{ width: "100%" }}
              >
                {submitting
                  ? t("placing")
                  : hasPendingOdds
                    ? t("accept")
                    : t("placeBet")}
              </Button>
            </>
          )}

          {/* Bettor opt-in for the live-bet acceptance delay window.
              Hidden when nothing on the slip can trigger a delay
              (effectiveMode is tiple/tippot/betbuilder — the server
              ignores the flag for those, see services/api/src/modules/
              bets/service.ts). Persisted in localStorage so the
              preference survives reloads. */}
          {(effectiveMode === "single" || effectiveMode === "combo") && (
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontSize: 12,
                color: "var(--fg-muted)",
                cursor: "pointer",
                userSelect: "none",
              }}
            >
              <input
                type="checkbox"
                checked={acceptOddsChanges}
                onChange={(e) => setAcceptOddsChanges(e.currentTarget.checked)}
                style={{ accentColor: "var(--fg)" }}
              />
              <span>{t("acceptOddsChangesLabel")}</span>
            </label>
          )}

          <div style={{ fontSize: 10, color: "var(--fg-dim)", textAlign: "center" }}>
            {t("oddsChanged")}
          </div>
        </form>
      )}
        </>
      )}
      {/*
        Match panel — Insights / Chat / Analyses tabs, all keyed off
        the active match-detail page via MatchPageContext. Hidden on
        the History tab (the user is reviewing past tickets and
        match-specific tools are off-topic) and right after placement
        (the success card / freshly-flipped history view should
        breathe). Chat and Analyses live here instead of below the
        markets so they share the bet slip's vertical real estate
        — bet slip + Place button stay above the fold, match-specific
        content stacks below where it competes only with itself.
      */}
      {activeTab === "slip" && !placedTicket && <RailMatchPanel />}
    </aside>
  );
}

function SelectionCard({
  selection,
  onRemove,
}: {
  selection: SlipSelection;
  onRemove: () => void;
}) {
  const t = useTranslations("betSlip");
  const tCommon = useTranslations("common");
  // Match-page link tap closes the mobile drawer so the navigation
  // doesn't get hidden behind the slip overlay. No-op on desktop where
  // the rail is always-on.
  const { closeAll: closeMobileDrawers } = useMobileDrawers();
  // Selections persisted from older slip versions don't carry an active
  // flag — treat the absence as bettable so the card doesn't suddenly
  // grey out for everyone after a deploy.
  const suspended = selection.active === false;
  // Resolve the pending-odds delta. Compare the parsed numeric values
  // so trailing-zero noise ("1.85" vs "1.850") doesn't tag a phantom
  // change. Direction colours: green for an increase (better for the
  // bettor — higher payout), red for a decrease.
  const acceptedNum = Number(selection.odds);
  const pendingNum =
    selection.pendingOdds != null ? Number(selection.pendingOdds) : null;
  const pendingChanged =
    pendingNum != null &&
    Number.isFinite(pendingNum) &&
    Number.isFinite(acceptedNum) &&
    pendingNum.toFixed(2) !== acceptedNum.toFixed(2);
  const pendingDir: "up" | "down" | null = pendingChanged
    ? pendingNum! > acceptedNum
      ? "up"
      : "down"
    : null;
  // Outline accent on the card edge when there's a pending change so
  // the eye picks the row out of a long combo. Suspension still wins —
  // it's the more urgent state.
  const cardBorder = suspended
    ? "1px solid color-mix(in oklab, var(--negative) 35%, var(--border))"
    : pendingChanged
      ? "1px solid color-mix(in oklab, var(--accent) 45%, var(--border))"
      : "1px solid var(--border)";
  return (
    <div
      style={{
        padding: "9px 12px",
        background: "var(--surface)",
        border: cardBorder,
        borderRadius: 10,
        display: "flex",
        flexDirection: "column",
        gap: 4,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <SportGlyph sport={selection.sportSlug} size={12} />
        <span
          className="mono"
          style={{
            fontSize: 10,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "var(--fg-dim)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {stripUnresolvedPlaceholders(selection.marketLabel)}
        </span>
        {suspended && (
          <span
            className="mono"
            style={{
              fontSize: 9.5,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              fontWeight: 600,
              padding: "1px 6px",
              borderRadius: 999,
              color: "var(--negative)",
              border: "1px solid color-mix(in oklab, var(--negative) 40%, transparent)",
              background: "color-mix(in oklab, var(--negative) 8%, transparent)",
            }}
          >
            {tCommon("suspended")}
          </span>
        )}
        <div style={{ flex: 1 }} />
        <Link
          href={`/match/${selection.matchId}`}
          onClick={() => closeMobileDrawers()}
          style={{
            display: "inline-flex",
            alignItems: "center",
            color: "var(--fg-dim)",
            padding: 2,
            textDecoration: "none",
          }}
          aria-label={t("openMatch")}
          title={t("openMatch")}
        >
          <I.Chev size={12} />
        </Link>
        <button
          type="button"
          onClick={onRemove}
          style={{
            background: 0,
            border: 0,
            color: "var(--fg-dim)",
            cursor: "pointer",
            padding: 2,
          }}
          aria-label={t("removeLeg")}
        >
          <I.Close size={12} />
        </button>
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 10,
        }}
      >
        <div
          style={{
            fontSize: 13.5,
            fontWeight: 500,
            letterSpacing: "-0.005em",
            minWidth: 0,
            flex: 1,
            color: suspended ? "var(--fg-muted)" : undefined,
            textDecoration: suspended ? "line-through" : undefined,
          }}
        >
          {stripUnresolvedPlaceholders(selection.outcomeLabel)}
        </div>
        <div
          className="mono tnum"
          style={{
            display: "inline-flex",
            alignItems: "baseline",
            gap: 6,
            fontSize: 14,
            fontWeight: 600,
            flexShrink: 0,
            color: suspended ? "var(--fg-muted)" : undefined,
          }}
        >
          {/* Accepted price first. Strike-through when a pending update
              is hovering — the value about to be replaced by the
              "Accept odds change" click. */}
          <span
            style={{
              textDecoration: pendingChanged ? "line-through" : undefined,
              color: pendingChanged ? "var(--fg-muted)" : undefined,
            }}
          >
            {acceptedNum.toFixed(2)}
          </span>
          {pendingChanged && pendingNum != null ? (
            <>
              <span
                style={{
                  fontSize: 11,
                  color: pendingDir === "up" ? "var(--positive)" : "var(--negative)",
                  fontWeight: 700,
                }}
                aria-hidden="true"
              >
                {pendingDir === "up" ? "↑" : "↓"}
              </span>
              <span
                style={{
                  color: pendingDir === "up" ? "var(--positive)" : "var(--negative)",
                }}
              >
                {pendingNum.toFixed(2)}
              </span>
            </>
          ) : null}
        </div>
      </div>
      <div
        style={{
          fontSize: 11,
          color: "var(--fg-muted)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {selection.homeTeam} vs {selection.awayTeam}
      </div>
    </div>
  );
}

function CurrencyTabs({
  value,
  onChange,
}: {
  value: Currency;
  onChange: (c: Currency) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Wallet currency"
      style={{
        display: "flex",
        gap: 4,
        padding: 3,
        background: "var(--surface-2)",
        border: "1px solid var(--border)",
        borderRadius: 999,
      }}
    >
      {SUPPORTED_CURRENCIES.map((c) => {
        const active = c === value;
        return (
          <button
            key={c}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(c)}
            className="mono"
            style={{
              flex: 1,
              height: 26,
              border: 0,
              borderRadius: 999,
              background: active ? "var(--fg)" : "transparent",
              color: active ? "var(--bg)" : "var(--fg-muted)",
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              cursor: active ? "default" : "pointer",
              fontFamily: "var(--font-mono)",
            }}
          >
            {c}
            {c === "OZ" ? (
              <span
                style={{
                  marginLeft: 6,
                  fontSize: 9,
                  fontWeight: 500,
                  opacity: 0.7,
                  letterSpacing: "0.06em",
                }}
              >
                demo
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

function mapError(err: ApiFetchError): string {
  // RiskZilla rejection codes (the engine throws BadRequestError(reason,
  // decision) so `error` carries the decision — `rejected_*` — and
  // `message` carries the human reason). Surface a specific message per
  // gate so the bettor knows whether it's a per-match, per-bettor, or
  // bankroll-level limit that fired.
  switch (err.body.error) {
    case "rejected_min_stake":
      return "Stake is below the minimum bet for this match.";
    case "rejected_max_payout":
      return "Potential payout exceeds the maximum allowed for this match.";
    case "rejected_match_liability":
      return "Bet limit exceeded — match liability cap reached.";
    case "rejected_bet_factor":
      return "Bet limit exceeded — your slice of this match is full.";
    case "rejected_bank_limit":
      return "Bet limit exceeded — operator bankroll cap reached.";
    case "rejected_user_blocked":
      return "Your account can't place bets right now.";
    case "rejected_market_factor":
      return "This market is currently restricted from accepting bets.";
    case "wallet_not_found":
      return "No wallet for this currency yet — switch currency or contact support.";
    case "insufficient_balance":
      return "Not enough balance for this stake.";
    case "exceeds_global_limit":
      return "Stake exceeds your global limit.";
    case "odds_drift_exceeded":
      return DRIFT_ERROR_MESSAGE;
    case "market_not_active":
    case "outcome_not_active":
    case "outcome_no_price":
      return SUSPENDED_ERROR_MESSAGE;
    case "match_not_open":
      return "This match is no longer open for betting.";
    case "account_not_active":
      return "Your account can't place bets right now.";
    case "idempotency_key_collision":
      return "Please retry — collision on submission id.";
    case "combo_same_match":
      return "This product can't include two markets from the same match.";
    case "outcome_no_probability":
    case "outcome_probability_invalid":
    case "outcome_probability_extreme":
      return "One of your selections has no implied probability. Try a different market.";
    case "too_few_legs":
      return "Add more selections to use this product.";
    case "too_many_legs":
      return "Too many selections for this product.";
    case "tiple_odds_too_low":
      return "Your Tiple is too likely — pick longer-shot selections.";
    case "bet_product_disabled":
      return "This product is currently disabled.";
    case "bet_product_unconfigured":
      return "This product isn't configured yet — try Single or Combo.";
    case "multi_leg_required":
      return "This product needs at least 2 selections.";
    case "single_requires_one_leg":
      return "Single accepts only one selection — switch mode for combos.";
    case "betbuilder_disabled":
      return "BetBuilder is currently unavailable.";
    case "betbuilder_session_invalid":
      return "BetBuilder odds moved — your slip will refresh shortly.";
    case "betbuilder_unavailable":
      return "BetBuilder is temporarily unavailable. Try again in a moment.";
    case "betbuilder_block_required":
    case "betbuilder_selection_mismatch":
      return "Couldn't confirm the BetBuilder session. Please re-select your legs.";
    case "betbuilder_cross_match":
      return "BetBuilder needs every leg from the same match.";
    case "betbuilder_odds_too_low":
      return "BetBuilder returned odds below 1.01 — try a different combination.";
    case "internal_error":
      // The api error handler returns this for unhandled exceptions
      // (status 500). Show a stable message; details land in the api
      // logs for ops to diagnose.
      return "Bet placement service hit an unexpected error. Try again in a moment.";
    case "riskzilla_engine_error":
      return "Risk evaluation failed temporarily — try again in a moment.";
    default:
      // Surface the typed code rather than a generic "Placement failed"
      // — operators investigating support tickets need the code to
      // grep the api logs. The human message (when present) is more
      // useful than just the code; fall back to the code otherwise.
      return err.body.message || err.body.error || "Placement failed.";
  }
}

function ModeSelector({
  mode,
  n,
  onChange,
}: {
  mode: SlipMode;
  n: number;
  onChange: (m: SlipMode) => void;
}) {
  // tippot defaults to ≥3 legs at the server; offer the toggle anyway
  // and let the server reject with a clear error if min_legs is unmet.
  const opts: Array<{ id: SlipMode; label: string; disabled?: boolean }> = [
    { id: "combo", label: "Combo" },
    { id: "tiple", label: "Tiple" },
    { id: "tippot", label: "Tippot", disabled: n < 3 },
  ];
  return (
    <div
      role="tablist"
      style={{
        display: "flex",
        gap: 4,
        padding: 3,
        background: "var(--surface-2)",
        border: "1px solid var(--border)",
        borderRadius: 999,
      }}
    >
      {opts.map((o) => {
        const active = mode === o.id;
        return (
          <button
            key={o.id}
            type="button"
            role="tab"
            aria-selected={active}
            disabled={o.disabled}
            onClick={() => onChange(o.id)}
            className="mono"
            style={{
              flex: 1,
              padding: "5px 10px",
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              background: active ? "var(--fg)" : "transparent",
              color: active
                ? "var(--bg)"
                : o.disabled
                  ? "var(--fg-dim)"
                  : "var(--fg-muted)",
              border: 0,
              borderRadius: 999,
              cursor: o.disabled ? "not-allowed" : "pointer",
              fontFamily: "var(--font-mono)",
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function TippotTierTable({ tiers, stake }: { tiers: TippotTier[]; stake: number }) {
  // Bettor-facing payout table for Tippot. One row per possible outcome
  // ("k of N legs win") with the projected payout for the current stake.
  // Implied probability and the raw multiplier are intentionally hidden —
  // the bettor accepts a payout schedule, not a probability quote.
  const N = tiers.length;
  const stakeOk = Number.isFinite(stake) && stake > 0;
  const fmtUsdt = (n: number): string => {
    if (!Number.isFinite(n) || n <= 0) return "—";
    return n.toFixed(2).replace(/\.?0+$/, "");
  };
  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: 10,
        overflow: "hidden",
      }}
    >
      <div
        className="mono"
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0,1fr) auto",
          gap: 10,
          fontSize: 10,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: "var(--fg-muted)",
          padding: "8px 12px",
          background: "var(--surface-2)",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <span>Wins</span>
        <span style={{ textAlign: "right" }}>Payout</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column" }}>
        {tiers.map((t, i) => {
          const m = Number(t.multiplier);
          const payout = stakeOk ? stake * m : 0;
          const isTop = t.k === N;
          return (
            <div
              key={t.k}
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(0,1fr) auto",
                alignItems: "baseline",
                gap: 10,
                padding: "8px 12px",
                fontSize: 12.5,
                borderTop: i === 0 ? 0 : "1px dashed var(--border)",
                background: isTop
                  ? "color-mix(in oklab, var(--positive) 6%, transparent)"
                  : "transparent",
              }}
            >
              <span style={{ color: "var(--fg)", display: "flex", alignItems: "baseline", gap: 6 }}>
                <span
                  className="mono tnum"
                  style={{ fontWeight: 600, fontSize: 13, minWidth: 18, textAlign: "right" }}
                >
                  {t.k}
                </span>
                <span style={{ color: "var(--fg-muted)", fontSize: 11.5 }}>
                  of {N}
                </span>
                {isTop && (
                  <span
                    className="mono"
                    style={{
                      fontSize: 9,
                      letterSpacing: "0.08em",
                      textTransform: "uppercase",
                      color: "var(--positive)",
                      fontWeight: 700,
                      marginLeft: 2,
                    }}
                  >
                    Top
                  </span>
                )}
              </span>
              <span
                className="mono tnum"
                style={{
                  textAlign: "right",
                  fontWeight: isTop ? 700 : 600,
                  color: isTop ? "var(--positive)" : "var(--fg)",
                }}
              >
                {fmtUsdt(payout)}
              </span>
            </div>
          );
        })}
      </div>
      <div
        style={{
          padding: "6px 12px 8px",
          fontSize: 10,
          color: "var(--fg-dim)",
          background: "var(--surface-2)",
          borderTop: "1px solid var(--border)",
          lineHeight: 1.45,
        }}
      >
        Locked at placement. Voids drop legs; payout uses the row matching
        the count of winning legs in the remainder.
      </div>
    </div>
  );
}

function RailTabs({
  active,
  onChange,
  slipCount,
}: {
  active: RailTab;
  onChange: (t: RailTab) => void;
  slipCount: number;
}) {
  const tr = useTranslations("betSlip");
  const tabs: Array<{ id: RailTab; label: string; icon: "ticket" | "history" }> = [
    { id: "slip", label: tr("switchTab"), icon: "ticket" },
    { id: "history", label: tr("historyTab"), icon: "history" },
  ];
  return (
    <div role="tablist" aria-label={tr("title")} style={{ display: "flex", gap: 4 }}>
      {tabs.map((t) => {
        const isActive = active === t.id;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(t.id)}
            className="display"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "4px 2px",
              fontSize: 16,
              fontWeight: 500,
              letterSpacing: "-0.01em",
              background: 0,
              border: 0,
              borderBottom: isActive
                ? "2px solid var(--fg)"
                : "2px solid transparent",
              color: isActive ? "var(--fg)" : "var(--fg-muted)",
              cursor: isActive ? "default" : "pointer",
              fontFamily: "inherit",
              marginBottom: -1,
            }}
          >
            {t.icon === "ticket" ? <I.Ticket size={14} /> : <I.Clock size={14} />}
            <span>{t.label}</span>
            {t.id === "slip" && slipCount > 0 && !isActive && (
              <span
                className="mono tnum"
                style={{
                  fontSize: 10,
                  fontWeight: 600,
                  padding: "1px 6px",
                  background: "var(--fg)",
                  color: "var(--bg)",
                  borderRadius: 999,
                  letterSpacing: 0,
                  marginLeft: 2,
                }}
              >
                {slipCount}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

const HISTORY_STATUS_LABEL: Record<TicketStatus, string> = {
  pending_delay: "Pending",
  accepted: "Accepted",
  rejected: "Rejected",
  settled: "Settled",
  voided: "Voided",
  cashed_out: "Cashed out",
};

function resolveHistoryBadge(t: TicketSummary): {
  label: string;
  color: string;
} {
  if (t.status === "settled") {
    // Compare against stake, not 0. A fully voided ticket has
    // actual_payout == stake (refund), not 0 — labeling it "Won"
    // would mis-frame a refund as a winning ticket. A half-lost or
    // partially-voided ticket has 0 < payout < stake and is correctly
    // a Lost (the bettor still came out behind).
    const payout = t.actualPayoutMicro ? BigInt(t.actualPayoutMicro) : 0n;
    const stake = BigInt(t.stakeMicro);
    if (payout > stake) return { label: "Won", color: "var(--positive)" };
    if (payout === stake) return { label: "Voided", color: "var(--fg-muted)" };
    return { label: "Lost", color: "var(--negative)" };
  }
  if (t.status === "rejected") return { label: "Rejected", color: "var(--negative)" };
  if (t.status === "pending_delay") return { label: "Pending", color: "var(--warning, var(--fg-muted))" };
  if (t.status === "accepted") return { label: "Accepted", color: "var(--fg)" };
  return { label: HISTORY_STATUS_LABEL[t.status], color: "var(--fg-muted)" };
}

// Success view for the slip body after a placement lands. Two visual
// states: accepted bets get the green check + "Bet placed"; live-delay
// placements get a clock + countdown so the user can see their bet is
// being held in the per-match/sport/global acceptance window before it
// counts. Without this, the green check made users think the delay
// wasn't being applied even when it was.
function PlacedTicketCard({
  ticketId,
  status,
  notBeforeTs,
  tBetPlaced,
  tBetQueued,
  tAcceptingIn,
  tLiveDelayNote,
  tTicket,
  tViewMyBets,
}: {
  ticketId: string;
  status: TicketStatus | null;
  notBeforeTs: string | null;
  tBetPlaced: string;
  tBetQueued: string;
  tAcceptingIn: (seconds: number) => string;
  tLiveDelayNote: string;
  tTicket: string;
  tViewMyBets: string;
}) {
  const pending = status === "pending_delay";
  const secondsLeft = useSecondsUntil(pending ? notBeforeTs : null);
  const showingCountdown =
    pending && secondsLeft !== null && secondsLeft > 0;
  const accent = showingCountdown ? "var(--warning, var(--fg))" : "var(--positive)";
  return (
    <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 10 }}>
      <div
        style={{
          width: 36,
          height: 36,
          borderRadius: 999,
          background: `color-mix(in oklab, ${accent} 15%, transparent)`,
          color: accent,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {showingCountdown ? <I.Clock size={18} /> : "✓"}
      </div>
      <div
        className="display"
        style={{ fontSize: 16, fontWeight: 500, letterSpacing: "-0.01em" }}
      >
        {showingCountdown ? tBetQueued : tBetPlaced}
      </div>
      {showingCountdown ? (
        <div style={{ fontSize: 12.5, color: "var(--fg)", lineHeight: 1.4 }}>
          {tAcceptingIn(secondsLeft!)}
          <span style={{ color: "var(--fg-muted)" }}> · {tLiveDelayNote}</span>
        </div>
      ) : null}
      <div style={{ fontSize: 12, color: "var(--fg-muted)" }}>
        {tTicket} <span className="mono">{ticketId.slice(0, 8)}…</span>
      </div>
      <Link
        href="/bets"
        style={{
          fontSize: 13,
          color: "var(--fg)",
          textDecoration: "underline",
          marginTop: 4,
        }}
      >
        {tViewMyBets} →
      </Link>
    </div>
  );
}

// Header rendered above the slip selections while the bet-delay worker
// is sitting on a freshly-placed ticket. The selection cards below this
// banner keep their normal "drift / suspended" badges (driven by the
// already-flowing live-odds + market-status WS ticks via slip.updateOdds
// + slip.setMarketStatus), so the bettor sees the same per-leg state
// the worker will evaluate against when it wakes up.
function PendingPlacementBanner({
  notBeforeTs,
  acceptOddsChanges,
  ticketId,
  t,
}: {
  notBeforeTs: string | null;
  acceptOddsChanges: boolean;
  ticketId: string;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const secondsLeft = useSecondsUntil(notBeforeTs);
  const counting = secondsLeft !== null && secondsLeft > 0;
  return (
    <div
      role="status"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
        padding: "10px 12px",
        background: "color-mix(in oklab, var(--warning, var(--fg)) 7%, var(--surface))",
        border:
          "1px solid color-mix(in oklab, var(--warning, var(--fg-muted)) 35%, var(--border))",
        borderRadius: 10,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <I.Clock size={14} />
        <span
          className="display"
          style={{ fontSize: 13.5, fontWeight: 500, letterSpacing: "-0.005em" }}
        >
          {counting ? t("betQueued") : t("betPlaced")}
        </span>
        {counting ? (
          <span
            className="mono tnum"
            style={{
              marginLeft: "auto",
              fontSize: 11,
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              fontWeight: 600,
            }}
          >
            {t("acceptingIn", { seconds: secondsLeft! })}
          </span>
        ) : null}
      </div>
      <div style={{ fontSize: 11.5, color: "var(--fg-muted)", lineHeight: 1.4 }}>
        {t("liveDelayNote")}
      </div>
      {acceptOddsChanges ? (
        <div
          style={{
            fontSize: 11,
            color: "var(--fg-muted)",
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <span style={{ fontSize: 11, color: "var(--positive)" }}>✓</span>
          {t("acceptOddsChangesActive")}
        </div>
      ) : null}
      <div
        style={{
          fontSize: 10,
          color: "var(--fg-dim)",
          letterSpacing: "0.04em",
        }}
      >
        {t("ticket")} <span className="mono">{ticketId.slice(0, 8)}…</span>
      </div>
    </div>
  );
}

// Inline notice for the slip body when the bet-delay worker rejected the
// pending ticket. The slip selections are still populated (and their
// pendingOdds / s.active are already up-to-date from the WS ticks that
// arrived during the wait), so a "Place bet again" path is one click +
// the existing "Accept odds change" flow.
function RejectedPlacementBanner({
  reason,
  onDismiss,
}: {
  reason: string | null;
  onDismiss: () => void;
}) {
  return (
    <div
      role="alert"
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 8,
        padding: "10px 12px",
        background: "color-mix(in oklab, var(--negative) 6%, var(--surface))",
        border:
          "1px solid color-mix(in oklab, var(--negative) 30%, var(--border))",
        borderRadius: 10,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          flex: "0 0 auto",
          width: 14,
          height: 14,
          borderRadius: 999,
          background: "var(--negative)",
          color: "var(--surface)",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 10,
          fontWeight: 700,
          lineHeight: 1,
        }}
      >
        !
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          className="display"
          style={{
            fontSize: 13,
            fontWeight: 500,
            letterSpacing: "-0.005em",
            color: "var(--negative)",
          }}
        >
          {humanReject(reason)}
        </div>
        <div style={{ fontSize: 11, color: "var(--fg-muted)", lineHeight: 1.4 }}>
          {rejectHint(reason)}
        </div>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        style={{
          background: 0,
          border: 0,
          color: "var(--fg-dim)",
          cursor: "pointer",
          padding: 2,
        }}
        aria-label="Dismiss"
      >
        <I.Close size={12} />
      </button>
    </div>
  );
}

// Footer rendered in place of the placement form while the bet-delay
// worker is processing a ticket. Mirrors the form's vertical footprint
// so the rail doesn't reflow when the bet first lands.
function PendingPlacementFooter({
  notBeforeTs,
  t,
}: {
  notBeforeTs: string | null;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const secondsLeft = useSecondsUntil(notBeforeTs);
  const counting = secondsLeft !== null && secondsLeft > 0;
  return (
    <div
      style={{
        padding: "10px 16px 14px",
        borderTop: "1px solid var(--hairline)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        color: "var(--fg-muted)",
        fontSize: 12.5,
      }}
    >
      <I.Clock size={14} />
      <span className="mono tnum">
        {counting ? t("acceptingIn", { seconds: secondsLeft! }) : t("betPlaced")}
      </span>
    </div>
  );
}

// Map the worker's reject_reason enum into a short human line + a hint
// for the bettor. Kept inline (not in i18n) for now — these are operator-
// facing reasons surfaced rarely; the slip's existing drift / suspended
// pills on the legs themselves are the primary signal.
function humanReject(reason: string | null): string {
  switch (reason) {
    case "odds_drift_exceeded":
      return "Odds changed during the delay";
    case "market_suspended":
      return "Market suspended during the delay";
    case "outcome_inactive":
      return "Outcome became inactive";
    case "no_current_price":
      return "No price available right now";
    default:
      return "Bet not accepted";
  }
}
function rejectHint(reason: string | null): string {
  switch (reason) {
    case "odds_drift_exceeded":
      return "Stake refunded. Review the updated price and place again, or tick “Accept odds changes” to auto-accept future drift.";
    case "market_suspended":
    case "outcome_inactive":
    case "no_current_price":
      return "Stake refunded. Wait for the market to reopen, or pick a different leg.";
    default:
      return "Stake refunded.";
  }
}

function HistoryPane({ highlightTicketId }: { highlightTicketId: string | null }) {
  const [tickets, setTickets] = useState<TicketSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Lazy fetch on first mount of the pane. The /bets full page already
  // has its own SSR fetch — this one is independent and lighter (capped
  // at 20 rows since the rail is narrow).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await clientApi<TicketListResponse>("/bets?limit=20");
        if (!cancelled) setTickets(data.tickets ?? []);
      } catch (e) {
        if (!cancelled) {
          setError(
            e instanceof ApiFetchError && e.status === 401
              ? "Sign in to see your bet history."
              : "Could not load bet history.",
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Live ticket frames update status in place — same pattern as the full
  // /bets page so the rail stays consistent without polling.
  useTicketStream(
    useCallback((frame: WsTicketFrame) => {
      setTickets((prev) =>
        prev
          ? prev.map((t) =>
              t.id === frame.ticketId
                ? {
                    ...t,
                    status: frame.status,
                    rejectReason: frame.rejectReason ?? t.rejectReason,
                    actualPayoutMicro:
                      frame.actualPayoutMicro ?? t.actualPayoutMicro,
                  }
                : t,
            )
          : prev,
      );
    }, []),
  );

  return (
    <div
      style={{
        minHeight: 0,
        flex: 1,
        overflow: "auto",
        padding: "12px 16px 18px",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      {error ? (
        <div
          role="alert"
          style={{
            fontSize: 12,
            color: "var(--fg-muted)",
            padding: "20px 0",
            textAlign: "center",
            lineHeight: 1.5,
          }}
        >
          {error}
        </div>
      ) : tickets === null ? (
        <div
          style={{
            fontSize: 12,
            color: "var(--fg-muted)",
            padding: "20px 0",
            textAlign: "center",
          }}
        >
          Loading…
        </div>
      ) : tickets.length === 0 ? (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 8,
            textAlign: "center",
            padding: "12px 20px 20px",
            color: "var(--fg-muted)",
          }}
        >
          <div
            style={{
              width: 44,
              height: 44,
              borderRadius: 999,
              background: "var(--surface-2)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--fg-dim)",
            }}
          >
            <I.Clock size={18} />
          </div>
          <div
            className="display"
            style={{ fontSize: 15, color: "var(--fg)", letterSpacing: "-0.01em" }}
          >
            No bets yet
          </div>
          <div
            style={{
              fontSize: 12,
              color: "var(--fg-muted)",
              maxWidth: 220,
              lineHeight: 1.5,
            }}
          >
            Once you place a bet it will appear here and on your full bet
            history page.
          </div>
        </div>
      ) : (
        <>
          {tickets.map((t) => (
            <HistoryTicketCard
              key={t.id}
              ticket={t}
              highlight={t.id === highlightTicketId}
            />
          ))}
          <Link
            href="/bets"
            style={{
              marginTop: 4,
              fontSize: 12,
              color: "var(--fg-muted)",
              textDecoration: "underline",
              textAlign: "center",
            }}
          >
            View full history →
          </Link>
        </>
      )}
    </div>
  );
}

function HistoryTicketCard({
  ticket,
  highlight,
}: {
  ticket: TicketSummary;
  highlight: boolean;
}) {
  const t = useTranslations("betSlip");
  const stake = fromMicro(BigInt(ticket.stakeMicro));
  const potential = fromMicro(BigInt(ticket.potentialPayoutMicro));
  const actual = ticket.actualPayoutMicro
    ? fromMicro(BigInt(ticket.actualPayoutMicro))
    : null;
  const badge = resolveHistoryBadge(ticket);
  const first = ticket.selections[0];
  const legCount = ticket.selections.length;
  const matchHref = first?.market ? `/match/${first.market.matchId}` : null;
  const placedAt = new Date(ticket.placedAt);
  const placedLabel = Number.isFinite(placedAt.getTime())
    ? placedAt.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : ticket.placedAt;
  // Live countdown for the live-delay acceptance window. Only ticks while
  // the ticket is still `pending_delay`; once the WS frame promotes it to
  // accepted, the badge flips and this collapses to null.
  const pending = ticket.status === "pending_delay";
  const secondsLeft = useSecondsUntil(pending ? ticket.notBeforeTs : null);

  return (
    <div
      style={{
        padding: "12px 14px",
        background: highlight
          ? "color-mix(in oklab, var(--positive) 7%, var(--surface))"
          : "var(--surface)",
        border: highlight
          ? "1px solid color-mix(in oklab, var(--positive) 35%, var(--border))"
          : "1px solid var(--border)",
        borderRadius: 10,
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {first?.market ? (
          <SportGlyph sport={first.market.sportSlug} size={12} />
        ) : (
          <I.Ticket size={12} />
        )}
        <span
          className="mono"
          style={{
            fontSize: 10,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "var(--fg-dim)",
          }}
        >
          {ticket.betType}
          {legCount > 1 ? ` · ${legCount} legs` : ""}
        </span>
        <div style={{ flex: 1 }} />
        <span
          className="mono"
          style={{
            fontSize: 10,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: badge.color,
            fontWeight: 600,
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
          }}
        >
          {pending ? <I.Clock size={10} /> : null}
          {pending && secondsLeft !== null && secondsLeft > 0
            ? t("acceptingIn", { seconds: secondsLeft })
            : badge.label}
        </span>
      </div>
      {pending && secondsLeft !== null && secondsLeft > 0 ? (
        // Sub-line below the header making it impossible to miss that the
        // bet is being held for the live-bet acceptance delay configured
        // in /admin/riskzilla/live-delay. Without this many users assumed
        // no delay was being applied at all because "Pending" flashed past
        // before they noticed.
        <div
          style={{
            fontSize: 11,
            color: "var(--fg-muted)",
            lineHeight: 1.35,
          }}
        >
          {t("liveDelayNote")}
        </div>
      ) : null}
      {legCount > 1 ? (
        // Combo / tiple / tippot / betbuilder — list every leg with
        // its odds + per-leg result colour + a result tag (WON / LOST
        // / VOID). Void legs strikethrough the placement odds and
        // show their effective factor (×1.00 for full void) so the
        // payout math reads correctly: a 1.01 × 1.03 combo where the
        // 1.01 leg voids becomes a 1.00 × 1.03 = 1.03 payout, and the
        // strikethrough makes that visible.
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {ticket.selections.map((s, i) => {
            const m = s.market;
            const legHref = m ? `/match/${m.matchId}` : null;
            const legOdds = Number(s.oddsAtPlacement);
            const oddsLabel = Number.isFinite(legOdds)
              ? legOdds.toFixed(2)
              : s.oddsAtPlacement;
            const isWon = s.result === "won" || s.result === "half_won";
            const isLost = s.result === "lost" || s.result === "half_lost";
            const isVoid = s.result === "void";
            const resultColor = isWon
              ? "var(--positive)"
              : isLost
                ? "var(--negative)"
                : isVoid
                  ? "var(--fg-muted)"
                  : "var(--fg)";
            // Effective factor on payout. Lost = 0; full void = 1;
            // half_won/half_lost would scale by void_factor — for now
            // we only annotate the simple cases (won/lost/void).
            const effectiveFactor = isVoid
              ? "×1.00"
              : isLost
                ? "×0.00"
                : null;
            // Strike through the placement odds when they're not what
            // actually contributed to the payout (lost: didn't pay;
            // void: paid 1.00 instead of the displayed odds).
            const strikeOdds = isVoid || isLost;
            const tagLabel = isWon
              ? "WON"
              : isLost
                ? "LOST"
                : isVoid
                  ? "VOID"
                  : null;
            const marketLabel = m
              ? m.marketName?.trim() || `Market #${m.providerMarketId}`
              : null;
            const outcomeLabel = m?.outcomeName?.trim() || s.outcomeId;
            const content = (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 2,
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    fontSize: 12.5,
                    overflow: "hidden",
                  }}
                >
                  {m ? <SportGlyph sport={m.sportSlug} size={11} /> : null}
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      color: resultColor,
                    }}
                  >
                    {m ? (
                      <>
                        {m.homeTeam}{" "}
                        <span style={{ color: "var(--fg-muted)" }}>vs</span>{" "}
                        {m.awayTeam}
                      </>
                    ) : (
                      "Match unavailable"
                    )}
                  </span>
                  {tagLabel ? (
                    <span
                      className="mono"
                      style={{
                        fontSize: 9.5,
                        letterSpacing: "0.06em",
                        color: resultColor,
                        fontWeight: 600,
                      }}
                    >
                      {tagLabel}
                    </span>
                  ) : null}
                  <span
                    className="mono tnum"
                    style={{
                      fontSize: 11,
                      color: "var(--fg-muted)",
                      textDecoration: strikeOdds ? "line-through" : undefined,
                    }}
                  >
                    {oddsLabel}
                  </span>
                  {effectiveFactor ? (
                    <span
                      className="mono tnum"
                      style={{ fontSize: 11, color: resultColor }}
                    >
                      {effectiveFactor}
                    </span>
                  ) : null}
                </div>
                {m ? (
                  // Market + selection sub-line. Without this the leg row
                  // shows the match teams and the placement odds but not
                  // what was actually picked, which made the rail history
                  // unreadable for anything other than match-winner singles.
                  <div
                    style={{
                      paddingLeft: 19, // align under the team name (icon + gap)
                      fontSize: 11,
                      color: "var(--fg-muted)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {marketLabel ? (
                      <>
                        {marketLabel}
                        <span style={{ color: "var(--fg-subtle)" }}> · </span>
                      </>
                    ) : null}
                    <span style={{ color: "var(--fg)" }}>{outcomeLabel}</span>
                  </div>
                ) : null}
              </div>
            );
            return legHref ? (
              <Link
                key={`${s.marketId}:${s.outcomeId}:${i}`}
                href={legHref}
                style={{
                  textDecoration: "none",
                  color: "inherit",
                  borderRadius: 6,
                  padding: "2px 0",
                }}
              >
                {content}
              </Link>
            ) : (
              <div key={`${s.marketId}:${s.outcomeId}:${i}`}>{content}</div>
            );
          })}
        </div>
      ) : first?.market ? (
        // Single-leg ticket: teams on the top line, market + selection
        // on the sub-line below. The sub-line is what answers "what did
        // I actually bet on?" — the team names alone don't.
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 2,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              fontSize: 13,
              fontWeight: 500,
              letterSpacing: "-0.005em",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {first.market.homeTeam}{" "}
            <span style={{ color: "var(--fg-muted)" }}>vs</span>{" "}
            {first.market.awayTeam}
          </div>
          <div
            style={{
              fontSize: 11,
              color: "var(--fg-muted)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {first.market.marketName?.trim() ? (
              <>
                {first.market.marketName}
                <span style={{ color: "var(--fg-subtle)" }}> · </span>
              </>
            ) : null}
            <span style={{ color: "var(--fg)" }}>
              {first.market.outcomeName?.trim() || first.outcomeId}
            </span>
          </div>
        </div>
      ) : (
        <div style={{ fontSize: 13, color: "var(--fg-muted)" }}>
          Selection metadata unavailable
        </div>
      )}
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 10,
        }}
      >
        <span style={{ fontSize: 11, color: "var(--fg-muted)" }}>
          {placedLabel}
        </span>
        <span
          className="mono tnum"
          style={{ fontSize: 12, color: "var(--fg-muted)" }}
        >
          {stake} → {actual ?? potential} {ticket.currency}
        </span>
      </div>
      {ticket.rejectReason ? (
        <div style={{ fontSize: 11, color: "var(--negative)" }}>
          {ticket.rejectReason}
        </div>
      ) : null}
      {matchHref && legCount === 1 ? (
        // Singles: deep-link to the one match. For combos each leg
        // above is already its own clickable row, so a single "View
        // match" link would be misleading.
        <Link
          href={matchHref}
          style={{
            fontSize: 11,
            color: "var(--fg-muted)",
            textDecoration: "underline",
          }}
        >
          View match →
        </Link>
      ) : null}
    </div>
  );
}

// ─── Combi Boost progress panel ────────────────────────────────────────
//
// Renders only in combo mode with >= 2 selections. Shows the active tier
// (or a prompt to start earning one), the next tier and how many more
// legs unlock it, plus a segmented bar with markers at each tier
// threshold from the live admin config. The segments fill green up to
// the user's current eligible-leg count.

function CombiBoostPanel({
  eligibleLegCount,
  currentTier,
  nextTier,
  legsToNext,
  ineligibleLegCount,
  config,
}: {
  eligibleLegCount: number;
  currentTier: CombiBoostTier | null;
  nextTier: CombiBoostTier | null;
  legsToNext: number;
  ineligibleLegCount: number;
  config: CombiBoostConfigLive;
}) {
  const cells = config.tiers[config.tiers.length - 1]?.minLegs ?? 8;
  const filled = Math.min(eligibleLegCount, cells);

  let statusText: string;
  if (currentTier && nextTier) {
    statusText = `${currentTier.label} boost active — ${legsToNext} more leg${legsToNext === 1 ? "" : "s"} to ${nextTier.label}`;
  } else if (currentTier && !nextTier) {
    statusText = `${currentTier.label} boost active — top tier reached`;
  } else if (nextTier) {
    const need = Math.max(0, nextTier.minLegs - eligibleLegCount);
    statusText = `Add ${need} more leg${need === 1 ? "" : "s"} (odds ≥ ${config.minOdds.toFixed(2)}) to unlock ${nextTier.label} boost`;
  } else {
    statusText = "";
  }

  return (
    <div
      role="status"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
        padding: "8px 10px",
        background: "var(--surface-2)",
        border: "1px solid var(--border)",
        borderRadius: 8,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <span
          className="mono"
          style={{
            fontSize: 10,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            color: "var(--fg-dim)",
          }}
        >
          Combi Boost
        </span>
        <span
          className="mono"
          style={{
            fontSize: 10,
            letterSpacing: "0.04em",
            color: "var(--fg-muted)",
          }}
        >
          MIN ODDS {config.minOdds.toFixed(2)}
        </span>
      </div>
      <div style={{ fontSize: 12, color: "var(--fg)", lineHeight: 1.35 }}>
        {statusText}
      </div>
      <BoostProgressBar
        filled={filled}
        totalCells={cells}
        currentTier={currentTier}
        config={config}
      />
      {ineligibleLegCount > 0 && (
        <div style={{ fontSize: 10.5, color: "var(--fg-muted)", lineHeight: 1.3 }}>
          {ineligibleLegCount} leg{ineligibleLegCount === 1 ? "" : "s"} below {config.minOdds.toFixed(2)} odds and won&apos;t count toward the boost.
        </div>
      )}
    </div>
  );
}

function BoostProgressBar({
  filled,
  totalCells,
  currentTier,
  config,
}: {
  filled: number;
  totalCells: number;
  currentTier: CombiBoostTier | null;
  config: CombiBoostConfigLive;
}) {
  // Tier thresholds expressed as cell indices — we mark each one with a
  // tick line above the bar so the user can see at a glance which step
  // they're on.
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${totalCells}, minmax(0, 1fr))`,
          gap: 0,
          fontSize: 9.5,
          color: "var(--fg-muted)",
        }}
        className="mono"
      >
        {Array.from({ length: totalCells }, (_, i) => {
          const cellLegs = i + 1;
          const tier = config.tiers.find((t) => t.minLegs === cellLegs);
          const isActive = currentTier ? currentTier.minLegs === cellLegs : false;
          return (
            <div
              key={i}
              style={{
                textAlign: "center",
                color: isActive ? "var(--positive, #16a34a)" : "var(--fg-muted)",
                fontWeight: isActive ? 600 : 400,
                opacity: tier ? 1 : 0,
              }}
            >
              {tier ? tier.label : "·"}
            </div>
          );
        })}
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${totalCells}, minmax(0, 1fr))`,
          gap: 2,
          height: 6,
        }}
      >
        {Array.from({ length: totalCells }, (_, i) => {
          const cellLegs = i + 1;
          const isFilled = cellLegs <= filled;
          const isTierBoundary = config.tiers.some(
            (t) => t.minLegs === cellLegs,
          );
          return (
            <div
              key={i}
              style={{
                height: "100%",
                background: isFilled
                  ? "var(--positive, #16a34a)"
                  : "var(--border)",
                borderRadius: 2,
                outline: isTierBoundary && !isFilled
                  ? "1px solid var(--fg-muted)"
                  : "none",
                outlineOffset: -1,
                transition: "background 160ms var(--ease)",
              }}
            />
          );
        })}
      </div>
    </div>
  );
}
