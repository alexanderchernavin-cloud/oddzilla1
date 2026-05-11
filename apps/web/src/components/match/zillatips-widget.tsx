"use client";

// ZillaTips widget — per-market historical-ROI hint surfaced as a small
// badge next to the market name. Hover (desktop) or tap (mobile) opens
// a popover listing the focused team(s) with their last N matches'
// outcomes coloured by win/lose/void and a per-leg +X% / -100% label;
// the right side of the section header shows the SUM of those legs.
//
// The badge is the ONLY visible affordance until the user interacts.
// It carries the highest ROI across the market's tips and bumps its
// chrome through three tiers (base → glow → fire) tracking
// ZILLATIP_TIER_GLOW and ZILLATIP_TIER_FIRE.
//
// Only one popover may be open at a time — coordinated via a context
// provider wrapping the markets tree. Hovering a new badge cancels
// the previous one without flicker via a short hover-intent close
// timer (so brief gap-crossings between badge and popover don't
// trigger close).

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
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

// ── Single-open coordination ──────────────────────────────────────────
//
// Each badge gets a stable useId(). When the user hovers/clicks one,
// it calls open(myId). All other badges read context.openId, see it's
// not theirs, and unmount their popover. No portal needed — popovers
// stay positioned relative to their own badge wrapper.
//
// Close path uses a short hover-intent delay so the 6px gap between
// the badge and its popover doesn't trigger close mid-flight. Each
// badge tracks its own timer; the shared context only carries openId.

interface ZillaTipsContextValue {
  openId: string | null;
  open: (id: string) => void;
  close: (id: string) => void;
}

const ZillaTipsContext = createContext<ZillaTipsContextValue>({
  openId: null,
  open: () => {},
  close: () => {},
});

export function ZillaTipsProvider({ children }: { children: ReactNode }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const open = useCallback((id: string) => setOpenId(id), []);
  // Idempotent close: only clear if the caller still thinks it's the
  // open one. Prevents a stale close() from a delayed mouseLeave from
  // tearing down a popover the user has already moved to.
  const close = useCallback((id: string) => {
    setOpenId((cur) => (cur === id ? null : cur));
  }, []);
  return (
    <ZillaTipsContext.Provider value={{ openId, open, close }}>
      {children}
    </ZillaTipsContext.Provider>
  );
}

