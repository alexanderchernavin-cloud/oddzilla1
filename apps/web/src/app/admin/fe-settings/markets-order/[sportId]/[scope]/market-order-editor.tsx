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

// One screen, one shape: the list on the left is the tab, the pool on the
// right is every market this sport offers, and a market moves between
// them. Feed tabs (Match / Map N / a sub-event) were order-only until
// migration 0111 — their pool was just their own markets, so there was no
// way to put the corners total on the Match tab or leave a market off a
// tab that carries it.
//
// The one thing that still differs is what happens to markets NOT on the
// list. A feed tab defaults to 'auto': the feed keeps filling it behind
// the operator's order, which is what it always did and what keeps a
// market kind that is not live right now — and so is not in this pool —
// from silently vanishing from the storefront. 'manual' makes the list
// the whole tab, exactly like Top and custom groups, which have no feed
// side to fall back on.
export function MarketOrderEditor({
  sportId,
  scope,
  feedTab,
  initialMembership,
  seeded,
  tabs,
  initialOrdered,
  initialAvailable,
}: {
  sportId: number;
  scope: string;
  feedTab: boolean;
  initialMembership: "auto" | "manual";
  /** `ordered` is the tab's live contents, not saved rows — see the API. */
  seeded: boolean;
  tabs: ScopeTab[];
  initialOrdered: MarketEntry[];
  initialAvailable: MarketEntry[];
}) {
  const router = useRouter();
  const [ordered, setOrdered] = useState<MarketEntry[]>(initialOrdered);
  const [available, setAvailable] = useState<MarketEntry[]>(initialAvailable);
  const [membership, setMembership] = useState(initialMembership);
  const [query, setQuery] = useState("");
  const [busy, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const savedKeys = useMemo(
    () => (seeded ? null : initialOrdered.map(entryKey).join("|")),
    [initialOrdered, seeded],
  );
  // A seeded list is a preview of what the feed puts on the tab; saving it
  // is a real change (it pins that list), so Save stays enabled.
  const dirty =
    savedKeys === null ||
    membership !== initialMembership ||
    ordered.map(entryKey).join("|") !== savedKeys;

  const tabTitle = useMemo(() => {
    const byScope = new Map(tabs.map((t) => [t.scope, t]));
    return (s: string | null) => {
      if (!s) return null;
      const hit = byScope.get(s);
      return hit ? tabLabel(hit) : s;
    };
  }, [tabs]);

  // Removing one of the tab's OWN markets does nothing while the feed is
  // still allowed to fill the tab — it comes back at the end of the list
  // on the next load, which looks like the remove button is broken. Say
  // so instead, and point at the control that makes it stick.
  const removedButStillShown = useMemo(
    () =>
      membership === "auto"
        ? available.filter((m) => m.tab === scope).length
        : 0,
    [available, membership, scope],
  );

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
            ...(feedTab ? { membership } : null),
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
    // The tab chip says where this market lives in the feed, which is the
    // only thing the name cannot: two tabs can carry the same market type,
    // and a market on this list may have been imported from another tab.
    const title = tabTitle(m.tab);
    const imported = m.tab != null && m.tab !== scope;
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
            {title ? (
              <span
                className={
                  "rounded border px-1.5 py-px uppercase tracking-[0.08em] " +
                  (imported
                    ? "border-[var(--color-fg-muted)] text-[var(--color-fg-muted)]"
                    : "border-[var(--color-border)]")
                }
              >
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
          disabled={
            busy ||
            (seeded && initialMembership === "auto") ||
            (initialOrdered.length === 0 && initialMembership === "auto")
          }
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
        Drag a market from the right into this tab, or use the arrow. Top to
        bottom is the order bettors see.
        {seeded
          ? " Markets the feed puts on this tab are listed here too, even where nothing is saved for them yet — save to pin the list as it stands."
          : ""}
      </p>

      {feedTab ? (
        <fieldset className="mt-4 rounded border border-[var(--color-border)] p-3">
          <legend className="px-1 text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
            Markets not on this list
          </legend>
          <div className="flex flex-col gap-2">
            <label className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="membership"
                checked={membership === "auto"}
                onChange={() => {
                  setMsg(null);
                  setMembership("auto");
                }}
                className="mt-1"
              />
              <span>
                Keep showing them, after this list
                <span className="block text-xs text-[var(--color-fg-subtle)]">
                  The feed keeps filling the tab. A market kind that is not
                  live right now — and so is not in the pool on the right —
                  still reaches bettors when it comes back.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="membership"
                checked={membership === "manual"}
                onChange={() => {
                  setMsg(null);
                  setMembership("manual");
                }}
                className="mt-1"
              />
              <span>
                Hide them — this list is the whole tab
                <span className="block text-xs text-[var(--color-fg-subtle)]">
                  Like Top and custom tabs. Anything the feed adds later is
                  off the tab until you add it here.
                </span>
              </span>
            </label>
          </div>
        </fieldset>
      ) : null}

      <div className="mt-4 grid gap-6 lg:grid-cols-2">
        <section>
          <h3 className="text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
            In this tab ({ordered.length})
          </h3>
          {removedButStillShown > 0 ? (
            <p className="mt-1 text-xs text-[var(--color-fg-muted)]">
              {removedButStillShown} market
              {removedButStillShown === 1 ? "" : "s"} you took off this tab will
              still show, because the feed puts {removedButStillShown === 1 ? "it" : "them"}{" "}
              here. Pick &ldquo;Hide them&rdquo; above to leave{" "}
              {removedButStillShown === 1 ? "it" : "them"} off.
            </p>
          ) : null}
          <ol
            className="mt-2 overflow-hidden rounded border border-[var(--color-border)]"
            onDragOver={(ev) => {
              if (dragRef.current) ev.preventDefault();
            }}
            onDrop={handleDrop(ordered.length)}
          >
            {ordered.length === 0 ? (
              <li className="px-3 py-6 text-center text-sm text-[var(--color-fg-muted)]">
                Nothing here yet — add markets from the right.
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
                    <button
                      type="button"
                      onClick={() => remove(idx)}
                      disabled={busy}
                      className={btn}
                      aria-label="Remove from this tab"
                    >
                      →
                    </button>
                  </div>
                </Row>
              ))
            )}
          </ol>
        </section>

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
      </div>
    </div>
  );
}
