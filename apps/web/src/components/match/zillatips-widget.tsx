"use client";

// ZillaTips widget — per-market historical-ROI hint surfaced as a small
// badge next to the market name. Hover (desktop) or tap (mobile) opens
// a popover listing the focused team(s) with their last N matches'
// outcomes coloured by win/lose/void.
//
// The badge is the ONLY visible affordance until the user interacts.
// It carries the highest ROI across the market's tips and bumps its
// chrome through three tiers (base → glow → fire) tracking
// ZILLATIP_TIER_GLOW and ZILLATIP_TIER_FIRE.

import { useEffect, useId, useRef, useState } from "react";
// Subpath import — @oddzilla/types' root entry chains `export *` through
// other modules with `.js` extensions that Next.js webpack can't resolve
// when a RUNTIME value (zillaTipTier here) forces the package to be
// bundled. Pulling from /zillatips bypasses the root entry; same
// convention bet-slip.tsx uses for `@oddzilla/types/currencies`.
import {
  zillaTipTier,
  type ZillaTip,
  type ZillaTipLeg,
  type ZillaTipResult,
} from "@oddzilla/types/zillatips";
import { I } from "@/components/ui/icons";
import { TeamMark } from "@/components/ui/primitives";

// Map outcome_result enum → semantic colour. Void / null result / unknown
// all fall back to grey per the user spec.
function resultPalette(result: ZillaTipResult | null): {
  bg: string;
  ring: string;
  fg: string;
  label: string;
} {
  switch (result) {
    case "won":
    case "half_won":
      return {
        bg: "rgba(36, 161, 72, 0.18)",
        ring: "rgba(36, 161, 72, 0.55)",
        fg: "#1a7d3a",
        label: result === "half_won" ? "½W" : "W",
      };
    case "lost":
    case "half_lost":
      return {
        bg: "rgba(220, 60, 60, 0.18)",
        ring: "rgba(220, 60, 60, 0.55)",
        fg: "#a32424",
        label: result === "half_lost" ? "½L" : "L",
      };
    case "void":
    default:
      return {
        bg: "var(--surface-2, rgba(0, 0, 0, 0.06))",
        ring: "var(--border)",
        fg: "var(--fg-muted)",
        label: result === "void" ? "V" : "—",
      };
  }
}

// Visual chrome for the badge based on ROI tier. Token-aware so the
// badge looks coherent against both themes.
function badgePalette(tier: ReturnType<typeof zillaTipTier>) {
  if (tier === "fire") {
    return {
      bg: "linear-gradient(135deg, rgba(255, 90, 30, 0.95), rgba(255, 50, 60, 0.95))",
      color: "#fff",
      border: "1px solid rgba(255, 90, 30, 0.7)",
      shadow: "0 0 14px rgba(255, 90, 30, 0.55)",
      icon: <I.Fire size={12} />,
      label: "FIRE",
    };
  }
  if (tier === "glow") {
    return {
      bg: "linear-gradient(135deg, rgba(255, 150, 50, 0.95), rgba(255, 110, 30, 0.95))",
      color: "#fff",
      border: "1px solid rgba(255, 150, 50, 0.7)",
      shadow: "0 0 8px rgba(255, 150, 50, 0.35)",
      icon: <I.Fire size={12} />,
      label: "HOT",
    };
  }
  return {
    bg: "var(--accent, #f0e9d8)",
    color: "var(--accent-fg, #1c1a14)",
    border: "1px solid var(--accent-border, rgba(0, 0, 0, 0.12))",
    shadow: "none",
    icon: <I.Sparkles size={12} />,
    label: "TIP",
  };
}

function fmtRoi(roi: number): string {
  // Display as +47% / +120% / +320%. roi is already a unitless ratio.
  const pct = Math.round(roi * 100);
  return pct > 0 ? `+${pct}%` : `${pct}%`;
}