// Delay between mouseLeave and actual close. Long enough to let the
// user cross the 6px gap from badge to popover (or popover to badge)
// without flicker; short enough that moving past doesn't feel sticky.
const HOVER_CLOSE_DELAY_MS = 140;

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
// badge looks coherent against both themes. iconSize matches the chip
// size so the compact (outcome-overlay) variant gets a slightly
// smaller flame/sparkle than the legacy header variant.
function badgePalette(
  tier: ReturnType<typeof zillaTipTier>,
  iconSize: number,
) {
  if (tier === "fire") {
    return {
      bg: "linear-gradient(135deg, rgba(255, 90, 30, 0.95), rgba(255, 50, 60, 0.95))",
      color: "#fff",
      border: "1px solid rgba(255, 90, 30, 0.7)",
      shadow: "0 0 14px rgba(255, 90, 30, 0.55)",
      icon: <I.Fire size={iconSize} />,
      label: "FIRE",
    };
  }
  if (tier === "glow") {
    return {
      bg: "linear-gradient(135deg, rgba(255, 150, 50, 0.95), rgba(255, 110, 30, 0.95))",
      color: "#fff",
      border: "1px solid rgba(255, 150, 50, 0.7)",
      shadow: "0 0 8px rgba(255, 150, 50, 0.35)",
      icon: <I.Fire size={iconSize} />,
      label: "HOT",
    };
  }
  return {
    bg: "var(--accent, #f0e9d8)",
    color: "var(--accent-fg, #1c1a14)",
    border: "1px solid var(--accent-border, rgba(0, 0, 0, 0.12))",
    shadow: "none",
    icon: <I.Sparkles size={iconSize} />,
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

// Per-leg ROI as a unit-less ratio. Mirrors the SQL CASE inside
// roi_aggregates so the per-chip label sums to the section's
// displayed total. Returns null for void / null result / won-with-
// no-odds — chip renders "VOID" or "—" and the leg drops from the
// running total.
function legRoi(leg: ZillaTipLeg): number | null {
  const odds = leg.prematchOdds == null ? null : Number(leg.prematchOdds);
  switch (leg.result) {
    case "won":
      return odds != null && Number.isFinite(odds) ? odds - 1 : null;
    case "lost":
      return -1;
    case "half_won":
      return odds != null && Number.isFinite(odds) ? (odds - 1) / 2 : null;
    case "half_lost":
      return -0.5;
    default:
      return null;
  }
}

// One historical leg rendered as a small chip with the opponent's
// logo, the prematch odds (small grey), and a bold per-leg ROI label
// (+X% / -100% / VOID) coloured by result. The ring colour around
// the chip echoes the result so it remains scannable from a distance
// even without reading the percentage.
function LegChip({ leg }: { leg: ZillaTipLeg }) {
  const palette = resultPalette(leg.result);
  const roi = legRoi(leg);
  const oddsLabel = leg.prematchOdds
    ? Number(leg.prematchOdds).toFixed(2)
    : "—";
  // Bottom label semantics:
  //   • rated leg (won/lost/half_*) with a numeric ROI → "+90%" / "-100%"
  //   • void result → "VOID"
  //   • won/half_won with no prematch_odds → "—" (unrated, hidden from sum)
  //   • null result (still in progress) → "—"
  const roiLabel =
    roi != null
      ? `${roi >= 0 ? "+" : ""}${Math.round(roi * 100)}%`
      : leg.result === "void"
        ? "VOID"
        : "—";
  return (
    <div
      title={`vs ${leg.opponentLabel} @ ${oddsLabel}`}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 3,
        padding: "6px 4px 5px",
        borderRadius: 8,
        background: palette.bg,
        boxShadow: `inset 0 0 0 1px ${palette.ring}`,
        minWidth: 60,
      }}
    >
      <TeamMark
        tag={teamTag(leg.opponentLabel)}
        name={leg.opponentLabel}
        size={26}
        logoUrl={leg.opponentLogoUrl}
        color={leg.opponentBrandColor ?? undefined}
      />
      <span
        className="mono tnum"
        style={{
          fontSize: 10,
          color: "var(--fg-dim)",
          letterSpacing: "0.02em",
        }}
      >
        {oddsLabel}
      </span>
      <span
        className="mono tnum"
        style={{
          fontSize: 11,
          fontWeight: 700,
          color: palette.fg,
        }}
      >
        {roiLabel}
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
  size = "lg",
  popoverAlign = "right",
  onPick,
  pickSelected = false,
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
  // "lg" (default) = original chip with TIP/HOT/FIRE label + roi.
  // "sm" = compact 16px chip used when overlaying an outcome button —
  // just icon + roi, no text label, smaller font + tighter padding.
  size?: "lg" | "sm";
  // Where to anchor the popover horizontally. "right" pins to the
  // right edge of the badge (legacy / card-header behaviour); "left"
  // pins to the left edge so a badge sitting in the LEFT half of a
  // grid doesn't push its popover off-screen to the right.
  popoverAlign?: "left" | "right";
  // CTA inside the popover — when provided, renders an "Add to bet
  // slip" button at the bottom. Parent wires this to the same toggle
  // the underlying OddButton uses, so the user can pick the
  // selection from inside the tip without aiming at the small button
  // behind the popover.
  onPick?: () => void;
  // Whether the bet slip ALREADY carries this outcome. Drives the
  // pick button's label + disabled state — clicking again would
  // remove it from the slip, which is confusing UX from a "this is
  // your tip" popover.
  pickSelected?: boolean;
}) {
  const compact = size === "sm";
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const popoverId = useId();
  const myId = useId();
  const { openId, open, close } = useContext(ZillaTipsContext);
  const isOpen = openId === myId;
  // Hover-intent timer: started on either badge or popover mouseLeave,
  // cancelled on mouseEnter of either, so brief gap-crossings between
  // the badge and the popover (6px) don't tear it down.
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelClose = useCallback(() => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);
  const scheduleClose = useCallback(() => {
    cancelClose();
    closeTimerRef.current = setTimeout(() => {
      close(myId);
    }, HOVER_CLOSE_DELAY_MS);
  }, [cancelClose, close, myId]);
  // Clean up timer on unmount so a closed-then-unmounted badge doesn't
  // try to fire close() into stale state.
  useEffect(() => () => cancelClose(), [cancelClose]);

  // Aggregate "best tip" for tier — same source the badge uses.
  let bestRoi = 0;
  for (const t of tips) {
    if (t.roi > bestRoi) bestRoi = t.roi;
  }
  const tier = zillaTipTier(bestRoi);
  const palette = badgePalette(tier, compact ? 10 : 12);

  useEffect(() => {
    if (!isOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) close(myId);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close(myId);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [isOpen, close, myId]);

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
        aria-expanded={isOpen}
        aria-controls={popoverId}
        onClick={() => (isOpen ? close(myId) : open(myId))}
        onMouseEnter={() => {
          cancelClose();
          open(myId);
        }}
        onMouseLeave={scheduleClose}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: compact ? 2 : 4,
          height: compact ? 17 : 22,
          padding: compact ? "0 5px" : "0 8px",
          borderRadius: 999,
          background: palette.bg,
          color: palette.color,
          border: palette.border,
          boxShadow: palette.shadow,
          fontSize: compact ? 9.5 : 11,
          fontWeight: 700,
          letterSpacing: "0.04em",
          textTransform: "uppercase",
          cursor: "pointer",
          // Keep the badge on one line — sits at the right of the
          // market header (lg) or pinned over an outcome cell (sm).
          whiteSpace: "nowrap",
        }}
      >
        {palette.icon}
        <span className="mono tnum">{fmtRoi(bestRoi)}</span>
      </button>
      {isOpen && (
        <div
          id={popoverId}
          role="dialog"
          aria-label="ZillaTips historical ROI"
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            // Anchor edge depends on where the badge sits in its grid.
            // Right-edge cells use "right: 0" so the popover stays on
            // screen; left-edge cells use "left: 0" for the same
            // reason. Center cells default to right anchoring.
            ...(popoverAlign === "left" ? { left: 0 } : { right: 0 }),
            // High z-index so the popover always wins over neighbouring
            // market cards and the bet-slip rail. The match page's
            // header / live-scoreboard scope IDs sit around 20–40, so
            // 200 leaves headroom for future modals without competing
            // with the global mobile drawer overlay.
            zIndex: 200,
            width: "min(440px, 92vw)",
            // Use --bg-elevated (defined in globals.css for both
            // themes: #ffffff light / #131314 dark) — previously this
            // referenced --surface-1, which doesn't exist in the
            // token system, so the background fell back to invalid and
            // rendered transparent over the market cards.
            background: "var(--bg-elevated)",
            border: "1px solid var(--border)",
            borderRadius: "var(--r-md)",
            padding: 14,
            boxShadow:
              "0 12px 32px rgba(0, 0, 0, 0.28), 0 2px 6px rgba(0, 0, 0, 0.12)",
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
              last 5 trail · sum of legs
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
          {onPick && (
            <button
              type="button"
              onClick={() => {
                if (pickSelected) return;
                onPick();
                close(myId);
              }}
              disabled={pickSelected}
              style={{
                width: "100%",
                height: 36,
                borderRadius: 8,
                border: "1px solid var(--accent, #f0e9d8)",
                background: pickSelected
                  ? "var(--surface-2)"
                  : "var(--accent, #f0e9d8)",
                color: pickSelected
                  ? "var(--fg-muted)"
                  : "var(--accent-fg, #1c1a14)",
                fontFamily: "inherit",
                fontSize: 13,
                fontWeight: 600,
                letterSpacing: "0.01em",
                cursor: pickSelected ? "default" : "pointer",
                transition: "background 140ms var(--ease)",
              }}
            >
              {pickSelected ? "On bet slip" : "Add to bet slip"}
            </button>
          )}
          <div
            style={{
              fontSize: 10.5,
              color: "var(--fg-dim)",
              borderTop: "1px solid var(--border)",
              paddingTop: 8,
            }}
          >
            ROI is the sum of per-leg flat-stake returns (e.g. +90% + −100%
            + +150% = +140%). Voided legs are shown grey and excluded
            from the sum.
          </div>
        </div>
      )}
    </div>
  );
}
