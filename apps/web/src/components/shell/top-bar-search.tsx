"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { I } from "@/components/ui/icons";
import { SportGlyph } from "@/components/ui/sport-glyph";
import { Pill, LiveDot, TeamMark } from "@/components/ui/primitives";
import { TierMark } from "@/components/ui/tier-mark";
import { clientApi, ApiFetchError } from "@/lib/api-client";

interface SportHit {
  slug: string;
  name: string;
  kind: string;
}
interface TournamentHit {
  id: number;
  name: string;
  riskTier?: number | null;
  sport: { slug: string; name: string };
}
interface TeamHit {
  id: number;
  name: string;
  abbreviation: string | null;
  sport: { slug: string; name: string };
}
interface MatchHit {
  id: string;
  homeTeam: string;
  awayTeam: string;
  scheduledAt: string | null;
  status: "not_started" | "live" | "closed" | "cancelled" | "suspended";
  tournament: { id: number; name: string; riskTier?: number | null };
  sport: { slug: string; name: string };
}
interface SearchResponse {
  query: string;
  sports: SportHit[];
  tournaments: TournamentHit[];
  teams: TeamHit[];
  matches: MatchHit[];
}

type NavItem =
  | { kind: "sport"; href: string; sport: SportHit }
  | { kind: "tournament"; href: string; tournament: TournamentHit }
  | { kind: "team"; href: string; team: TeamHit }
  | { kind: "match"; href: string; match: MatchHit };

const DEBOUNCE_MS = 180;

export function TopBarSearch() {
  const router = useRouter();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResponse | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  // Debounced fetch. Each keystroke starts a fresh timer; an in-flight
  // request is abandoned via AbortController so a slow response can't
  // overwrite a fresher one.
  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      setResults(null);
      setLoading(false);
      setError(null);
      return;
    }
    const ctrl = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await clientApi<SearchResponse>(
          `/catalog/search?q=${encodeURIComponent(trimmed)}`,
          { signal: ctrl.signal },
        );
        setResults(data);
        setActiveIndex(0);
      } catch (e) {
        if (ctrl.signal.aborted) return;
        if (e instanceof ApiFetchError) {
          setError(e.body.message || "Search failed");
        } else {
          setError("Search unavailable");
        }
        setResults(null);
      } finally {
        if (!ctrl.signal.aborted) setLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      ctrl.abort();
    };
  }, [query]);

  // Close on click-outside.
  useEffect(() => {
    if (!open) return;
    function onDocMouseDown(e: MouseEvent) {
      if (!wrapperRef.current) return;
      if (wrapperRef.current.contains(e.target as Node)) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [open]);

  // Cmd/Ctrl+K focuses the input.
  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
        setOpen(true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const navItems = buildNavItems(results);

  const go = useCallback(
    (href: string) => {
      setOpen(false);
      setQuery("");
      router.push(href);
    },
    [router],
  );

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      setOpen(false);
      inputRef.current?.blur();
      return;
    }
    if (!open) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, Math.max(navItems.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      const item = navItems[activeIndex];
      if (item) {
        e.preventDefault();
        go(item.href);
      }
    }
  }

  const showDropdown = open && query.trim().length > 0;
  const empty =
    results != null &&
    results.sports.length === 0 &&
    results.tournaments.length === 0 &&
    results.teams.length === 0 &&
    results.matches.length === 0;

  return (
    <div
      ref={wrapperRef}
      className="oz-topbar-search"
      style={{
        flex: 1,
        maxWidth: 460,
        marginLeft: 16,
        minWidth: 0,
        position: "relative",
      }}
    >
      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          height: 36,
          padding: "0 14px",
          background: "var(--surface-2)",
          border: "1px solid var(--border)",
          borderRadius: 999,
          color: "var(--fg-muted)",
        }}
      >
        <I.Search size={15} />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder="Search teams, tournaments, matches…"
          style={{
            flex: 1,
            minWidth: 0,
            border: 0,
            background: "transparent",
            outline: "none",
            fontFamily: "inherit",
            fontSize: 13,
            color: "var(--fg)",
          }}
          autoComplete="off"
          spellCheck={false}
        />
        {query.length > 0 ? (
          <button
            type="button"
            onClick={() => {
              setQuery("");
              inputRef.current?.focus();
            }}
            aria-label="Clear search"
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 18,
              height: 18,
              border: 0,
              background: "transparent",
              color: "var(--fg-muted)",
              cursor: "pointer",
              padding: 0,
              borderRadius: 999,
            }}
          >
            <I.Close size={13} />
          </button>
        ) : (
          <span
            className="mono oz-topbar-kbd"
            style={{
              fontSize: 10.5,
              padding: "2px 6px",
              border: "1px solid var(--border)",
              borderRadius: 4,
              color: "var(--fg-dim)",
            }}
          >
            ⌘K
          </span>
        )}
      </label>

      {showDropdown && (
        <div
          role="listbox"
          style={{
            position: "absolute",
            top: "calc(100% + 8px)",
            left: 0,
            right: 0,
            maxHeight: "min(520px, 70vh)",
            overflow: "auto",
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 14,
            boxShadow: "var(--shadow-md, 0 12px 32px rgba(0,0,0,0.18))",
            zIndex: 60,
          }}
        >
          {error && (
            <div
              style={{
                padding: "14px 16px",
                fontSize: 12.5,
                color: "var(--negative)",
              }}
            >
              {error}
            </div>
          )}
          {!error && results == null && loading && (
            <div
              style={{
                padding: "14px 16px",
                fontSize: 12.5,
                color: "var(--fg-muted)",
              }}
            >
              Searching…
            </div>
          )}
          {!error && empty && !loading && (
            <div
              style={{
                padding: "14px 16px",
                fontSize: 12.5,
                color: "var(--fg-muted)",
              }}
            >
              No matches for &ldquo;{query.trim()}&rdquo;.
            </div>
          )}
          {!error && results && !empty && (
            <ResultGroups
              results={results}
              activeIndex={activeIndex}
              onHoverIndex={setActiveIndex}
              onPick={go}
            />
          )}
        </div>
      )}
    </div>
  );
}

