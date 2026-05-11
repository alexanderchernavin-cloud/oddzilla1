import { BetsClient } from "./bets-client";

export const dynamic = "force-dynamic";

export default function AdminBetsPage() {
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">All bets</h1>
      <p className="mt-2 text-sm text-[var(--color-fg-muted)]">
        Every placed ticket across every currency, regardless of whether
        the RiskZilla engine evaluated it. USDC placements go through
        the engine and write decisions to RiskZilla&apos;s log; OZ is
        demo currency and bypasses the engine, so this view is the only
        place to see OZ activity alongside USDC. Filter by status,
        outcome, user, sport, bet type, date, or stake range.
      </p>
      <div className="mt-6">
        <BetsClient />
      </div>
    </div>
  );
}
