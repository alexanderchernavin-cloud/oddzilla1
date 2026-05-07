"use client";

import type { CSSProperties, JSX } from "react";
import { useBetSlip } from "@/lib/bet-slip";
import { SportGlyph } from "@/components/ui/sport-glyph";
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
  gradient: string;
  accent: string;
  Icon: (props: { size: number; color: string }) => JSX.Element;
}

const TIERS: TierMeta[] = [
  {
    key: "safe",
    label: "Safe",
    tagline: "Build with favorites",
    gradient: "linear-gradient(135deg, #14532d 0%, #166534 60%, #15803d 100%)",
    accent: "#86efac",
    Icon: ShieldIcon,
  },
  {
    key: "challenging",
    label: "Challenging",
    tagline: "Mid-risk multi",
    gradient: "linear-gradient(135deg, #78350f 0%, #92400e 60%, #b45309 100%)",
    accent: "#fcd34d",
    Icon: BoltIcon,
  },
  {
    key: "ultimate",
    label: "Ultimate",
    tagline: "Long-shot 3-fold",
    gradient: "linear-gradient(135deg, #7f1d1d 0%, #991b1b 60%, #b91c1c 100%)",
    accent: "#fca5a5",
    Icon: FlameIcon,
  },
];

export function ThreeFoldCards({
  suggestions,
}: {
  suggestions: ThreeFoldSuggestions;
}) {
  const slip = useBetSlip();

  const visibleTiers = TIERS.filter((t) => suggestions[t.key]);
  if (visibleTiers.length === 0) return null;

  const handle = (s: ThreeFoldSuggestion) => {
    slip.clear();
    slip.setMode("combo");
    for (const leg of s.legs) {
      slip.add(stripPickedSide(leg));
    }
    slip.setOpen(true);
  };

  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
      {visibleTiers.map((t) => {
        const s = suggestions[t.key]!;
        return (
          <Card
            key={t.key}
            label={t.label}
            tagline={t.tagline}
            gradient={t.gradient}
            accent={t.accent}
            Icon={t.Icon}
            suggestion={s}
            onActivate={() => handle(s)}
          />
        );
      })}
    </div>
  );
}

function stripPickedSide(leg: ThreeFoldLeg) {
  // pickedSide is UI-only — SlipSelection doesn't carry it, and the slip
  // would happily accept the extra field but it'd then ride along into
  // localStorage. Keep the slip object lean.
  const { pickedSide: _ignored, ...rest } = leg;
  void _ignored;
  return rest;
}

function Card({
  label,
  tagline,
  gradient,
  accent,
  Icon,
  suggestion,
  onActivate,
}: {
  label: string;
  tagline: string;
  gradient: string;
  accent: string;
  Icon: (props: { size: number; color: string }) => JSX.Element;
  suggestion: ThreeFoldSuggestion;
  onActivate: () => void;
}) {
  const cardStyle: CSSProperties = {
    flex: "1 1 280px",
    minWidth: 0,
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
  };

  return (
    <button
      type="button"
      onClick={onActivate}
      style={cardStyle}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLButtonElement).style.borderColor = "var(--fg-muted)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).style.borderColor = "var(--border)";
      }}
      aria-label={`Load ${label} 3-fold suggestion at combined odds ${suggestion.combinedOdds}`}
    >
      <div
        style={{
          background: gradient,
          padding: "12px 14px",
          display: "flex",
          alignItems: "center",
          gap: 10,
          color: "#fff",
        }}
      >
        <Icon size={20} color={accent} />
        <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.15, minWidth: 0 }}>
          <span
            className="mono"
            style={{
              fontSize: 10.5,
              letterSpacing: "0.14em",
              textTransform: "uppercase",
              color: accent,
            }}
          >
            {label}
          </span>
          <span style={{ fontSize: 12, color: "rgba(255,255,255,0.85)" }}>{tagline}</span>
        </div>
        <div style={{ flex: 1 }} />
        <span
          className="mono tnum"
          style={{
            fontSize: 22,
            fontWeight: 600,
            color: "#fff",
          }}
        >
          {suggestion.combinedOdds}
        </span>
      </div>
      <div
        style={{
          padding: "10px 14px 12px",
          display: "flex",
          flexDirection: "column",
          gap: 6,
        }}
      >
        {suggestion.legs.map((leg) => {
          const opponent = leg.pickedSide === "home" ? leg.awayTeam : leg.homeTeam;
          return (
            <div
              key={`${leg.matchId}-${leg.outcomeId}`}
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
              <span
                className="mono tnum"
                style={{ fontSize: 11.5, color: "var(--fg-muted)", flexShrink: 0 }}
              >
                {leg.odds}
              </span>
            </div>
          );
        })}
      </div>
    </button>
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
        fillOpacity="0.25"
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
        fillOpacity="0.25"
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
