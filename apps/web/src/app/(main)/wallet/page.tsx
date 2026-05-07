import { fromMicro } from "@oddzilla/types/money";
import type {
  Currency,
  DepositAddressResponse,
  DepositIntentListResponse,
  LinkedWalletListResponse,
  WalletListResponse,
  WithdrawalListResponse,
} from "@oddzilla/types";
import { serverApi } from "@/lib/server-fetch";
import { WalletPanels } from "./wallet-panels";
import { CurrencyCard } from "./currency-card";

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
  const [walletRes, ledger, addressRes, deposits, withdrawals, linkedWallets] =
    await Promise.all([
      serverApi<WalletListResponse>("/wallet"),
      serverApi<LedgerResponse>("/wallet/ledger?limit=25"),
      serverApi<DepositAddressResponse>("/wallet/deposit-address"),
      serverApi<DepositIntentListResponse>("/wallet/deposits?limit=25"),
      serverApi<WithdrawalListResponse>("/wallet/withdrawals?limit=25"),
      serverApi<LinkedWalletListResponse>("/wallet/addresses"),
    ]);

  const wallets = walletRes?.wallets ?? [];
  const usdc = wallets.find((w) => w.currency === "USDC");
  const oz = wallets.find((w) => w.currency === "OZ");

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Wallet</h1>
      <p className="mt-2 text-sm text-[var(--color-fg-muted)]">
        Real-money USDC plus the OZ demo balance for testing the bet
        flow. Deposits and withdrawals are USDC on Ethereum (ERC20).
      </p>

      <section className="mt-8 grid gap-4 md:grid-cols-2">
        <CurrencyCard wallet={usdc} currency="USDC" tag={null} />
        <CurrencyCard wallet={oz} currency="OZ" tag="demo" />
      </section>

      <WalletPanels
        depositAddress={addressRes?.address ?? null}
        depositsAvailable={addressRes?.available ?? false}
        deposits={deposits?.deposits ?? []}
        withdrawals={withdrawals?.withdrawals ?? []}
        availableMicro={usdc?.availableMicro ?? "0"}
        linkedWallets={linkedWallets?.addresses ?? []}
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

