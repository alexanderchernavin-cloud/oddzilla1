"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { clientApi, ApiFetchError } from "@/lib/api-client";

// Stepper widget intentionally uses chunky -1%/-0.5%/+0.5%/+1% buttons
// instead of a free-form number input. Per the spec: "Можно даже не
// вводом цифры сделать, а переключателем кнопкой вверх и вниз". The
// draft is editable for the unusual case where the operator wants to
// jump to a specific value, but the default flow is click-the-button.

export interface Override {
  id: string;
  adjustmentBp: number;
  updatedAt: string;
  updatedBy: string | null;
}

type Source = "global" | "sport" | "tournament" | "match" | "none";

export interface SportRow {
  id: number;
  slug: string;
  name: string;
  override: Override | null;
  effectiveAdjustmentBp: number;
  effectiveSource: Source;
}

interface TournamentRow {
  id: number;
  slug: string;
  name: string;
  startAt: string | null;
  endAt: string | null;
  riskTier: number | null;
  override: Override | null;
  effectiveAdjustmentBp: number;
  effectiveSource: Source;
}

interface MatchRow {
  id: string;
  homeTeam: string;
  awayTeam: string;
  scheduledAt: string | null;
  status: string;
  override: Override | null;
  effectiveAdjustmentBp: number;
  effectiveSource: Source;
}

interface MatchesPayload {
  inheritedFromSport: number | null;
  inheritedFromTournament: number | null;
  entries: MatchRow[];
}

// ── Helpers ─────────────────────────────────────────────────────────────

const BP_MIN = -9000;
const BP_MAX = 9000;

// Display "+2.50%" / "-0.25%" / "0.00%" — sign matters so the operator
// always sees the direction of the bump.
function formatBpPct(bp: number): string {
  if (bp === 0) return "0.00%";
  const sign = bp > 0 ? "+" : "−";
  const abs = Math.abs(bp) / 100;
  return `${sign}${abs.toFixed(2)}%`;
}

function clampBp(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < BP_MIN) return BP_MIN;
  if (v > BP_MAX) return BP_MAX;
  return Math.round(v);
}

// ── Top-level tree ─────────────────────────────────────────────────────

