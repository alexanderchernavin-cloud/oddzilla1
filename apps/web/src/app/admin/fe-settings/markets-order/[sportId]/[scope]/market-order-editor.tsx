"use client";

import { useMemo, useState, useTransition, useRef, type DragEvent } from "react";
import { useRouter } from "next/navigation";
import { clientApi, ApiFetchError } from "@/lib/api-client";

export interface MarketEntry {
  providerMarketId: number;
  label: string;
}

type Scope = "match" | "map" | "top";

export function MarketOrderEditor({
  sportId,
  scope,
  initialOrdered,
  initialUnranked,
}: {
  sportId: number;
  scope: Scope;
  initialOrdered: MarketEntry[];
  initialUnranked: MarketEntry[];
}) {
  const router = useRouter();
  const [ordered, setOrdered] = useState<MarketEntry[]>(initialOrdered);
  const [unranked, setUnranked] = useState<MarketEntry[]>(initialUnranked);
  const [busy, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  // Drag state lives in a ref so React renders don't reset it mid-drag.
  // The drag source can be either the ordered or unranked list; the
  // drop target is always the ordered list (drops onto unranked unrank
  // the item via the dedicated → button instead, to keep the drop zones
  // unambiguous when you're rearranging within ordered).
  const dragRef = useRef<{ from: "ordered" | "unranked"; index: number } | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  const dirty = useMemo(() => {
    if (ordered.length !== initialOrdered.length) return true;
    for (let i = 0; i < ordered.length; i++) {
      const a = ordered[i];
      const b = initialOrdered[i];
      if (!a || !b || a.providerMarketId !== b.providerMarketId) return true;
    }
    return false;
  }, [ordered, initialOrdered]);

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

  function unrank(idx: number) {
    setMsg(null);
    setOrdered((cur) => {
      const item = cur[idx];
      if (!item) return cur;
      const next = cur.slice();
      next.splice(idx, 1);
      setUnranked((u) =>
        [...u, item].sort((a, b) => a.providerMarketId - b.providerMarketId),
      );
      return next;
    });
  }

  function rank(providerMarketId: number) {
    setMsg(null);
    setUnranked((cur) => {
      const idx = cur.findIndex((m) => m.providerMarketId === providerMarketId);
      if (idx < 0) return cur;
      const item = cur[idx];
      if (!item) return cur;
      const next = cur.slice();
      next.splice(idx, 1);
      setOrdered((o) => [...o, item]);
      return next;
    });
  }

  // Drag handlers. The native HTML5 DnD API requires a non-empty
  // setData call in dragstart for Firefox to actually fire dragend; we
  // store a sentinel string and read the real source from the ref.
  function handleDragStart(from: "ordered" | "unranked", index: number) {
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
  function handleDragLeaveOrdered() {
    setDragOverIndex(null);
  }
  function handleDropOrdered(targetIdx: number) {
    return (ev: DragEvent<HTMLLIElement | HTMLOListElement>) => {
      ev.preventDefault();
      const drag = dragRef.current;
      dragRef.current = null;
      setDragOverIndex(null);
      if (!drag) return;
      setMsg(null);

      if (drag.from === "ordered") {
        setOrdered((cur) => {
          const item = cur[drag.index];
          if (!item) return cur;
          const next = cur.slice();
          next.splice(drag.index, 1);
          // After removing, the indices shift. If we were dropping
          // *after* the source item, adjust by one.
          const insertAt = drag.index < targetIdx ? targetIdx - 1 : targetIdx;
          next.splice(Math.max(0, Math.min(insertAt, next.length)), 0, item);
          return next;
        });
      } else {
        // Coming from unranked: pull item out of unranked, insert into
        // ordered at targetIdx (clamped).
        setUnranked((u) => {
          const item = u[drag.index];
          if (!item) return u;
          const nextU = u.slice();
          nextU.splice(drag.index, 1);
          setOrdered((o) => {
            const next = o.slice();
            next.splice(Math.max(0, Math.min(targetIdx, next.length)), 0, item);
            return next;
          });
          return nextU;
        });
      }
    };
  }
  // Drop on the empty bottom of the ordered list (or on the empty list
  // itself) inserts at the end.
  function handleDropAtEnd(ev: DragEvent<HTMLOListElement>) {
    handleDropOrdered(ordered.length)(ev);
  }
  function handleDragOverEmpty(ev: DragEvent<HTMLOListElement>) {
    if (!dragRef.current) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = "move";
  }

  function save() {
    setMsg(null);
    startTransition(async () => {
      try {
        await clientApi(`/admin/fe-settings/markets-order/${sportId}/${scope}`, {
          method: "PUT",
          body: JSON.stringify({
            order: ordered.map((m) => m.providerMarketId),
          }),
        });
        setMsg({ kind: "ok", text: "Saved." });
        router.refresh();
      } catch (err) {
        setMsg({
          kind: "err",
          text: err instanceof ApiFetchError ? err.body.message : "Save failed.",
        });
      }
    });
  }

  function reset() {
    setMsg(null);
    startTransition(async () => {
      try {
        await clientApi(`/admin/fe-settings/markets-order/${sportId}/${scope}`, {
          method: "DELETE",
        });
        setMsg({ kind: "ok", text: "Reverted to default order." });
        router.refresh();
      } catch (err) {
        setMsg({
          kind: "err",
          text: err instanceof ApiFetchError ? err.body.message : "Reset failed.",
        });
      }
    });
  }

  return (
    <div className="mt-6 space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={busy || !dirty}
          className="btn btn-primary"
        >
          {busy ? "Saving…" : "Save order"}
        </button>
        <button
          type="button"
          onClick={reset}
          disabled={busy || (ordered.length === 0 && initialOrdered.length === 0)}
          className="text-xs uppercase tracking-[0.15em] text-[var(--color-fg-muted)] hover:text-[var(--color-negative)] disabled:opacity-50"
        >
          Revert to default
        </button>
        {msg ? (
          <span
            role={msg.kind === "err" ? "alert" : "status"}
            className={
              "text-sm " +
              (msg.kind === "ok"
                ? "text-[var(--color-positive)]"
                : "text-[var(--color-negative)]")
            }
          >
            {msg.text}
          </span>
        ) : null}
      </div>

      <p className="text-xs text-[var(--color-fg-subtle)]">
        Drag rows to reorder, drop into Ordered to add. Buttons work too.
      </p>

      <div className="grid gap-6 lg:grid-cols-2">
        <section>
          <h3 className="text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
            Ordered ({ordered.length})
          </h3>
          <ol
            className="card mt-2 divide-y divide-[var(--color-border)]"
            onDragOver={handleDragOverEmpty}
            onDrop={handleDropAtEnd}
          >
            {ordered.length === 0 ? (
              <li
                className="px-4 py-3 text-sm text-[var(--color-fg-muted)]"
                onDragOver={handleDragOver(0)}
                onDrop={handleDropOrdered(0)}
              >
                {scope === "top"
                  ? "Drop markets here to feature them on the Top tab."
                  : "No explicit order — markets fall back to provider market id ascending."}
              </li>
            ) : (
              ordered.map((m, idx) => {
                const showInsertGuide = dragOverIndex === idx;
                return (
                  <li
                    key={m.providerMarketId}
                    draggable
                    onDragStart={handleDragStart("ordered", idx)}
                    onDragOver={handleDragOver(idx)}
                    onDragLeave={handleDragLeaveOrdered}
                    onDrop={handleDropOrdered(idx)}
                    className={
                      "flex items-center gap-3 px-4 py-2 cursor-grab active:cursor-grabbing " +
                      (showInsertGuide
                        ? "border-t-2 border-t-[var(--color-accent)]"
                        : "")
                    }
                  >
                    <span
                      aria-hidden
                      className="select-none text-[var(--color-fg-subtle)]"
                      title="Drag to reorder"
                    >
                      ⋮⋮
                    </span>
                    <span className="w-8 text-right font-mono text-xs text-[var(--color-fg-subtle)]">
                      {idx + 1}.
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="truncate text-sm">{m.label}</div>
                      <div className="font-mono text-[10px] text-[var(--color-fg-subtle)]">
                        id {m.providerMarketId}
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => move(idx, -1)}
                        disabled={busy || idx === 0}
                        className="rounded border border-[var(--color-border)] px-2 py-1 text-xs disabled:opacity-30"
                        aria-label="Move up"
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        onClick={() => move(idx, 1)}
                        disabled={busy || idx === ordered.length - 1}
                        className="rounded border border-[var(--color-border)] px-2 py-1 text-xs disabled:opacity-30"
                        aria-label="Move down"
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        onClick={() => unrank(idx)}
                        disabled={busy}
                        className="rounded border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
                        aria-label="Move to unranked"
                      >
                        →
                      </button>
                    </div>
                  </li>
                );
              })
            )}
          </ol>
        </section>

        <section>
          <h3 className="text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
            Unranked ({unranked.length})
          </h3>
          <ul className="card mt-2 divide-y divide-[var(--color-border)]">
            {unranked.length === 0 ? (
              <li className="px-4 py-3 text-sm text-[var(--color-fg-muted)]">
                {scope === "top"
                  ? "Top has no implicit pool — every known market id for this sport that isn't ordered yet is shown here."
                  : "Every known market for this sport is in the ordered list."}
              </li>
            ) : (
              unranked.map((m, idx) => (
                <li
                  key={m.providerMarketId}
                  draggable
                  onDragStart={handleDragStart("unranked", idx)}
                  className="flex items-center gap-3 px-4 py-2 cursor-grab active:cursor-grabbing"
                >
                  <span
                    aria-hidden
                    className="select-none text-[var(--color-fg-subtle)]"
                    title="Drag to ordered list"
                  >
                    ⋮⋮
                  </span>
                  <button
                    type="button"
                    onClick={() => rank(m.providerMarketId)}
                    disabled={busy}
                    className="rounded border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
                    aria-label="Add to ordered"
                  >
                    ←
                  </button>
                  <div className="flex-1 min-w-0">
                    <div className="truncate text-sm">{m.label}</div>
                    <div className="font-mono text-[10px] text-[var(--color-fg-subtle)]">
                      id {m.providerMarketId}
                    </div>
                  </div>
                </li>
              ))
            )}
          </ul>
        </section>
      </div>
    </div>
  );
}
