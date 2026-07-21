"use client";

import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "@/lib/i18n";

// ── Manifest shape (emitted by sync-to-web.py) ──────────────────────────────
// n=name, s/logo/flag/icon = url-encoded paths under /logos/
type Team = { n: string; s: string };
type League = { name: string; teams: Team[]; logo?: string };
type Category = { name: string; count: number; leagues: League[]; flag?: string };
type Sport = { name: string; count: number; categories: Category[]; icon?: string };
type Manifest = { totalTeams: number; sports: Sport[] };

const ALL = "__all__"; // sentinel for the "All Leagues" selection

type Selection = { sport: string; category: string; league: string } | null;

export function LogosBrowser() {
  const t = useTranslations("logos");
  const tCommon = useTranslations("common");
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [error, setError] = useState(false);
  const [expSports, setExpSports] = useState<Set<string>>(new Set());
  const [expCats, setExpCats] = useState<Set<string>>(new Set());
  const [sel, setSel] = useState<Selection>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    fetch("/logos/manifest.json", { cache: "force-cache" })
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json() as Promise<Manifest>;
      })
      .then(setManifest)
      .catch(() => setError(true));
  }, []);

  const toggle = (set: Set<string>, key: string) => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  };

  // Resolve the teams for the current selection.
  const view = useMemo(() => {
    if (!manifest || !sel) return null;
    const sport = manifest.sports.find((s) => s.name === sel.sport);
    const cat = sport?.categories.find((c) => c.name === sel.category);
    if (!cat) return null;
    const leagues =
      sel.league === ALL
        ? cat.leagues
        : cat.leagues.filter((l) => l.name === sel.league);
    const teams = leagues.flatMap((l) => l.teams);
    const q = query.trim().toLowerCase();
    const filtered = q ? teams.filter((t) => t.n.toLowerCase().includes(q)) : teams;
    const single = sel.league === ALL ? null : leagues[0];
    return {
      title:
        sel.league === ALL
          ? `${sel.sport} · ${sel.category} · ${t("allLeagues")}`
          : `${sel.sport} · ${sel.category} · ${sel.league}`,
      img: single?.logo ?? cat.flag, // league badge, or country flag for "All Leagues"
      round: !single, // flags render with rounded corners, badges square
      total: teams.length,
      teams: filtered,
    };
  }, [manifest, sel, query, t]);

  if (error) {
    return (
      <div style={{ color: "var(--fg-muted)", padding: "24px 0" }}>
        Could not load the logo manifest. Run{" "}
        <code>python sync-to-web.py</code> to (re)generate it.
      </div>
    );
  }
  if (!manifest) {
    return (
      <div style={{ color: "var(--fg-muted)", padding: "24px 0" }}>
        {tCommon("loading")}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", gap: 24, alignItems: "flex-start" }}>
      {/* ── Left: Sport › Category › League tree ─────────────────────────── */}
      <nav
        style={{
          flex: "0 0 280px",
          position: "sticky",
          top: 16,
          maxHeight: "calc(100vh - 96px)",
          overflowY: "auto",
          borderRight: "1px solid var(--hairline)",
          paddingRight: 12,
        }}
      >
        {manifest.sports.map((sport) => {
          const sportOpen = expSports.has(sport.name);
          return (
            <div key={sport.name}>
              <Row
                depth={0}
                open={sportOpen}
                hasChildren
                label={sport.name}
                count={sport.count}
                img={sport.icon}
                onClick={() => setExpSports((s) => toggle(s, sport.name))}
              />
              {sportOpen &&
                sport.categories.map((cat) => {
                  const catKey = `${sport.name}>${cat.name}`;
                  const catOpen = expCats.has(catKey);
                  return (
                    <div key={catKey}>
                      <Row
                        depth={1}
                        open={catOpen}
                        hasChildren
                        label={cat.name}
                        count={cat.count}
                        img={cat.flag}
                        round
                        onClick={() => setExpCats((s) => toggle(s, catKey))}
                      />
                      {catOpen && (
                        <>
                          <Row
                            depth={2}
                            label={t("allLeagues")}
                            count={cat.count}
                            emphasis
                            active={
                              sel?.sport === sport.name &&
                              sel?.category === cat.name &&
                              sel?.league === ALL
                            }
                            onClick={() =>
                              setSel({
                                sport: sport.name,
                                category: cat.name,
                                league: ALL,
                              })
                            }
                          />
                          {cat.leagues.map((lg) => (
                            <Row
                              key={lg.name}
                              depth={2}
                              label={lg.name}
                              count={lg.teams.length}
                              img={lg.logo}
                              active={
                                sel?.sport === sport.name &&
                                sel?.category === cat.name &&
                                sel?.league === lg.name
                              }
                              onClick={() =>
                                setSel({
                                  sport: sport.name,
                                  category: cat.name,
                                  league: lg.name,
                                })
                              }
                            />
                          ))}
                        </>
                      )}
                    </div>
                  );
                })}
            </div>
          );
        })}
      </nav>

      {/* ── Right: team logos for the current selection ──────────────────── */}
      <section style={{ flex: 1, minWidth: 0 }}>
        {!view ? (
          <div style={{ color: "var(--fg-muted)", padding: "48px 0", fontSize: 14 }}>
            {t("pickHint")}
          </div>
        ) : (
          <>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 16,
                marginBottom: 16,
                flexWrap: "wrap",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                {view.img && (
                  <img
                    src={`/logos/${view.img}`}
                    alt=""
                    style={{
                      width: 28,
                      height: 28,
                      objectFit: "contain",
                      borderRadius: view.round ? 4 : 0,
                      border: view.round ? "1px solid var(--hairline)" : "none",
                      flex: "0 0 auto",
                    }}
                    onError={(e) => {
                      (e.currentTarget as HTMLImageElement).style.display = "none";
                    }}
                  />
                )}
                <div>
                  <div style={{ fontSize: 15, fontWeight: 600 }}>{view.title}</div>
                  <div style={{ fontSize: 12.5, color: "var(--fg-muted)", marginTop: 2 }}>
                    {view.teams.length === view.total
                      ? t("teamsCount", { count: view.total })
                      : t("teamsOfCount", {
                          shown: view.teams.length,
                          total: view.total,
                        })}
                  </div>
                </div>
              </div>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("filterPlaceholder")}
                style={{
                  height: 34,
                  width: 200,
                  padding: "0 12px",
                  fontSize: 13,
                  color: "var(--fg)",
                  background: "var(--surface)",
                  border: "1px solid var(--hairline)",
                  borderRadius: "var(--r-sm, 6px)",
                  outline: "none",
                }}
              />
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))",
                gap: 12,
              }}
            >
              {view.teams.map((t) => (
                <div
                  key={t.s}
                  className="card"
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    gap: 10,
                    padding: "16px 10px 12px",
                    textAlign: "center",
                  }}
                >
                  <img
                    src={`/logos/${t.s}`}
                    alt={t.n}
                    loading="lazy"
                    width={56}
                    height={56}
                    style={{ width: 56, height: 56, objectFit: "contain" }}
                    onError={(e) => {
                      (e.currentTarget as HTMLImageElement).style.visibility =
                        "hidden";
                    }}
                  />
                  <span
                    style={{
                      fontSize: 12,
                      lineHeight: 1.3,
                      color: "var(--fg)",
                      wordBreak: "break-word",
                    }}
                  >
                    {t.n}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}
      </section>
    </div>
  );
}