// 2-3 letter abbreviation derived from a team's display name, used as
// the `tag` fallback in TeamMark when the competitor has no admin-
// curated abbreviation. Prefers word initials ("Team Vitality" → "TV"),
// falls back to the first 3 chars of a single-word name ("NaVi" → "NAV").
function teamTag(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    return (words[0]![0]! + words[1]![0]!).toUpperCase();
  }
  return (words[0] ?? name).slice(0, 3).toUpperCase();
}

// One historical leg rendered as a small chip with the opponent's
// logo, the prematch odds, and a colour-coded ring for win/loss/void.
function LegChip({ leg }: { leg: ZillaTipLeg }) {
  const palette = resultPalette(leg.result);
  return (
    <div
      title={`vs ${leg.opponentLabel} @ ${leg.prematchOdds ?? "—"}`}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 4,
        padding: "6px 4px",
        borderRadius: 8,
        background: palette.bg,
        boxShadow: `inset 0 0 0 1px ${palette.ring}`,
        minWidth: 56,
      }}
    >
      <TeamMark
        tag={teamTag(leg.opponentLabel)}
        name={leg.opponentLabel}
        size={28}
        logoUrl={leg.opponentLogoUrl}
        color={leg.opponentBrandColor ?? undefined}
      />
      <span
        className="mono tnum"
        style={{ fontSize: 11, fontWeight: 600, color: palette.fg }}
      >
        {leg.prematchOdds
          ? Number(leg.prematchOdds).toFixed(2)
          : palette.label}
      </span>
    </div>
  );
}

// Optional per-tip context label. For a LineFamily that bundles many
// lines under one badge, the parent passes a per-marketId string (e.g.
// "Over 2.5") so the popover header explains which leg of the ladder
// each section refers to. Defaults to the outcome label when omitted.
export interface TipContext {
  marketId: string;
  outcomeId: string;
  // Free-form prefix shown before the outcome label, typically a line
  // value ("2.5", "+1.5"). Empty string and undefined both render
  // without a prefix.
  contextLabel?: string;
  // The outcome's user-visible name (rendered by the API: "Over",
  // "Under", team name, etc.). Falls back to the raw outcomeId.
  outcomeLabel?: string;
}

function tipContextKey(c: TipContext): string {
  return `${c.marketId}:${c.outcomeId}`;
}

