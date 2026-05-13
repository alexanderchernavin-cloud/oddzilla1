import { serverApi } from "@/lib/server-fetch";
import {
  AdminDeposits,
  AdminUnattributed,
  type AdminDepositEntry,
  type AdminUnattributedEntry,
} from "./admin-deposits";

interface IntentsListResponse {
  deposits: AdminDepositEntry[];
}

interface UnattributedListResponse {
  deposits: AdminUnattributedEntry[];
}

interface AlertCounts {
  wrongTokenUnack: number;
  unattributedUnack: number;
  total: number;
}

const INTENT_TABS = [
  "all",
  "pending",
  "confirming",
  "credited",
  "rejected",
  "wrong_token",
] as const;
type IntentTab = (typeof INTENT_TABS)[number];

function isIntentTab(s: string | undefined): s is IntentTab {
  return INTENT_TABS.includes(s as IntentTab);
}

// `view=unattributed` swaps the list source from deposit_intents to
// unattributed_deposits. `tab` controls the deposit_intents.status
// sub-filter when in the intents view.
export default async function DepositsPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; tab?: string; acked?: string }>;
}) {
  const params = await searchParams;
  const view = params.view === "unattributed" ? "unattributed" : "intents";
  const tab: IntentTab = isIntentTab(params.tab) ? (params.tab as IntentTab) : "all";
  const acked: "all" | "unack" | "ack" =
    params.acked === "unack" || params.acked === "ack" ? params.acked : "all";

  const counts =
    (await serverApi<AlertCounts>("/admin/deposits/alert-counts")) ?? {
      wrongTokenUnack: 0,
      unattributedUnack: 0,
      total: 0,
    };

  let intents: AdminDepositEntry[] = [];
  let unattributed: AdminUnattributedEntry[] = [];

  if (view === "intents") {
    const qs = new URLSearchParams({ limit: "100" });
    if (tab !== "all") qs.set("status", tab);
    // Wrong-Token tab defaults to "unack only" — that's the alert
    // surface; ack'd rows are visible via the explicit toggle.
    const effectiveAcked = tab === "wrong_token" && acked === "all" ? "unack" : acked;
    if (effectiveAcked !== "all") qs.set("acked", effectiveAcked);
    const data = await serverApi<IntentsListResponse>(
      `/admin/deposits?${qs.toString()}`,
    );
    intents = data?.deposits ?? [];
  } else {
    const qs = new URLSearchParams({ limit: "100" });
    // Unattributed view defaults to "unack only" — that's the alert
    // surface. Explicit ?acked=ack | all overrides.
    const effectiveAcked: "unack" | "ack" = acked === "all" ? "unack" : acked;
    qs.set("acked", effectiveAcked);
    const data = await serverApi<UnattributedListResponse>(
      `/admin/deposits/unattributed?${qs.toString()}`,
    );
    unattributed = data?.deposits ?? [];
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Deposits</h1>
      <p className="mt-2 text-sm text-[var(--color-fg-muted)]">
        Users submit a tx hash after sending USDC to the shared receive
        address. wallet-watcher resolves the receipt and credits after
        confirmations. Wrong-Token and Unattributed surface incidents
        where someone sent the wrong coin to our address.
      </p>

      <TabStrip
        view={view}
        tab={tab}
        wrongTokenUnack={counts.wrongTokenUnack}
        unattributedUnack={counts.unattributedUnack}
      />

      {(view === "unattributed" || tab === "wrong_token") && (
        <AckFilter view={view} tab={tab} acked={acked} />
      )}

      <section className="mt-6">
        {view === "intents" ? (
          intents.length === 0 ? (
            <p className="text-sm text-[var(--color-fg-muted)]">
              No deposits in this view.
            </p>
          ) : (
            <AdminDeposits entries={intents} />
          )
        ) : unattributed.length === 0 ? (
          <p className="text-sm text-[var(--color-fg-muted)]">
            No unattributed deposits in this view.
          </p>
        ) : (
          <AdminUnattributed entries={unattributed} />
        )}
      </section>
    </div>
  );
}

function TabStrip({
  view,
  tab,
  wrongTokenUnack,
  unattributedUnack,
}: {
  view: "intents" | "unattributed";
  tab: IntentTab;
  wrongTokenUnack: number;
  unattributedUnack: number;
}) {
  const intentTabs: { id: IntentTab; label: string; badge?: number }[] = [
    { id: "all", label: "All" },
    { id: "pending", label: "Pending" },
    { id: "confirming", label: "Confirming" },
    { id: "credited", label: "Credited" },
    { id: "rejected", label: "Rejected" },
    { id: "wrong_token", label: "Wrong Token", badge: wrongTokenUnack },
  ];

  const intentActive = view === "intents";
  return (
    <section className="mt-6 flex flex-wrap items-center gap-2 text-sm">
      {intentTabs.map((t) => {
        const href =
          t.id === "all"
            ? "/admin/deposits"
            : `/admin/deposits?tab=${t.id}`;
        const active = intentActive && tab === t.id;
        return (
          <TabLink key={t.id} href={href} active={active} badge={t.badge}>
            {t.label}
          </TabLink>
        );
      })}
      <span className="mx-1 h-4 w-px bg-[var(--color-border)]" aria-hidden />
      <TabLink
        href="/admin/deposits?view=unattributed"
        active={view === "unattributed"}
        badge={unattributedUnack}
      >
        Unattributed
      </TabLink>
    </section>
  );
}

function TabLink({
  href,
  active,
  badge,
  children,
}: {
  href: string;
  active: boolean;
  badge?: number;
  children: React.ReactNode;
}) {
  return (
    <a
      href={href}
      className={
        "inline-flex items-center gap-2 rounded-[8px] border px-3 py-1 " +
        (active
          ? "border-[var(--color-accent)] text-[var(--color-accent)]"
          : "border-[var(--color-border-strong)] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]")
      }
    >
      <span>{children}</span>
      {badge && badge > 0 ? (
        <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-[var(--color-negative)] px-1.5 text-[10px] font-semibold text-white">
          {badge}
        </span>
      ) : null}
    </a>
  );
}

function AckFilter({
  view,
  tab,
  acked,
}: {
  view: "intents" | "unattributed";
  tab: IntentTab;
  acked: "all" | "unack" | "ack";
}) {
  const base =
    view === "unattributed"
      ? "/admin/deposits?view=unattributed"
      : `/admin/deposits?tab=${tab}`;
  const opts: { id: typeof acked; label: string }[] = [
    { id: "unack", label: "Unacknowledged" },
    { id: "ack", label: "Acknowledged" },
    { id: "all", label: "Both" },
  ];
  return (
    <section className="mt-3 flex flex-wrap items-center gap-2 text-xs">
      <span className="uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
        Show
      </span>
      {opts.map((o) => {
        const href = o.id === "unack" ? base : `${base}&acked=${o.id}`;
        const active = acked === o.id || (acked === "all" && o.id === "unack" && view === "intents" && tab === "wrong_token") || (acked === "all" && o.id === "unack" && view === "unattributed");
        // The active match is a little messy because "unack" is the
        // implicit default on these surfaces. The expression boils
        // down to: highlight whichever option matches the effective
        // filter after the implicit default kicks in.
        return (
          <a
            key={o.id}
            href={href}
            className={
              "rounded-[8px] border px-2.5 py-1 " +
              (active
                ? "border-[var(--color-accent)] text-[var(--color-accent)]"
                : "border-[var(--color-border-strong)] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]")
            }
          >
            {o.label}
          </a>
        );
      })}
    </section>
  );
}
