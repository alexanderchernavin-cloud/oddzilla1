"use client";

import type { CSSProperties, JSX, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useBetSlip } from "@/lib/bet-slip";
import { useOddsFlash } from "@/lib/use-odds-flash";
import {
  useLiveOddsForMatches,
  useLiveMarketStatusForMatches,
  type LiveOddsTick,
} from "@/lib/use-live-odds";
import { useTranslations } from "@/lib/i18n";
import { SportGlyph } from "@/components/ui/sport-glyph";
import { computeCombiBoost } from "@oddzilla/types/combi-boost";
import { useCombiBoostConfig } from "@/lib/combi-boost-config";
import {
  TIER_ORDER,
  type ThreeFoldLeg,
  type ThreeFoldSuggestion,
  type ThreeFoldSuggestions,
  type TierKey,
} from "@/lib/three-fold-builder";

// ComboZilla carousel. All tier cards live in a single horizontally
// scrollable track with native scroll-snap. Desktop renders ~2 cards
// with the next peeking on the right; mobile renders ~1 card with a
// peek. Header arrow buttons scroll by one card and disable at the
// boundaries; touch/wheel/drag also scroll natively and snap.

interface TierMeta {
  key: TierKey;
  label: string;
  tagline: string;
  accent: string;
  Icon: (props: { size: number; color: string }) => JSX.Element;
}

interface TierStatic {
  key: TierKey;
  accent: string;
  Icon: (props: { size: number; color: string }) => JSX.Element;
}

const TIER_STATIC: TierStatic[] = [
  { key: "safe", accent: "#15803d", Icon: ShieldIcon },
  { key: "challenging", accent: "#b45309", Icon: BoltIcon },
  { key: "risky", accent: "#c2410c", Icon: FlameIcon },
  { key: "ultimate", accent: "#b91c1c", Icon: SkullIcon },
];

