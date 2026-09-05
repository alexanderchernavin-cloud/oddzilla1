import { serverApi } from "@/lib/server-fetch";
import { AlertsClient, type AlertDto, type AlertListResponse } from "./alerts-client";
import type { AlertRuleDto } from "./rules-editor";

export const dynamic = "force-dynamic";

// Alert center. The queue is produced by the API's alert sweeper from
// the rules under the Rules tab; this page is where the risk desk works
// it: acknowledge, assign, comment, resolve. Lives in the Risk & limits
// group next to RiskZilla, which owns the levers the alerts point at.
export default async function AlertCenterPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const userId = typeof sp.userId === "string" ? sp.userId : undefined;
  const qs = new URLSearchParams({ status: "active", limit: "100" });
  if (userId) qs.set("userId", userId);

  const [list, rules] = await Promise.all([
    serverApi<AlertListResponse>(`/admin/riskzilla/alerts?${qs.toString()}`),
    serverApi<{ rules: AlertRuleDto[] }>("/admin/riskzilla/alerts/rules"),
  ]);

  return (
    <div>
      <header className="flex flex-wrap items-center gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Alert center</h1>
        <span className="mono text-[11px] uppercase tracking-[0.14em] text-[var(--color-fg-subtle)]">
          Risk desk queue
        </span>
      </header>
      <p className="mt-1 mb-6 max-w-3xl text-sm text-[var(--color-fg-muted)]">
        Every risk signal the book raises about a bettor, a ticket, a deposit
        or its own bank lands here once and stays until someone resolves it.
        Acknowledge to take it, comment to hand it over, resolve with a note.
        Rules and thresholds are tunable under the Rules tab; the sweeper
        re-evaluates them every minute.
      </p>
      <AlertsClient
        initial={list ?? { entries: [] as AlertDto[], total: 0, limit: 100, offset: 0, counts: null }}
        initialRules={rules?.rules ?? []}
        initialUserId={userId ?? ""}
      />
    </div>
  );
}
