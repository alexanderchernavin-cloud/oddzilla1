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

import { useState } from "react";
import { useActiveMatchPage } from "@/lib/match-page-context";
import { DisirWidget, type WidgetAvailability } from "./disir-widget";
import { supportsPrematchWidget } from "./supported-sports";
import { MatchRoom } from "@/components/match-room/match-room";
import { MatchAnalysesSection } from "@/components/community/match-analyses-section";

type Tab = "insights" | "chat" | "analyses";

export function RailMatchPanel() {
  const active = useActiveMatchPage();
  const [insightsAvailability, setInsightsAvailability] =
    useState<WidgetAvailability>("loading");

  if (!active) return null;

  const insightsSupported = supportsPrematchWidget(active.sportSlug);
  // Hide the Insights tab entirely when Disir can't ship data for this
  // sport, OR when the embed itself reports unavailable/error after
  // load. Keeps the tab strip honest — no dead labels.
  const insightsAvailable =
    insightsSupported &&
    insightsAvailability !== "unavailable" &&
    insightsAvailability !== "error";

  const tabs: Tab[] = [];
  if (insightsAvailable) tabs.push("insights");
  tabs.push("chat");
  // Analyses is gated by match status — same logic the section's own
  // null-render uses. Cancelled and suspended don't surface analyses.
  const analysesAvailable =
    active.matchStatus === "not_started" ||
    active.matchStatus === "live" ||
    active.matchStatus === "closed";
  if (analysesAvailable) tabs.push("analyses");

  // Default-tab logic: pre-match leads with Insights when available
  // (the existing rail default, preserves bettor muscle memory), live
  // leads with Chat (active social surface), closed/other fall back to
  // Chat. If Insights is unsupported, pre-match defaults to Analyses.
  const defaultTab: Tab = (() => {
    if (active.matchStatus === "not_started") {
      if (insightsAvailable) return "insights";
      if (analysesAvailable) return "analyses";
      return "chat";
    }
    return "chat";
  })();
  const [tab, setTab] = useState<Tab>(defaultTab);
  const activeTab: Tab = tabs.includes(tab) ? tab : (tabs[0] ?? "chat");

  // Don't claim rail space when nothing's renderable for this match.
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
        {insightsAvailable && (
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
