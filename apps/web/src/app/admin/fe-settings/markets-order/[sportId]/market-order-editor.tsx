"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { clientApi, ApiFetchError } from "@/lib/api-client";

export interface MarketEntry {
  providerMarketId: number;
  label: string;
}

export function MarketOrderEditor({
  sportId,
  initialOrdered,
  initialUnranked,
}: {
  sportId: number;
  initialOrdered: MarketEntry[];
  initialUnranked: MarketEntry[];
}) {
  const router = useRouter();
  const [ordered, setOrdered] = useState<MarketEntry[]>(initialOrdered);
  const [unranked, setUnranked] = useState<MarketEntry[]>(initialUnranked);
  const [busy, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

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

  function save() {
    setMsg(null);
    startTransition(async () => {
      try {
        await clientApi(`/admin/fe-settings/markets-order/${sportId}`, {
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
        await clientApi(`/admin/fe-settings/markets-order/${sportId}`, {
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

      <div className="grid gap-6 lg:grid-cols-2">
        <section>
          <h3 className="text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
            Ordered ({ordered.length})
          </h3>
          <ol className="card mt-2 divide-y divide-[var(--color-border)]">
            {ordered.length === 0 ? (
              <li className="px-4 py-3 text-sm text-[var(--color-fg-muted)]">
                No explicit order — every market falls back to provider market id ascending.
              </li>
            ) : (
              ordered.map((m, idx) => (
                <li
                  key={m.providerMarketId}
                  className="flex items-center gap-3 px-4 py-2"
                >
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
              ))
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
                Every known market for this sport is in the ordered list.
              </li>
            ) : (
              unranked.map((m) => (
                <li
                  key={m.providerMarketId}
                  className="flex items-center gap-3 px-4 py-2"
                >
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
