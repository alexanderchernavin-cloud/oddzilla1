"use client";

// Mobile-only inline prematch widget on the match-detail page. Renders
// a toggle button under the match header / scoreboard; clicking opens
// the iframe in-place (above the markets). Hidden on desktop via the
// `oz-match-prematch-mobile` CSS class — the same widget is shown in
// the right rail there instead.
//
// Lazy-mounts the iframe only after first click so unopened widgets
// don't issue a network request to /widgets/* + Disir on every match
// detail view.

import { useState } from "react";
import { I } from "@/components/ui/icons";
import { DisirWidget, type WidgetAvailability } from "./disir-widget";
import { supportsPrematchWidget } from "./supported-sports";

interface Props {
  matchId: string;
  sportSlug: string;
  homeTeam: string;
  awayTeam: string;
}

export function MatchPrematchMobile({ matchId, sportSlug, homeTeam, awayTeam }: Props) {
  const [open, setOpen] = useState(false);
  const [availability, setAvailability] = useState<WidgetAvailability>("loading");

  if (!supportsPrematchWidget(sportSlug)) return null;

  const unavailable = availability === "unavailable" || availability === "error";

  return (
    <section
      className="oz-match-prematch-mobile"
      aria-label="Match insights"
      style={{
        flexDirection: "column",
        gap: 10,
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="match-prematch-iframe"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
          padding: "10px 14px",
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          color: "var(--fg)",
          fontFamily: "inherit",
          fontSize: 13.5,
          fontWeight: 500,
          cursor: "pointer",
        }}
      >
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <I.Trophy size={14} />
          {open ? "Hide match insights" : "Show match insights"}
        </span>
        <span
          style={{
            display: "inline-flex",
            transform: open ? "rotate(180deg)" : "rotate(0deg)",
            transition: "transform 140ms var(--ease)",
            color: "var(--fg-muted)",
          }}
          aria-hidden
        >
          <I.ChevD size={14} />
        </span>
      </button>
      {open && !unavailable ? (
        <div id="match-prematch-iframe">
          <DisirWidget
            variant="prematch-match"
            id={matchId}
            title={`Prematch insights — ${homeTeam} vs ${awayTeam}`}
            onAvailabilityChange={setAvailability}
            minHeight={420}
          />
        </div>
      ) : null}
      {open && unavailable ? (
        <div
          role="status"
          style={{
            padding: 12,
            fontSize: 12,
            color: "var(--fg-muted)",
            border: "1px solid var(--border)",
            borderRadius: 10,
            background: "var(--surface-2)",
          }}
        >
          Match insights are not available for this match.
        </div>
      ) : null}
    </section>
  );
}
