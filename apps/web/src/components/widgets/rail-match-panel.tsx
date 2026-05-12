"use client";

// RailMatchPanel — match-detail companion that lives at the bottom of
// the right rail (below the bet slip), tabbed across three surfaces:
//
//   Insights  → Oddin Disir prematch widget (the previous default)
//   Chat      → live match-room chat panel
//   Analyses  → community pre-match takes
//
// Replaces the older RailPrematchPanel which only carried Insights.
// Sasha's feedback (2026-05-12): chat + analyses had ended up in their
// own middle column next to markets, which competed with the bet slip
// for attention. The rail is the natural home — same vertical real
// estate, user picks. Bet slip + Place button stay above the fold.
//
// All match-specific state (matchId, sportSlug, matchStatus, viewer
// auth) is read from MatchPageContext, populated by MatchPageRegistrar
// on the match-detail page. Renders nothing on every other page.
//
// Two-level split (outer gate + inner active-aware component) keeps
// hooks rules clean: MatchPageContext starts null and populates after
// the registrar's effect fires, so the outer's null-return changes
// the inner's mount status — not the inner's hook count. Without
// this split a `useState(defaultTab)` placed after a context-null
// early-return would trip React error #310 on the very first
// context update.

import { useState } from "react";
import {
  useActiveMatchPage,
  type ActiveMatch,
} from "@/lib/match-page-context";
import { DisirWidget, type WidgetAvailability } from "./disir-widget";
import { supportsPrematchWidget } from "./supported-sports";
import { MatchRoom } from "@/components/match-room/match-room";
import { MatchAnalysesSection } from "@/components/community/match-analyses-section";

type Tab = "insights" | "chat" | "analyses";

export function RailMatchPanel() {
  const active = useActiveMatchPage();
  if (!active) return null;
  // Re-mount on matchId change so the inner's useState initializers
  // (default tab, Disir availability) reset for the new fixture
  // instead of carrying stale state across navigations.
  return <RailMatchPanelInner key={active.matchId} active={active} />;
}

function RailMatchPanelInner({ active }: { active: ActiveMatch }) {
  const insightsSupported = supportsPrematchWidget(active.sportSlug);
  // Analyses is gated by match status — same logic the section's own
  // null-render uses. Cancelled and suspended don't surface analyses.
  const analysesAvailable =
    active.matchStatus === "not_started" ||
    active.matchStatus === "live" ||
    active.matchStatus === "closed";

  const [insightsAvailability, setInsightsAvailability] =
    useState<WidgetAvailability>("loading");
  // Default-tab logic: pre-match leads with Insights when the sport
  // supports it (preserves the rail's prior muscle memory), live /
  // closed lead with Chat. Computed once at mount via the lazy
  // initializer so toggling the Insights tab off later (e.g. iframe
  // reports unavailable) doesn't yank the user's selection.
  const [tab, setTab] = useState<Tab>(() => {
    if (active.matchStatus === "not_started") {
      if (insightsSupported) return "insights";
      if (analysesAvailable) return "analyses";
      return "chat";
    }
    return "chat";
  });

  // Hide the Insights tab when Disir can't ship data for this sport,
  // OR when the embed itself reports unavailable/error after load.
  // Keeps the tab strip honest — no dead labels.
  const insightsAvailable =
    insightsSupported &&
    insightsAvailability !== "unavailable" &&
    insightsAvailability !== "error";

  const tabs: Tab[] = [];
  if (insightsAvailable) tabs.push("insights");
  tabs.push("chat");
  if (analysesAvailable) tabs.push("analyses");

  // Fall back to the first available tab if the user's selection has
  // since become unavailable (e.g. they were on Insights and the
  // iframe failed to load).
  const activeTab: Tab = tabs.includes(tab) ? tab : (tabs[0] ?? "chat");

  if (tabs.length === 0) return null;

  return (
    <section
      aria-label="Match panel"
      style={{
        borderTop: "1px solid var(--hairline)",
        padding: "14px 16px 18px",
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <div
        role="tablist"
        aria-label="Match panel tabs"
        className="flex w-full overflow-hidden rounded-[10px] border border-[var(--color-border)]"
      >
        {tabs.map((t) => (
          <RailTab
            key={t}
            active={activeTab === t}
            label={LABELS[t]}
            onClick={() => setTab(t)}
          />
        ))}
      </div>

      {/* Render each tab once so component state survives switching:
          Disir's iframe handshake, the chat room's WebSocket
          subscription, and the analyses fetch all reset on unmount.
          Hidden tabs use CSS `display: none` so they're inert but
          still mounted. */}
      <div role="tabpanel">
        {insightsSupported && (
          <div style={{ display: activeTab === "insights" ? "block" : "none" }}>
            <DisirWidget
              variant="prematch-match"
              id={active.matchId}
              theme="dark"
              title={`Prematch insights — ${active.homeTeam} vs ${active.awayTeam}`}
              onAvailabilityChange={setInsightsAvailability}
              minHeight={280}
            />
          </div>
        )}
        <div style={{ display: activeTab === "chat" ? "block" : "none" }}>
          <MatchRoom
            matchId={active.matchId}
            viewer={active.viewerId ? { id: active.viewerId } : null}
          />
        </div>
        {analysesAvailable && (
          <div style={{ display: activeTab === "analyses" ? "block" : "none" }}>
            <MatchAnalysesSection
              matchId={active.matchId}
              matchTitle={`${active.homeTeam} vs ${active.awayTeam}`}
              matchStatus={active.matchStatus}
              loggedIn={active.loggedIn}
            />
          </div>
        )}
      </div>
    </section>
  );
}

const LABELS: Record<Tab, string> = {
  insights: "Insights",
  chat: "Chat",
  analyses: "Analyses",
};

function RailTab({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={
        "flex-1 px-3 py-2 text-xs uppercase tracking-[0.15em] transition-colors " +
        (active
          ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)]"
          : "text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]")
      }
    >
      {label}
    </button>
  );
}
