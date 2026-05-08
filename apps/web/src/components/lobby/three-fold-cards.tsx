"use client";

import type { CSSProperties, JSX, ReactNode } from "react";
import { useMemo, useRef } from "react";
import { useBetSlip } from "@/lib/bet-slip";
import { useOddsFlash } from "@/lib/use-odds-flash";
import { useLiveOddsForMatches, type LiveOddsTick } from "@/lib/use-live-odds";
import { SportGlyph } from "@/components/ui/sport-glyph";
import { computeCombiBoost } from "@oddzilla/types/combi-boost";
import { useCombiBoostConfig } from "@/lib/combi-boost-config";
import type {
  ThreeFoldLeg,
  ThreeFoldSuggestion,
  ThreeFoldSuggestions,
  TierKey,
} from "@/lib/three-fold-builder";

interface TierMeta {
  key: TierKey;
  label: string;
  tagline: string;
  accent: string;
  Icon: (props: { size: number; color: string }) => JSX.Element;
}

// Accents kept muted — we only colour the icon, the tier word, and a
// thin badge. The card body itself stays neutral so the lobby doesn't
// turn into a traffic-light wall.
const TIERS: TierMeta[] = [
  {
    key: "safe",
    label: "Safe",
    tagline: "Build with favorites",
    accent: "#15803d",
    Icon: ShieldIcon,
  },
  {
    key: "challenging",
    label: "Challenging",
    tagline: "Mid-risk multi",
    accent: "#b45309",
    Icon: BoltIcon,
  },
  {
    key: "risky",
    label: "Risky",
    tagline: "Push the price",
    accent: "#c2410c",
    Icon: FlameIcon,
  },
  {
    key: "ultimate",
    label: "Ultimate",
    tagline: "Long-shot 3-fold",
    accent: "#b91c1c",
    Icon: SkullIcon,
  },
];

export function ThreeFoldCards({
  suggestions,
}: {
  suggestions: ThreeFoldSuggestions;
}) {
  const slip = useBetSlip();
  const boostCfg = useCombiBoostConfig();
  const visibleTiers = TIERS.filter((t) => suggestions[t.key]);

  const matchIds = useMemo(() => {
    const ids: string[] = [];
    for (const t of visibleTiers) {
      const s = suggestions[t.key];
      if (!s) continue;
      for (const leg of s.legs) ids.push(leg.matchId);
    }
    return ids;
  }, [visibleTiers, suggestions]);

  const ticks = useLiveOddsForMatches(matchIds);

  if (visibleTiers.length === 0) return null;

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
      // Default to active=true; the slip rail picks up the real WS
      // active flag on the next tick after subscribing.
      slip.add({ ...stripPickedSide(fresh), active: tick?.active ?? true });
    }
    slip.setOpen(true);
  };

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
        gap: 12,
      }}
    >
      {visibleTiers.map((t) => (
        <Card
          key={t.key}
          tier={t}
          suggestion={suggestions[t.key]!}
          ticks={ticks}
          onActivate={handle}
          boostCfg={boostCfg}
        />
      ))}
    </div>
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
  // Overlay live ticks onto the snapshot legs. Inactive ticks (market
  // suspended) are dropped — the snapshot odds remain visible until the
  // outcome reactivates, mirroring how the bet-slip rail behaves.
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

  // Combi Boost preview. Mirrors what the slip + API will compute when
  // the user clicks the card — the click handler doesn't need to do
  // anything extra, the slip's `add` flow already triggers the boost.
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
      aria-label={`Load ${tier.label} 3-fold suggestion at combined odds ${boostedStr}${boostActive ? ` (boosted from ${baseCombinedStr})` : ""}`}
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
            {tier.tagline}
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
  const opponent = leg.pickedSide === "home" ? leg.awayTeam : leg.homeTeam;
  const oddsNum = Number.parseFloat(leg.odds);
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
        title={`vs ${opponent}`}
      >
        vs {opponent}
      </span>
      <div style={{ flex: 1 }} />
      <OddsChip price={Number.isFinite(oddsNum) ? oddsNum : null} size="sm">
        {leg.odds}
      </OddsChip>
    </div>
  );
}

// Visual twin of OddButton's price tile, rendered as a span so it stays
// valid HTML inside the card's outer <button>. useOddsFlash flashes the
// background green/red on every price tick — same behaviour as live
// odds elsewhere on the site.
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
