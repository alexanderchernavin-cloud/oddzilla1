import { serverApi } from "@/lib/server-fetch";
import { CombiBoostEditor, type CombiBoostConfigDto } from "./combi-boost-editor";

export const dynamic = "force-dynamic";

export default async function AdminCombiBoostPage() {
  const config = await serverApi<CombiBoostConfigDto>(
    "/admin/combi-boost-config",
  );

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Combi Boost</h1>
      <p className="mt-2 text-sm text-[var(--color-fg-muted)]">
        Payout-multiplier promo on multi-leg combo tickets. Only legs whose
        odds are at least the per-leg floor count toward a tier; the
        multiplier is locked into <code>tickets.bet_meta</code> at placement
        and applied on settlement. Edits here propagate to the next bet
        placed — there&apos;s no caching layer in front of this row.
      </p>
      {config ? (
        <CombiBoostEditor initial={config} />
      ) : (
        <p className="mt-6 text-sm text-[var(--color-fg-muted)]">
          Couldn&apos;t load the current config. Reload the page or check the
          API service status.
        </p>
      )}
    </div>
  );
}
