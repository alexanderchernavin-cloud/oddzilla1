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
import { useLiveOddsForMatches } from "@/lib/use-live-odds";
import { useTicketStream } from "@/lib/use-ticket-stream";
import { clientApi, ApiFetchError } from "@/lib/api-client";
import { I } from "@/components/ui/icons";
import { Button } from "@/components/ui/primitives";
import { SportGlyph } from "@/components/ui/sport-glyph";
import { useMobileDrawers } from "./mobile-drawer-context";
import { RailPrematchPanel } from "@/components/widgets/rail-prematch-panel";
import type {
  SlipSelection,
  TicketListResponse,
  TicketStatus,
  TicketSummary,
  WsTicketFrame,
} from "@oddzilla/types";

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

type RailTab = "slip" | "history";

export function BetSlipRail() {
  const slip = useBetSlip();
  const selections = slip.selections;
  const currency = slip.currency;
  const { closeAll } = useMobileDrawers();
  const router = useRouter();
  const [stakeInput, setStakeInput] = useState("10");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [placedTicketId, setPlacedTicketId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<RailTab>("slip");

  // Drop the success view as soon as the user starts a new slip — otherwise
  // the post-placement screen would shadow new picks indefinitely.
  useEffect(() => {
    if (selections.length > 0 && placedTicketId) {
      setPlacedTicketId(null);
    }
  }, [selections.length, placedTicketId]);

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

  // Once any selection is flagged inactive (either by the WS tick path
  // above or stamped at click time by the caller), surface the
  // suspended state in the rail and gate Place bet so the user doesn't
  // hit the server's market_not_active / outcome_not_active guard.
  const hasSuspendedSelection = selections.some((s) => s.active === false);

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
  useEffect(() => {
    if (!isBetBuilder || !builderMatchId || builderLegSig === "") {
      // Either not in builder mode or empty leg list — clear quote.
      slip.setBetbuilderQuote(null);
      return;
    }
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
    // builderLegSig captures everything material to the leg set; the
    // rest of the deps are stable references managed by the slip store.
    // (The `react-hooks/exhaustive-deps` rule is not configured in this
    // repo's ESLint, so a `// eslint-disable-next-line` for it would
    // fail Next.js's lint pass with "Definition for rule … not found".)
  }, [isBetBuilder, builderMatchId, builderLegSig]);

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
    setError(null);
    setPlacedTicketId(null);

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
      const res = await clientApi<{ ticket: { id: string; status: string } }>(
        "/bets",
        {
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
            })),
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
        },
      );
      setPlacedTicketId(res.ticket.id);
      slip.clear();
      router.refresh();
      // Surface the new ticket in-rail by flipping to History — the slip
      // body now also shows a placement-success card, but the user usually
      // wants to watch their fresh ticket pick up status.
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
        top: 60,
        maxHeight: "calc(100vh - 60px)",
        // Widget panels and long histories can exceed the viewport-bounded
        // sticky aside — let the entire rail column scroll as one. The
        // selections list inside still has its own overflow so a mid-slip
        // scroll doesn't push the form out of view.
        overflowY: "auto",
      }}
    >
      {/* Drag handle — only visible when the rail is rendered as a
          mobile bottom sheet; CSS handles the breakpoint. */}
      <span className="oz-rail-handle" aria-hidden="true" />
      <div
        style={{
          padding: "14px 20px 12px",
          display: "flex",
          flexDirection: "column",
          gap: 10,
          borderBottom: "1px solid var(--hairline)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
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
              Clear
            </button>
          )}
          <button
            type="button"
            onClick={closeAll}
            className="oz-rail-close"
            aria-label="Close bet slip"
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
                ? "Single"
                : `${effectiveMode} · ${selections.length}`}
            </span>
          </div>
        )}
      </div>

      {activeTab === "history" ? (
        <HistoryPane highlightTicketId={placedTicketId} />
      ) : (
        <>
      <div
        style={{
          minHeight: 0,
          flexShrink: 1,
          overflow: "auto",
          padding: "12px 16px 8px",
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        {placedTicketId ? (
          <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 10 }}>
            <div
              style={{
                width: 36,
                height: 36,
                borderRadius: 999,
                background: "color-mix(in oklab, var(--positive) 15%, transparent)",
                color: "var(--positive)",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              ✓
            </div>
            <div
              className="display"
              style={{ fontSize: 16, fontWeight: 500, letterSpacing: "-0.01em" }}
            >
              Bet placed.
            </div>
            <div style={{ fontSize: 12, color: "var(--fg-muted)" }}>
              Ticket id{" "}
              <span className="mono">{placedTicketId.slice(0, 8)}…</span>
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
              View in bet history →
            </Link>
          </div>
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
              Empty slip
            </div>
            <div
              style={{
                fontSize: 12,
                color: "var(--fg-muted)",
                maxWidth: 220,
                lineHeight: 1.5,
              }}
            >
              Tap any odds button to build your bet. Add a second match for a
              combo — multiple markets from the same match replace each other.
            </div>
          </div>
        ) : (
          <>
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

      {selections.length > 0 && !placedTicketId && (
        <form
          onSubmit={onSubmit}
          style={{
            padding: "14px 20px 18px",
            borderTop: "1px solid var(--hairline)",
            display: "flex",
            flexDirection: "column",
            // Without this, the form competes with the prematch widget
            // below for vertical space and the Place button can drop
            // below the fold on shorter viewports.
            flexShrink: 0,
            gap: 12,
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
                {(combinedOdds * combiBoost.multiplier).toFixed(2)}
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
              padding: "0 14px",
              height: 44,
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
                fontSize: 15,
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
                  height: 28,
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
              padding: "10px 0",
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
                style={{ fontSize: 22, fontWeight: 500, letterSpacing: "-0.02em" }}
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

          {/* Pre-empt the server's suspended-market 400 — the WS tick
              path already flipped one of our selections to active=false,
              so submitting would just dead-end against the validator. */}
          {!error && hasSuspendedSelection && (
            <div
              role="status"
              style={{ fontSize: 12, color: "var(--negative)", lineHeight: 1.45 }}
            >
              {SUSPENDED_ERROR_MESSAGE}
            </div>
          )}

          <Button
            variant="primary"
            size="lg"
            type="submit"
            disabled={
              submitting ||
              builderNeedsLegs ||
              builderQuoteMissing ||
              (isBetBuilderMode && !!builderError) ||
              hasSuspendedSelection
            }
            style={{ width: "100%" }}
          >
            {submitting
              ? "Placing…"
              : isBetBuilderMode
                ? "Place BetBuilder"
                : isTiple
                  ? "Place Tiple"
                  : isTippot
                    ? "Place Tippot"
                    : isCombo
                      ? "Place combo"
                      : "Place bet"}
          </Button>

          <div style={{ fontSize: 11, color: "var(--fg-dim)", textAlign: "center" }}>
            Odds may update before acceptance.
          </div>
        </form>
      )}
        </>
      )}
      {/*
        Match-insights widget — only relevant while building a slip
        for the active match. Hidden on the History tab (the user is
        reviewing past tickets, prematch stats are off-topic) and
        right after placement (the success card / freshly-flipped
        history view should breathe). This stops the widget's
        minHeight from squeezing the rail's primary content.
      */}
      {activeTab === "slip" && !placedTicketId && <RailPrematchPanel />}
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
  // Selections persisted from older slip versions don't carry an active
  // flag — treat the absence as bettable so the card doesn't suddenly
  // grey out for everyone after a deploy.
  const suspended = selection.active === false;
  return (
    <div
      style={{
        padding: "12px 14px",
        background: "var(--surface)",
        border: suspended
          ? "1px solid color-mix(in oklab, var(--negative) 35%, var(--border))"
          : "1px solid var(--border)",
        borderRadius: 10,
        display: "flex",
        flexDirection: "column",
        gap: 6,
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
          {selection.marketLabel}
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
            Suspended
          </span>
        )}
        <div style={{ flex: 1 }} />
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
          aria-label="Remove selection"
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
          {selection.outcomeLabel}
        </div>
        <div
          className="mono tnum"
          style={{
            fontSize: 14,
            fontWeight: 600,
            flexShrink: 0,
            color: suspended ? "var(--fg-muted)" : undefined,
          }}
        >
          {Number(selection.odds).toFixed(2)}
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
  const tabs: Array<{ id: RailTab; label: string; icon: "ticket" | "history" }> = [
    { id: "slip", label: "Slip", icon: "ticket" },
    { id: "history", label: "History", icon: "history" },
  ];
  return (
    <div role="tablist" aria-label="Bet slip view" style={{ display: "flex", gap: 4 }}>
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
    const won =
      t.actualPayoutMicro != null && BigInt(t.actualPayoutMicro) > 0n;
    return won
      ? { label: "Won", color: "var(--positive)" }
      : { label: "Lost", color: "var(--negative)" };
  }
  if (t.status === "rejected") return { label: "Rejected", color: "var(--negative)" };
  if (t.status === "pending_delay") return { label: "Pending", color: "var(--warning, var(--fg-muted))" };
  if (t.status === "accepted") return { label: "Accepted", color: "var(--fg)" };
  return { label: HISTORY_STATUS_LABEL[t.status], color: "var(--fg-muted)" };
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
          }}
        >
          {badge.label}
        </span>
      </div>
      {legCount > 1 ? (
        // Combo / tiple / tippot / betbuilder — list every leg with
        // its odds + per-leg result colour. Each row links to its
        // match so the user can drill back in. No more "+1" hidden
        // legs.
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {ticket.selections.map((s, i) => {
            const m = s.market;
            const legHref = m ? `/match/${m.matchId}` : null;
            const legOdds = Number(s.oddsAtPlacement);
            const oddsLabel = Number.isFinite(legOdds)
              ? legOdds.toFixed(2)
              : s.oddsAtPlacement;
            const resultColor =
              s.result === "won" || s.result === "half_won"
                ? "var(--positive)"
                : s.result === "lost" || s.result === "half_lost"
                  ? "var(--negative)"
                  : s.result === "void"
                    ? "var(--fg-muted)"
                    : "var(--fg)";
            const content = (
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
                <span
                  className="mono tnum"
                  style={{ fontSize: 11, color: "var(--fg-muted)" }}
                >
                  {oddsLabel}
                </span>
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
        gap: 8,
        padding: "10px 12px",
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
