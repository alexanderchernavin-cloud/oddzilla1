"use client";

// Boosted Odds admin board (migration 0085). Laid out like the
// storefront, not like a config tree: a sports rail on the left (same
// TOP-pinned order + live counts the oddzilla.cc sidebar shows) and
// the selected sport's MATCH LIST on the right — the same flat card
// list the sport page renders (live first, then upcoming by time,
// team logos, tournament label with the gold star on Tier 1-2). Only
// matches with something to bet on appear; tournaments without
// matches don't exist here.
//
// Every entity keeps its green Boost button: the sport (rail + board
// header), each tournament (chip strip above the list, doubles as a
// filter), each match card, each market (expand a card), and each team
// (Teams tab with search). The popup assigns boost % / end time / Min
// Risk Score.

import { useCallback, useEffect, useMemo, useState } from "react";
import { clientApi, ApiFetchError } from "@/lib/api-client";
import { orderSportsForSidebar } from "@/lib/sport-order";
import { isFeaturedTier } from "@/components/ui/tier-mark";

export interface RuleDto {
  id: string;
  scope: "sport" | "tournament" | "match" | "competitor" | "market";
  boostPct: number;
  endsAt: string | null;
  minRiskScore: number | null;
  banner: boolean;
  updatedAt: string;
}

export interface RuleWithLabel extends RuleDto {
  refId: string;
  label: string;
}

export interface SportRow {
  id: number;
  slug: string;
  name: string;
  liveCount: number;
  upcomingCount: number;
  rule: RuleDto | null;
}

interface BoardTournament {
  id: number;
  name: string;
  riskTier: number | null;
  rule: RuleDto | null;
  matchCount: number;
}

interface BoardMatch {
  id: string;
  homeTeam: string;
  awayTeam: string;
  homeLogoUrl: string | null;
  awayLogoUrl: string | null;
  scheduledAt: string | null;
  status: string;
  tournamentId: number;
  tournamentName: string;
  riskTier: number | null;
  rule: RuleDto | null;
}

interface BoardPayload {
  tournaments: BoardTournament[];
  matches: BoardMatch[];
}

interface TeamRow {
  id: number;
  name: string;
  abbreviation: string | null;
  rule: RuleDto | null;
}

interface MarketRow {
  id: string;
  providerMarketId: number;
  label: string;
  rule: RuleDto | null;
}

type Scope = RuleDto["scope"];

const SCOPE_LABEL: Record<Scope, string> = {
  sport: "Sport",
  tournament: "Tournament",
  match: "Match",
  competitor: "Team",
  market: "Market",
};

const GREEN = "#16a34a";

// ─── Root ───────────────────────────────────────────────────────────────