export function ThreeFoldCards({
  suggestions,
}: {
  suggestions: ThreeFoldSuggestions;
}) {
  const slip = useBetSlip();
  const boostCfg = useCombiBoostConfig();
  const t = useTranslations("threeFold");

  const TIERS: TierMeta[] = useMemo(
    () =>
      TIER_STATIC.map((s) => ({
        ...s,
        label: t(`${s.key}Label`),
        tagline: t(`${s.key}Tagline`),
      })),
    [t],
  );

  // Tiers in their canonical order. We keep all four slots in the DOM
  // (the carousel just translates) so SSR + CSR agree on layout and
  // the breakpoint can swap windowing without a re-render.
  const orderedTiers: TierMeta[] = useMemo(
    () => TIER_ORDER.map((k) => TIERS.find((t) => t.key === k)!).filter(Boolean),
    [TIERS],
  );
  const visibleTiers = orderedTiers.filter((m) => !!suggestions[m.key]);

  // Live-odds tick across every leg in every tier (not just the visible
  // window). The card preview prices stay in sync even before the user
  // pages over to a tier — and the boost preview re-renders when ticks
  // arrive.
  const matchIds = useMemo(() => {
    const ids: string[] = [];
    for (const m of visibleTiers) {
      const s = suggestions[m.key];
      if (!s) continue;
      for (const leg of s.legs) ids.push(leg.matchId);
    }
    return ids;
  }, [visibleTiers, suggestions]);

  const ticks = useLiveOddsForMatches(matchIds);
  // Per-market status — needed so a suggested leg sitting on a market
  // that has flipped to suspended/settled/cancelled is stamped
  // active=false when the user activates the card. Oddin leaves the
  // outcome at active=true with stale prices while the parent market
  // is suspended (see odds-publisher comment), so the per-outcome
  // `tick.active` alone misses the lock and POST /bets dead-ends at
  // `market_not_active` ("This market is suspended"). Same shared
  // socket as ticks above.
  const marketStatuses = useLiveMarketStatusForMatches(matchIds);

  // Scroll boundary state — drives the disabled state of the header
  // arrows. Updated on scroll + resize via a single rAF-coalesced
  // listener so wheel/touch/drag stay in sync with button clicks.
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [canPrev, setCanPrev] = useState(false);
  const [canNext, setCanNext] = useState(true);

  const updateBoundaries = useCallback(() => {
    const el = trackRef.current;
    if (!el) return;
    // 2-px epsilon to absorb subpixel rounding after smooth-scroll.
    const epsilon = 2;
    setCanPrev(el.scrollLeft > epsilon);
    setCanNext(el.scrollLeft + el.clientWidth < el.scrollWidth - epsilon);
  }, []);

  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    updateBoundaries();
    el.addEventListener("scroll", updateBoundaries, { passive: true });
    const ro = new ResizeObserver(updateBoundaries);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", updateBoundaries);
      ro.disconnect();
    };
  }, [updateBoundaries, visibleTiers.length]);

  const scrollByOneCard = (direction: 1 | -1) => {
    const el = trackRef.current;
    if (!el) return;
    const firstCard = el.querySelector<HTMLElement>("[data-card-slot]");
    // Card width + flex-gap. The gap is fixed at 12 px in the CSS;
    // querying computedStyle here avoids a magic number drifting out
    // of sync, but the CSS variable would be even better long-term.
    const cardWidth = firstCard ? firstCard.offsetWidth : el.clientWidth;
    const gap = parseFloat(getComputedStyle(el).columnGap || "0") || 12;
    el.scrollBy({ left: direction * (cardWidth + gap), behavior: "smooth" });
  };

  if (visibleTiers.length === 0) return null;

  const handle = (legs: ThreeFoldLeg[]) => {
    slip.clear();
    slip.setMode("combo");
    for (const leg of legs) {
      const tick = ticks[`${leg.marketId}:${leg.outcomeId}`];
      const marketTick = marketStatuses[leg.marketId];
      // A leg is active iff its outcome is active AND the parent
      // market is currently at status=1. Oddin sometimes lags the
      // outcome flip on a suspension, so the market-level signal is
      // the authoritative gate. Suspended legs are still added (so
      // the slip rail surfaces the "drop suspended legs?" confirm
      // before placement instead of silently dropping them).
      const outcomeActive = tick ? tick.active : true;
      const marketActive = marketTick == null || marketTick.status === 1;
      const legActive = outcomeActive && marketActive;
      const fresh: ThreeFoldLeg =
        tick && tick.active
          ? {
              ...leg,
              odds: tick.publishedOdds,
              probability: tick.probability ?? leg.probability,
            }
          : leg;
      slip.add({ ...stripPickedSide(fresh), active: legActive });
    }
    slip.setOpen(true);
  };

  // Hide the nav entirely if there's nothing to scroll — keeps a
  // single visible tier from showing two dead-disabled chevrons.
  const showNav = canPrev || canNext;

  return (
    <section className="oz-combozilla-row" aria-label="ComboZilla">
      <header className="oz-combozilla-header">
        <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.1 }}>
          <span
            className="mono"
            style={{
              fontSize: 10.5,
              letterSpacing: "0.16em",
              textTransform: "uppercase",
              color: "var(--fg-dim)",
            }}
          >
            {t("kicker")}
          </span>
          <span
            style={{
              fontFamily: "var(--font-display, inherit)",
              fontSize: 22,
              fontWeight: 500,
              letterSpacing: "-0.01em",
              color: "var(--fg)",
            }}
          >
            ComboZilla
          </span>
        </div>
        <span style={{ flex: 1 }} />
        {showNav && (
          <div className="oz-combozilla-nav">
            <ArrowButton
              direction="prev"
              disabled={!canPrev}
              ariaLabel={t("cyclePrevGeneric")}
              onClick={() => scrollByOneCard(-1)}
            />
            <ArrowButton
              direction="next"
              disabled={!canNext}
              ariaLabel={t("cycleNextGeneric")}
              onClick={() => scrollByOneCard(1)}
            />
          </div>
        )}
      </header>
      <div className="oz-combozilla-track" ref={trackRef}>
        {visibleTiers.map((tier) => (
          <div key={tier.key} className="oz-combozilla-card-slot" data-card-slot>
            <Card
              tier={tier}
              suggestion={suggestions[tier.key]!}
              ticks={ticks}
              onActivate={handle}
              boostCfg={boostCfg}
            />
          </div>
        ))}
      </div>
    </section>
  );
}

