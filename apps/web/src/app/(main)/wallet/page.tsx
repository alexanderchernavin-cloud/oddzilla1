import { fromMicro } from "@oddzilla/types/money";
import type {
  DepositAddressesResponse,
  DepositListResponse,
  WithdrawalListResponse,
} from "@oddzilla/types";
import { serverApi } from "@/lib/server-fetch";
import { WalletPanels } from "./wallet-panels";

interface WalletResponse {
  currency: "USDT";
  balanceMicro: string;
  lockedMicro: string;
  availableMicro: string;
}

interface LedgerResponse {
  entries: Array<{
    id: string;
    deltaMicro: string;
    type: string;
    refType: string | null;
    refId: string | null;
    txHash: string | null;
    memo: string | null;
    createdAt: string;
  }>;
}

export default async function WalletPage() {
  const [wallet, ledger, addresses, deposits, withdrawals] = await Promise.all([
    serverApi<WalletResponse>("/wallet"),
    serverApi<LedgerResponse>("/wallet/ledger?limit=25"),
    serverApi<DepositAddressesResponse>("/wallet/deposit-addresses"),
    serverApi<DepositListResponse>("/wallet/deposits?limit=25"),
    serverApi<WithdrawalListResponse>("/wallet/withdrawals?limit=25"),
  ]);

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Wallet</h1>
      <p className="mt-2 text-sm text-[var(--color-fg-muted)]">
        USDT balance plus your TRC20 + ERC20 deposit addresses.
      </p>

      <section className="mt-8 grid gap-4 sm:grid-cols-3">
        <Stat
          label="Balance"
          value={wallet ? fromMicro(BigInt(wallet.balanceMicro)) : "—"}
          suffix="USDT"
        />
        <Stat
          label="Locked"
          value={wallet ? fromMicro(BigInt(wallet.lockedMicro)) : "—"}
          suffix="USDT"
        />
        <Stat
          label="Available"
          value={wallet ? fromMicro(BigInt(wallet.availableMicro)) : "—"}
          suffix="USDT"
          highlight
        />
      </section>

      <WalletPanels
        addresses={addresses?.addresses ?? []}
        deposits={deposits?.deposits ?? []}
        withdrawals={withdrawals?.withdrawals ?? []}
        availableMicro={wallet?.availableMicro ?? "0"}
      />

      <section className="mt-12">
        <h2 className="text-sm uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
          Recent ledger
        </h2>
        {!ledger || ledger.entries.length === 0 ? (
          <p className="mt-4 text-sm text-[var(--color-fg-muted)]">
            No wallet activity yet.
          </p>
        ) : (
          <ul className="mt-4 divide-y divide-[var(--color-border)] rounded-[14px] border border-[var(--color-border)] bg-[var(--color-bg-card)]">
            {ledger.entries.map((e) => {
              const delta = BigInt(e.deltaMicro);
              const positive = delta >= 0n;
              return (
                <li
                  key={e.id}
                  className="flex items-center justify-between px-4 py-3 text-sm"
                >
                  <div>
                    <p className="font-medium capitalize">{e.type.replace(/_/g, " ")}</p>
                    <p className="text-xs text-[var(--color-fg-subtle)]">
                      {new Date(e.createdAt).toLocaleString()}
                      {e.txHash ? ` · ${e.txHash.slice(0, 12)}…` : ""}
                    </p>
                  </div>
                  <p
                    className={
                      "font-mono text-sm " +
                      (positive
                        ? "text-[var(--color-positive)]"
                        : "text-[var(--color-negative)]")
                    }
                  >
                    {positive ? "+" : ""}
                    {fromMicro(delta)} USDT
                  </p>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

function Stat({
  label,
  value,
  suffix,
  highlight,
}: {
  label: string;
  value: string;
  suffix: string;
  highlight?: boolean;
}) {
  return (
    <div className="card p-6">
      <p className="text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
        {label}
      </p>
      <p
        className={
          "mt-3 font-mono " +
          (highlight
            ? "text-3xl text-[var(--color-accent)]"
            : "text-2xl text-[var(--color-fg)]")
        }
      >
        {value} <span className="text-sm text-[var(--color-fg-muted)]">{suffix}</span>
      </p>
    </div>
  );
}