export function BoostedOddsBoard({
  initialSports,
  initialRules,
}: {
  initialSports: SportRow[];
  initialRules: RuleWithLabel[];
}) {
  const [error, setError] = useState<string | null>(null);
  const [rules, setRules] = useState<RuleWithLabel[]>(initialRules);
  const [sports, setSports] = useState<SportRow[]>(initialSports);
  // Storefront order: CS2 / Dota 2 / LoL / Valorant pinned, the rest
  // alphabetical, bot sports hidden — identical to the sidebar.
  const orderedSports = useMemo(
    () => orderSportsForSidebar(sports, null, null),
    [sports],
  );
  const [selectedId, setSelectedId] = useState<number | null>(
    () => orderSportsForSidebar(initialSports, null, null)[0]?.id ?? null,
  );
  const selected = orderedSports.find((s) => s.id === selectedId) ?? null;

  const onError = useCallback((msg: string) => {
    setError(msg);
    if (typeof window !== "undefined") {
      window.setTimeout(() => setError(null), 5000);
    }
  }, []);

  const refreshSummary = useCallback(async () => {
    try {
      const [r, s] = await Promise.all([
        clientApi<{ rules: RuleWithLabel[] }>("/admin/boosted-odds/rules"),
        clientApi<{ entries: SportRow[] }>("/admin/boosted-odds/sports"),
      ]);
      setRules(r.rules);
      setSports(s.entries);
    } catch {
      // Non-fatal — the next mutation retries.
    }
  }, []);

  const removeRule = useCallback(
    async (id: string) => {
      try {
        await clientApi(`/admin/boosted-odds/rules/${id}`, { method: "DELETE" });
        await refreshSummary();
      } catch (err) {
        onError(err instanceof ApiFetchError ? err.message : "delete failed");
      }
    },
    [refreshSummary, onError],
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {error && (
        <div
          role="alert"
          style={{
            fontSize: 12.5,
            color: "#dc2626",
            background: "color-mix(in oklab, #dc2626 8%, transparent)",
            padding: "6px 10px",
            borderRadius: 6,
          }}
        >
          {error}
        </div>
      )}

      <ActiveRulesTable
        rules={rules}
        onRemove={removeRule}
        onError={onError}
        onChanged={refreshSummary}
      />

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "230px minmax(0, 1fr)",
          gap: 14,
          alignItems: "start",
        }}
      >
        {/* ── Sports rail (storefront sidebar shape) ────────────────── */}
        <nav
          style={{
            border: "1px solid var(--color-border)",
            borderRadius: 10,
            overflow: "hidden",
            position: "sticky",
            top: 12,
          }}
        >
          {orderedSports.map((s) => {
            const active = s.id === selectedId;
            return (
              <div
                key={s.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "7px 10px",
                  borderBottom: "1px solid var(--color-border)",
                  background: active ? "var(--color-bg-subtle)" : "transparent",
                }}
              >
                <button
                  type="button"
                  onClick={() => setSelectedId(s.id)}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    background: "transparent",
                    border: "none",
                    cursor: "pointer",
                    padding: 0,
                    fontSize: 13,
                    fontWeight: active ? 650 : 450,
                    color: "var(--color-fg)",
                    textAlign: "left",
                  }}
                >
                  <span
                    style={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {s.name}
                  </span>
                  {s.liveCount > 0 && (
                    <span
                      className="mono tnum"
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 4,
                        fontSize: 10.5,
                        color: "#dc2626",
                        fontWeight: 700,
                      }}
                    >
                      <span
                        style={{
                          width: 5,
                          height: 5,
                          borderRadius: 999,
                          background: "#dc2626",
                        }}
                      />
                      {s.liveCount}
                    </span>
                  )}
                  {s.upcomingCount > 0 && (
                    <span
                      className="mono tnum"
                      style={{ fontSize: 10.5, color: "var(--color-fg-muted)" }}
                    >
                      {s.upcomingCount}
                    </span>
                  )}
                </button>
                {s.rule && <MiniRuleDot rule={s.rule} />}
                <BoostControl
                  scope="sport"
                  refId={String(s.id)}
                  entityLabel={s.name}
                  rule={s.rule}
                  compact
                  onError={onError}
                  onChanged={refreshSummary}
                />
              </div>
            );
          })}
        </nav>

        {/* ── Sport board ───────────────────────────────────────────── */}
        {selected ? (
          <SportBoard
            key={selected.id}
            sport={selected}
            onError={onError}
            onChanged={refreshSummary}
          />
        ) : (
          <div style={{ fontSize: 13, color: "var(--color-fg-muted)" }}>
            No active sports.
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Active rules summary ───────────────────────────────────────────────

function ActiveRulesTable({
  rules,
  onRemove,
  onError,
  onChanged,
}: {
  rules: RuleWithLabel[];
  onRemove: (id: string) => void;
  onError: (msg: string) => void;
  onChanged: () => void;
}) {
  if (rules.length === 0) {
    return (
      <section
        style={{
          padding: "10px 14px",
          border: "1px solid var(--color-border)",
          borderRadius: 8,
          background: "var(--color-bg-subtle)",
          fontSize: 13,
          color: "var(--color-fg-muted)",
        }}
      >
        No boost rules yet. Pick any sport, tournament, team, match or market
        below and press <span style={{ color: GREEN, fontWeight: 600 }}>Boost</span>.
      </section>
    );
  }
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <SectionHeader>Active rules ({rules.length})</SectionHeader>
      <div
        style={{
          border: "1px solid var(--color-border)",
          borderRadius: 8,
          overflow: "hidden",
        }}
      >
        {rules.map((r) => (
          <div
            key={r.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "8px 12px",
              borderBottom: "1px solid var(--color-border)",
              fontSize: 13,
            }}
          >
            <span
              className="mono"
              style={{
                fontSize: 10.5,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                color: "var(--color-fg-muted)",
                width: 84,
                flexShrink: 0,
              }}
            >
              {SCOPE_LABEL[r.scope]}
            </span>
            <span
              style={{
                flex: 1,
                minWidth: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {r.label}
            </span>
            <RuleBadge rule={r} />
            <BoostControl
              scope={r.scope}
              refId={r.refId}
              entityLabel={r.label}
              rule={r}
              compact
              onError={onError}
              onChanged={onChanged}
            />
            <button
              type="button"
              onClick={() => onRemove(r.id)}
              style={{
                fontSize: 12,
                padding: "3px 10px",
                borderRadius: 6,
                border: "1px solid var(--color-border)",
                background: "transparent",
                color: "#dc2626",
                cursor: "pointer",
              }}
            >
              Remove
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

// ─── Sport board (right pane) ───────────────────────────────────────────

function SportBoard({
  sport,
  onError,
  onChanged,
}: {
  sport: SportRow;
  onError: (msg: string) => void;
  onChanged: () => void;
}) {
  const [board, setBoard] = useState<BoardPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<"matches" | "teams">("matches");
  const [tournamentFilter, setTournamentFilter] = useState<number | null>(null);

  const loadBoard = useCallback(async () => {
    setLoading(true);
    try {
      const data = await clientApi<BoardPayload>(
        `/admin/boosted-odds/sports/${sport.id}/board`,
      );
      setBoard(data);
    } catch (err) {
      onError(err instanceof ApiFetchError ? err.message : "load failed");
      setBoard({ tournaments: [], matches: [] });
    } finally {
      setLoading(false);
    }
  }, [sport.id, onError]);

  useEffect(() => {
    void loadBoard();
  }, [loadBoard]);

  const reload = useCallback(() => {
    onChanged();
    void loadBoard();
  }, [onChanged, loadBoard]);

  const visibleMatches = useMemo(() => {
    if (!board) return [];
    if (tournamentFilter === null) return board.matches;
    return board.matches.filter((m) => m.tournamentId === tournamentFilter);
  }, [board, tournamentFilter]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>
      {/* Header: sport name + sport-level Boost */}
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <h2 style={{ fontSize: 16, fontWeight: 650, margin: 0, flex: 1 }}>
          {sport.name}
        </h2>
        <div
          role="tablist"
          style={{
            display: "inline-flex",
            border: "1px solid var(--color-border)",
            borderRadius: 999,
            overflow: "hidden",
          }}
        >
          {(["matches", "teams"] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              style={{
                fontSize: 12,
                fontWeight: 600,
                padding: "4px 14px",
                border: "none",
                cursor: "pointer",
                background: tab === t ? "var(--color-fg)" : "transparent",
                color: tab === t ? "var(--color-bg)" : "var(--color-fg-muted)",
              }}
            >
              {t === "matches" ? "Matches" : "Teams"}
            </button>
          ))}
        </div>
        <BoostControl
          scope="sport"
          refId={String(sport.id)}
          entityLabel={sport.name}
          rule={sport.rule}
          onError={onError}
          onChanged={reload}
        />
      </div>

      {tab === "teams" ? (
        <TeamsPane sport={sport} onError={onError} onChanged={reload} />
      ) : (
        <>
          {/* Tournament chip strip — boost a whole tournament, or click
              to filter the match list down to it. */}
          {board && board.tournaments.length > 0 && (
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 6,
              }}
            >
              <TournamentChip
                label="All"
                active={tournamentFilter === null}
                onClick={() => setTournamentFilter(null)}
              />
              {board.tournaments.map((t) => (
                <TournamentChip
                  key={t.id}
                  label={t.name}
                  count={t.matchCount}
                  featured={isFeaturedTier(t.riskTier)}
                  rule={t.rule}
                  active={tournamentFilter === t.id}
                  onClick={() =>
                    setTournamentFilter((cur) => (cur === t.id ? null : t.id))
                  }
                  boost={
                    <BoostControl
                      scope="tournament"
                      refId={String(t.id)}
                      entityLabel={t.name}
                      rule={t.rule}
                      compact
                      onError={onError}
                      onChanged={reload}
                    />
                  }
                />
              ))}
            </div>
          )}

          {loading && <Note>Loading matches…</Note>}
          {!loading && visibleMatches.length === 0 && (
            <Note>No live or upcoming matches with active markets.</Note>
          )}
          {!loading && visibleMatches.length > 0 && (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              {visibleMatches.map((m) => (
                <MatchCard key={m.id} match={m} onError={onError} onChanged={reload} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function TournamentChip({
  label,
  count,
  featured,
  rule,
  active,
  onClick,
  boost,
}: {
  label: string;
  count?: number;
  featured?: boolean;
  rule?: RuleDto | null;
  active: boolean;
  onClick: () => void;
  boost?: React.ReactNode;
}) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "3px 6px 3px 10px",
        borderRadius: 999,
        border: `1px solid ${active ? "var(--color-fg)" : "var(--color-border)"}`,
        background: active ? "var(--color-bg-subtle)" : "transparent",
        fontSize: 12,
        maxWidth: 340,
      }}
    >
      <button
        type="button"
        onClick={onClick}
        style={{
          background: "transparent",
          border: "none",
          cursor: "pointer",
          padding: 0,
          fontSize: 12,
          fontWeight: active ? 650 : 450,
          color: "var(--color-fg)",
          display: "inline-flex",
          alignItems: "center",
          gap: 5,
          minWidth: 0,
        }}
        title={label}
      >
        {featured && <span style={{ color: "#eab308" }}>★</span>}
        <span
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            maxWidth: 220,
          }}
        >
          {label}
        </span>
        {count !== undefined && (
          <span className="mono tnum" style={{ color: "var(--color-fg-muted)", fontSize: 10.5 }}>
            {count}
          </span>
        )}
      </button>
      {rule && <MiniRuleDot rule={rule} />}
      {boost}
    </span>
  );
}

// ─── Match card (storefront match-row shape) ────────────────────────────

function MatchCard({
  match: m,
  onError,
  onChanged,
}: {
  match: BoardMatch;
  onError: (msg: string) => void;
  onChanged: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [markets, setMarkets] = useState<MarketRow[] | null>(null);
  const [loadingMarkets, setLoadingMarkets] = useState(false);
  // Multiselect for bulk market boosts — checked market ids.
  const [checked, setChecked] = useState<Set<string>>(() => new Set());
  const [bulkOpen, setBulkOpen] = useState(false);
  const live = m.status === "live";

  const loadMarkets = useCallback(async () => {
    setLoadingMarkets(true);
    try {
      const data = await clientApi<{ entries: MarketRow[] }>(
        `/admin/boosted-odds/matches/${m.id}/markets`,
      );
      setMarkets(data.entries);
    } catch (err) {
      onError(err instanceof ApiFetchError ? err.message : "load failed");
      setMarkets([]);
    } finally {
      setLoadingMarkets(false);
    }
  }, [m.id, onError]);

  const toggleMarkets = () => {
    const next = !expanded;
    setExpanded(next);
    if (next && markets === null) void loadMarkets();
  };

  return (
    <div
      style={{
        border: "1px solid var(--color-border)",
        borderRadius: 10,
        background: "var(--color-bg)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "10px 12px",
        }}
      >
        {/* When / LIVE — same left column the storefront card leads with */}
        <div
          style={{
            width: 74,
            flexShrink: 0,
            display: "flex",
            flexDirection: "column",
            gap: 2,
          }}
        >
          {live ? (
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                fontSize: 11,
                fontWeight: 700,
                color: "#dc2626",
                letterSpacing: "0.08em",
              }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 999,
                  background: "#dc2626",
                }}
              />
              LIVE
            </span>
          ) : (
            <MatchWhen iso={m.scheduledAt} />
          )}
        </div>

        {/* Teams, stacked like the storefront row */}
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 4 }}>
          <TeamLine name={m.homeTeam} logoUrl={m.homeLogoUrl} />
          <TeamLine name={m.awayTeam} logoUrl={m.awayLogoUrl} />
        </div>

        {/* Tournament label + tier star */}
        <div
          style={{
            width: 200,
            flexShrink: 0,
            fontSize: 11.5,
            color: "var(--color-fg-muted)",
            display: "flex",
            alignItems: "center",
            gap: 5,
            overflow: "hidden",
          }}
          title={m.tournamentName}
        >
          {isFeaturedTier(m.riskTier) && <span style={{ color: "#eab308" }}>★</span>}
          <span
            style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {m.tournamentName}
          </span>
        </div>

        {m.rule && <RuleBadge rule={m.rule} />}
        <BoostControl
          scope="match"
          refId={m.id}
          entityLabel={`${m.homeTeam} vs ${m.awayTeam}`}
          rule={m.rule}
          onError={onError}
          onChanged={onChanged}
        />
        <button
          type="button"
          onClick={toggleMarkets}
          aria-expanded={expanded}
          title="Boost a single market"
          style={{
            fontSize: 11.5,
            padding: "3px 9px",
            borderRadius: 6,
            border: "1px solid var(--color-border)",
            background: "transparent",
            color: "var(--color-fg-muted)",
            cursor: "pointer",
            flexShrink: 0,
          }}
        >
          Markets {expanded ? "▾" : "▸"}
        </button>
      </div>

      {expanded && (
        <div
          style={{
            borderTop: "1px solid var(--color-border)",
            background: "var(--color-bg-subtle)",
            padding: "4px 0",
          }}
        >
          {loadingMarkets && <Note>Loading markets…</Note>}
          {!loadingMarkets && markets && markets.length === 0 && (
            <Note>No active markets on this match.</Note>
          )}
          {checked.size > 0 && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "6px 12px 6px 98px",
                fontSize: 12.5,
              }}
            >
              <span style={{ color: "var(--color-fg-muted)" }}>
                {checked.size} selected
              </span>
              <button
                type="button"
                onClick={() => setBulkOpen(true)}
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  padding: "3px 12px",
                  borderRadius: 6,
                  border: "none",
                  background: GREEN,
                  color: "#fff",
                  cursor: "pointer",
                }}
              >
                Boost selected
              </button>
              <button
                type="button"
                onClick={() => setChecked(new Set())}
                style={{
                  fontSize: 12,
                  padding: "3px 10px",
                  borderRadius: 6,
                  border: "1px solid var(--color-border)",
                  background: "transparent",
                  color: "var(--color-fg-muted)",
                  cursor: "pointer",
                }}
              >
                Clear
              </button>
            </div>
          )}
          {bulkOpen && (
            <BoostModal
              targets={[...checked].map((id) => ({
                scope: "market" as const,
                refId: id,
              }))}
              entityLabel={`${checked.size} markets — ${m.homeTeam} vs ${m.awayTeam}`}
              rule={null}
              onClose={() => setBulkOpen(false)}
              onError={onError}
              onChanged={() => {
                setChecked(new Set());
                onChanged();
                void loadMarkets();
              }}
            />
          )}
          {markets?.map((mk) => (
            <div
              key={mk.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "5px 12px 5px 78px",
                fontSize: 12.5,
              }}
            >
              <input
                type="checkbox"
                checked={checked.has(mk.id)}
                onChange={(e) => {
                  const on = e.currentTarget.checked;
                  setChecked((prev) => {
                    const next = new Set(prev);
                    if (on) next.add(mk.id);
                    else next.delete(mk.id);
                    return next;
                  });
                }}
                style={{ accentColor: "#16a34a", flexShrink: 0 }}
              />
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                title={mk.label}
              >
                {mk.label}
                <span
                  className="mono"
                  style={{ marginLeft: 8, fontSize: 10.5, color: "var(--color-fg-muted)" }}
                >
                  #{mk.providerMarketId}
                </span>
              </span>
              {mk.rule && <RuleBadge rule={mk.rule} />}
              <BoostControl
                scope="market"
                refId={mk.id}
                entityLabel={`${mk.label} — ${m.homeTeam} vs ${m.awayTeam}`}
                rule={mk.rule}
                compact
                onError={onError}
                onChanged={() => {
                  onChanged();
                  void loadMarkets();
                }}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TeamLine({ name, logoUrl }: { name: string; logoUrl: string | null }) {
  const [broken, setBroken] = useState(false);
  return (
    <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
      {logoUrl && !broken ? (
        <img
          src={logoUrl}
          alt=""
          width={18}
          height={18}
          style={{ borderRadius: 4, objectFit: "contain", flexShrink: 0 }}
          onError={() => setBroken(true)}
        />
      ) : (
        <span
          style={{
            width: 18,
            height: 18,
            borderRadius: 4,
            background: "var(--color-bg-subtle)",
            border: "1px solid var(--color-border)",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 8.5,
            fontWeight: 700,
            color: "var(--color-fg-muted)",
            flexShrink: 0,
          }}
        >
          {name.slice(0, 2).toUpperCase()}
        </span>
      )}
      <span
        style={{
          fontSize: 13.5,
          fontWeight: 550,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {name}
      </span>
    </span>
  );
}

function MatchWhen({ iso }: { iso: string | null }) {
  if (!iso) {
    return (
      <span style={{ fontSize: 11.5, color: "var(--color-fg-muted)" }}>TBD</span>
    );
  }
  const d = new Date(iso);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return (
    <>
      <span className="mono tnum" style={{ fontSize: 13, fontWeight: 650 }}>
        {d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
      </span>
      <span style={{ fontSize: 10.5, color: "var(--color-fg-muted)" }}>
        {sameDay
          ? "Today"
          : d.toLocaleDateString([], { day: "numeric", month: "short" })}
      </span>
    </>
  );
}

// ─── Teams pane ─────────────────────────────────────────────────────────

function TeamsPane({
  sport,
  onError,
  onChanged,
}: {
  sport: SportRow;
  onError: (msg: string) => void;
  onChanged: () => void;
}) {
  const [teams, setTeams] = useState<TeamRow[] | null>(null);
  const [query, setQuery] = useState("");

  const loadTeams = useCallback(
    async (q: string) => {
      try {
        const data = await clientApi<{ entries: TeamRow[] }>(
          `/admin/boosted-odds/sports/${sport.id}/teams${q ? `?q=${encodeURIComponent(q)}` : ""}`,
        );
        setTeams(data.entries);
      } catch (err) {
        onError(err instanceof ApiFetchError ? err.message : "load failed");
        setTeams([]);
      }
    },
    [sport.id, onError],
  );

  useEffect(() => {
    const t = window.setTimeout(() => void loadTeams(query), 250);
    return () => window.clearTimeout(t);
  }, [query, loadTeams]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <input
        value={query}
        onChange={(e) => setQuery(e.currentTarget.value)}
        placeholder="Search teams…"
        style={{
          fontSize: 13,
          padding: "6px 10px",
          borderRadius: 8,
          border: "1px solid var(--color-border)",
          background: "var(--color-bg)",
          color: "var(--color-fg)",
          maxWidth: 300,
        }}
      />
      <div
        style={{
          border: "1px solid var(--color-border)",
          borderRadius: 10,
          overflow: "hidden",
        }}
      >
        {teams === null && <Note>Loading teams…</Note>}
        {teams !== null && teams.length === 0 && <Note>No teams found.</Note>}
        {teams?.map((team) => (
          <div
            key={team.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "7px 12px",
              borderBottom: "1px solid var(--color-border)",
              fontSize: 13,
            }}
          >
            <span
              style={{
                flex: 1,
                minWidth: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {team.name}
              {team.abbreviation && (
                <span
                  className="mono"
                  style={{
                    marginLeft: 8,
                    fontSize: 10.5,
                    color: "var(--color-fg-muted)",
                  }}
                >
                  {team.abbreviation}
                </span>
              )}
            </span>
            {team.rule && <RuleBadge rule={team.rule} />}
            <BoostControl
              scope="competitor"
              refId={String(team.id)}
              entityLabel={team.name}
              rule={team.rule}
              onError={onError}
              onChanged={onChanged}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Shared chrome ──────────────────────────────────────────────────────

function RuleBadge({ rule }: { rule: RuleDto }) {
  const expired =
    rule.endsAt !== null && new Date(rule.endsAt).getTime() <= Date.now();
  const bits = [`+${rule.boostPct}%`];
  if (rule.endsAt) {
    bits.push(
      expired ? "ended" : `until ${new Date(rule.endsAt).toLocaleString()}`,
    );
  }
  if (rule.minRiskScore != null) bits.push(`RS ≥ ${rule.minRiskScore}`);
  if (rule.banner) bits.push("banner");
  return (
    <span
      className="mono tnum"
      style={{
        fontSize: 11,
        padding: "2px 8px",
        borderRadius: 999,
        flexShrink: 0,
        background: expired
          ? "color-mix(in oklab, #dc2626 12%, transparent)"
          : `color-mix(in oklab, ${GREEN} 14%, transparent)`,
        color: expired ? "#dc2626" : "#15803d",
        whiteSpace: "nowrap",
      }}
      title={bits.join(" · ")}
    >
      {bits.join(" · ")}
    </span>
  );
}

// Tiny green dot for tight rows (sports rail, tournament chips) where a
// full badge doesn't fit — the badge shows in the summary + on hover
// via the Boost popup.
function MiniRuleDot({ rule }: { rule: RuleDto }) {
  const expired =
    rule.endsAt !== null && new Date(rule.endsAt).getTime() <= Date.now();
  return (
    <span
      title={`+${rule.boostPct}%${rule.endsAt ? ` until ${new Date(rule.endsAt).toLocaleString()}` : ""}${rule.minRiskScore != null ? ` · RS ≥ ${rule.minRiskScore}` : ""}`}
      style={{
        width: 7,
        height: 7,
        borderRadius: 999,
        flexShrink: 0,
        background: expired ? "#dc2626" : GREEN,
      }}
    />
  );
}

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="mono"
      style={{
        fontSize: 11,
        letterSpacing: "0.12em",
        textTransform: "uppercase",
        color: "var(--color-fg-muted)",
      }}
    >
      {children}
    </div>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ padding: "10px 12px", fontSize: 12.5, color: "var(--color-fg-muted)" }}>
      {children}
    </div>
  );
}

// ─── Boost button + assignment popup ───────────────────────────────────

function BoostControl({
  scope,
  refId,
  entityLabel,
  rule,
  compact,
  onError,
  onChanged,
}: {
  scope: Scope;
  refId: string;
  entityLabel: string;
  rule: RuleDto | null;
  compact?: boolean;
  onError: (msg: string) => void;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        style={{
          fontSize: compact ? 11 : 12,
          fontWeight: 600,
          padding: compact ? "2px 8px" : "3px 12px",
          borderRadius: 6,
          border: "none",
          flexShrink: 0,
          background: rule
            ? `color-mix(in oklab, ${GREEN} 18%, transparent)`
            : GREEN,
          color: rule ? "#15803d" : "#fff",
          cursor: "pointer",
        }}
      >
        {rule ? "Edit" : "Boost"}
      </button>
      {open && (
        <BoostModal
          targets={[{ scope, refId }]}
          entityLabel={entityLabel}
          rule={rule}
          onClose={() => setOpen(false)}
          onError={onError}
          onChanged={onChanged}
        />
      )}
    </>
  );
}

// datetime-local wants "YYYY-MM-DDTHH:mm" in LOCAL time.
function toLocalInputValue(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function BoostModal({
  targets,
  entityLabel,
  rule,
  onClose,
  onError,
  onChanged,
}: {
  // One rule is upserted per target — a single entity from a Boost
  // button, or a checked set of markets from the multiselect.
  targets: Array<{ scope: Scope; refId: string }>;
  entityLabel: string;
  rule: RuleDto | null;
  onClose: () => void;
  onError: (msg: string) => void;
  onChanged: () => void;
}) {
  const scope = targets[0]?.scope ?? "market";
  const [pct, setPct] = useState(rule ? String(rule.boostPct) : "3");
  // End modes: open-ended, a duration from now (quick presets or a
  // custom amount in minutes/hours), or an exact end time.
  const [endMode, setEndMode] = useState<"none" | "duration" | "at">(
    rule?.endsAt ? "at" : "none",
  );
  const [endsAt, setEndsAt] = useState(
    rule?.endsAt ? toLocalInputValue(rule.endsAt) : "",
  );
  const [durationN, setDurationN] = useState("1");
  const [durationUnit, setDurationUnit] = useState<"minutes" | "hours">("hours");
  const [minRs, setMinRs] = useState(
    rule?.minRiskScore != null ? String(rule.minRiskScore) : "",
  );
  const [banner, setBanner] = useState(rule?.banner ?? false);
  const [busy, setBusy] = useState(false);

  const applyPreset = (minutes: number) => {
    setEndMode("duration");
    if (minutes % 60 === 0) {
      setDurationN(String(minutes / 60));
      setDurationUnit("hours");
    } else {
      setDurationN(String(minutes));
      setDurationUnit("minutes");
    }
  };

  const save = async () => {
    const pctNum = Number.parseFloat(pct);
    if (!Number.isFinite(pctNum) || pctNum <= 0 || pctNum > 50) {
      onError("Boost % must be between 0 and 50.");
      return;
    }
    let endsIso: string | null = null;
    if (endMode === "duration") {
      const n = Number.parseFloat(durationN);
      if (!Number.isFinite(n) || n <= 0) {
        onError("Duration must be a positive number.");
        return;
      }
      const minutes = durationUnit === "hours" ? n * 60 : n;
      if (minutes > 60 * 24 * 90) {
        onError("Duration is too long (max 90 days).");
        return;
      }
      endsIso = new Date(Date.now() + minutes * 60_000).toISOString();
    } else if (endMode === "at") {
      if (endsAt.trim() === "") {
        onError("Pick an end time, or switch to No end / Duration.");
        return;
      }
      const d = new Date(endsAt);
      if (Number.isNaN(d.getTime())) {
        onError("End time is not a valid date.");
        return;
      }
      if (d.getTime() <= Date.now()) {
        onError("End time must be in the future.");
        return;
      }
      endsIso = d.toISOString();
    }
    let minRsNum: number | null = null;
    if (minRs.trim() !== "") {
      minRsNum = Number.parseFloat(minRs);
      if (!Number.isFinite(minRsNum) || minRsNum < 0.01 || minRsNum > 10) {
        onError("Min Risk Score must be between 0.01 and 10.");
        return;
      }
    }
    setBusy(true);
    try {
      for (const target of targets) {
        await clientApi("/admin/boosted-odds/rules", {
          method: "PUT",
          body: JSON.stringify({
            scope: target.scope,
            refId: target.refId,
            boostPct: pctNum,
            endsAt: endsIso,
            minRiskScore: minRsNum,
            banner,
          }),
        });
      }
      onChanged();
      onClose();
    } catch (err) {
      onError(err instanceof ApiFetchError ? err.message : "save failed");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!rule) return;
    setBusy(true);
    try {
      await clientApi(`/admin/boosted-odds/rules/${rule.id}`, {
        method: "DELETE",
      });
      onChanged();
      onClose();
    } catch (err) {
      onError(err instanceof ApiFetchError ? err.message : "delete failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 300,
        background: "rgba(0,0,0,0.4)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 420,
          background: "var(--color-bg)",
          border: "1px solid var(--color-border)",
          borderRadius: 10,
          padding: 18,
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        <div>
          <div
            className="mono"
            style={{
              fontSize: 10.5,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              color: "var(--color-fg-muted)",
            }}
          >
            ZillaBoost · {SCOPE_LABEL[scope]}
          </div>
          <div style={{ fontSize: 15, fontWeight: 600, marginTop: 2 }}>
            {entityLabel}
          </div>
        </div>

        <label style={fieldStyle}>
          <span style={labelStyle}>Boost %</span>
          <input
            type="number"
            min={0.1}
            max={50}
            step={0.5}
            value={pct}
            onChange={(e) => setPct(e.currentTarget.value)}
            style={inputStyle}
          />
          <span style={hintStyle}>
            Netwinstable key delta in percentage points — same math as
            ZillaFlash (3 = its baseline). Clamped so the book never goes to
            or below fair.
          </span>
        </label>

        <div style={fieldStyle}>
          <span style={labelStyle}>Ends</span>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {(
              [
                ["none", "No end"],
                ["duration", "Duration"],
                ["at", "Exact time"],
              ] as const
            ).map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                onClick={() => setEndMode(mode)}
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  padding: "4px 12px",
                  borderRadius: 999,
                  border: `1px solid ${endMode === mode ? "var(--color-fg)" : "var(--color-border)"}`,
                  background:
                    endMode === mode ? "var(--color-bg-subtle)" : "transparent",
                  color: "var(--color-fg)",
                  cursor: "pointer",
                }}
              >
                {label}
              </button>
            ))}
          </div>
          {endMode === "duration" && (
            <>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                {(
                  [
                    ["15m", 15],
                    ["30m", 30],
                    ["1h", 60],
                    ["3h", 180],
                    ["24h", 1440],
                  ] as const
                ).map(([label, minutes]) => {
                  const active =
                    (durationUnit === "minutes" &&
                      Number(durationN) === minutes) ||
                    (durationUnit === "hours" &&
                      Number(durationN) * 60 === minutes);
                  return (
                    <button
                      key={label}
                      type="button"
                      onClick={() => applyPreset(minutes)}
                      style={{
                        fontSize: 11.5,
                        padding: "3px 10px",
                        borderRadius: 6,
                        border: `1px solid ${active ? "#16a34a" : "var(--color-border)"}`,
                        background: active
                          ? "color-mix(in oklab, #16a34a 14%, transparent)"
                          : "transparent",
                        color: active ? "#15803d" : "var(--color-fg)",
                        cursor: "pointer",
                      }}
                    >
                      {label}
                    </button>
                  );
                })}
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={durationN}
                  onChange={(e) => setDurationN(e.currentTarget.value)}
                  style={{ ...inputStyle, width: 80 }}
                />
                <select
                  value={durationUnit}
                  onChange={(e) =>
                    setDurationUnit(e.currentTarget.value as "minutes" | "hours")
                  }
                  style={inputStyle}
                >
                  <option value="minutes">minutes</option>
                  <option value="hours">hours</option>
                </select>
              </div>
              <span style={hintStyle}>
                Boost switches off this long after saving. The storefront
                shows a ZillaFlash-style countdown on boosted prices.
              </span>
            </>
          )}
          {endMode === "at" && (
            <>
              <input
                type="datetime-local"
                value={endsAt}
                onChange={(e) => setEndsAt(e.currentTarget.value)}
                style={inputStyle}
              />
              <span style={hintStyle}>
                The storefront shows a ZillaFlash-style countdown on boosted
                prices.
              </span>
            </>
          )}
          {endMode === "none" && (
            <span style={hintStyle}>
              Boost runs until removed - no countdown on the storefront.
            </span>
          )}
        </div>

        <label style={fieldStyle}>
          <span style={labelStyle}>Min Risk Score (optional)</span>
          <input
            type="number"
            min={0.01}
            max={10}
            step={0.1}
            value={minRs}
            onChange={(e) => setMinRs(e.currentTarget.value)}
            placeholder="everyone"
            style={inputStyle}
          />
          <span style={hintStyle}>
            Bettors with a risk score below this don&apos;t receive the boost.
            Default bettor RS is 1.000.
          </span>
        </label>

        <label
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 8,
            cursor: scope === "competitor" ? "not-allowed" : "pointer",
            opacity: scope === "competitor" ? 0.55 : 1,
          }}
        >
          <input
            type="checkbox"
            checked={banner}
            disabled={scope === "competitor"}
            onChange={(e) => setBanner(e.currentTarget.checked)}
            style={{ accentColor: "#16a34a", marginTop: 2 }}
          />
          <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <span style={labelStyle}>Create promo banner</span>
            <span style={hintStyle}>
              Shows on the storefront home page: market &rarr; ZillaFlash-style
              card, match &rarr; match card with old + boosted winner prices,
              tournament &rarr; ZillaBoost banner opening its match list,
              sport &rarr; boost icon in the sidebar. Not available for teams.
            </span>
          </span>
        </label>

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          {rule && (
            <button
              type="button"
              onClick={remove}
              disabled={busy}
              style={{
                fontSize: 12.5,
                padding: "6px 12px",
                borderRadius: 6,
                border: "1px solid var(--color-border)",
                background: "transparent",
                color: "#dc2626",
                cursor: "pointer",
                marginRight: "auto",
              }}
            >
              Remove boost
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            style={{
              fontSize: 12.5,
              padding: "6px 12px",
              borderRadius: 6,
              border: "1px solid var(--color-border)",
              background: "transparent",
              color: "var(--color-fg)",
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={busy}
            style={{
              fontSize: 12.5,
              fontWeight: 600,
              padding: "6px 14px",
              borderRadius: 6,
              border: "none",
              background: GREEN,
              color: "#fff",
              cursor: "pointer",
              opacity: busy ? 0.6 : 1,
            }}
          >
            {busy ? "Saving…" : "Save boost"}
          </button>
        </div>
      </div>
    </div>
  );
}

const fieldStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
};
const labelStyle: React.CSSProperties = {
  fontSize: 12.5,
  fontWeight: 600,
};
const inputStyle: React.CSSProperties = {
  fontSize: 13,
  padding: "6px 8px",
  borderRadius: 6,
  border: "1px solid var(--color-border)",
  background: "var(--color-bg)",
  color: "var(--color-fg)",
};
const hintStyle: React.CSSProperties = {
  fontSize: 11.5,
  color: "var(--color-fg-muted)",
  lineHeight: 1.4,
};
