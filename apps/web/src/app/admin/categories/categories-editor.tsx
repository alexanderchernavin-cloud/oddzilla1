"use client";

import { useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { clientApi, ApiFetchError } from "@/lib/api-client";
import { PinOrderControls } from "@/components/admin/pin-order-controls";

export interface CategoryRow {
  id: number;
  name: string;
  slug: string;
  hiddenFromLists: boolean;
  /**
   * Operator pin position within this category's own SPORT (migration
   * 0103), or null when unpinned. Pinned categories head the sport's
   * sidebar tree in this order; the rest stay alphabetical.
   */
  displayOrder: number | null;
  /** Live + upcoming matches under the category — the sizing signal. */
  bookableCount: number;
  sport: { id: number; name: string; slug: string };
}

export interface SportOption {
  id: number;
  slug: string;
  name: string;
}

interface ListShape {
  total: number;
  hiddenCount: number;
  limit: number;
  offset: number;
  categories: CategoryRow[];
}

interface Filters {
  sportId: string;
  q: string;
  hidden: boolean;
  offset: number;
  limit: number;
}

export function CategoriesEditor({
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
      <FilterBar
        sports={sports}
        current={currentFilters}
        total={initialList.total}
        hiddenCount={initialList.hiddenCount}
      />
      <CategoryTable list={initialList} />
      <Pager list={initialList} current={currentFilters} />
    </div>
  );
}

function FilterBar({
  sports,
  current,
  total,
  hiddenCount,
}: {
  sports: SportOption[];
  current: Filters;
  total: number;
  hiddenCount: number;
}) {
  const router = useRouter();
  const [q, setQ] = useState(current.q);
  const [sportId, setSportId] = useState(current.sportId);
  const [hiddenOnly, setHiddenOnly] = useState(current.hidden);

  function applyFilters(e?: FormEvent) {
    e?.preventDefault();
    const params = new URLSearchParams();
    if (sportId) params.set("sportId", sportId);
    if (q.trim()) params.set("q", q.trim());
    if (hiddenOnly) params.set("hidden", "1");
    router.push(`/admin/categories${params.toString() ? `?${params.toString()}` : ""}`);
  }

  function clearFilters() {
    setQ("");
    setSportId("");
    setHiddenOnly(false);
    router.push("/admin/categories");
  }

  return (
    <form onSubmit={applyFilters} className="card flex flex-wrap items-end gap-3 p-4">
      <label className="block">
        <span className="block text-xs text-[var(--color-fg-subtle)]">Sport</span>
        <select
          value={sportId}
          onChange={(e) => setSportId(e.target.value)}
          className="mt-1 min-w-[200px] rounded-[10px] border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-2 outline-none focus:border-[var(--color-accent)]"
        >
          <option value="">All sports</option>
          {sports.map((s) => (
            <option key={s.id} value={String(s.id)}>
              {s.name}
            </option>
          ))}
        </select>
      </label>

      <label className="block min-w-[220px] flex-1">
        <span className="block text-xs text-[var(--color-fg-subtle)]">Search</span>
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Category name"
          className="mt-1 w-full rounded-[10px] border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-2 outline-none focus:border-[var(--color-accent)]"
        />
      </label>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={hiddenOnly}
          onChange={(e) => setHiddenOnly(e.target.checked)}
        />
        Hidden only ({hiddenCount})
      </label>

      <button type="submit" className="btn btn-primary">
        Apply
      </button>
      {(current.q || current.sportId || current.hidden) && (
        <button
          type="button"
          onClick={clearFilters}
          className="text-xs uppercase tracking-[0.15em] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
        >
          Clear
        </button>
      )}

      <span className="ml-auto text-xs text-[var(--color-fg-muted)]">
        {total} categor{total === 1 ? "y" : "ies"}
      </span>
    </form>
  );
}

function CategoryTable({ list }: { list: ListShape }) {
  if (list.categories.length === 0) {
    return (
      <p className="text-sm text-[var(--color-fg-muted)]">
        No categories match the current filters.
      </p>
    );
  }
  return (
    <div className="card overflow-hidden">
      <table className="w-full text-sm">
        <thead className="border-b border-[var(--color-border)] text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
          <tr>
            <th className="px-4 py-3 text-left">Category</th>
            <th className="px-4 py-3 text-left">Sport</th>
            <th className="px-4 py-3 text-right">Bookable</th>
            <th className="px-4 py-3 text-left">Order in sport</th>
            <th className="px-4 py-3 text-left">In match lists</th>
            <th className="px-4 py-3" />
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--color-border)]">
          {list.categories.map((row) => (
            <CategoryEditableRow
              key={row.id}
              row={row}
              // Ends of the PINNED run inside this row's own sport, which
              // is the scope the arrows move within. Derived from the
              // page rather than sent by the API: the list is ordered
              // pinned-first per sport, so the run is contiguous here.
              first={isFirstPinnedInSport(row)}
              last={isLastPinnedInSport(list.categories, row)}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Whether a pinned row sits at an end of its sport's pinned run. A row
// whose pin position is 1 is first by definition; last needs the page,
// because "no pinned row in this sport carries a higher position" is
// what makes the down arrow meaningless.
//
// Read from the current page, which means an active filter (or a page
// boundary) can hide part of a sport's pinned run and grey out a "down"
// that did have somewhere to go. Only the disabled state is affected:
// the server computes every move against the true pinned list, so an
// arrow that IS enabled always does the right thing, and one that is
// wrongly greyed comes back the moment the filter is cleared.
function isFirstPinnedInSport(row: CategoryRow): boolean {
  return row.displayOrder === 1;
}

function isLastPinnedInSport(rows: CategoryRow[], row: CategoryRow): boolean {
  const position = row.displayOrder;
  if (position == null) return true;
  return !rows.some(
    (r) =>
      r.sport.id === row.sport.id &&
      r.displayOrder != null &&
      r.displayOrder > position,
  );
}

function CategoryEditableRow({
  row,
  first,
  last,
}: {
  row: CategoryRow;
  first: boolean;
  last: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function toggle() {
    setError(null);
    startTransition(async () => {
      try {
        await clientApi(`/admin/categories/${row.id}`, {
          method: "PATCH",
          body: JSON.stringify({ hiddenFromLists: !row.hiddenFromLists }),
        });
        router.refresh();
      } catch (e) {
        setError(e instanceof ApiFetchError ? e.body.message : "Save failed.");
      }
    });
  }

  return (
    <tr>
      <td className="px-4 py-3">
        <div className="font-medium">{row.name}</div>
        <div className="text-xs text-[var(--color-fg-subtle)]">{row.slug}</div>
        {error && (
          <div className="mt-1 text-xs text-[var(--color-danger)]">{error}</div>
        )}
      </td>
      <td className="px-4 py-3 text-[var(--color-fg-muted)]">{row.sport.name}</td>
      {/* Live + upcoming under this category. The number is the argument:
          a category at 165 is one an operator wants to think about, one at
          0 is noise. */}
      <td className="px-4 py-3 text-right tabular-nums">{row.bookableCount}</td>
      {/* Pinned categories head their sport's sidebar tree in this
          order; everything unpinned stays alphabetical behind them. */}
      <td className="px-4 py-3">
        <PinOrderControls
          basePath="/admin/categories"
          id={row.id}
          displayOrder={row.displayOrder}
          first={first}
          last={last}
          label={row.name}
        />
      </td>
      <td className="px-4 py-3">
        {row.hiddenFromLists ? (
          <span className="rounded-full bg-[var(--color-bg-elevated)] px-2 py-1 text-xs text-[var(--color-fg-muted)]">
            Hidden — tree only
          </span>
        ) : (
          <span className="text-xs text-[var(--color-fg-muted)]">Shown</span>
        )}
      </td>
      <td className="px-4 py-3 text-right">
        <button
          type="button"
          onClick={toggle}
          disabled={pending}
          className="btn"
          title={
            row.hiddenFromLists
              ? "Put this category back in the lobby, Live, Pre-match and sport-page lists"
              : "Keep this category out of the lists; it stays reachable from the sidebar tree"
          }
        >
          {pending ? "Saving…" : row.hiddenFromLists ? "Show in lists" : "Hide from lists"}
        </button>
      </td>
    </tr>
  );
}

function Pager({ list, current }: { list: ListShape; current: Filters }) {
  const router = useRouter();
  const canPrev = list.offset > 0;
  const canNext = list.offset + list.categories.length < list.total;

  function go(nextOffset: number) {
    const params = new URLSearchParams();
    if (current.sportId) params.set("sportId", current.sportId);
    if (current.q) params.set("q", current.q);
    if (current.hidden) params.set("hidden", "1");
    if (nextOffset > 0) params.set("offset", String(nextOffset));
    router.push(`/admin/categories${params.toString() ? `?${params.toString()}` : ""}`);
  }

  if (!canPrev && !canNext) return null;

  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        className="btn"
        disabled={!canPrev}
        onClick={() => go(Math.max(0, list.offset - current.limit))}
      >
        ← Previous
      </button>
      <span className="text-xs text-[var(--color-fg-muted)]">
        {list.offset + 1}–{list.offset + list.categories.length} of {list.total}
      </span>
      <button
        type="button"
        className="btn"
        disabled={!canNext}
        onClick={() => go(list.offset + current.limit)}
      >
        Next →
      </button>
    </div>
  );
}
