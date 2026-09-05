"use client";

import { useMemo, useState, useTransition, useRef, type DragEvent } from "react";
import { useRouter } from "next/navigation";
import { clientApi, ApiFetchError } from "@/lib/api-client";
import { tabLabel, type ScopeTab } from "../../scope-label";

export interface MarketEntry {
  providerMarketId: number;
  /** Fonbet sub-event (`specifiers.variant`); empty for the base event. */
  variant: string;
  label: string;
  /** Feed tab this market sits on. Null when only a config row knows it. */
  tab: string | null;
}

export function entryKey(m: MarketEntry): string {
  return `${m.providerMarketId}:${m.variant}`;
}

// Two jobs, one screen.
//
// A FEED tab (Match / Map N / a sub-event) already holds its markets — the
// feed decides membership, not the operator — so there is ONE list, in the
// order bettors see, and dragging changes that order. It used to render as
// "Ordered (0)" beside "Unranked (6)", which read as "this tab is empty"
// when in fact all six markets were on it and merely unpinned.
//
// A CURATED tab (Top, custom groups) is opt-in membership, so it keeps two
// columns: what's in the tab, and every market on the sport to pick from.
export function MarketOrderEditor({
  sportId,
  scope,
  curated,
  tabs,
  initialOrdered,
  initialUnranked,
}: {
  sportId: number;
  scope: string;
  curated: boolean;
  tabs: ScopeTab[];
  initialOrdered: MarketEntry[];
  initialUnranked: MarketEntry[];
}) {
  const router = useRouter();
  // Feed mode has a single list; curated mode splits it in two.
  const [ordered, setOrdered] = useState<MarketEntry[]>(
    curated ? initialOrdered : [...initialOrdered, ...initialUnranked],
  );
  const [available, setAvailable] = useState<MarketEntry[]>(
    curated ? initialUnranked : [],
  );
  const [query, setQuery] = useState("");
  const [busy, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const savedKeys = useMemo(
    () => initialOrdered.map(entryKey).join("|"),
    [initialOrdered],
  );
  const dirty = ordered.map(entryKey).join("|") !== savedKeys;

  const tabTitle = useMemo(() => {
    const byScope = new Map(tabs.map((t) => [t.scope, t]));
    return (s: string | null) => {
      if (!s) return null;
      const hit = byScope.get(s);
      return hit ? tabLabel(hit) : s;
    };
  }, [tabs]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return available;
    return available.filter(
      (m) =>
        m.label.toLowerCase().includes(q) ||
        String(m.providerMarketId).includes(q) ||
        (tabTitle(m.tab) ?? "").toLowerCase().includes(q),
    );
  }, [available, query, tabTitle]);

  // Drag state lives in a ref so React renders don't reset it mid-drag.
  const dragRef = useRef<{ from: "ordered" | "available"; index: number } | null>(
    null,
  );
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  function move(idx: number, delta: number) {
    setMsg(null);
    setOrdered((cur) => {
      const j = idx + delta;
      if (j < 0 || j >= cur.length) return cur;
      const next = cur.slice();
      const item = next[idx];
      if (!item) return cur;
      next.splice(idx, 1);
      next.splice(j, 0, item);
      return next;
    });
  }

  function remove(idx: number) {
    setMsg(null);
    setOrdered((cur) => {
      const item = cur[idx];
      if (!item) return cur;
      const next = cur.slice();
      next.splice(idx, 1);
      setAvailable((a) =>
        [...a, item].sort((x, y) => x.providerMarketId - y.providerMarketId),
      );
      return next;
    });
  }

  function add(key: string) {
    setMsg(null);
    setAvailable((cur) => {
      const idx = cur.findIndex((m) => entryKey(m) === key);
      if (idx < 0) return cur;
      const item = cur[idx];
      if (!item) return cur;
      const next = cur.slice();
      next.splice(idx, 1);
      setOrdered((o) => [...o, item]);
      return next;
    });
  }

  function handleDragStart(from: "ordered" | "available", index: number) {
    return (ev: DragEvent<HTMLLIElement>) => {
      dragRef.current = { from, index };
      ev.dataTransfer.effectAllowed = "move";
      ev.dataTransfer.setData("text/plain", `${from}:${index}`);
    };
  }
  function handleDragOver(targetIdx: number) {
    return (ev: DragEvent<HTMLLIElement>) => {
      if (!dragRef.current) return;
      ev.preventDefault();
      ev.dataTransfer.dropEffect = "move";
      setDragOverIndex(targetIdx);
    };
  }
  function handleDrop(targetIdx: number) {
    return (ev: DragEvent<Element>) => {
      ev.preventDefault();
      const src = dragRef.current;
      dragRef.current = null;
      setDragOverIndex(null);
      if (!src) return;
      setMsg(null);
      if (src.from === "available") {
        const item = available[src.index];
        if (!item) return;
        setAvailable((cur) => cur.filter((_, i) => i !== src.index));
        setOrdered((cur) => {
          const next = cur.slice();
          next.splice(Math.min(targetIdx, next.length), 0, item);
          return next;
        });
        return;
      }
      setOrdered((cur) => {
        const next = cur.slice();
        const item = next[src.index];
        if (!item) return cur;
        next.splice(src.index, 1);
        const dest = src.index < targetIdx ? targetIdx - 1 : targetIdx;
        next.splice(Math.max(0, Math.min(dest, next.length)), 0, item);
        return next;
      });
    };
  }

  function save() {
    setMsg(null);
    startTransition(async () => {
      try {
        await clientApi(`/admin/fe-settings/markets-order/${sportId}/${scope}`, {
          method: "PUT",
          body: JSON.stringify({
            order: ordered.map((m) => ({
              providerMarketId: m.providerMarketId,
              variant: m.variant,
            })),
          }),
        });
        setMsg({ kind: "ok", text: "Saved." });
        router.refresh();
      } catch (err) {
        setMsg({
          kind: "err",
          text:
            err instanceof ApiFetchError ? err.body.message : "Could not save.",
        });
      }
    });
  }

  function revert() {
    setMsg(null);
    startTransition(async () => {
      try {
        await clientApi(`/admin/fe-settings/markets-order/${sportId}/${scope}`, {
          method: "DELETE",
        });
        setMsg({ kind: "ok", text: "Reverted to the default order." });
        router.refresh();
      } catch (err) {
        setMsg({
          kind: "err",
          text:
            err instanceof ApiFetchError ? err.body.message : "Could not revert.",
        });
      }
    });
  }

  function Row({
    m,
    children,
    draggable,
    onDragStart,
    onDragOver,
    onDrop,
    highlighted,
  }: {
    m: MarketEntry;
    children?: React.ReactNode;
    draggable?: boolean;
    onDragStart?: (ev: DragEvent<HTMLLIElement>) => void;
    onDragOver?: (ev: DragEvent<HTMLLIElement>) => void;
    onDrop?: (ev: DragEvent<HTMLLIElement>) => void;
    highlighted?: boolean;
  }) {
    const title = tabTitle(m.tab);
    return (
      <li
        draggable={draggable}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDrop={onDrop}
        onDragEnd={() => {
          dragRef.current = null;
          setDragOverIndex(null);
        }}
        className={
          "flex items-center gap-3 border-b border-[var(--color-border)] px-3 py-2 last:border-b-0 " +
          (highlighted ? "bg-[var(--color-bg-elevated)]" : "")
        }
      >
        <span className="cursor-grab select-none text-[var(--color-fg-subtle)]">⠿</span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm">{m.label}</div>
          <div className="flex items-center gap-2 font-mono text-[11px] text-[var(--color-fg-subtle)]">
            <span>id {m.providerMarketId}</span>
            {curated && title ? (
              <span className="rounded border border-[var(--color-border)] px-1.5 py-px uppercase tracking-[0.08em]">
                {title}
              </span>
            ) : null}
          </div>
        </div>
        {children}
      </li>
    );
  }

  const btn =
    "rounded border border-[var(--color-border)] px-2 py-1 text-xs disabled:opacity-30";

  return (
    <div className="mt-6">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={busy || !dirty}
          className="rounded bg-[var(--color-fg)] px-4 py-2 text-sm text-[var(--color-bg)] disabled:opacity-40"
        >
          {busy ? "Saving…" : "Save order"}
        </button>
        <button
          type="button"
          onClick={revert}
          disabled={busy || initialOrdered.length === 0}
          className="text-xs uppercase tracking-[0.15em] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] disabled:opacity-30"
        >
          Revert to default
        </button>
        {msg ? (
          <span
            className={
              "text-xs " +
              (msg.kind === "ok"
                ? "text-[var(--color-fg-muted)]"
                : "text-[var(--color-danger,#c0392b)]")
            }
          >
            {msg.text}
          </span>
        ) : null}
      </div>

      <p className="mt-2 text-xs text-[var(--color-fg-subtle)]">
        {curated
          ? "Drag a market from the right into this tab, or use the arrow. Order top to bottom is the render order."
          : "Every market on this tab, in the order bettors see. Drag to reorder; markets the feed adds later sort after these."}
      </p>

      <div
        className={
          "mt-4 grid gap-6 " + (curated ? "lg:grid-cols-2" : "lg:grid-cols-1")
        }
      >
        <section>
          <h3 className="text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
            {curated ? `In this tab (${ordered.length})` : `Markets (${ordered.length})`}
          </h3>
          <ol
            className="mt-2 overflow-hidden rounded border border-[var(--color-border)]"
            onDragOver={(ev) => {
              if (dragRef.current) ev.preventDefault();
            }}
            onDrop={handleDrop(ordered.length)}
          >
            {ordered.length === 0 ? (
              <li className="px-3 py-6 text-center text-sm text-[var(--color-fg-muted)]">
                {curated
                  ? "Nothing featured yet — add markets from the right."
                  : "No markets on this tab in the current offer."}
              </li>
            ) : (
              ordered.map((m, idx) => (
                <Row
                  key={entryKey(m)}
                  m={m}
                  draggable
                  highlighted={dragOverIndex === idx}
                  onDragStart={handleDragStart("ordered", idx)}
                  onDragOver={handleDragOver(idx)}
                  onDrop={handleDrop(idx)}
                >
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => move(idx, -1)}
                      disabled={busy || idx === 0}
                      className={btn}
                      aria-label="Move up"
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      onClick={() => move(idx, 1)}
                      disabled={busy || idx === ordered.length - 1}
                      className={btn}
                      aria-label="Move down"
                    >
                      ↓
                    </button>
                    {curated ? (
                      <button
                        type="button"
                        onClick={() => remove(idx)}
                        disabled={busy}
                        className={btn}
                        aria-label="Remove from this tab"
                      >
                        →
                      </button>
                    ) : null}
                  </div>
                </Row>
              ))
            )}
          </ol>
        </section>

        {curated ? (
          <section>
            <div className="flex items-baseline justify-between gap-3">
              <h3 className="text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
                All markets ({filtered.length}
                {filtered.length !== available.length ? ` of ${available.length}` : ""})
              </h3>
            </div>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter by name, tab or id"
              className="mt-2 w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm"
            />
            <ol className="mt-2 max-h-[70vh] overflow-y-auto rounded border border-[var(--color-border)]">
              {filtered.length === 0 ? (
                <li className="px-3 py-6 text-center text-sm text-[var(--color-fg-muted)]">
                  {available.length === 0
                    ? "Every market on this sport is already in this tab."
                    : "No market matches that filter."}
                </li>
              ) : (
                filtered.map((m) => (
                  <Row
                    key={entryKey(m)}
                    m={m}
                    draggable
                    onDragStart={handleDragStart(
                      "available",
                      available.indexOf(m),
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => add(entryKey(m))}
                      disabled={busy}
                      className={btn}
                      aria-label="Add to this tab"
                    >
                      ←
                    </button>
                  </Row>
                ))
              )}
            </ol>
          </section>
        ) : null}
      </div>
    </div>
  );
}
