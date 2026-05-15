"use client";

import type { CSSProperties, JSX, ReactNode } from "react";
import { useMemo, useRef, useState } from "react";
import { useBetSlip } from "@/lib/bet-slip";
import { useOddsFlash } from "@/lib/use-odds-flash";
import { useLiveOddsForMatches, type LiveOddsTick } from "@/lib/use-live-odds";
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

// ComboZilla rebrand: the existing four pre-built parlays are now
// surfaced as a horizontally-paged carousel. Desktop renders two cards
// at a time; mobile renders one. A single cycle button advances by 1
// slot and wraps. Its label reflects whichever tier slides INTO view
// next, so the affordance reads e.g. "Risky →" while the user is
// currently looking at safe + challenging.

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

  // First-visible tier index. Desktop renders [first, first+1]; mobile
  // renders [first]. Pagination is by window: desktop jumps by 2,
  // mobile jumps by 1, and we DON'T wrap — when the user is at the
  // boundary (safest combo on the left, ultimate on the right) the
  // corresponding direction button hides. The user has the tier name
  // shown on the card itself, so the cycle buttons are icon-only.
  const N = visibleTiers.length;
  const [first, setFirst] = useState(0);
  // Clamp the desktop view if the state was set via mobile navigation
  // to an index that would put the second visible slot past the end.
  const desktopFirst = Math.max(0, Math.min(first, N - 2));
  const mobileFirst = Math.max(0, Math.min(first, N - 1));

  if (N === 0) return null;

  const handle = (legs: ThreeFoldLeg[]) => {
    slip.clear();
    slip.setMode("combo");
    for (const leg of legs) {
      const tick = ticks[`${leg.marketId}:${leg.outcomeId}`];
      const fresh: ThreeFoldLeg =
        tick && tick.active
          ? {
              ...leg,
              odds: tick.publishedOdds,
              probability: tick.probability ?? leg.probability,
            }
          : leg;
      slip.add({ ...stripPickedSide(fresh), active: tick?.active ?? true });
    }
    slip.setOpen(true);
  };

  // Tiers shown in each visible slot.
  const slotA = visibleTiers[desktopFirst]!;
  const slotB = visibleTiers[Math.min(desktopFirst + 1, N - 1)]!;
  const mobileTier = visibleTiers[mobileFirst]!;

  // Tiers the cycle buttons advertise. The icon on each button is the
  // tier that would land in the leftmost slot after pressing — the
  // "next page" preview. Buttons hide entirely (via visibility:hidden
  // to preserve layout) when the page boundary is reached.
  const desktopPrevTier = visibleTiers[Math.max(desktopFirst - 2, 0)] ?? null;
  const desktopNextTier = visibleTiers[Math.min(desktopFirst + 2, N - 1)] ?? null;
  const mobilePrevTier = visibleTiers[Math.max(mobileFirst - 1, 0)] ?? null;
  const mobileNextTier = visibleTiers[Math.min(mobileFirst + 1, N - 1)] ?? null;

  const canPrevDesktop = desktopFirst > 0;
  const canNextDesktop = desktopFirst + 2 < N;
  const canPrevMobile = mobileFirst > 0;
  const canNextMobile = mobileFirst + 1 < N;

  const renderCard = (tier: TierMeta) => (
    <Card
      key={tier.key}
      tier={tier}
      suggestion={suggestions[tier.key]!}
      ticks={ticks}
      onActivate={handle}
      boostCfg={boostCfg}
    />
  );

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
      </header>
      <div className="oz-combozilla-track-wrap">
        <div className="oz-combozilla-cycle-slot" data-side="prev">
          <CycleButton
            className="oz-cycle-desktop"
            direction="prev"
            tier={desktopPrevTier}
            visible={canPrevDesktop}
            ariaLabel={
              desktopPrevTier
                ? t("cyclePrev", { tier: desktopPrevTier.label })
                : t("cyclePrevGeneric")
            }
            onClick={() => setFirst((i) => Math.max(0, i - 2))}
          />
          <CycleButton
            className="oz-cycle-mobile"
            direction="prev"
            tier={mobilePrevTier}
            visible={canPrevMobile}
            ariaLabel={
              mobilePrevTier
                ? t("cyclePrev", { tier: mobilePrevTier.label })
                : t("cyclePrevGeneric")
            }
            onClick={() => setFirst((i) => Math.max(0, i - 1))}
          />
        </div>
        <div className="oz-combozilla-track">
          <div className="oz-combozilla-slot" data-slot="a">
            {/* Desktop pulls from slotA; mobile pulls from mobileTier */}
            <div className="oz-combozilla-card-desktop">{renderCard(slotA)}</div>
            <div className="oz-combozilla-card-mobile">{renderCard(mobileTier)}</div>
          </div>
          <div className="oz-combozilla-slot" data-slot="b">
            {renderCard(slotB)}
          </div>
        </div>
        <div className="oz-combozilla-cycle-slot" data-side="next">
          <CycleButton
            className="oz-cycle-desktop"
            direction="next"
            tier={desktopNextTier}
            visible={canNextDesktop}
            ariaLabel={
              desktopNextTier
                ? t("cycleNext", { tier: desktopNextTier.label })
                : t("cycleNextGeneric")
            }
            onClick={() => setFirst((i) => Math.min(N - 2, i + 2))}
          />
          <CycleButton
            className="oz-cycle-mobile"
            direction="next"
            tier={mobileNextTier}
            visible={canNextMobile}
            ariaLabel={
              mobileNextTier
                ? t("cycleNext", { tier: mobileNextTier.label })
                : t("cycleNextGeneric")
            }
            onClick={() => setFirst((i) => Math.min(N - 1, i + 1))}
          />
        </div>
      </div>
    </section>
  );
}

// Icon-only carousel button. Tall and narrow — matches the card
// height via `align-self: stretch` driven by the surrounding grid
// (`.oz-combozilla-track-wrap { align-items: stretch }`). Renders
// the tier that would slide into the leftmost slot after pressing,
// so the icon alone communicates the discount / risk-tier flavour.
//
// Visibility is driven by CSS classes (.oz-cycle-desktop /
// .oz-cycle-mobile), one of which display:none's per breakpoint.
// Crucially: NO inline `display` here, or the class rule would be
// overridden and BOTH desktop + mobile buttons would render side by
// side. The previous version had this bug.
//
// When `visible` is false the button stays mounted but hidden via
// visibility:hidden so the cards don't shift sideways as the user
// scrolls toward the boundaries.
function CycleButton({
  className,
  direction,
  tier,
  visible,
  ariaLabel,
  onClick,
}: {
  className: string;
  direction: "prev" | "next";
  tier: TierMeta | null;
  visible: boolean;
  ariaLabel: string;
  onClick: () => void;
}) {
  if (!tier) {
    return <span className={`oz-cycle ${className}`} aria-hidden />;
  }
  return (
    <button
      type="button"
      className={`oz-cycle ${className}`}
      onClick={onClick}
      aria-label={ariaLabel}
      title={ariaLabel}
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 12,
        cursor: visible ? "pointer" : "default",
        color: "var(--fg)",
        padding: 0,
        visibility: visible ? "visible" : "hidden",
        transition: "border-color 140ms var(--ease)",
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLButtonElement).style.borderColor =
          "var(--fg-muted)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).style.borderColor = "var(--border)";
      }}
      data-direction={direction}
    >
      <tier.Icon size={20} color={tier.accent} />
    </button>
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
