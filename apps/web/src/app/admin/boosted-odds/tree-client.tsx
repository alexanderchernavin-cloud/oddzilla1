"use client";

// Boosted Odds admin tree (migration 0085). Mirrors the storefront's
// catalog hierarchy — sports at the top, expanding into tournaments
// AND teams, tournaments into matches, matches into markets — with a
// green Boost button on every row. Clicking it opens the assignment
// popup: boost % (Netwinstable key delta, same math as ZillaFlash),
// optional end time, optional Min Risk Score.
//
// Levels lazy-load on expand (same pattern as the RiskZilla live-delay
// tree). After every save / remove, the branch reloads so rule badges
// stay accurate, and the summary table re-fetches.

import { useCallback, useEffect, useState } from "react";
import { clientApi, ApiFetchError } from "@/lib/api-client";

export interface RuleDto {
  id: string;
  scope: "sport" | "tournament" | "match" | "competitor" | "market";
  boostPct: number;
  endsAt: string | null;
  minRiskScore: number | null;
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
  rule: RuleDto | null;
}

interface TournamentRow {
  id: number;
  name: string;
  riskTier: number | null;
  startAt: string | null;
  endAt: string | null;
  rule: RuleDto | null;
}

interface TeamRow {
  id: number;
  name: string;
  abbreviation: string | null;
  rule: RuleDto | null;
}

