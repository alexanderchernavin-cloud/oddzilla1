"use client";

// ZillaFacts — statistical streak band rendered between the live
// stream and the markets-tabs strip on the match-detail page. Each
// card states one hard, consecutive-from-newest streak that the user
// can act on (e.g. "Guara eSports have won their last 9 matches —
// Match Winner @ 3.30"), with the run's opponent chips below for
// scannable provenance. Surfaces nothing — the band collapses to
// zero height — when no streak on the match clears
// ZILLAFACT_MIN_STREAK.
//
// Tier ladder mirrors ZillaTips' base → glow → fire ramp, but the
// score is `streak × ln(currentOdds)` rather than ROI; the badge in
// the upper-right of each card flames up accordingly so a 9-streak
// at 1.50 stands out from a 5-streak at 1.05 even though the latter
// looks like a "longer in a row" win on paper.
//
// Card affordances are intentionally minimal: a click on the card
// jumps the user to the matching market in the markets tree via a
// hash anchor. The body of the card carries the entire fact — no
// hover/popover, since the data is already digestible at a glance.

import {
  zillaFactTier,
  type ZillaFact,
  type ZillaFactLeg,
  type ZillaFactResult,
} from "@oddzilla/types/zillafacts";
import { useZillaFacts } from "@/lib/use-zillafacts";
import { TeamMark } from "@/components/ui/primitives";
import { I } from "@/components/ui/icons";

// Max cards rendered at once. The tier-sorted list usually has 3-6
// strong entries; capping at 6 keeps the band visually focused
// without forcing a horizontal scroll on a 1000px column.
const MAX_FACTS = 6;

// 2-3 letter abbreviation derived from a team's display name. Same
// algorithm ZillaTips uses for its leg chips — kept local so the
// fact card doesn't depend on widget internals.
function teamTag(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    return (words[0]![0]! + words[1]![0]!).toUpperCase();
  }
  return (words[0] ?? name).slice(0, 3).toUpperCase();
}

// Tier-specific chrome for the streak badge (top-right of the card)
// AND a subtle accent ring around the card itself. Token-aware so
// the look stays coherent against both themes; the gradient
// backgrounds match the ZillaTips badge palette so the two widgets
// feel like one family.
function tierChrome(tier: ReturnType<typeof zillaFactTier>) {
  if (tier === "fire") {
    return {
      badgeBg: "linear-gradient(135deg, rgba(255, 90, 30, 0.95), rgba(255, 50, 60, 0.95))",
      badgeColor: "#fff",
      badgeBorder: "1px solid rgba(255, 90, 30, 0.7)",
      badgeShadow: "0 0 12px rgba(255, 90, 30, 0.45)",
      cardRing: "0 0 0 1px rgba(255, 90, 30, 0.3)",
      cardAccent: "linear-gradient(180deg, rgba(255, 90, 30, 0.18), rgba(255, 90, 30, 0))",
      icon: <I.Fire size={12} />,
      label: "FIRE",
    };
  }
  if (tier === "glow") {
    return {
      badgeBg: "linear-gradient(135deg, rgba(255, 150, 50, 0.95), rgba(255, 110, 30, 0.95))",
      badgeColor: "#fff",
      badgeBorder: "1px solid rgba(255, 150, 50, 0.7)",
      badgeShadow: "0 0 8px rgba(255, 150, 50, 0.3)",
      cardRing: "0 0 0 1px rgba(255, 150, 50, 0.28)",
      cardAccent: "linear-gradient(180deg, rgba(255, 150, 50, 0.14), rgba(255, 150, 50, 0))",
      icon: <I.Fire size={12} />,
      label: "HOT",
    };
  }
  return {
    badgeBg: "var(--accent, #f0e9d8)",
    badgeColor: "var(--accent-fg, #1c1a14)",
    badgeBorder: "1px solid var(--accent-border, rgba(0, 0, 0, 0.12))",
    badgeShadow: "none",
    cardRing: "0 0 0 1px var(--border)",
    cardAccent: "none",
    icon: <I.Sparkles size={12} />,
    label: "FACT",
  };
}

// Compact "DD MMM" formatter for the date strip above each chip.
// en-GB renders "12 May" — fits in ~40px columns without wrapping.
function formatChipDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.valueOf())) return "";
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
}

