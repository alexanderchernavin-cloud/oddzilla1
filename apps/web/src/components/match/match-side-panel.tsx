"use client";

import { useState } from "react";
import { MatchAnalysesSection } from "@/components/community/match-analyses-section";
import { MatchRoom } from "@/components/match-room/match-room";

type Tab = "chat" | "analyses";

interface Props {
  matchId: string;
  matchTitle: string;
  matchStatus: "not_started" | "live" | "closed" | "cancelled" | "suspended";
  loggedIn: boolean;
  viewer: { id: string } | null;
}

// Tabbed side panel surfacing chat and analyses next to the markets
// list so bettors discover both without scrolling past the bet rows.
// Pre-match defaults to Analyses (decision input); live/closed default
// to Chat (the active social surface). User selection wins after that.
export function MatchSidePanel({
  matchId,
  matchTitle,
  matchStatus,
  loggedIn,
  viewer,
}: Props) {
  const defaultTab: Tab = matchStatus === "not_started" ? "analyses" : "chat";
  const [tab, setTab] = useState<Tab>(defaultTab);

  return (
    <aside className="flex flex-col">
      <div
        role="tablist"
        aria-label="Match side panel"
        className="flex w-full overflow-hidden rounded-[10px] border border-[var(--color-border)]"
      >
        <PanelTab
          active={tab === "chat"}
          label="Chat"
          onClick={() => setTab("chat")}
        />
        <PanelTab
          active={tab === "analyses"}
          label="Analyses"
          onClick={() => setTab("analyses")}
        />
      </div>

      <div className="mt-3" role="tabpanel">
        {tab === "chat" ? (
          <MatchRoom matchId={matchId} viewer={viewer} />
        ) : (
          <MatchAnalysesSection
            matchId={matchId}
            matchTitle={matchTitle}
            matchStatus={matchStatus}
            loggedIn={loggedIn}
          />
        )}
      </div>
    </aside>
  );
}

function PanelTab({
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