// ── A single tree row (sport / category / league) ──────────────────────────
function Row({
  depth,
  label,
  count,
  open,
  hasChildren,
  active,
  emphasis,
  img,
  round,
  onClick,
}: {
  depth: number;
  label: string;
  count?: number;
  open?: boolean;
  hasChildren?: boolean;
  active?: boolean;
  emphasis?: boolean;
  img?: string; // url-encoded path under /logos/
  round?: boolean; // flags get rounded corners + border; icons/badges don't
  onClick: () => void;
}) {
  const imgSize = depth === 0 ? 18 : 16;
  return (
    <button
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        width: "100%",
        textAlign: "left",
        padding: "6px 8px",
        paddingLeft: 8 + depth * 14,
        border: "none",
        borderRadius: 6,
        cursor: "pointer",
        background: active ? "var(--surface-2)" : "transparent",
        color: active || depth === 0 ? "var(--fg)" : "var(--fg-muted)",
        fontSize: depth === 0 ? 13.5 : 12.5,
        fontWeight: active || emphasis || depth === 0 ? 600 : 400,
      }}
    >
      <span
        style={{
          width: 10,
          flex: "0 0 10px",
          fontSize: 9,
          color: "var(--fg-dim, var(--fg-muted))",
        }}
      >
        {hasChildren ? (open ? "▾" : "▸") : ""}
      </span>
      {img ? (
        <img
          src={`/logos/${img}`}
          alt=""
          width={imgSize}
          height={imgSize}
          style={{
            width: imgSize,
            height: imgSize,
            flex: `0 0 ${imgSize}px`,
            objectFit: "contain",
            borderRadius: round ? 3 : 0,
            border: round ? "1px solid var(--hairline)" : "none",
          }}
          onError={(e) => {
            (e.currentTarget as HTMLImageElement).style.visibility = "hidden";
          }}
        />
      ) : (
        <span style={{ flex: `0 0 ${imgSize}px` }} />
      )}
      <span
        style={{
          flex: 1,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {label}
      </span>
      {count != null && (
        <span style={{ fontSize: 11, color: "var(--fg-dim, var(--fg-muted))" }}>
          {count}
        </span>
      )}
    </button>
  );
}