function buildNavItems(r: SearchResponse | null): NavItem[] {
  if (!r) return [];
  const out: NavItem[] = [];
  for (const s of r.sports) {
    out.push({ kind: "sport", href: `/sport/${s.slug}`, sport: s });
  }
  for (const t of r.tournaments) {
    out.push({
      kind: "tournament",
      href: `/sport/${t.sport.slug}?tournament=${t.id}`,
      tournament: t,
    });
  }
  for (const team of r.teams) {
    out.push({
      kind: "team",
      href: `/sport/${team.sport.slug}`,
      team,
    });
  }
  for (const m of r.matches) {
    out.push({ kind: "match", href: `/match/${m.id}`, match: m });
  }
  return out;
}

function ResultGroups({
  results,
  activeIndex,
  onHoverIndex,
  onPick,
}: {
  results: SearchResponse;
  activeIndex: number;
  onHoverIndex: (i: number) => void;
  onPick: (href: string) => void;
}) {
  // Track a running index across groups so keyboard highlight aligns
  // with the flat nav list built by buildNavItems.
  let idx = 0;
  const sections: ReactNode[] = [];

  if (results.sports.length > 0) {
    sections.push(
      <SectionLabel key="sports">Sports</SectionLabel>,
    );
    for (const s of results.sports) {
      const i = idx++;
      sections.push(
        <Row
          key={`s-${s.slug}`}
          active={i === activeIndex}
          href={`/sport/${s.slug}`}
          onHover={() => onHoverIndex(i)}
          onPick={onPick}
          left={<SportGlyph sport={s.slug} size={16} />}
          primary={s.name}
          secondary={s.kind === "esport" ? "Esport" : "Sport"}
        />,
      );
    }
  }

  if (results.tournaments.length > 0) {
    sections.push(
      <SectionLabel key="tournaments">Tournaments</SectionLabel>,
    );
    for (const t of results.tournaments) {
      const i = idx++;
      sections.push(
        <Row
          key={`t-${t.id}`}
          active={i === activeIndex}
          href={`/sport/${t.sport.slug}?tournament=${t.id}`}
          onHover={() => onHoverIndex(i)}
          onPick={onPick}
          left={<SportGlyph sport={t.sport.slug} size={16} />}
          primary={
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <TierMark tier={t.riskTier ?? null} size={11} />
              {t.name}
            </span>
          }
          secondary={t.sport.name}
        />,
      );
    }
  }

  if (results.teams.length > 0) {
    sections.push(<SectionLabel key="teams">Teams</SectionLabel>);
    for (const team of results.teams) {
      const i = idx++;
      const tag = (team.abbreviation ?? team.name.slice(0, 3)).toUpperCase();
      sections.push(
        <Row
          key={`c-${team.id}`}
          active={i === activeIndex}
          href={`/sport/${team.sport.slug}`}
          onHover={() => onHoverIndex(i)}
          onPick={onPick}
          left={<TeamMark tag={tag} size={22} />}
          primary={team.name}
          secondary={team.sport.name}
        />,
      );
    }
  }

  if (results.matches.length > 0) {
    sections.push(<SectionLabel key="matches">Matches</SectionLabel>);
    for (const m of results.matches) {
      const i = idx++;
      const isLive = m.status === "live";
      const when =
        !isLive && m.scheduledAt
          ? new Date(m.scheduledAt).toLocaleString("en-GB", {
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })
          : null;
      sections.push(
        <Row
          key={`m-${m.id}`}
          active={i === activeIndex}
          href={`/match/${m.id}`}
          onHover={() => onHoverIndex(i)}
          onPick={onPick}
          left={<SportGlyph sport={m.sport.slug} size={16} />}
          primary={`${m.homeTeam} vs ${m.awayTeam}`}
          secondary={
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <TierMark tier={m.tournament.riskTier ?? null} size={10} />
              {`${m.sport.name} · ${m.tournament.name}`}
            </span>
          }
          right={
            isLive ? (
              <Pill tone="live">
                <LiveDot size={6} /> LIVE
              </Pill>
            ) : when ? (
              <span
                className="mono"
                style={{ fontSize: 11, color: "var(--fg-muted)" }}
              >
                {when}
              </span>
            ) : null
          }
        />,
      );
    }
  }

  return <div style={{ padding: "6px 0" }}>{sections}</div>;
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div
      className="mono"
      style={{
        padding: "10px 16px 4px",
        fontSize: 10,
        letterSpacing: "0.14em",
        textTransform: "uppercase",
        color: "var(--fg-dim)",
        fontWeight: 600,
      }}
    >
      {children}
    </div>
  );
}

function Row({
  active,
  href,
  onHover,
  onPick,
  left,
  primary,
  secondary,
  right,
}: {
  active: boolean;
  href: string;
  onHover: () => void;
  onPick: (href: string) => void;
  left: ReactNode;
  primary: ReactNode;
  secondary?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <Link
      href={href}
      onMouseEnter={onHover}
      onClick={(e) => {
        e.preventDefault();
        onPick(href);
      }}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "8px 16px",
        textDecoration: "none",
        color: "var(--fg)",
        background: active ? "var(--surface-2)" : "transparent",
        cursor: "pointer",
      }}
    >
      <span style={{ color: "var(--fg-muted)", display: "inline-flex" }}>
        {left}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 13,
            fontWeight: 500,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {primary}
        </div>
        {secondary && (
          <div
            style={{
              fontSize: 11.5,
              color: "var(--fg-muted)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {secondary}
          </div>
        )}
      </div>
      {right}
    </Link>
  );
}