interface MatchRow {
  id: string;
  homeTeam: string;
  awayTeam: string;
  scheduledAt: string | null;
  status: string;
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

// ─── Root ───────────────────────────────────────────────────────────────

export function BoostedOddsTree({
  initialSports,
  initialRules,
}: {
  initialSports: SportRow[];
  initialRules: RuleWithLabel[];
}) {
  const [error, setError] = useState<string | null>(null);
  const [rules, setRules] = useState<RuleWithLabel[]>(initialRules);
  const [sports, setSports] = useState<SportRow[]>(initialSports);

  const onError = useCallback((msg: string) => {
    setError(msg);
    if (typeof window !== "undefined") {
      window.setTimeout(() => setError(null), 5000);
    }
  }, []);

  // Refresh the summary + the sports level after any mutation. Deeper
  // levels each reload their own branch via their `bump` counters.
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
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
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

      <ActiveRulesTable rules={rules} onRemove={removeRule} />

      <section style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <SectionHeader>Catalog</SectionHeader>
        <div
          style={{
            border: "1px solid var(--color-border)",
            borderRadius: 8,
            overflow: "hidden",
          }}
        >
          {sports.map((s) => (
            <SportNode
              key={s.id}
              sport={s}
              onError={onError}
              onChanged={refreshSummary}
            />
          ))}
          {sports.length === 0 && (
            <div
              style={{
                padding: "16px 14px",
                fontSize: 13,
                color: "var(--color-fg-muted)",
              }}
            >
              No active sports.
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

// ─── Active rules summary ───────────────────────────────────────────────

function ActiveRulesTable({
  rules,
  onRemove,
}: {
  rules: RuleWithLabel[];
  onRemove: (id: string) => void;
}) {
  if (rules.length === 0) {
    return (
      <section
        style={{
          padding: "12px 14px",
          border: "1px solid var(--color-border)",
          borderRadius: 8,
          background: "var(--color-bg-subtle)",
          fontSize: 13,
          color: "var(--color-fg-muted)",
        }}
      >
        No boost rules yet. Pick any entity below and press{" "}
        <span style={{ color: "#16a34a", fontWeight: 600 }}>Boost</span>.
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
            <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {r.label}
            </span>
            <RuleBadge rule={r} />
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

// ─── Sport node ─────────────────────────────────────────────────────────

function SportNode({
  sport,
  onError,
  onChanged,
}: {
  sport: SportRow;
  onError: (msg: string) => void;
  onChanged: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [tournaments, setTournaments] = useState<TournamentRow[] | null>(null);
  const [teams, setTeams] = useState<TeamRow[] | null>(null);
  const [teamQuery, setTeamQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [showTeams, setShowTeams] = useState(false);

  const loadTournaments = useCallback(async () => {
    setLoading(true);
    try {
      const data = await clientApi<{ entries: TournamentRow[] }>(
        `/admin/boosted-odds/sports/${sport.id}/tournaments`,
      );
      setTournaments(data.entries);
    } catch (err) {
      onError(err instanceof ApiFetchError ? err.message : "load failed");
      setTournaments([]);
    } finally {
      setLoading(false);
    }
  }, [sport.id, onError]);

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

  // Debounced team search once the Teams branch is open.
  useEffect(() => {
    if (!showTeams) return;
    const t = window.setTimeout(() => void loadTeams(teamQuery), 250);
    return () => window.clearTimeout(t);
  }, [showTeams, teamQuery, loadTeams]);

  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    if (next) void loadTournaments();
  };

  const reload = useCallback(() => {
    onChanged();
    if (expanded) void loadTournaments();
    if (showTeams) void loadTeams(teamQuery);
  }, [onChanged, expanded, showTeams, teamQuery, loadTournaments, loadTeams]);

  return (
    <div style={{ borderBottom: "1px solid var(--color-border)" }}>
      <TreeRow
        depth={0}
        expanded={expanded}
        onToggle={toggle}
        title={sport.name}
        rule={sport.rule}
        boost={
          <BoostControl
            scope="sport"
            refId={String(sport.id)}
            entityLabel={sport.name}
            rule={sport.rule}
            onError={onError}
            onChanged={reload}
          />
        }
      />
      {expanded && (
        <div style={{ padding: "4px 0 10px 0" }}>
          {loading && <LoadingNote>Loading tournaments…</LoadingNote>}
          {!loading && tournaments && tournaments.length === 0 && (
            <LoadingNote>No active tournaments under this sport.</LoadingNote>
          )}
          {tournaments?.map((t) => (
            <TournamentNode
              key={t.id}
              tournament={t}
              onError={onError}
              onChanged={reload}
            />
          ))}

          {/* Teams branch — collapsed by default, has its own search
              because a sport can carry thousands of competitors. */}
          <div style={{ padding: "6px 0 0 26px" }}>
            <button
              type="button"
              onClick={() => setShowTeams((v) => !v)}
              style={{
                fontSize: 12,
                fontWeight: 600,
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                color: "var(--color-fg-muted)",
                background: "transparent",
                border: "none",
                cursor: "pointer",
                padding: "4px 0",
              }}
            >
              {showTeams ? "▾" : "▸"} Teams
            </button>
            {showTeams && (
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                <input
                  value={teamQuery}
                  onChange={(e) => setTeamQuery(e.currentTarget.value)}
                  placeholder="Search teams…"
                  style={{
                    fontSize: 12.5,
                    padding: "5px 8px",
                    borderRadius: 6,
                    border: "1px solid var(--color-border)",
                    background: "var(--color-bg)",
                    color: "var(--color-fg)",
                    maxWidth: 260,
                    marginBottom: 4,
                  }}
                />
                {teams === null && <LoadingNote>Loading teams…</LoadingNote>}
                {teams !== null && teams.length === 0 && (
                  <LoadingNote>No teams found.</LoadingNote>
                )}
                {teams?.map((team) => (
                  <TreeRow
                    key={team.id}
                    depth={1}
                    title={team.name}
                    subtitle={team.abbreviation ?? undefined}
                    rule={team.rule}
                    boost={
                      <BoostControl
                        scope="competitor"
                        refId={String(team.id)}
                        entityLabel={team.name}
                        rule={team.rule}
                        onError={onError}
                        onChanged={reload}
                      />
                    }
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Tournament node ────────────────────────────────────────────────────

function TournamentNode({
  tournament,
  onError,
  onChanged,
}: {
  tournament: TournamentRow;
  onError: (msg: string) => void;
  onChanged: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [matches, setMatches] = useState<MatchRow[] | null>(null);
  const [loading, setLoading] = useState(false);

  const loadMatches = useCallback(async () => {
    setLoading(true);
    try {
      const data = await clientApi<{ entries: MatchRow[] }>(
        `/admin/boosted-odds/tournaments/${tournament.id}/matches`,
      );
      setMatches(data.entries);
    } catch (err) {
      onError(err instanceof ApiFetchError ? err.message : "load failed");
      setMatches([]);
    } finally {
      setLoading(false);
    }
  }, [tournament.id, onError]);

  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    if (next) void loadMatches();
  };

  const reload = useCallback(() => {
    onChanged();
    if (expanded) void loadMatches();
  }, [onChanged, expanded, loadMatches]);

  return (
    <div>
      <TreeRow
        depth={1}
        expanded={expanded}
        onToggle={toggle}
        title={tournament.name}
        subtitle={
          tournament.riskTier != null ? `Tier ${tournament.riskTier}` : undefined
        }
        rule={tournament.rule}
        boost={
          <BoostControl
            scope="tournament"
            refId={String(tournament.id)}
            entityLabel={tournament.name}
            rule={tournament.rule}
            onError={onError}
            onChanged={reload}
          />
        }
      />
      {expanded && (
        <div style={{ padding: "2px 0 6px 0" }}>
          {loading && <LoadingNote>Loading matches…</LoadingNote>}
          {!loading && matches && matches.length === 0 && (
            <LoadingNote>No upcoming or live matches.</LoadingNote>
          )}
          {matches?.map((m) => (
            <MatchNode key={m.id} match={m} onError={onError} onChanged={reload} />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Match node ─────────────────────────────────────────────────────────

function MatchNode({
  match,
  onError,
  onChanged,
}: {
  match: MatchRow;
  onError: (msg: string) => void;
  onChanged: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [markets, setMarkets] = useState<MarketRow[] | null>(null);
  const [loading, setLoading] = useState(false);

  const loadMarkets = useCallback(async () => {
    setLoading(true);
    try {
      const data = await clientApi<{ entries: MarketRow[] }>(
        `/admin/boosted-odds/matches/${match.id}/markets`,
      );
      setMarkets(data.entries);
    } catch (err) {
      onError(err instanceof ApiFetchError ? err.message : "load failed");
      setMarkets([]);
    } finally {
      setLoading(false);
    }
  }, [match.id, onError]);

  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    if (next) void loadMarkets();
  };

  const reload = useCallback(() => {
    onChanged();
    if (expanded) void loadMarkets();
  }, [onChanged, expanded, loadMarkets]);

  const title = `${match.homeTeam} vs ${match.awayTeam}`;
  const when = match.scheduledAt
    ? new Date(match.scheduledAt).toLocaleString()
    : "";

  return (
    <div>
      <TreeRow
        depth={2}
        expanded={expanded}
        onToggle={toggle}
        title={title}
        subtitle={`${match.status === "live" ? "LIVE" : when}`}
        rule={match.rule}
        boost={
          <BoostControl
            scope="match"
            refId={match.id}
            entityLabel={title}
            rule={match.rule}
            onError={onError}
            onChanged={reload}
          />
        }
      />
      {expanded && (
        <div style={{ padding: "2px 0 6px 0" }}>
          {loading && <LoadingNote>Loading markets…</LoadingNote>}
          {!loading && markets && markets.length === 0 && (
            <LoadingNote>No active markets on this match.</LoadingNote>
          )}
          {markets?.map((mk) => (
            <TreeRow
              key={mk.id}
              depth={3}
              title={mk.label}
              subtitle={`#${mk.providerMarketId}`}
              rule={mk.rule}
              boost={
                <BoostControl
                  scope="market"
                  refId={mk.id}
                  entityLabel={`${mk.label} — ${title}`}
                  rule={mk.rule}
                  onError={onError}
                  onChanged={reload}
                />
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Shared row chrome ──────────────────────────────────────────────────

function TreeRow({
  depth,
  expanded,
  onToggle,
  title,
  subtitle,
  rule,
  boost,
}: {
  depth: number;
  expanded?: boolean;
  onToggle?: () => void;
  title: string;
  subtitle?: string;
  rule: RuleDto | null;
  boost: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: `6px 12px 6px ${12 + depth * 18}px`,
        fontSize: 13,
      }}
    >
      {onToggle ? (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          style={{
            width: 18,
            flexShrink: 0,
            background: "transparent",
            border: "none",
            cursor: "pointer",
            color: "var(--color-fg-muted)",
            fontSize: 11,
            padding: 0,
          }}
        >
          {expanded ? "▾" : "▸"}
        </button>
      ) : (
        <span style={{ width: 18, flexShrink: 0 }} />
      )}
      <span
        style={{
          flex: 1,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
        title={title}
      >
        {onToggle ? (
          <button
            type="button"
            onClick={onToggle}
            style={{
              background: "transparent",
              border: "none",
              cursor: "pointer",
              color: "var(--color-fg)",
              fontSize: 13,
              padding: 0,
              textAlign: "left",
            }}
          >
            {title}
          </button>
        ) : (
          title
        )}
        {subtitle && (
          <span
            style={{
              marginLeft: 8,
              fontSize: 11.5,
              color: "var(--color-fg-muted)",
            }}
          >
            {subtitle}
          </span>
        )}
      </span>
      {rule && <RuleBadge rule={rule} />}
      {boost}
    </div>
  );
}

function RuleBadge({ rule }: { rule: RuleDto }) {
  const expired =
    rule.endsAt !== null && new Date(rule.endsAt).getTime() <= Date.now();
  const bits = [`+${rule.boostPct}%`];
  if (rule.endsAt) {
    bits.push(
      expired
        ? "ended"
        : `until ${new Date(rule.endsAt).toLocaleString()}`,
    );
  }
  if (rule.minRiskScore != null) bits.push(`RS ≥ ${rule.minRiskScore}`);
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
          : "color-mix(in oklab, #16a34a 14%, transparent)",
        color: expired ? "#dc2626" : "#15803d",
        whiteSpace: "nowrap",
      }}
      title={bits.join(" · ")}
    >
      {bits.join(" · ")}
    </span>
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

function LoadingNote({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        padding: "6px 12px 6px 44px",
        fontSize: 12.5,
        color: "var(--color-fg-muted)",
      }}
    >
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
  onError,
  onChanged,
}: {
  scope: Scope;
  refId: string;
  entityLabel: string;
  rule: RuleDto | null;
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
          fontSize: 12,
          fontWeight: 600,
          padding: "3px 12px",
          borderRadius: 6,
          border: "none",
          flexShrink: 0,
          background: rule ? "color-mix(in oklab, #16a34a 18%, transparent)" : "#16a34a",
          color: rule ? "#15803d" : "#fff",
          cursor: "pointer",
        }}
      >
        {rule ? "Edit" : "Boost"}
      </button>
      {open && (
        <BoostModal
          scope={scope}
          refId={refId}
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
  scope,
  refId,
  entityLabel,
  rule,
  onClose,
  onError,
  onChanged,
}: {
  scope: Scope;
  refId: string;
  entityLabel: string;
  rule: RuleDto | null;
  onClose: () => void;
  onError: (msg: string) => void;
  onChanged: () => void;
}) {
  const [pct, setPct] = useState(rule ? String(rule.boostPct) : "3");
  const [endsAt, setEndsAt] = useState(
    rule?.endsAt ? toLocalInputValue(rule.endsAt) : "",
  );
  const [minRs, setMinRs] = useState(
    rule?.minRiskScore != null ? String(rule.minRiskScore) : "",
  );
  const [busy, setBusy] = useState(false);

  const save = async () => {
    const pctNum = Number.parseFloat(pct);
    if (!Number.isFinite(pctNum) || pctNum <= 0 || pctNum > 50) {
      onError("Boost % must be between 0 and 50.");
      return;
    }
    let endsIso: string | null = null;
    if (endsAt.trim() !== "") {
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
      await clientApi("/admin/boosted-odds/rules", {
        method: "PUT",
        body: JSON.stringify({
          scope,
          refId,
          boostPct: pctNum,
          endsAt: endsIso,
          minRiskScore: minRsNum,
        }),
      });
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
            Boosted odds · {SCOPE_LABEL[scope]}
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
            ZillaFlash (3 = its baseline). Clamped so the book never goes
            to or below fair.
          </span>
        </label>

        <label style={fieldStyle}>
          <span style={labelStyle}>End time (optional)</span>
          <input
            type="datetime-local"
            value={endsAt}
            onChange={(e) => setEndsAt(e.currentTarget.value)}
            style={inputStyle}
          />
          <span style={hintStyle}>
            Empty = boost runs until removed (no countdown on the
            storefront).
          </span>
        </label>

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
            Bettors with a risk score below this don&apos;t receive the
            boost. Default bettor RS is 1.000.
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
              background: "#16a34a",
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
