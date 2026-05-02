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
import { useBetSlip, type SlipMode } from "@/lib/bet-slip";
import { useLiveOddsForMatches } from "@/lib/use-live-odds";
import { useTicketStream } from "@/lib/use-ticket-stream";
import { clientApi, ApiFetchError } from "@/lib/api-client";
import { I } from "@/components/ui/icons";
import { Button } from "@/components/ui/primitives";
import { SportGlyph } from "@/components/ui/sport-glyph";
import { useMobileDrawers } from "./mobile-drawer-context";
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
      if (tick.publishedOdds === s.odds && (tick.probability ?? s.probability) === s.probability) {
        continue;
      }
      slip.updateOdds(s.marketId, s.outcomeId, tick.publishedOdds, tick.probability);
      appliedAny = true;
    }
    if (appliedAny) {
      setError((prev) => (prev === DRIFT_ERROR_MESSAGE ? null : prev));
    }
  }, [liveTicks, selections, slip]);

  // Effective product mode. Single is forced when there's only one
  // selection regardless of last-stored mode. tiple/tippot need ≥2.
  const effectiveMode: SlipMode = useMemo(() => {
    if (selections.length <= 1) return "single";
    if (slip.mode === "single") return "combo";
    return slip.mode;
  }, [selections.length, slip.mode]);

  // Combined odds = product of all selection odds (combo accumulator).
  // Used for single + combo display.
  const combinedOdds = useMemo(() => {
    if (selections.length === 0) return 0;
    return selections.reduce((acc, s) => acc * Number(s.odds || 0), 1);
  }, [selections]);

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

  const potentialReturn = useMemo(() => {
    const stake = Number(stakeInput);
    if (!Number.isFinite(stake) || stake <= 0) return 0;
    if (effectiveMode === "tiple" && tipleQuote) {
      return stake * Number(tipleQuote.offeredOdds);
    }
    if (effectiveMode === "tippot" && tippotQuote) {
      const top = tippotQuote.tiers[tippotQuote.tiers.length - 1];
      return top ? stake * Number(top.multiplier) : 0;
    }
    if (combinedOdds <= 0) return 0;
    return stake * combinedOdds;
  }, [stakeInput, combinedOdds, effectiveMode, tipleQuote, tippotQuote]);

  // Show a whole-number amount without trailing ".00"; keep up to
  // 2 decimals otherwise, trimming trailing zeros (e.g. "14.5" not "14.50").
  const formatAmount = (n: number): string => {
    if (!Number.isFinite(n) || n <= 0) return "0";
    return n.toFixed(2).replace(/\.?0+$/, "");
  };

  const isCombo = effectiveMode === "combo";
  const isTiple = effectiveMode === "tiple";
  const isTippot = effectiveMode === "tippot";
  const isMulti = selections.length >= 2;
  const productPriceMissing = (isTiple || isTippot) && probabilityArr === null;

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
      const res = await clientApi<{ ticket: { id: string; status: string } }>(
        "/bets",
        {
          method: "POST",
          body: JSON.stringify({
            stakeMicro,
            idempotencyKey,
            currency,
            // Send explicit betType so the server knows to apply tiple/
            // tippot pricing — without this, ≥2 legs default to "combo".
            betType: effectiveMode,
            selections: selections.map((s) => ({
              marketId: s.marketId,
              outcomeId: s.outcomeId,
              odds: s.odds,
            })),
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
            gap: 12,
          }}
        >
          {isMulti && (
            <ModeSelector
              mode={effectiveMode}
              n={selections.length}
              onChange={(m) => slip.setMode(m)}
            />
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
                {combinedOdds.toFixed(2)}
              </span>
            </div>
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

          <Button
            variant="primary"
            size="lg"
            type="submit"
            disabled={submitting}
            style={{ width: "100%" }}
          >
            {submitting
              ? "Placing…"
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
  return (
    <div
      style={{
        padding: "12px 14px",
        background: "var(--surface)",
        border: "1px solid var(--border)",
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
          }}
        >
          {selection.outcomeLabel}
        </div>
        <div className="mono tnum" style={{ fontSize: 14, fontWeight: 600, flexShrink: 0 }}>
          {Number(selection.odds).toFixed(2)}
        </div>
      </div>
      <div style={{ fontSize: 11, color: "var(--fg-muted)" }}>
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
  switch (err.body.error) {
    case "insufficient_balance":
      return "Not enough balance for this stake.";
    case "exceeds_global_limit":
      return "Stake exceeds your global limit.";
    case "odds_drift_exceeded":
      return DRIFT_ERROR_MESSAGE;
    case "market_not_active":
    case "outcome_not_active":
    case "outcome_no_price":
      return "This market is suspended. Try again in a moment.";
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
    default:
      return err.body.message || "Placement failed.";
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
      {first?.market ? (
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
          {legCount > 1 ? (
            <span style={{ color: "var(--fg-muted)" }}> +{legCount - 1}</span>
          ) : null}
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
      {matchHref ? (
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
