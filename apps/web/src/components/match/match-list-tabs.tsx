"use client";

import { useState, type ReactNode } from "react";
import { MatchRow, type ListMatch, type MatchListTab } from "./match-row";

// A list match enriched server-side with the per-row metadata MatchRow
// needs. Functions can't cross the server/client boundary, so the
// surrounding page bakes these in instead of passing computed callbacks.
export interface ListMatchEnriched extends ListMatch {
  _sportSlug: string;
  _sportShort: string;
  _topConfigured: boolean;
}

// Page-level [Match | Top] tab strip for storefront list pages. The
// "Top" tab is only rendered when at least one match in view has the
// Top scope configured for its sport — otherwise the strip is hidden
// and Match-Winner odds render as before.
export function MatchListTabs({
  matches,
  groups,
}: {
  matches: ListMatchEnriched[];
  // Optional grouping — render headers between sections (e.g. Live /
  // Upcoming). When omitted we render a single flat list.
  groups?: Array<{ key: string; label: ReactNode; matches: ListMatchEnriched[] }>;
}) {
  const [tab, setTab] = useState<MatchListTab>("match");

  const anyTopConfigured = matches.some((m) => m._topConfigured);

  function renderRow(m: ListMatchEnriched) {
    return (
      <MatchRow
        key={m.id}
        match={m}
        sportSlug={m._sportSlug}
        sportShort={m._sportShort}
        tab={tab}
      />
    );
  }

  const body = groups
    ? groups.map((g) => (
        <section key={g.key} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {g.label}
          {g.matches.map(renderRow)}
        </section>
      ))
    : matches.map(renderRow);

  return (
    <>
      {anyTopConfigured ? (
        <div
          style={{
            display: "inline-flex",
            alignSelf: "flex-start",
            gap: 4,
            padding: 4,
            border: "1px solid var(--border)",
            borderRadius: 999,
            background: "var(--surface)",
            fontSize: 12,
          }}
        >
          {(["match", "top"] as MatchListTab[]).map((t) => {
            const active = t === tab;
            return (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className="mono"
                style={{
                  border: "none",
                  background: active ? "var(--fg)" : "transparent",
                  color: active ? "var(--bg)" : "var(--fg-muted)",
                  borderRadius: 999,
                  padding: "5px 12px",
                  fontSize: 11,
                  letterSpacing: "0.12em",
                  textTransform: "uppercase",
                  cursor: "pointer",
                }}
              >
                {t === "match" ? "Match" : "Top"}
              </button>
            );
          })}
        </div>
      ) : null}
      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>{body}</div>
    </>
  );
}