// Result palette for the chip border — matches ZillaTips' visual
// vocabulary so users who've seen Tips immediately read the colour
// the same way. Every streak leg is a win by construction, so the
// chip should never render the loss palette; the switch is here for
// completeness and future "broke a streak last night" framing.
function legChrome(result: ZillaFactResult | null) {
  if (result === "won" || result === "half_won") {
    return {
      bg: "rgba(36, 161, 72, 0.16)",
      ring: "rgba(36, 161, 72, 0.55)",
      fg: "#1a7d3a",
      label: result === "half_won" ? "½W" : "W",
    };
  }
  return {
    bg: "var(--surface-2)",
    ring: "var(--border)",
    fg: "var(--fg-muted)",
    label: "—",
  };
}

// One opponent chip in the bottom run of a card. Stacks: date label
// (top, dim), opponent logo (middle), W stamp (bottom, green-ish).
// Click is inert by design — the chips are read-only provenance for
// the streak claim.
function FactLegChip({ leg }: { leg: ZillaFactLeg }) {
  const palette = legChrome(leg.result);
  return (
    <div
      title={`vs ${leg.opponentLabel} · ${formatChipDate(leg.liveStartedAt)}`}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 3,
        minWidth: 0,
      }}
    >
      <span
        className="mono"
        style={{
          fontSize: 9.5,
          color: "var(--fg-dim)",
          letterSpacing: "0.02em",
          whiteSpace: "nowrap",
        }}
      >
        {formatChipDate(leg.liveStartedAt)}
      </span>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 3,
          padding: "5px 4px 4px",
          borderRadius: 8,
          background: palette.bg,
          boxShadow: `inset 0 0 0 1px ${palette.ring}`,
          minWidth: 38,
        }}
      >
        <TeamMark
          tag={teamTag(leg.opponentLabel)}
          name={leg.opponentLabel}
          size={22}
          logoUrl={leg.opponentLogoUrl}
          color={leg.opponentBrandColor ?? undefined}
        />
        <span
          className="mono tnum"
          style={{
            fontSize: 10.5,
            fontWeight: 700,
            color: palette.fg,
            letterSpacing: "0.02em",
          }}
        >
          {palette.label}
        </span>
      </div>
    </div>
  );
}

