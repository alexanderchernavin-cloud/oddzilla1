"use client";

// Renders the Oddin Disir prematch widget below the bet slip in the
// right rail. Reads MatchPageContext to pick up the active match-detail
// page; renders nothing on every other page, on mobile (the rail
// becomes a bottom sheet there and the widget belongs inline on the
// match page itself), or for sports Disir doesn't cover.
//
// Hidden on mobile via the `oz-rail-prematch` class (see globals.css).

import { useState } from "react";
import { useActiveMatchPage } from "@/lib/match-page-context";
import { DisirWidget, type WidgetAvailability } from "./disir-widget";
import { supportsPrematchWidget } from "./supported-sports";

export function RailPrematchPanel() {
  const active = useActiveMatchPage();
  const [availability, setAvailability] = useState<WidgetAvailability>("loading");

  if (!active) return null;
  if (!supportsPrematchWidget(active.sportSlug)) return null;
  // Don't take vertical space when the upstream provider has nothing
  // to ship — the rail keeps the bet slip's "always visible bottom"
  // affordance for matches without prematch coverage.
  if (availability === "unavailable" || availability === "error") return null;

  return (
    <section
      className="oz-rail-prematch"
      aria-label="Match statistics"
      style={{
        borderTop: "1px solid var(--hairline)",
        padding: "14px 16px 18px",
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 10,
        }}
      >
        <h3
          className="display"
          style={{
            fontSize: 13,
            fontWeight: 500,
            margin: 0,
            color: "var(--fg)",
          }}
        >
          Match insights
        </h3>
        <span
          className="mono"
          style={{
            fontSize: 10,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "var(--fg-dim)",
          }}
        >
          {active.sportSlug}
        </span>
      </div>
      <DisirWidget
        variant="prematch-match"
        id={active.matchId}
        theme="dark"
        title={`Prematch insights — ${active.homeTeam} vs ${active.awayTeam}`}
        onAvailabilityChange={setAvailability}
        minHeight={420}
      />
    </section>
  );
}
