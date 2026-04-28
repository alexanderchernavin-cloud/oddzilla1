import { fromMicro } from "@oddzilla/types/money";
import type {
  Currency,
  DepositAddressesResponse,
  DepositListResponse,
  WalletListResponse,
  WalletSnapshot,
  WithdrawalListResponse,
} from "@oddzilla/types";
import { serverApi } from "@/lib/server-fetch";
import { WalletPanels } from "./wallet-panels";

interface LedgerEntry {
  id: string;
  currency: Currency;
  deltaMicro: string;
  type: string;
  refType: string | null;
  refId: string | null;
  txHash: string | null;
  memo: string | null;
  createdAt: string;
}

interface LedgerResponse {
  entries: LedgerEntry[];
}

export default async function WalletPage() {
  const [walletRes, ledger, addresses, deposits, withdrawals] = await Promise.all([
    serverApi<WalletListResponse>("/wallet"),
    serverApi<LedgerResponse>("/wallet/ledger?limit=25"),
    serverApi<DepositAddressesResponse>("/wallet/deposit-addresses"),
    serverApi<DepositListResponse>("/wallet/deposits?limit=25"),
    serverApi<WithdrawalListResponse>("/wallet/withdrawals?limit=25"),
  ]);

  const wallets = walletRes?.wallets ?? [];
  const usdt = wallets.find((w) => w.currency === "USDT");
  const oz = wallets.find((w) => w.currency === "OZ");

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Wallet</h1>
      <p className="mt-2 text-sm text-[var(--color-fg-muted)]">
        Real-money USDT plus the OZ demo balance for testing the bet flow.
        Deposits and withdrawals are USDT only.
      </p>

      <section className="mt-8 grid gap-4 md:grid-cols-2">
        <CurrencyCard wallet={usdt} currency="USDT" tag={null} />
        <CurrencyCard wallet={oz} currency="OZ" tag="demo" />
      </section>

      <WalletPanels
        addresses={addresses?.addresses ?? []}
        deposits={deposits?.deposits ?? []}
        withdrawals={withdrawals?.withdrawals ?? []}
        availableMicro={usdt?.availableMicro ?? "0"}
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
                    <p className="font-medium capitalize">
                      {e.type.replace(/_/g, " ")}
                      <span className="ml-2 font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--color-fg-muted)]">
                        {e.currency}
                      </span>
                    </p>
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
                    {fromMicro(delta)} {e.currency}
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

function CurrencyCard({
  wallet,
  currency,
  tag,
}: {
  wallet: WalletSnapshot | undefined;
  currency: Currency;
  tag: string | null;
}) {
  const balance = wallet ? fromMicro(BigInt(wallet.balanceMicro)) : "—";
  const locked = wallet ? fromMicro(BigInt(wallet.lockedMicro)) : "—";
  const available = wallet ? fromMicro(BigInt(wallet.availableMicro)) : "—";

  return (
    <div className="card p-6">
      <div className="flex items-center gap-2">
        <p className="text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
          {currency}
        </p>
        {tag ? (
          <span className="rounded-full border border-[var(--color-border-strong)] px-2 py-[1px] text-[10px] uppercase tracking-[0.12em] text-[var(--color-fg-muted)]">
            {tag}
          </span>
        ) : null}
      </div>
      <p className="mt-3 font-mono text-3xl text-[var(--color-accent)]">
        {available}
        <span className="ml-2 text-sm text-[var(--color-fg-muted)]">{currency}</span>
      </p>
      <dl className="mt-4 grid grid-cols-2 gap-y-1 text-xs text-[var(--color-fg-muted)]">
        <dt>Balance</dt>
        <dd className="text-right font-mono text-[var(--color-fg)]">{balance}</dd>
        <dt>Locked</dt>
        <dd className="text-right font-mono text-[var(--color-fg)]">{locked}</dd>
      </dl>
    </div>
  );
}
