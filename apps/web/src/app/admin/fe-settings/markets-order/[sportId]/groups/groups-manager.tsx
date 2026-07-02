"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { clientApi, ApiFetchError } from "@/lib/api-client";

export interface GroupTab {
  scope: string;
  label: string | null; // null for built-ins
  custom: boolean;
  marketCount: number;
}

export interface GroupsResponse {
  sport: { id: number; slug: string; name: string };
  maxMapNumber: number;
  ordered: boolean;
  groups: GroupTab[];
}

const MAP_SCOPE_RE = /^map_([1-9][0-9]*)$/;

function tabLabel(tab: GroupTab): string {
  if (tab.label) return tab.label;
  if (tab.scope === "match") return "Match";
  if (tab.scope === "top") return "Top";
  const m = tab.scope.match(MAP_SCOPE_RE);
  return m ? `Map ${m[1]}` : tab.scope;
}

export function GroupsManager({
  sportId,
  initial,
}: {
  sportId: number;
  initial: GroupsResponse;
}) {
  const router = useRouter();
  const [groups, setGroups] = useState<GroupTab[]>(initial.groups);
  const [savedGroups, setSavedGroups] = useState<GroupTab[]>(initial.groups);
  const [newLabel, setNewLabel] = useState("");
  const [renaming, setRenaming] = useState<{ scope: string; label: string } | null>(
    null,
  );
  const [busy, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const dirty = useMemo(() => {
    if (groups.length !== savedGroups.length) return true;
    for (let i = 0; i < groups.length; i++) {
      if (groups[i]?.scope !== savedGroups[i]?.scope) return true;
    }
    return false;
  }, [groups, savedGroups]);

  function fail(err: unknown, fallback: string) {
    setMsg({
      kind: "err",
      text: err instanceof ApiFetchError ? err.body.message : fallback,
    });
  }

  // Re-fetch the authoritative list after any mutation so local state
  // never drifts from the server (create/delete change the set, and the
  // server may have seeded built-in anchor rows on first configuration).
  async function reload() {
    const data = await clientApi<GroupsResponse>(
      `/admin/fe-settings/market-groups/${sportId}`,
    );
    setGroups(data.groups);
    setSavedGroups(data.groups);
    router.refresh();
  }

  function move(idx: number, delta: number) {
    setMsg(null);
    setGroups((cur) => {
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

  function saveOrder() {
    setMsg(null);
    startTransition(async () => {
      try {
        await clientApi(`/admin/fe-settings/market-groups/${sportId}/order`, {
          method: "PUT",
          body: JSON.stringify({ order: groups.map((g) => g.scope) }),
        });
        setMsg({ kind: "ok", text: "Order saved." });
        await reload();
      } catch (err) {
        fail(err, "Save failed.");
      }
    });
  }

  function addGroup() {
    const label = newLabel.trim();
    if (!label) return;
    setMsg(null);
    startTransition(async () => {
      try {
        await clientApi(`/admin/fe-settings/market-groups/${sportId}`, {
          method: "POST",
          body: JSON.stringify({ label }),
        });
        setNewLabel("");
        setMsg({
          kind: "ok",
          text: `Group "${label}" created — open its tab to add markets.`,
        });
        await reload();
      } catch (err) {
        fail(err, "Create failed.");
      }
    });
  }

  function saveRename() {
    if (!renaming) return;
    const label = renaming.label.trim();
    if (!label) return;
    const scope = renaming.scope;
    setMsg(null);
    startTransition(async () => {
      try {
        await clientApi(`/admin/fe-settings/market-groups/${sportId}/${scope}`, {
          method: "PATCH",
          body: JSON.stringify({ label }),
        });
        setRenaming(null);
        setMsg({ kind: "ok", text: "Renamed." });
        await reload();
      } catch (err) {
        fail(err, "Rename failed.");
      }
    });
  }

  function deleteGroup(tab: GroupTab) {
    if (
      !window.confirm(
        `Delete group "${tabLabel(tab)}"? Its curated market list (${tab.marketCount}) is removed too.`,
      )
    ) {
      return;
    }
    setMsg(null);
    startTransition(async () => {
      try {
        await clientApi(
          `/admin/fe-settings/market-groups/${sportId}/${tab.scope}`,
          { method: "DELETE" },
        );
        setMsg({ kind: "ok", text: "Group deleted." });
        await reload();
      } catch (err) {
        fail(err, "Delete failed.");
      }
    });
  }

  return (
    <div className="mt-6 space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={saveOrder}
          disabled={busy || !dirty}
          className="btn btn-primary"
        >
          {busy ? "Working…" : "Save order"}
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

      <section>
        <h3 className="text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
          Tabs ({groups.length})
        </h3>
        <ol className="card mt-2 divide-y divide-[var(--color-border)]">
          {groups.map((tab, idx) => (
            <li key={tab.scope} className="flex items-center gap-3 px-4 py-2">
              <span className="w-8 text-right font-mono text-xs text-[var(--color-fg-subtle)]">
                {idx + 1}.
              </span>
              <div className="flex-1 min-w-0">
                {renaming?.scope === tab.scope ? (
                  <div className="flex items-center gap-2">
                    <input
                      value={renaming.label}
                      onChange={(e) =>
                        setRenaming({ scope: tab.scope, label: e.target.value })
                      }
                      onKeyDown={(e) => {
                        if (e.key === "Enter") saveRename();
                        if (e.key === "Escape") setRenaming(null);
                      }}
                      maxLength={40}
                      autoFocus
                      className="w-48 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-sm"
                    />
                    <button
                      type="button"
                      onClick={saveRename}
                      disabled={busy || !renaming.label.trim()}
                      className="rounded border border-[var(--color-border)] px-2 py-1 text-xs disabled:opacity-30"
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      onClick={() => setRenaming(null)}
                      disabled={busy}
                      className="rounded border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-fg-muted)]"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="truncate text-sm">
                      {tabLabel(tab)}
                      {tab.custom ? (
                        <span className="ml-2 rounded border border-[var(--color-accent)] px-1.5 py-0.5 text-[10px] uppercase tracking-[0.12em] text-[var(--color-fg-muted)]">
                          custom
                        </span>
                      ) : null}
                    </div>
                    <div className="font-mono text-[10px] text-[var(--color-fg-subtle)]">
                      {tab.scope}
                      {tab.custom || tab.scope === "top"
                        ? ` — ${tab.marketCount} curated market${tab.marketCount === 1 ? "" : "s"}`
                        : tab.marketCount > 0
                          ? ` — ${tab.marketCount} ordered`
                          : ""}
                    </div>
                  </>
                )}
              </div>
              <div className="flex items-center gap-1">
                <Link
                  href={`/admin/fe-settings/markets-order/${sportId}/${tab.scope}`}
                  className="rounded border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
                >
                  Edit markets
                </Link>
                {tab.custom ? (
                  <>
                    <button
                      type="button"
                      onClick={() =>
                        setRenaming({ scope: tab.scope, label: tab.label ?? "" })
                      }
                      disabled={busy}
                      className="rounded border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
                    >
                      Rename
                    </button>
                    <button
                      type="button"
                      onClick={() => deleteGroup(tab)}
                      disabled={busy}
                      className="rounded border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-fg-muted)] hover:text-[var(--color-negative)]"
                    >
                      Delete
                    </button>
                  </>
                ) : null}
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
                  disabled={busy || idx === groups.length - 1}
                  className="rounded border border-[var(--color-border)] px-2 py-1 text-xs disabled:opacity-30"
                  aria-label="Move down"
                >
                  ↓
                </button>
              </div>
            </li>
          ))}
        </ol>
        <p className="mt-2 text-xs text-[var(--color-fg-subtle)]">
          Tabs render on the storefront in this order. Top and custom groups
          only appear once they have curated markets; Map tabs only appear
          for maps the match actually has.
        </p>
      </section>

      <section>
        <h3 className="text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
          Add custom group
        </h3>
        <div className="mt-2 flex items-center gap-2">
          <input
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") addGroup();
            }}
            placeholder="Group name (e.g. Kills)"
            maxLength={40}
            className="w-64 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm"
          />
          <button
            type="button"
            onClick={addGroup}
            disabled={busy || !newLabel.trim()}
            className="btn btn-primary"
          >
            Add group
          </button>
        </div>
      </section>
    </div>
  );
}
