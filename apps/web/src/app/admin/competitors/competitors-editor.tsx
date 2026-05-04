"use client";

import { useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { clientApi, ApiFetchError } from "@/lib/api-client";

export interface CompetitorRow {
  id: number;
  sportId: number;
  sportSlug: string;
  sportName: string;
  slug: string;
  name: string;
  abbreviation: string | null;
  logoUrl: string | null;
  brandColor: string | null;
  active: boolean;
  providerUrn: string | null;
}

export interface SportOption {
  id: number;
  slug: string;
  name: string;
  teamCount: number;
  missingLogoCount: number;
}

interface ListShape {
  total: number;
  limit: number;
  offset: number;
  competitors: CompetitorRow[];
}

interface Filters {
  sportId: string;
  q: string;
  missingLogo: boolean;
  offset: number;
  limit: number;
}

export function CompetitorsEditor({
  initialList,
  sports,
  currentFilters,
}: {
  initialList: ListShape;
  sports: SportOption[];
  currentFilters: Filters;
}) {
  return (
    <div className="space-y-6">
      <FilterBar sports={sports} current={currentFilters} total={initialList.total} />
      <CompetitorTable list={initialList} />
      <Pager list={initialList} current={currentFilters} />
    </div>
  );
}

function FilterBar({
  sports,
  current,
  total,
}: {
  sports: SportOption[];
  current: Filters;
  total: number;
}) {
  const router = useRouter();
  const [q, setQ] = useState(current.q);
  const [sportId, setSportId] = useState(current.sportId);
  const [missingOnly, setMissingOnly] = useState(current.missingLogo);

  function applyFilters(e?: FormEvent) {
    e?.preventDefault();
    const params = new URLSearchParams();
    if (sportId) params.set("sportId", sportId);
    if (q.trim()) params.set("q", q.trim());
    if (missingOnly) params.set("missingLogo", "1");
    // reset offset on filter change
    router.push(`/admin/competitors${params.toString() ? `?${params.toString()}` : ""}`);
  }

  function clearFilters() {
    setQ("");
    setSportId("");
    setMissingOnly(false);
    router.push("/admin/competitors");
  }

  const totalMissing = sports.reduce((acc, s) => acc + s.missingLogoCount, 0);
  const totalTeams = sports.reduce((acc, s) => acc + s.teamCount, 0);

  return (
    <form
      onSubmit={applyFilters}
      className="card flex flex-wrap items-end gap-3 p-4"
    >
      <label className="block">
        <span className="block text-xs text-[var(--color-fg-subtle)]">Sport</span>
        <select
          value={sportId}
          onChange={(e) => setSportId(e.target.value)}
          className="mt-1 min-w-[180px] rounded-[10px] border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-2 outline-none focus:border-[var(--color-accent)]"
        >
          <option value="">All sports ({totalTeams} teams)</option>
          {sports.map((s) => (
            <option key={s.id} value={String(s.id)}>
              {s.name} — {s.teamCount} teams · {s.missingLogoCount} missing
            </option>
          ))}
        </select>
      </label>

      <label className="block flex-1 min-w-[220px]">
        <span className="block text-xs text-[var(--color-fg-subtle)]">Search</span>
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Team name, slug, or abbreviation"
          className="mt-1 w-full rounded-[10px] border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-2 outline-none focus:border-[var(--color-accent)]"
        />
      </label>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={missingOnly}
          onChange={(e) => setMissingOnly(e.target.checked)}
        />
        Missing logo only ({totalMissing})
      </label>

      <button type="submit" className="btn btn-primary">
        Apply
      </button>
      {(current.q || current.sportId || current.missingLogo) && (
        <button
          type="button"
          onClick={clearFilters}
          className="text-xs uppercase tracking-[0.15em] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
        >
          Clear
        </button>
      )}

      <span className="ml-auto text-xs text-[var(--color-fg-muted)]">
        {total} match{total === 1 ? "" : "es"}
      </span>
    </form>
  );
}

function CompetitorTable({ list }: { list: ListShape }) {
  if (list.competitors.length === 0) {
    return (
      <p className="text-sm text-[var(--color-fg-muted)]">
        No teams match the current filters.
      </p>
    );
  }
  return (
    <div className="card overflow-hidden">
      <table className="w-full text-sm">
        <thead className="border-b border-[var(--color-border)] text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
          <tr>
            <th className="px-4 py-3 text-left">Logo</th>
            <th className="px-4 py-3 text-left">Team</th>
            <th className="px-4 py-3 text-left">Sport</th>
            <th className="px-4 py-3 text-left">Logo URL</th>
            <th className="px-4 py-3 text-left">Color</th>
            <th className="px-4 py-3 text-left">Abbr.</th>
            <th className="px-4 py-3" />
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--color-border)]">
          {list.competitors.map((row) => (
            <CompetitorEditableRow key={row.id} row={row} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CompetitorEditableRow({ row }: { row: CompetitorRow }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState(false);
  const [logoUrl, setLogoUrl] = useState(row.logoUrl ?? "");
  const [brandColor, setBrandColor] = useState(row.brandColor ?? "");
  const [abbreviation, setAbbreviation] = useState(row.abbreviation ?? "");
  const [error, setError] = useState<string | null>(null);

  function startEdit() {
    setLogoUrl(row.logoUrl ?? "");
    setBrandColor(row.brandColor ?? "");
    setAbbreviation(row.abbreviation ?? "");
    setError(null);
    setEditing(true);
  }
  function cancelEdit() {
    setEditing(false);
    setError(null);
  }

  function save() {
    setError(null);
    if (brandColor.trim() && !/^#[0-9A-Fa-f]{6}$/.test(brandColor.trim())) {
      setError("Brand color must look like #RRGGBB.");
      return;
    }
    startTransition(async () => {
      try {
        await clientApi(`/admin/competitors/${row.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            logoUrl: logoUrl.trim(),
            brandColor: brandColor.trim(),
            abbreviation: abbreviation.trim(),
          }),
        });
        setEditing(false);
        router.refresh();
      } catch (e) {
        setError(e instanceof ApiFetchError ? e.body.message : "Save failed.");
      }
    });
  }

  function clearLogo() {
    setError(null);
    startTransition(async () => {
      try {
        await clientApi(`/admin/competitors/${row.id}`, {
          method: "PATCH",
          body: JSON.stringify({ logoUrl: "" }),
        });
        router.refresh();
      } catch (e) {
        setError(e instanceof ApiFetchError ? e.body.message : "Clear failed.");
      }
    });
  }

  return (
    <tr>
      <td className="px-4 py-3">
        <LogoPreview
          url={editing ? logoUrl.trim() || null : row.logoUrl}
          name={row.name}
          color={editing ? brandColor.trim() || null : row.brandColor}
        />
      </td>
      <td className="px-4 py-3">
        <div className="font-medium">{row.name}</div>
        <div className="font-mono text-[10px] text-[var(--color-fg-subtle)]">{row.slug}</div>
      </td>
      <td className="px-4 py-3 text-[var(--color-fg-muted)]">{row.sportSlug}</td>
      <td className="px-4 py-3 align-top">
        {editing ? (
          <input
            type="url"
            value={logoUrl}
            onChange={(e) => setLogoUrl(e.target.value)}
            placeholder="https://…/logo.png"
            disabled={pending}
            className="w-full min-w-[280px] rounded-[8px] border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-2 py-1 font-mono text-xs outline-none focus:border-[var(--color-accent)]"
          />
        ) : row.logoUrl ? (
          <a
            href={row.logoUrl}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-xs text-[var(--color-fg-muted)] underline-offset-2 hover:underline"
          >
            {truncate(row.logoUrl, 48)}
          </a>
        ) : (
          <span className="text-xs text-[var(--color-fg-subtle)]">—</span>
        )}
      </td>
      <td className="px-4 py-3 align-top">
        {editing ? (
          <input
            type="text"
            value={brandColor}
            onChange={(e) => setBrandColor(e.target.value)}
            placeholder="#RRGGBB"
            disabled={pending}
            className="w-[110px] rounded-[8px] border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-2 py-1 font-mono text-xs outline-none focus:border-[var(--color-accent)]"
          />
        ) : row.brandColor ? (
          <span className="inline-flex items-center gap-2 font-mono text-xs">
            <span
              aria-hidden
              style={{
                width: 12,
                height: 12,
                borderRadius: 3,
                background: row.brandColor,
                border: "1px solid var(--color-border)",
              }}
            />
            {row.brandColor}
          </span>
        ) : (
          <span className="text-xs text-[var(--color-fg-subtle)]">—</span>
        )}
      </td>
      <td className="px-4 py-3 align-top">
        {editing ? (
          <input
            type="text"
            value={abbreviation}
            onChange={(e) => setAbbreviation(e.target.value)}
            maxLength={16}
            disabled={pending}
            className="w-[88px] rounded-[8px] border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-2 py-1 font-mono text-xs outline-none focus:border-[var(--color-accent)]"
          />
        ) : row.abbreviation ? (
          <span className="font-mono text-xs">{row.abbreviation}</span>
        ) : (
          <span className="text-xs text-[var(--color-fg-subtle)]">—</span>
        )}
      </td>
      <td className="px-4 py-3 align-top text-right">
        {editing ? (
          <div className="flex flex-col items-end gap-1">
            <div className="flex justify-end gap-3">
              <button
                type="button"
                onClick={save}
                disabled={pending}
                className="text-xs uppercase tracking-[0.15em] text-[var(--color-accent)] hover:opacity-80 disabled:opacity-50"
              >
                Save
              </button>
              <button
                type="button"
                onClick={cancelEdit}
                disabled={pending}
                className="text-xs uppercase tracking-[0.15em] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
            {error ? (
              <span role="alert" className="text-[11px] text-[var(--color-negative)]">
                {error}
              </span>
            ) : null}
          </div>
        ) : (
          <div className="flex justify-end gap-3">
            <button
              type="button"
              onClick={startEdit}
              className="text-xs uppercase tracking-[0.15em] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
            >
              Edit
            </button>
            {row.logoUrl ? (
              <button
                type="button"
                onClick={clearLogo}
                disabled={pending}
                className="text-xs uppercase tracking-[0.15em] text-[var(--color-fg-muted)] hover:text-[var(--color-negative)] disabled:opacity-50"
              >
                Clear
              </button>
            ) : null}
          </div>
        )}
      </td>
    </tr>
  );
}

function LogoPreview({
  url,
  name,
  color,
}: {
  url: string | null;
  name: string;
  color: string | null;
}) {
  const [failed, setFailed] = useState(false);
  const showImg = !!url && !failed && (url.startsWith("http") || url.startsWith("/"));
  const initials = name
    .split(/\s+/)
    .slice(0, 3)
    .map((w) => w[0])
    .join("")
    .slice(0, 4)
    .toUpperCase();
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 36,
        height: 36,
        borderRadius: 8,
        background: showImg ? "var(--color-bg-elevated)" : "var(--color-bg-elevated)",
        border: "1px solid var(--color-border)",
        fontFamily: "var(--font-geist-mono, monospace)",
        fontSize: 11,
        color: "var(--color-fg-muted)",
        position: "relative",
        overflow: "hidden",
      }}
    >
      {color ? (
        <span
          aria-hidden
          style={{
            position: "absolute",
            top: 3,
            right: 3,
            width: 6,
            height: 6,
            borderRadius: 999,
            background: color,
            zIndex: 2,
          }}
        />
      ) : null}
      {showImg ? (
        <img
          src={url ?? undefined}
          alt={name}
          onError={() => setFailed(true)}
          loading="lazy"
          decoding="async"
          style={{
            width: "100%",
            height: "100%",
            objectFit: "contain",
            padding: 3,
          }}
        />
      ) : (
        initials
      )}
    </span>
  );
}

function Pager({ list, current }: { list: ListShape; current: Filters }) {
  if (list.total <= list.limit) return null;
  const router = useRouter();
  const page = Math.floor(list.offset / list.limit) + 1;
  const lastPage = Math.ceil(list.total / list.limit);

  function go(offset: number) {
    const params = new URLSearchParams();
    if (current.sportId) params.set("sportId", current.sportId);
    if (current.q) params.set("q", current.q);
    if (current.missingLogo) params.set("missingLogo", "1");
    if (offset > 0) params.set("offset", String(offset));
    router.push(
      `/admin/competitors${params.toString() ? `?${params.toString()}` : ""}`,
    );
  }

  return (
    <div className="flex items-center justify-between text-xs text-[var(--color-fg-muted)]">
      <span>
        Page {page} of {lastPage}
      </span>
      <div className="flex gap-3">
        <button
          type="button"
          onClick={() => go(Math.max(0, list.offset - list.limit))}
          disabled={list.offset === 0}
          className="rounded border border-[var(--color-border)] px-3 py-1 disabled:opacity-40"
        >
          ← Prev
        </button>
        <button
          type="button"
          onClick={() => go(list.offset + list.limit)}
          disabled={list.offset + list.limit >= list.total}
          className="rounded border border-[var(--color-border)] px-3 py-1 disabled:opacity-40"
        >
          Next →
        </button>
      </div>
    </div>
  );
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}
