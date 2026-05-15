"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { clientApi, ApiFetchError } from "@/lib/api-client";

export interface Override {
  id: string;
  delaySeconds: number;
  updatedAt: string;
  updatedBy: string | null;
}

type Source = "global" | "sport" | "tournament" | "match";

export interface SportRow {
  id: number;
  slug: string;
  name: string;
  override: Override | null;
  effectiveDelaySeconds: number;
  effectiveSource: "global" | "sport";
}

interface TournamentRow {
  id: number;
  slug: string;
  name: string;
  startAt: string | null;
  endAt: string | null;
  riskTier: number | null;
  override: Override | null;
  effectiveDelaySeconds: number;
  effectiveSource: "global" | "sport" | "tournament";
}

interface MatchRow {
  id: string;
  homeTeam: string;
  awayTeam: string;
  scheduledAt: string | null;
  status: string;
  override: Override | null;
  effectiveDelaySeconds: number;
  effectiveSource: Source;
}

interface MatchesPayload {
  inheritedFromSport: number | null;
  inheritedFromTournament: number | null;
  entries: MatchRow[];
}

// ─── Top-level tree ─────────────────────────────────────────────────────

export function LiveDelayTree({
  global,
  sports,
}: {
  global: Override;
  sports: SportRow[];
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  // Single global error sink shared by every nested mutation. The tree
  // re-fetches via router.refresh() after every successful PUT/DELETE
  // so the freshly-resolved effective values flow back through SSR.
  const onError = useCallback((msg: string) => {
    setError(msg);
    if (typeof window !== "undefined") window.setTimeout(() => setError(null), 4000);
  }, []);
  const onSuccess = useCallback(() => {
    setError(null);
    router.refresh();
  }, [router]);

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

      <GlobalRow value={global} onError={onError} onSuccess={onSuccess} />

      <section style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <SectionHeader>Sports</SectionHeader>
        <div
          style={{
            border: "1px solid var(--color-border)",
            borderRadius: 8,
            overflow: "hidden",
          }}
        >
          {sports.map((s) => (
            <SportNode key={s.id} sport={s} onError={onError} onSuccess={onSuccess} />
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

// ─── Global row ─────────────────────────────────────────────────────────

function GlobalRow({
  value,
  onError,
  onSuccess,
}: {
  value: Override;
  onError: (msg: string) => void;
  onSuccess: () => void;
}) {
  const [draft, setDraft] = useState(String(value.delaySeconds));
  const [pending, startTransition] = useTransition();
  // Re-sync the input when SSR ships a fresh server value after
  // router.refresh() (the parent's `value` prop changes).
  useEffect(() => {
    setDraft(String(value.delaySeconds));
  }, [value.delaySeconds]);
  const dirty = draft !== String(value.delaySeconds);

  const save = () => {
    const n = Number.parseInt(draft, 10);
    if (!Number.isFinite(n) || n < 0 || n > 300) {
      onError("Delay must be between 0 and 300 seconds.");
      return;
    }
    startTransition(async () => {
      try {
        await clientApi(`/admin/riskzilla/live-delay/global`, {
          method: "PUT",
          body: JSON.stringify({ delaySeconds: n }),
        });
        onSuccess();
      } catch (err) {
        onError(err instanceof ApiFetchError ? err.message : "save failed");
      }
    });
  };

  return (
    <section
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
        padding: "12px 14px",
        border: "1px solid var(--color-border)",
        borderRadius: 8,
        background: "var(--color-bg-subtle)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <div>
          <div
            className="mono"
            style={{
              fontSize: 11,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              color: "var(--color-fg-muted)",
              marginBottom: 2,
            }}
          >
            Global default
          </div>
          <div style={{ fontSize: 13, color: "var(--color-fg-muted)" }}>
            Used when no sport / tournament / match override applies.
          </div>
        </div>
        <DelayInput
          draft={draft}
          setDraft={setDraft}
          onSave={save}
          dirty={dirty}
          pending={pending}
          showClear={false}
        />
      </div>
    </section>
  );
}

// ─── Sport node ─────────────────────────────────────────────────────────

function SportNode({
  sport,
  onError,
  onSuccess,
}: {
  sport: SportRow;
  onError: (msg: string) => void;
  onSuccess: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [tournaments, setTournaments] = useState<TournamentRow[] | null>(null);
  const [loading, setLoading] = useState(false);

  // Lazy-load on first expand. Re-fetch on every expand so an
  // operator who saved an override elsewhere sees the new effective
  // values without a full page refresh.
  const loadTournaments = useCallback(async () => {
    setLoading(true);
    try {
      const data = await clientApi<{ entries: TournamentRow[] }>(
        `/admin/riskzilla/live-delay/sports/${sport.id}/tournaments`,
      );
      setTournaments(data.entries);
    } catch (err) {
      onError(err instanceof ApiFetchError ? err.message : "load failed");
      setTournaments([]);
    } finally {
      setLoading(false);
    }
  }, [sport.id, onError]);

  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    if (next) void loadTournaments();
  };

  return (
    <div
      style={{
        borderBottom: "1px solid var(--color-border)",
      }}
    >
      <Row
        depth={0}
        expanded={expanded}
        onToggle={toggle}
        title={sport.name}
        subtitle={
          <SourcePill
            override={sport.override}
            source={sport.effectiveSource}
            effective={sport.effectiveDelaySeconds}
          />
        }
        action={
          <ScopeEditor
            initial={sport.override?.delaySeconds ?? sport.effectiveDelaySeconds}
            hasOverride={!!sport.override}
            inheritedDelay={
              sport.override ? null : sport.effectiveDelaySeconds
            }
            inheritedFrom={sport.override ? null : sport.effectiveSource}
            putUrl={`/admin/riskzilla/live-delay/sport/${sport.id}`}
            deleteUrl={`/admin/riskzilla/live-delay/sport/${sport.id}`}
            onSuccess={onSuccess}
            onError={onError}
          />
        }
      />
      {expanded && (
        <div style={{ padding: "6px 0 10px 0" }}>
          {loading && <LoadingNote>Loading tournaments…</LoadingNote>}
          {!loading && tournaments && tournaments.length === 0 && (
            <LoadingNote>No active tournaments under this sport.</LoadingNote>
          )}
          {tournaments?.map((t) => (
            <TournamentNode
              key={t.id}
              sportId={sport.id}
              tournament={t}
              onError={onError}
              onSuccess={onSuccess}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Tournament node ────────────────────────────────────────────────────

function TournamentNode({
  sportId: _sportId,
  tournament,
  onError,
  onSuccess,
}: {
  sportId: number;
  tournament: TournamentRow;
  onError: (msg: string) => void;
  onSuccess: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [matches, setMatches] = useState<MatchRow[] | null>(null);
  const [loading, setLoading] = useState(false);

  const loadMatches = useCallback(async () => {
    setLoading(true);
    try {
      const data = await clientApi<MatchesPayload>(
        `/admin/riskzilla/live-delay/tournaments/${tournament.id}/matches`,
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

  return (
    <div>
      <Row
        depth={1}
        expanded={expanded}
        onToggle={toggle}
        title={tournament.name}
        subtitle={
          <SourcePill
            override={tournament.override}
            source={tournament.effectiveSource}
            effective={tournament.effectiveDelaySeconds}
          />
        }
        action={
          <ScopeEditor
            initial={
              tournament.override?.delaySeconds ??
              tournament.effectiveDelaySeconds
            }
            hasOverride={!!tournament.override}
            inheritedDelay={
              tournament.override ? null : tournament.effectiveDelaySeconds
            }
            inheritedFrom={
              tournament.override ? null : tournament.effectiveSource
            }
            putUrl={`/admin/riskzilla/live-delay/tournament/${tournament.id}`}
            deleteUrl={`/admin/riskzilla/live-delay/tournament/${tournament.id}`}
            onSuccess={onSuccess}
            onError={onError}
          />
        }
      />
      {expanded && (
        <div style={{ padding: "4px 0 8px 0" }}>
          {loading && <LoadingNote indent={2}>Loading matches…</LoadingNote>}
          {!loading && matches && matches.length === 0 && (
            <LoadingNote indent={2}>
              No upcoming / live matches in this tournament.
            </LoadingNote>
          )}
          {matches?.map((m) => (
            <MatchNode
              key={m.id}
              match={m}
              onError={onError}
              onSuccess={onSuccess}
            />
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
  onSuccess,
}: {
  match: MatchRow;
  onError: (msg: string) => void;
  onSuccess: () => void;
}) {
  return (
    <Row
      depth={2}
      title={`${match.homeTeam} vs ${match.awayTeam}`}
      subtitle={
        <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
          <StatusPill status={match.status} />
          {match.scheduledAt && (
            <span style={{ fontSize: 12, color: "var(--color-fg-muted)" }}>
              {new Date(match.scheduledAt).toLocaleString()}
            </span>
          )}
          <SourcePill
            override={match.override}
            source={match.effectiveSource}
            effective={match.effectiveDelaySeconds}
          />
        </span>
      }
      action={
        <ScopeEditor
          initial={match.override?.delaySeconds ?? match.effectiveDelaySeconds}
          hasOverride={!!match.override}
          inheritedDelay={match.override ? null : match.effectiveDelaySeconds}
          inheritedFrom={match.override ? null : match.effectiveSource}
          putUrl={`/admin/riskzilla/live-delay/match/${match.id}`}
          deleteUrl={`/admin/riskzilla/live-delay/match/${match.id}`}
          onSuccess={onSuccess}
          onError={onError}
        />
      }
    />
  );
}

// ─── Per-scope editor (input + Save + Clear) ────────────────────────────

function ScopeEditor({
  initial,
  hasOverride,
  inheritedDelay,
  inheritedFrom,
  putUrl,
  deleteUrl,
  onSuccess,
  onError,
}: {
  initial: number;
  hasOverride: boolean;
  inheritedDelay: number | null;
  inheritedFrom: Source | null;
  putUrl: string;
  deleteUrl: string;
  onSuccess: () => void;
  onError: (msg: string) => void;
}) {
  const [draft, setDraft] = useState(String(initial));
  const [pending, startTransition] = useTransition();
  useEffect(() => {
    setDraft(String(initial));
  }, [initial]);
  const dirty = draft !== String(initial);

  const save = () => {
    const n = Number.parseInt(draft, 10);
    if (!Number.isFinite(n) || n < 0 || n > 300) {
      onError("Delay must be between 0 and 300 seconds.");
      return;
    }
    startTransition(async () => {
      try {
        await clientApi(putUrl, {
          method: "PUT",
          body: JSON.stringify({ delaySeconds: n }),
        });
        onSuccess();
      } catch (err) {
        onError(err instanceof ApiFetchError ? err.message : "save failed");
      }
    });
  };

  const clear = () => {
    startTransition(async () => {
      try {
        await clientApi(deleteUrl, { method: "DELETE" });
        onSuccess();
      } catch (err) {
        onError(err instanceof ApiFetchError ? err.message : "clear failed");
      }
    });
  };

  // Inherited row shows the source pill in muted text; explicit override
  // gets a Clear button so the operator can revert without recomputing
  // the inherited value by hand.
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <DelayInput
        draft={draft}
        setDraft={setDraft}
        onSave={save}
        dirty={dirty}
        pending={pending}
        showClear={hasOverride}
        onClear={clear}
        placeholder={
          inheritedDelay !== null ? `inherits ${inheritedDelay}s` : undefined
        }
        ariaLabel={
          inheritedFrom
            ? `delay (inherited from ${inheritedFrom})`
            : "delay"
        }
      />
    </div>
  );
}

// ─── Input control shared across rows ───────────────────────────────────

function DelayInput({
  draft,
  setDraft,
  onSave,
  dirty,
  pending,
  showClear,
  onClear,
  placeholder,
  ariaLabel,
}: {
  draft: string;
  setDraft: (v: string) => void;
  onSave: () => void;
  dirty: boolean;
  pending: boolean;
  showClear: boolean;
  onClear?: () => void;
  placeholder?: string;
  ariaLabel?: string;
}) {
  return (
    <>
      <input
        aria-label={ariaLabel ?? "delay seconds"}
        type="text"
        inputMode="numeric"
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onSave();
        }}
        style={{
          height: 28,
          width: 72,
          padding: "0 6px",
          textAlign: "right",
          background: "var(--color-bg)",
          border: "1px solid var(--color-border)",
          borderRadius: 4,
          color: "var(--color-fg)",
          fontFamily: "var(--font-mono, monospace)",
          fontVariantNumeric: "tabular-nums",
          fontSize: 13,
        }}
      />
      <span style={{ fontSize: 12, color: "var(--color-fg-muted)" }}>s</span>
      <button
        type="button"
        onClick={onSave}
        disabled={!dirty || pending}
        style={{
          height: 28,
          padding: "0 10px",
          borderRadius: 4,
          border: "1px solid var(--color-border)",
          background: dirty ? "var(--accent, #16a34a)" : "var(--color-bg-subtle)",
          color: dirty ? "#fff" : "var(--color-fg-muted)",
          fontSize: 12,
          cursor: dirty && !pending ? "pointer" : "default",
        }}
      >
        Save
      </button>
      {showClear && onClear && (
        <button
          type="button"
          onClick={onClear}
          disabled={pending}
          title="Clear override and inherit from parent scope"
          style={{
            height: 28,
            padding: "0 8px",
            borderRadius: 4,
            border: "1px solid var(--color-border)",
            background: "transparent",
            color: "var(--color-fg-muted)",
            fontSize: 12,
            cursor: pending ? "default" : "pointer",
          }}
        >
          Clear
        </button>
      )}
    </>
  );
}

// ─── Pills + chrome ─────────────────────────────────────────────────────

function SourcePill({
  override,
  source,
  effective,
}: {
  override: Override | null;
  source: Source;
  effective: number;
}) {
  // A row carries its own override → "Override" pill in accent. Without
  // its own override the row's effective value comes from a parent
  // scope; show "Inherited (from sport)".
  if (override) {
    return (
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <Pill tone="accent">Override</Pill>
        <Eff>{effective}s</Eff>
      </span>
    );
  }
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <Pill tone="muted">Inherits {source}</Pill>
      <Eff dim>{effective}s</Eff>
    </span>
  );
}

function StatusPill({ status }: { status: string }) {
  const isLive = status === "live";
  return (
    <Pill tone={isLive ? "live" : "muted"}>{isLive ? "Live" : "Upcoming"}</Pill>
  );
}

function Pill({
  tone,
  children,
}: {
  tone: "accent" | "muted" | "live";
  children: React.ReactNode;
}) {
  const palette = {
    accent: {
      bg: "color-mix(in oklab, var(--accent, #16a34a) 12%, transparent)",
      fg: "var(--accent, #16a34a)",
    },
    muted: {
      bg: "var(--color-bg-subtle)",
      fg: "var(--color-fg-muted)",
    },
    live: {
      bg: "color-mix(in oklab, #dc2626 12%, transparent)",
      fg: "#dc2626",
    },
  }[tone];
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "2px 6px",
        borderRadius: 999,
        background: palette.bg,
        color: palette.fg,
        fontSize: 10.5,
        fontWeight: 600,
        letterSpacing: "0.04em",
        textTransform: "uppercase",
      }}
    >
      {children}
    </span>
  );
}

function Eff({
  children,
  dim,
}: {
  children: React.ReactNode;
  dim?: boolean;
}) {
  return (
    <span
      className="mono"
      style={{
        fontSize: 12,
        fontVariantNumeric: "tabular-nums",
        color: dim ? "var(--color-fg-muted)" : "var(--color-fg)",
      }}
    >
      {children}
    </span>
  );
}

// ─── Row chrome ─────────────────────────────────────────────────────────

function Row({
  depth,
  expanded,
  onToggle,
  title,
  subtitle,
  action,
}: {
  depth: 0 | 1 | 2;
  expanded?: boolean;
  onToggle?: () => void;
  title: string;
  subtitle?: React.ReactNode;
  action?: React.ReactNode;
}) {
  const indent = 14 + depth * 18;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "10px 14px",
        paddingLeft: indent,
        background: depth === 0 ? "transparent" : "var(--color-bg)",
        borderTop: depth === 0 ? "none" : "1px solid var(--color-border)",
      }}
    >
      {onToggle ? (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-label={expanded ? "Collapse" : "Expand"}
          style={{
            width: 18,
            height: 18,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            background: "transparent",
            border: "1px solid var(--color-border)",
            borderRadius: 4,
            color: "var(--color-fg-muted)",
            cursor: "pointer",
            fontSize: 11,
            lineHeight: 1,
          }}
        >
          {expanded ? "−" : "+"}
        </button>
      ) : (
        <span style={{ width: 18 }} />
      )}
      <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0 }}>
        <span style={{ fontSize: 13, fontWeight: 500, color: "var(--color-fg)" }}>
          {title}
        </span>
        {subtitle && <span style={{ marginTop: 2 }}>{subtitle}</span>}
      </div>
      <div style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
        {action}
      </div>
    </div>
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
        marginBottom: 4,
      }}
    >
      {children}
    </div>
  );
}

function LoadingNote({
  children,
  indent = 1,
}: {
  children: React.ReactNode;
  indent?: number;
}) {
  return (
    <div
      style={{
        padding: "6px 14px",
        paddingLeft: 14 + indent * 18 + 24,
        fontSize: 12,
        color: "var(--color-fg-muted)",
      }}
    >
      {children}
    </div>
  );
}