// Header chevron button. Sits in the top-right of the ComboZilla
// header next to the title; scrolls the track by one card. Stays
// mounted but `disabled` (opacity 0.5) at the boundaries so the
// header chrome doesn't shift when reaching the start or end.
function ArrowButton({
  direction,
  disabled,
  ariaLabel,
  onClick,
}: {
  direction: "prev" | "next";
  disabled: boolean;
  ariaLabel: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      title={ariaLabel}
      data-direction={direction}
      style={{
        width: 32,
        height: 32,
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 10,
        color: "var(--fg)",
        opacity: disabled ? 0.45 : 1,
        cursor: disabled ? "default" : "pointer",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 0,
        transition: "border-color 140ms var(--ease), opacity 140ms var(--ease)",
      }}
      onMouseEnter={(e) => {
        if (!disabled) {
          (e.currentTarget as HTMLButtonElement).style.borderColor =
            "var(--fg-muted)";
        }
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).style.borderColor =
          "var(--border)";
      }}
    >
      <ChevronGlyph direction={direction} />
    </button>
  );
}

function ChevronGlyph({ direction }: { direction: "prev" | "next" }) {
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden
      style={{ transform: direction === "prev" ? "rotate(180deg)" : undefined }}
    >
      <path
        d="m6 4 4 4-4 4"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function stripPickedSide(leg: ThreeFoldLeg) {
  const { pickedSide: _ignored, ...rest } = leg;
  void _ignored;
  return rest;
}

function Card({
  tier,
  suggestion,
  ticks,
  onActivate,
  boostCfg,
}: {
  tier: TierMeta;
  suggestion: ThreeFoldSuggestion;
  ticks: Record<string, LiveOddsTick>;
  onActivate: (legs: ThreeFoldLeg[]) => void;
  boostCfg: ReturnType<typeof useCombiBoostConfig>;
}) {
  const t = useTranslations("threeFold");
  const liveLegs: ThreeFoldLeg[] = suggestion.legs.map((leg) => {
    const tick = ticks[`${leg.marketId}:${leg.outcomeId}`];
    if (!tick || !tick.active) return leg;
    return {
      ...leg,
      odds: tick.publishedOdds,
      probability: tick.probability ?? leg.probability,
    };
  });

  const product = liveLegs.reduce(
    (p, l) => p * Number.parseFloat(l.odds),
    1,
  );
  const baseCombinedNum = Number.isFinite(product) ? product : NaN;
  const baseCombinedStr = Number.isFinite(baseCombinedNum)
    ? (Math.floor(baseCombinedNum * 100) / 100).toFixed(2)
    : suggestion.combinedOdds;

  const boost = computeCombiBoost(liveLegs.map((l) => l.odds), boostCfg);
  const boostActive = boost.multiplier > 1.0;
  const boostedNum = Number.isFinite(baseCombinedNum)
    ? baseCombinedNum * boost.multiplier
    : NaN;
  const boostedStr = Number.isFinite(boostedNum)
    ? (Math.floor(boostedNum * 100) / 100).toFixed(2)
    : baseCombinedStr;

  const cardStyle: CSSProperties = {
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: "var(--r-md)",
    overflow: "hidden",
    cursor: "pointer",
    textAlign: "left",
    padding: 0,
    color: "var(--fg)",
    fontFamily: "inherit",
    transition: "border-color 140ms var(--ease)",
    minWidth: 0,
    width: "100%",
  };

  return (
    <button
      type="button"
      onClick={() => onActivate(liveLegs)}
      style={cardStyle}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLButtonElement).style.borderColor = "var(--fg-muted)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).style.borderColor = "var(--border)";
      }}
      aria-label={t("aria", { tier: tier.label, odds: boostActive ? boostedStr : baseCombinedStr })}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "10px 12px",
          borderBottom: "1px solid var(--hairline)",
          minWidth: 0,
        }}
      >
        <tier.Icon size={16} color={tier.accent} />
        <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.15, minWidth: 0 }}>
          <span
            className="mono"
            style={{
              fontSize: 10.5,
              letterSpacing: "0.14em",
              textTransform: "uppercase",
              color: tier.accent,
            }}
          >
            {tier.label}
          </span>
          <span style={{ fontSize: 11.5, color: "var(--fg-muted)" }}>
            {suggestion.sportName} · {tier.tagline}
          </span>
        </div>
        <div style={{ flex: 1 }} />
        <OddsChip price={boostActive ? boostedNum : baseCombinedNum} size="md">
          {boostActive ? (
            <span
              style={{ display: "inline-flex", alignItems: "baseline", gap: 6 }}
            >
              <span
                className="mono tnum"
                style={{
                  fontSize: 11,
                  fontWeight: 500,
                  color: "var(--fg-dim)",
                  textDecoration: "line-through",
                }}
              >
                {baseCombinedStr}
              </span>
              <span style={{ color: "var(--positive, #16a34a)" }}>
                {boostedStr}
              </span>
            </span>
          ) : (
            baseCombinedStr
          )}
        </OddsChip>
      </div>
      <div
        style={{
          padding: "8px 12px 10px",
          display: "flex",
          flexDirection: "column",
          gap: 6,
        }}
      >
        {liveLegs.map((leg) => (
          <LegRow key={`${leg.matchId}-${leg.outcomeId}`} leg={leg} />
        ))}
      </div>
    </button>
  );
}

