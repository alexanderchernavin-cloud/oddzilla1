"use client";

import { useState, type ReactNode } from "react";
import { MatchRow, type ListMatch, type MatchListTab } from "./match-row";

// Page-level [Match | Top] tab strip for storefront list pages. The
// "Top" tab is only rendered when the API tells us the relevant sport
// has Top markets configured — otherwise the strip degrades to plain
// section headers and only Match-Winner inline odds.
//
// `topConfiguredFor` keys: sport slug → boolean. When `null` (single-
// sport page), we fall back to the boolean `topConfigured` prop.
export function MatchListTabs({
  matches,
  sportSlug,
  sportShort,
  topConfigured,
  groups,
}: {
  matches: ListMatch[];
  sportSlug: (m: ListMatch) => string;
  sportShort: (m: ListMatch) => string;
  topConfigured: (m: ListMatch) => boolean;
  // Optional grouping — render headers between sections (e.g. Live /
  // Upcoming). When omitted we render a single flat list.
  groups?: Array<{ key: string; label: ReactNode; matches: ListMatch[] }>;
}) {
  const [tab, setTab] = useState<MatchListTab>("match");

  // Show the strip only if at least one match in the list has the Top
  // scope configured for its sport. Hiding it on lists with zero Top
  // configs avoids a useless tab on the home page when no admin has
  // curated anything yet.
  const anyTopConfigured = matches.some(topConfigured);

  function renderRow(m: ListMatch) {
    const slug = sportSlug(m);
    const short = sportShort(m);
    return <MatchRow key={m.id} match={m} sportSlug={slug} sportShort={short} tab={tab} />;
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
