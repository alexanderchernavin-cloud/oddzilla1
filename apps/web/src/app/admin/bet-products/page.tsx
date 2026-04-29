import { serverApi } from "@/lib/server-fetch";
import { BetProductsEditor, type BetProduct } from "./bet-products-editor";

interface BetProductsResponse {
  products: BetProduct[];
}

export default async function BetProductsPage() {
  const res = await serverApi<BetProductsResponse>("/admin/bet-products");
  const products = res?.products ?? [];

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Bet products</h1>
      <p className="mt-2 text-sm text-[var(--color-fg-muted)]">
        Per-product margin and leg-count limits for the probability-driven
        products. Margins are applied at placement time — independent of
        the odds-publisher cascade. Changes take effect on the next bet
        placed.
      </p>

      <ul className="mt-3 space-y-1 text-xs text-[var(--color-fg-muted)]">
        <li>
          <strong className="text-[var(--color-fg)]">Tiple</strong> — wins if
          at least one leg wins. Offered odds = 1 / (P_any × (1 + margin)).
        </li>
        <li>
          <strong className="text-[var(--color-fg)]">Tippot</strong> —
          payout depends on number of winning legs. Cumulative tier
          multipliers, strictly increasing.
        </li>
      </ul>

      <BetProductsEditor initial={products} />
    </div>
  );
}