function LegRow({ leg }: { leg: ThreeFoldLeg }) {
  const tMatch = useTranslations("match");
  const opponent = leg.pickedSide === "home" ? leg.awayTeam : leg.homeTeam;
  const oddsNum = Number.parseFloat(leg.odds);
  const vsLabel = tMatch("vs");
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        fontSize: 12.5,
        minWidth: 0,
      }}
    >
      <SportGlyph sport={leg.sportSlug} size={14} />
      <span
        style={{
          fontWeight: 600,
          color: "var(--fg)",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          flexShrink: 1,
          minWidth: 0,
        }}
        title={leg.outcomeLabel}
      >
        {leg.outcomeLabel}
      </span>
      <span
        style={{
          color: "var(--fg-dim)",
          fontSize: 11,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          minWidth: 0,
          flexShrink: 1,
        }}
        title={`${vsLabel} ${opponent}`}
      >
        {vsLabel} {opponent}
      </span>
      <div style={{ flex: 1 }} />
      <OddsChip price={Number.isFinite(oddsNum) ? oddsNum : null} size="sm">
        {leg.odds}
      </OddsChip>
    </div>
  );
}

function OddsChip({
  price,
  size,
  children,
}: {
  price: number | null;
  size: "sm" | "md";
  children: ReactNode;
}) {
  const ref = useRef<HTMLSpanElement | null>(null);
  useOddsFlash(price, ref);
  const H = size === "md" ? 36 : 26;
  const fontSize = size === "md" ? 14 : 12;
  const padX = size === "md" ? 12 : 8;
  return (
    <span
      ref={ref}
      className="mono tnum"
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        height: H,
        padding: `0 ${padX}px`,
        background: "var(--surface-2)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        fontSize,
        fontWeight: 600,
        letterSpacing: "-0.01em",
        color: "var(--fg)",
        flexShrink: 0,
      }}
    >
      {children}
    </span>
  );
}

function ShieldIcon({ size, color }: { size: number; color: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 3 4 6v6c0 4.5 3.4 8.4 8 9 4.6-.6 8-4.5 8-9V6z"
        stroke={color}
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path
        d="m9 12 2 2 4-4"
        stroke={color}
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function BoltIcon({ size, color }: { size: number; color: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M13 3 4 14h6l-1 7 9-11h-6z"
        stroke={color}
        strokeWidth="1.6"
        strokeLinejoin="round"
        fill={color}
        fillOpacity="0.15"
      />
    </svg>
  );
}

function FlameIcon({ size, color }: { size: number; color: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 3c1 3 4 4.5 4 8.5a4 4 0 0 1-8 0c0-1.5.5-2.5 1.5-3.5C9 7 9 5 12 3z"
        stroke={color}
        strokeWidth="1.6"
        strokeLinejoin="round"
        fill={color}
        fillOpacity="0.15"
      />
      <path
        d="M10 14c0 2 1 3.5 2 3.5s2-1.5 2-3.5c-.7.7-1.3.7-2 0-.7.7-1.3.7-2 0z"
        stroke={color}
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SkullIcon({ size, color }: { size: number; color: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M5 11c0-4 3-7 7-7s7 3 7 7v3c0 1-.6 1.8-1.5 2.2L17 17v3h-2v-2h-2v2h-2v-2H9v2H7v-3l-.5-.8C5.6 15.8 5 15 5 14z"
        stroke={color}
        strokeWidth="1.6"
        strokeLinejoin="round"
        fill={color}
        fillOpacity="0.12"
      />
      <circle cx="9.5" cy="12" r="1.4" fill={color} />
      <circle cx="14.5" cy="12" r="1.4" fill={color} />
    </svg>
  );
}
