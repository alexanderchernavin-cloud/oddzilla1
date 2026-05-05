"use client";

// Debounced search popover for the /admin/logs panel. Hits
// /admin/logs/search and surfaces matched sports / tournaments / matches.
// Same matchInWindow filter as the rest of the panel (only matches with
// at least one feed_messages row), so results are always navigable.

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { clientApi, ApiFetchError } from "@/lib/api-client";

interface SportHit {
  id: number;
  slug: string;
  name: string;
}
interface TournamentHit {
  id: number;
  name: string;
  sportSlug: string;
  sportName: string;
}
interface MatchHit {
  id: string;
  homeTeam: string;
  awayTeam: string;
  scheduledAt: string | null;
  status: string;
  tournament: { id: number; name: string };
  sportSlug: string;
}
interface SearchResponse {
  query: string;
  sports: SportHit[];
  tournaments: TournamentHit[];
  matches: MatchHit[];
}

type Hit =
  | { kind: "sport"; data: SportHit }
  | { kind: "tournament"; data: TournamentHit }
  | { kind: "match"; data: MatchHit };

export function LogsSearch() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const reqIdRef = useRef(0);

  // Cmd/Ctrl+K focuses the input.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Click-outside closes the popover.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, []);

  // Debounced fetch.
  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      setResults(null);
      setError(null);
      setLoading(false);
      return;
    }
    const myReq = ++reqIdRef.current;
    setLoading(true);
    setError(null);
    const handle = setTimeout(async () => {
      try {
        const data = await clientApi<SearchResponse>(
          `/admin/logs/search?q=${encodeURIComponent(trimmed)}`,
        );
        if (myReq !== reqIdRef.current) return;
        setResults(data);
        setActiveIdx(0);
      } catch (err) {
        if (myReq !== reqIdRef.current) return;
        setError(
          err instanceof ApiFetchError ? err.body.message : "Search failed",
        );
        setResults(null);
      } finally {
        if (myReq === reqIdRef.current) setLoading(false);
      }
    }, 180);
    return () => clearTimeout(handle);
  }, [query]);

  const allHits: Hit[] = results
    ? [
        ...results.sports.map<Hit>((s) => ({ kind: "sport", data: s })),
        ...results.tournaments.map<Hit>((t) => ({ kind: "tournament", data: t })),
        ...results.matches.map<Hit>((m) => ({ kind: "match", data: m })),
      ]
    : [];

  const hrefForHit = useCallback((h: Hit): string => {
    if (h.kind === "sport") return `/admin/logs/sports/${h.data.slug}`;
    if (h.kind === "tournament") return `/admin/logs/tournaments/${h.data.id}`;
    return `/admin/logs/matches/${h.data.id}`;
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      setOpen(false);
      inputRef.current?.blur();
      return;
    }
    if (allHits.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => (i + 1) % allHits.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => (i - 1 + allHits.length) % allHits.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hit = allHits[activeIdx];
      if (hit) {
        router.push(hrefForHit(hit));
        setOpen(false);
      }
    }
  };

  return (
    <div ref={containerRef} className="relative w-full max-w-md">
      <input
        ref={inputRef}
        type="search"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        placeholder="Search sports, tournaments, teams… (Ctrl+K)"
        className="w-full rounded-[10px] border border-[var(--color-border-strong)] bg-[var(--color-bg-card)] px-3 py-2 text-sm placeholder:text-[var(--color-fg-subtle)] focus:border-[var(--color-accent)] focus:outline-none"
      />
      {open && query.trim().length > 0 ? (
        <div className="absolute left-0 right-0 top-full z-30 mt-1 max-h-[60vh] overflow-y-auto rounded-[12px] border border-[var(--color-border-strong)] bg-[var(--color-bg-card)] shadow-xl">
          {loading ? (
            <p className="px-3 py-2 text-xs text-[var(--color-fg-subtle)]">
              Searching…
            </p>
          ) : error ? (
            <p className="px-3 py-2 text-xs text-[var(--color-negative)]">
              {error}
            </p>
          ) : !results || allHits.length === 0 ? (
            <p className="px-3 py-2 text-xs text-[var(--color-fg-subtle)]">
              No matches.
            </p>
          ) : (
            <div className="py-1">
              {results.sports.length > 0 ? (
                <Section label="Sports">
                  {results.sports.map((s, i) => (
                    <Row
                      key={`sport-${s.id}`}
                      href={`/admin/logs/sports/${s.slug}`}
                      active={
                        allHits[activeIdx]?.kind === "sport" &&
                        (allHits[activeIdx]?.data as SportHit).id === s.id
                      }
                      onSelect={() => setOpen(false)}
                      onMouseEnter={() => setActiveIdx(i)}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <span className="font-medium">{s.name}</span>
                        <span className="font-mono text-[10px] text-[var(--color-fg-subtle)]">
                          {s.slug}
                        </span>
                      </div>
                    </Row>
                  ))}
                </Section>
              ) : null}

              {results.tournaments.length > 0 ? (
                <Section label="Tournaments">
                  {results.tournaments.map((t, i) => {
                    const idxOff = results.sports.length;
                    const idx = idxOff + i;
                    return (
                      <Row
                        key={`tournament-${t.id}`}
                        href={`/admin/logs/tournaments/${t.id}`}
                        active={activeIdx === idx}
                        onSelect={() => setOpen(false)}
                        onMouseEnter={() => setActiveIdx(idx)}
                      >
                        <div>
                          <p className="font-medium">{t.name}</p>
                          <p className="text-[10px] text-[var(--color-fg-subtle)]">
                            {t.sportName}
                          </p>
                        </div>
                      </Row>
                    );
                  })}
                </Section>
              ) : null}

              {results.matches.length > 0 ? (
                <Section label="Matches">
                  {results.matches.map((m, i) => {
                    const idxOff =
                      results.sports.length + results.tournaments.length;
                    const idx = idxOff + i;
                    return (
                      <Row
                        key={`match-${m.id}`}
                        href={`/admin/logs/matches/${m.id}`}
                        active={activeIdx === idx}
                        onSelect={() => setOpen(false)}
                        onMouseEnter={() => setActiveIdx(idx)}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0 flex-1 truncate">
                            <p className="truncate text-sm">
                              {m.homeTeam}
                              <span className="mx-1 text-[var(--color-fg-subtle)]">
                                vs
                              </span>
                              {m.awayTeam}
                            </p>
                            <p className="truncate text-[10px] text-[var(--color-fg-subtle)]">
                              {m.tournament.name}
                              {m.scheduledAt ? (
                                <>
                                  {" · "}
                                  {new Date(m.scheduledAt).toLocaleString()}
                                </>
                              ) : null}
                            </p>
                          </div>
                          <span className="rounded-[6px] border border-[var(--color-border-strong)] px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--color-fg-muted)]">
                            {m.status}
                          </span>
                        </div>
                      </Row>
                    );
                  })}
                </Section>
              ) : null}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

function Section({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="border-t border-[var(--color-border)] first:border-t-0">
      <p className="px-3 pb-1 pt-2 text-[10px] uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
        {label}
      </p>
      <ul>{children}</ul>
    </div>
  );
}

function Row({
  href,
  active,
  onSelect,
  onMouseEnter,
  children,
}: {
  href: string;
  active: boolean;
  onSelect: () => void;
  onMouseEnter: () => void;
  children: React.ReactNode;
}) {
  return (
    <li>
      <Link
        href={href}
        onClick={onSelect}
        onMouseEnter={onMouseEnter}
        className={
          "block px-3 py-2 text-xs " +
          (active
            ? "bg-[var(--color-bg)] text-[var(--color-fg)]"
            : "text-[var(--color-fg-muted)] hover:bg-[var(--color-bg)]")
        }
      >
        {children}
      </Link>
    </li>
  );
}
