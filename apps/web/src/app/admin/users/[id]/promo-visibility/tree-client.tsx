"use client";

import { useCallback, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { clientApi, ApiFetchError } from "@/lib/api-client";

// Sport → Tournament → Match tree with three toggle columns per row
// (ZillaFlash / CombiBoost / ZillaBuild). Each row's effective visibility
// cascades match > tournament > sport > global, with the server doing the
// resolution and shipping `effectiveVisible` + `effectiveSource` per
// row so the UI can render "Inherits sport" hints without re-computing
// client-side.

export interface Override {
  id: string;
  visible: boolean;
  updatedAt: string;
  updatedBy: string | null;
}

type Source = "global" | "sport" | "tournament" | "match" | "none";
type PromoKind = "zillaflash" | "combi_boost" | "zillabuild";

// Render order + display labels for the per-row toggle columns. The key
// is the path segment the admin routes consume.
const KINDS: ReadonlyArray<{ key: PromoKind; label: string }> = [
  { key: "zillaflash", label: "ZillaFlash" },
  { key: "combi_boost", label: "CombiBoost" },
  { key: "zillabuild", label: "ZillaBuild" },
];

interface PerKindRow {
  override: Override | null;
  effectiveVisible: boolean;
  effectiveSource: Source;
}

// Every scope row carries one PerKindRow per promo kind.
type KindRows = Record<PromoKind, PerKindRow>;

export interface SportRow extends KindRows {
  id: number;
  slug: string;
  name: string;
}

interface TournamentRow extends KindRows {
  id: number;
  slug: string;
  name: string;
  startAt: string | null;
  endAt: string | null;
  riskTier: number | null;
}

interface MatchRow extends KindRows {
  id: string;
  homeTeam: string;
  awayTeam: string;
  scheduledAt: string | null;
  status: string;
}

// ─── Top-level tree ─────────────────────────────────────────────────────

export function PromoVisibilityTree({
  userId,
  globalZillaflash,
  globalCombiBoost,
  globalZillabuild,
  sports,
}: {
  userId: string;
  globalZillaflash: Override | null;
  globalCombiBoost: Override | null;
  globalZillabuild: Override | null;
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
        globals={{
          zillaflash: globalZillaflash,
          combi_boost: globalCombiBoost,
          zillabuild: globalZillabuild,
        }}
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
            <div style={{ padding: "16px 14px", fontSize: 13, color: "var(--color-fg-muted)" }}>
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
  userId,
  globals,
  onError,
  onSuccess,
}: {
  userId: string;
  globals: Record<PromoKind, Override | null>;
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
          flexWrap: "wrap",
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
            Global defaults
          </div>
          <div style={{ fontSize: 13, color: "var(--color-fg-muted)" }}>
            Applied across every sport / tournament / match unless a more
            specific row overrides.
          </div>
        </div>
        <div style={{ display: "inline-flex", gap: 16, flexWrap: "wrap" }}>
          {KINDS.map(({ key, label }) => (
            <KindEditor
              key={key}
              label={label}
              override={globals[key]}
              inheritedVisible={null}
              inheritedSource={null}
              putUrl={`/admin/users/${userId}/promo-visibility/${key}/global`}
              deleteUrl={`/admin/users/${userId}/promo-visibility/${key}/global`}
              onError={onError}
              onSuccess={onSuccess}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

// ─── Sport node ─────────────────────────────────────────────────────────

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
        `/admin/users/${userId}/promo-visibility/sports/${sport.id}/tournaments`,
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
        action={
          <KindsEditor
            userId={userId}
            scopePath={`sport/${sport.id}`}
            row={sport}
            onError={onError}
            onSuccess={onSuccess}
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

// ─── Tournament node ────────────────────────────────────────────────────

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
      const data = await clientApi<{ entries: MatchRow[] }>(
        `/admin/users/${userId}/promo-visibility/tournaments/${tournament.id}/matches`,
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
        action={
          <KindsEditor
            userId={userId}
            scopePath={`tournament/${tournament.id}`}
            row={tournament}
            onError={onError}
            onSuccess={onSuccess}
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

// ─── Match node ─────────────────────────────────────────────────────────

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
        </span>
      }
      action={
        <KindsEditor
          userId={userId}
          scopePath={`match/${match.id}`}
          row={match}
          onError={onError}
          onSuccess={onSuccess}
        />
      }
    />
  );
}

// ─── Per-kind editor (one promo kind, no parent context) ───────────────

function KindEditor({
  label,
  override,
  inheritedVisible,
  inheritedSource,
  putUrl,
  deleteUrl,
  onError,
  onSuccess,
}: {
  label: string;
  override: Override | null;
  inheritedVisible: boolean | null;
  inheritedSource: Source | null;
  putUrl: string;
  deleteUrl: string;
  onError: (msg: string) => void;
  onSuccess: () => void;
}) {
  const [pending, startTransition] = useTransition();

  const setVisible = (next: boolean) => {
    startTransition(async () => {
      try {
        await clientApi(putUrl, {
          method: "PUT",
          body: JSON.stringify({ visible: next }),
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

  const effectiveVisible =
    override !== null ? override.visible : (inheritedVisible ?? true);

  return (
    <div style={{ display: "inline-flex", flexDirection: "column", gap: 4, minWidth: 130 }}>
      <span
        className="mono"
        style={{
          fontSize: 10,
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          color: "var(--color-fg-muted)",
        }}
      >
        {label}
      </span>
      <div style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
        <ToggleSegment
          active={effectiveVisible === true}
          dimmed={override === null}
          onClick={() => setVisible(true)}
          disabled={pending}
        >
          On
        </ToggleSegment>
        <ToggleSegment
          active={effectiveVisible === false}
          dimmed={override === null}
          onClick={() => setVisible(false)}
          disabled={pending}
        >
          Off
        </ToggleSegment>
        {override !== null && (
          <button
            type="button"
            onClick={clear}
            disabled={pending}
            title="Clear override and inherit from parent scope"
            style={{
              height: 26,
              padding: "0 6px",
              borderRadius: 4,
              border: "1px solid var(--color-border)",
              background: "transparent",
              color: "var(--color-fg-muted)",
              fontSize: 11,
              cursor: pending ? "default" : "pointer",
            }}
          >
            Clear
          </button>
        )}
      </div>
      {override === null && inheritedSource !== null && inheritedSource !== "none" && (
        <span style={{ fontSize: 10.5, color: "var(--color-fg-muted)" }}>
          inherits {inheritedSource}
        </span>
      )}
      {override === null && inheritedSource === "none" && (
        <span style={{ fontSize: 10.5, color: "var(--color-fg-muted)" }}>
          default on
        </span>
      )}
    </div>
  );
}

// All promo-kind editors side-by-side for one scope row (sport /
// tournament / match). URLs are derived from (userId, kind, scopePath)
// so adding a kind is a one-line change to KINDS.
function KindsEditor({
  userId,
  scopePath,
  row,
  onError,
  onSuccess,
}: {
  userId: string;
  scopePath: string;
  row: KindRows;
  onError: (msg: string) => void;
  onSuccess: () => void;
}) {
  return (
    <div style={{ display: "inline-flex", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
      {KINDS.map(({ key, label }) => {
        const r = row[key];
        const url = `/admin/users/${userId}/promo-visibility/${key}/${scopePath}`;
        return (
          <KindEditor
            key={key}
            label={label}
            override={r.override}
            inheritedVisible={r.override ? null : r.effectiveVisible}
            inheritedSource={r.override ? null : r.effectiveSource}
            putUrl={url}
            deleteUrl={url}
            onError={onError}
            onSuccess={onSuccess}
          />
        );
      })}
    </div>
  );
}

// ─── Toggle segment button ──────────────────────────────────────────────

function ToggleSegment({
  active,
  dimmed,
  onClick,
  disabled,
  children,
}: {
  active: boolean;
  dimmed: boolean;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  const accent = "var(--accent, #16a34a)";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        height: 26,
        minWidth: 38,
        padding: "0 8px",
        border: `1px solid ${active ? accent : "var(--color-border)"}`,
        borderRadius: 4,
        background: active
          ? dimmed
            ? "color-mix(in oklab, var(--accent, #16a34a) 12%, transparent)"
            : accent
          : "var(--color-bg)",
        color: active ? (dimmed ? accent : "#fff") : "var(--color-fg)",
        fontSize: 11.5,
        fontWeight: 600,
        cursor: disabled ? "default" : "pointer",
      }}
    >
      {children}
    </button>
  );
}

// ─── Pills + chrome ─────────────────────────────────────────────────────

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

// Silence unused-type warnings — PromoKind is the path-segment value the
// admin routes consume; declared here for completeness.
export type { PromoKind };