// One section of the popover: focused team + ROI + 5 legs in a row.
function TipSection({
  tip,
  currentHome,
  currentAway,
  context,
}: {
  tip: ZillaTip;
  currentHome: string;
  currentAway: string;
  context: TipContext | undefined;
}) {
  const focused = tip.role === "home" ? currentHome : currentAway;
  const tier = zillaTipTier(tip.roi);
  const outcomeLabel = context?.outcomeLabel ?? tip.outcomeId;
  // Header structure: "<contextLabel> · <outcomeLabel> · <focused team>"
  // with each segment skipped when absent. The team name is always last
  // since it's the most concrete "whose history is this?" anchor.
  const headerParts: string[] = [];
  if (context?.contextLabel) headerParts.push(context.contextLabel);
  if (outcomeLabel) headerParts.push(outcomeLabel);
  headerParts.push(focused);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>
            {headerParts.join(" · ")}
          </span>
          <span
            className="mono"
            style={{
              fontSize: 10,
              color: "var(--fg-dim)",
              textTransform: "uppercase",
              letterSpacing: "0.06em",
            }}
          >
            last {tip.sampleSize}
          </span>
        </div>
        <span
          className="mono tnum"
          style={{
            fontSize: 13,
            fontWeight: 700,
            color:
              tier === "fire"
                ? "#d23a2a"
                : tier === "glow"
                  ? "#d97a1a"
                  : "var(--fg)",
          }}
        >
          {fmtRoi(tip.roi)}
        </span>
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${tip.legs.length}, minmax(0, 1fr))`,
          gap: 6,
        }}
      >
        {tip.legs.map((leg) => (
          <LegChip key={leg.histMatchId} leg={leg} />
        ))}
      </div>
    </div>
  );
}

// The visible badge users see next to the market name. Click toggles
// open; hover (pointer:fine devices) opens too. Click outside or Esc
// closes. Single popover instance per badge (no portal — the parent
// card establishes its own stacking context via position:relative).
export function ZillaTipsBadge({
  tips,
  currentHome,
  currentAway,
  label,
  contexts,
}: {
  tips: ZillaTip[];
  currentHome: string;
  currentAway: string;
  // Optional override (defaults to "ZillaTips"). LineFamily passes
  // the family base name here so the popover header reads e.g.
  // "ZillaTips · Total kills".
  label?: string;
  // Per-(marketId, outcomeId) context. When provided, each tip's
  // section pulls the matching entry for its line value / outcome
  // label. Order doesn't matter — we key by (marketId, outcomeId).
  contexts?: TipContext[];
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const popoverId = useId();

  // Aggregate "best tip" for tier — same source the badge uses.
  let bestRoi = 0;
  for (const t of tips) {
    if (t.roi > bestRoi) bestRoi = t.roi;
  }
  const tier = zillaTipTier(bestRoi);
  const palette = badgePalette(tier);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Sort tips by ROI desc so the popover puts the strongest pick first.
  const sortedTips = [...tips].sort((a, b) => b.roi - a.roi);
  const contextByKey = new Map<string, TipContext>();
  if (contexts) {
    for (const c of contexts) contextByKey.set(tipContextKey(c), c);
  }

  return (
    <div ref={wrapRef} style={{ position: "relative", display: "inline-flex" }}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={popoverId}
        onClick={() => setOpen((v) => !v)}
        onMouseEnter={() => setOpen(true)}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          height: 22,
          padding: "0 8px",
          borderRadius: 999,
          background: palette.bg,
          color: palette.color,
          border: palette.border,
          boxShadow: palette.shadow,
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: "0.04em",
          textTransform: "uppercase",
          cursor: "pointer",
          // Keep the badge visible against any market-name length —
          // it sits on the right side of the header row's flex layout.
          whiteSpace: "nowrap",
        }}
      >
        {palette.icon}
        <span className="mono tnum">{fmtRoi(bestRoi)}</span>
      </button>
      {open && (
        <div
          id={popoverId}
          role="dialog"
          aria-label="ZillaTips historical ROI"
          onMouseLeave={() => setOpen(false)}
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            right: 0,
            zIndex: 30,
            width: "min(420px, 92vw)",
            background: "var(--surface-1)",
            border: "1px solid var(--border)",
            borderRadius: "var(--r-md)",
            padding: 14,
            boxShadow:
              "0 12px 32px rgba(0, 0, 0, 0.18), 0 2px 6px rgba(0, 0, 0, 0.08)",
            display: "flex",
            flexDirection: "column",
            gap: 14,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: 6,
              borderBottom: "1px solid var(--border)",
              paddingBottom: 8,
            }}
          >
            {palette.icon}
            <span style={{ fontSize: 13, fontWeight: 600 }}>
              ZillaTips{label ? ` · ${label}` : ""}
            </span>
            <span
              className="mono"
              style={{
                fontSize: 10,
                color: "var(--fg-dim)",
                textTransform: "uppercase",
                letterSpacing: "0.06em",
              }}
            >
              last 5 trail · per leg ROI
            </span>
          </div>
          {sortedTips.map((tip) => (
            <TipSection
              key={`${tip.marketId}:${tip.outcomeId}:${tip.role}`}
              tip={tip}
              currentHome={currentHome}
              currentAway={currentAway}
              context={contextByKey.get(`${tip.marketId}:${tip.outcomeId}`)}
            />
          ))}
          <div
            style={{
              fontSize: 10.5,
              color: "var(--fg-dim)",
              borderTop: "1px solid var(--border)",
              paddingTop: 8,
            }}
          >
            ROI is the average flat-stake return per leg. Voided legs are shown
            grey and excluded from the average.
          </div>
        </div>
      )}
    </div>
  );
}
