// /admin/unsettled/denylist — the market shapes the Fonbet ingester must
// not offer because no grader can settle them from the data we have
// (migration 0111, docs/SETTLEMENT_COVERAGE_PLAN.md phase 3a).
//
// Two kinds of rule: a whole catalogue table by provider_market_id
// ("winner of point N in a set", 1007800) and a sub-event family by the
// prefix of its label ("Player specials"). fonbet-ingester re-reads the
// list every minute. The markets already created under a rule stay listed
// here — the operator asked to keep them visible in case the grading for
// one of the shapes gets written later.

import Link from "next/link";
import { serverApi } from "@/lib/server-fetch";
import { DenylistEditor, type DenylistRule } from "./denylist-editor";

export const metadata = {
  title: "Settlement denylist — Oddzilla Admin",
};

export const dynamic = "force-dynamic";

export default async function DenylistPage() {
  const res = await serverApi<{ rules: DenylistRule[]; scanDays: number }>(
    "/admin/unsettled/denylist",
  );
  const rules = res?.rules ?? [];
  const scanDays = res?.scanDays ?? 30;

  return (
    <div>
      <div className="text-xs text-[var(--color-fg-muted)]">
        <Link href="/admin/unsettled" className="hover:underline">
          Unsettled
        </Link>{" "}
        / Denylist
      </div>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight">Market denylist</h1>
      <p className="mt-1 max-w-3xl text-sm text-[var(--color-fg-muted)]">
        Fonbet market shapes that are never offered because nothing can settle
        them from the results feed: a whole catalogue table by its provider
        market id, or a sub-event family by the prefix of its label. The
        ingester picks up a change within a minute. Markets already created
        under a rule are deactivated on the next snapshot and stay listed
        below — they are not voided; if a grading for the shape is ever
        written, they settle through it.
      </p>
      <DenylistEditor initialRules={rules} scanDays={scanDays} />
    </div>
  );
}