export function BettorOddsAdjustmentTree({
  userId,
  global,
  sports,
}: {
  userId: string;
  global: Override | null;
  sports: SportRow[];
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

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

      <GlobalRow
        userId={userId}
        value={global}
        onError={onError}
        onSuccess={onSuccess}
      />

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
            <SportNode
              key={s.id}
              userId={userId}
              sport={s}
              onError={onError}
              onSuccess={onSuccess}
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

// ── Global row ─────────────────────────────────────────────────────────

function GlobalRow({
  userId,
  value,
  onError,
  onSuccess,
}: {
  userId: string;
  value: Override | null;
  onError: (msg: string) => void;
  onSuccess: () => void;
}) {
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
            Applied across every sport / tournament / match unless a more
            specific row overrides it.
          </div>
        </div>
        <ScopeEditor
          initial={value?.adjustmentBp ?? 0}
          hasOverride={!!value}
          inheritedBp={null}
          inheritedFrom={null}
          putUrl={`/admin/users/${userId}/odds-adjustment/global`}
          deleteUrl={`/admin/users/${userId}/odds-adjustment/global`}
          allowClear={true}
          onSuccess={onSuccess}
          onError={onError}
        />
      </div>
    </section>
  );
}

// ── Sport node ─────────────────────────────────────────────────────────

function SportNode({
  userId,
  sport,
  onError,
  onSuccess,
}: {
  userId: string;
  sport: SportRow;
  onError: (msg: string) => void;
  onSuccess: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [tournaments, setTournaments] = useState<TournamentRow[] | null>(null);
  const [loading, setLoading] = useState(false);

  const loadTournaments = useCallback(async () => {
    setLoading(true);
    try {
      const data = await clientApi<{ entries: TournamentRow[] }>(
        `/admin/users/${userId}/odds-adjustment/sports/${sport.id}/tournaments`,
      );
      setTournaments(data.entries);
    } catch (err) {
      onError(err instanceof ApiFetchError ? err.message : "load failed");
      setTournaments([]);
    } finally {
      setLoading(false);
    }
  }, [userId, sport.id, onError]);

  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    if (next) void loadTournaments();
  };

  return (
    <div style={{ borderBottom: "1px solid var(--color-border)" }}>
      <Row
        depth={0}
        expanded={expanded}
        onToggle={toggle}
        title={sport.name}
        subtitle={
          <SourcePill
            override={sport.override}
            source={sport.effectiveSource}
            effective={sport.effectiveAdjustmentBp}
          />
        }
        action={
          <ScopeEditor
            initial={sport.override?.adjustmentBp ?? sport.effectiveAdjustmentBp}
            hasOverride={!!sport.override}
            inheritedBp={
              sport.override ? null : sport.effectiveAdjustmentBp
            }
            inheritedFrom={sport.override ? null : sport.effectiveSource}
            putUrl={`/admin/users/${userId}/odds-adjustment/sport/${sport.id}`}
            deleteUrl={`/admin/users/${userId}/odds-adjustment/sport/${sport.id}`}
            allowClear={!!sport.override}
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
              userId={userId}
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

// ── Tournament node ────────────────────────────────────────────────────

function TournamentNode({
  userId,
  tournament,
  onError,
  onSuccess,
}: {
  userId: string;
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
        `/admin/users/${userId}/odds-adjustment/tournaments/${tournament.id}/matches`,
      );
      setMatches(data.entries);
    } catch (err) {
      onError(err instanceof ApiFetchError ? err.message : "load failed");
      setMatches([]);
    } finally {
      setLoading(false);
    }
  }, [userId, tournament.id, onError]);

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
            effective={tournament.effectiveAdjustmentBp}
          />
        }
        action={
          <ScopeEditor
            initial={
              tournament.override?.adjustmentBp ?? tournament.effectiveAdjustmentBp
            }
            hasOverride={!!tournament.override}
            inheritedBp={
              tournament.override ? null : tournament.effectiveAdjustmentBp
            }
            inheritedFrom={
              tournament.override ? null : tournament.effectiveSource
            }
            putUrl={`/admin/users/${userId}/odds-adjustment/tournament/${tournament.id}`}
            deleteUrl={`/admin/users/${userId}/odds-adjustment/tournament/${tournament.id}`}
            allowClear={!!tournament.override}
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
              userId={userId}
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

// ── Match node ─────────────────────────────────────────────────────────

function MatchNode({
  userId,
  match,
  onError,
  onSuccess,
}: {
  userId: string;
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
            effective={match.effectiveAdjustmentBp}
          />
        </span>
      }
      action={
        <ScopeEditor
          initial={match.override?.adjustmentBp ?? match.effectiveAdjustmentBp}
          hasOverride={!!match.override}
          inheritedBp={match.override ? null : match.effectiveAdjustmentBp}
          inheritedFrom={match.override ? null : match.effectiveSource}
          putUrl={`/admin/users/${userId}/odds-adjustment/match/${match.id}`}
          deleteUrl={`/admin/users/${userId}/odds-adjustment/match/${match.id}`}
          allowClear={!!match.override}
          onSuccess={onSuccess}
          onError={onError}
        />
      }
    />
  );
}

// ── Per-scope stepper + Save + Clear ───────────────────────────────────

function ScopeEditor({
  initial,
  hasOverride,
  inheritedBp,
  inheritedFrom,
  putUrl,
  deleteUrl,
  allowClear,
  onSuccess,
  onError,
}: {
  initial: number;
  hasOverride: boolean;
  inheritedBp: number | null;
  inheritedFrom: Source | null;
  putUrl: string;
  deleteUrl: string;
  allowClear: boolean;
  onSuccess: () => void;
  onError: (msg: string) => void;
}) {
  const [draft, setDraft] = useState<number>(initial);
  const [pending, startTransition] = useTransition();
  useEffect(() => {
    setDraft(initial);
  }, [initial]);
  const dirty = draft !== initial;

  const bump = (delta: number) => {
    setDraft((d) => clampBp(d + delta));
  };

  const save = () => {
    const n = clampBp(draft);
    if (n < BP_MIN || n > BP_MAX) {
      onError("Adjustment must be within ±90.00%.");
      return;
    }
    startTransition(async () => {
      try {
        await clientApi(putUrl, {
          method: "PUT",
          body: JSON.stringify({ adjustmentBp: n }),
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

  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        flexWrap: "wrap",
        justifyContent: "flex-end",
      }}
    >
      <StepperButton onClick={() => bump(-100)} disabled={pending} title="-1.00%">
        −1%
      </StepperButton>
      <StepperButton onClick={() => bump(-50)} disabled={pending} title="-0.50%">
        −0.5%
      </StepperButton>
      <DraftReadout
        bp={draft}
        placeholder={
          inheritedBp !== null && inheritedFrom
            ? `inherits ${formatBpPct(inheritedBp)}`
            : null
        }
      />
      <StepperButton onClick={() => bump(50)} disabled={pending} title="+0.50%">
        +0.5%
      </StepperButton>
      <StepperButton onClick={() => bump(100)} disabled={pending} title="+1.00%">
        +1%
      </StepperButton>
      <button
        type="button"
        onClick={save}
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
      {allowClear && (
        <button
          type="button"
          onClick={clear}
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
    </div>
  );
}

function StepperButton({
  onClick,
  disabled,
  title,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        height: 28,
        minWidth: 44,
        padding: "0 6px",
        border: "1px solid var(--color-border)",
        borderRadius: 4,
        background: "var(--color-bg)",
        color: "var(--color-fg)",
        fontSize: 11.5,
        cursor: disabled ? "default" : "pointer",
        fontVariantNumeric: "tabular-nums",
        fontFamily: "var(--font-mono, monospace)",
      }}
    >
      {children}
    </button>
  );
}

function DraftReadout({
  bp,
  placeholder,
}: {
  bp: number;
  placeholder: string | null;
}) {
  // Show the draft value; non-dirty draft equal to inherited still
  // shows the actual number rather than the placeholder so the
  // operator always knows what would be saved if they hit Save.
  return (
    <div
      style={{
        height: 28,
        minWidth: 84,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--color-bg-subtle)",
        border: "1px solid var(--color-border)",
        borderRadius: 4,
        fontFamily: "var(--font-mono, monospace)",
        fontVariantNumeric: "tabular-nums",
        fontSize: 13,
        color: bp === 0 ? "var(--color-fg-muted)" : "var(--color-fg)",
        padding: "0 8px",
      }}
      title={placeholder ?? undefined}
    >
      {formatBpPct(bp)}
    </div>
  );
}

// ── Pills + chrome ─────────────────────────────────────────────────────

function SourcePill({
  override,
  source,
  effective,
}: {
  override: Override | null;
  source: Source;
  effective: number;
}) {
  if (override) {
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
        <Pill tone="accent">Override</Pill>
        <Eff bp={effective} />
      </span>
    );
  }
  if (source === "none") {
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
        <Pill tone="muted">No rule</Pill>
        <Eff bp={effective} dim />
      </span>
    );
  }
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <Pill tone="muted">Inherits {source}</Pill>
      <Eff bp={effective} dim />
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
    muted: { bg: "var(--color-bg-subtle)", fg: "var(--color-fg-muted)" },
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

function Eff({ bp, dim }: { bp: number; dim?: boolean }) {
  return (
    <span
      className="mono"
      style={{
        fontSize: 12,
        fontVariantNumeric: "tabular-nums",
        color: dim ? "var(--color-fg-muted)" : "var(--color-fg)",
      }}
    >
      {formatBpPct(bp)}
    </span>
  );
}

// ── Row chrome ─────────────────────────────────────────────────────────

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