// One card. Layout is intentionally compact — minWidth 260, maxWidth
// flex so the grid wraps 2-up on desktop (1000px column) and 1-up on
// mobile without configuring breakpoints in JS.
function FactCard({ fact }: { fact: ZillaFact }) {
  const tier = zillaFactTier(fact.score);
  const chrome = tierChrome(tier);
  // Compose the fact's headline. Markets where the outcome label
  // already names the team ("Guara eSports") render without
  // repeating the team — "WON LAST 9 MATCHES · Match Winner".
  // Markets where the outcome is generic ("Over") get the team
  // prefix — "GUARA · WON LAST 9" with "Total Maps Over" below.
  const outcomeNamesTeam = fact.outcomeLabel
    .toLowerCase()
    .includes(fact.teamName.toLowerCase());
  // Truncate ridiculously long market names so the card height stays
  // bounded — the full name is still on the matching market button.
  const marketLabel = fact.marketName.length > 60
    ? `${fact.marketName.slice(0, 57)}…`
    : fact.marketName;
  return (
    <a
      href={`#market-${fact.marketId}`}
      style={{
        position: "relative",
        display: "flex",
        flexDirection: "column",
        gap: 10,
        flex: "1 1 280px",
        minWidth: 260,
        maxWidth: 360,
        padding: 14,
        borderRadius: "var(--r-md)",
        background: "var(--bg-elevated)",
        boxShadow: chrome.cardRing,
        textDecoration: "none",
        color: "inherit",
        overflow: "hidden",
        isolation: "isolate",
      }}
    >
      {/* Subtle top-anchored gradient wash on glow/fire tiers. Behind
          everything else (zIndex: 0); the content lives above on
          zIndex: 1 via the default stacking. */}
      {chrome.cardAccent !== "none" && (
        <span
          aria-hidden
          style={{
            position: "absolute",
            inset: 0,
            background: chrome.cardAccent,
            pointerEvents: "none",
            zIndex: 0,
          }}
        />
      )}

      <div
        style={{
          position: "relative",
          zIndex: 1,
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
            color: "var(--fg-dim)",
            textTransform: "uppercase",
            letterSpacing: "0.08em",
          }}
        >
          Won last {fact.streak}
        </span>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            height: 18,
            padding: "0 7px",
            borderRadius: 999,
            background: chrome.badgeBg,
            color: chrome.badgeColor,
            border: chrome.badgeBorder,
            boxShadow: chrome.badgeShadow,
            fontSize: 9.5,
            fontWeight: 700,
            letterSpacing: "0.05em",
            textTransform: "uppercase",
          }}
        >
          {chrome.icon}
          <span className="mono">{chrome.label}</span>
        </span>
      </div>

      <div
        style={{
          position: "relative",
          zIndex: 1,
          display: "flex",
          alignItems: "center",
          gap: 10,
        }}
      >
        <TeamMark
          tag={teamTag(fact.teamName)}
          name={fact.teamName}
          size={28}
          logoUrl={fact.teamLogoUrl}
          color={fact.teamBrandColor ?? undefined}
        />
        <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
          <span
            style={{
              fontSize: 14,
              fontWeight: 600,
              lineHeight: 1.2,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {fact.teamName}
          </span>
          <span
            className="mono"
            style={{
              fontSize: 10.5,
              color: "var(--fg-dim)",
              textTransform: "uppercase",
              letterSpacing: "0.06em",
            }}
          >
            {fact.streak} in a row
          </span>
        </div>
      </div>

      <div
        style={{
          position: "relative",
          zIndex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
          padding: "8px 10px",
          borderRadius: "var(--r-sm)",
          background: "var(--surface-2)",
          border: "1px solid var(--border)",
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            minWidth: 0,
          }}
        >
          <span
            className="mono"
            style={{
              fontSize: 9.5,
              color: "var(--fg-dim)",
              textTransform: "uppercase",
              letterSpacing: "0.06em",
            }}
          >
            {marketLabel}
          </span>
          <span
            style={{
              fontSize: 13,
              fontWeight: 600,
              lineHeight: 1.25,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {outcomeNamesTeam ? fact.outcomeLabel : `${fact.teamName} · ${fact.outcomeLabel}`}
          </span>
        </div>
        <span
          className="mono tnum"
          style={{
            fontSize: 16,
            fontWeight: 700,
            color: "var(--accent-fg, var(--fg))",
            background: "var(--accent, #f0e9d8)",
            padding: "4px 10px",
            borderRadius: "var(--r-sm)",
            flexShrink: 0,
          }}
        >
          {fact.currentOdds ?? "—"}
        </span>
      </div>

      <div
        style={{
          position: "relative",
          zIndex: 1,
          display: "flex",
          gap: 6,
          overflowX: "auto",
          paddingBottom: 2,
        }}
      >
        {fact.legs.map((leg) => (
          <FactLegChip key={leg.histMatchId} leg={leg} />
        ))}
      </div>
    </a>
  );
}

// Public widget mounted on the match-detail page. Fetches on mount
// (one round-trip — cached server-side for 5 min), then renders a
// fluid grid of cards. Returns null while loading OR when no streak
// qualifies, so the band collapses to zero height without flicker.
export function ZillaFactsCards({ matchId }: { matchId: string }) {
  const { facts, loaded } = useZillaFacts(matchId);
  if (!loaded || facts.length === 0) return null;

  const visible = facts.slice(0, MAX_FACTS);

  return (
    <section
      aria-label="ZillaFacts — historical streaks on this match"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 8,
        }}
      >
        <span
          className="mono"
          style={{
            fontSize: 11,
            color: "var(--fg-muted)",
            textTransform: "uppercase",
            letterSpacing: "0.12em",
          }}
        >
          ZillaFacts
        </span>
        <span
          className="mono"
          style={{
            fontSize: 10,
            color: "var(--fg-dim)",
            textTransform: "uppercase",
            letterSpacing: "0.08em",
          }}
        >
          streaks worth knowing
        </span>
      </div>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 10,
        }}
      >
        {visible.map((fact) => (
          <FactCard
            key={`${fact.marketId}:${fact.outcomeId}:${fact.teamId}`}
            fact={fact}
          />
        ))}
      </div>
    </section>
  );
}
