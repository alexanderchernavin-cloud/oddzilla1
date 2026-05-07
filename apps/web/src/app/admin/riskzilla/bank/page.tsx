import { serverApi } from "@/lib/server-fetch";
import { fromMicro } from "@oddzilla/types/money";
import { BankAdjuster, type BankStateDto } from "./bank-adjuster";

export const dynamic = "force-dynamic";

interface LedgerEntry {
  id: string;
  deltaMicro: string;
  type: string;
  refType: string | null;
  refId: string | null;
  actorUserId: string | null;
  memo: string | null;
  createdAt: string;
}

const TYPE_LABELS: Record<string, string> = {
  seed: "Seed",
  bet_loss: "Bettor lost",
  bet_payout: "Payout",
  bet_refund: "Refund",
  manual_adjust: "Manual",
};

export default async function RiskzillaBankPage() {
  const [state, ledger] = await Promise.all([
    serverApi<BankStateDto>("/admin/riskzilla/bank"),
    serverApi<{ entries: LedgerEntry[] }>("/admin/riskzilla/bank/ledger?limit=100"),
  ]);
  if (!state) {
    return (
      <p style={{ color: "var(--color-fg-muted)" }}>
        Couldn&apos;t load bank state.
      </p>
    );
  }

  const limitDecimal = fromMicro(BigInt(state.bankLimitMicro));
  const balanceDecimal = fromMicro(BigInt(state.userBalancesMicro));
  const lockedDecimal = fromMicro(BigInt(state.userLockedMicro));
  const hasLocked = BigInt(state.userLockedMicro) > 0n;
  const openDecimal = fromMicro(BigInt(state.openLiabilityMicro));
  const free = BigInt(state.freeCapacityMicro);
  const freeDecimal = fromMicro(free);
  const committed = BigInt(state.userBalancesMicro) + BigInt(state.openLiabilityMicro);
  const utilization = state.bankLimitMicro === "0"
    ? 0
    : Number((committed * 10000n) / BigInt(state.bankLimitMicro)) / 100;

  return (
    <>
      <p style={{ fontSize: 13, color: "var(--color-fg-muted)", marginBottom: 16 }}>
        Operator bankroll ceiling. Bettor balances (withdrawable on
        demand) plus open potential payouts must never exceed it — bets
        that would breach the cap are rejected with{" "}
        <code>rejected_bank_limit</code>. Bank limit grows when bettors
        lose and shrinks when they win.
      </p>

      <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, marginBottom: 24 }}>
        <Kpi label="Bank limit" value={`${limitDecimal} USDC`} />
        <Kpi
          label="Bettor balances"
          value={`${balanceDecimal} USDC`}
          sub={
            hasLocked
              ? `Withdrawable now · ${lockedDecimal} more locked in open bets`
              : "Withdrawable on demand"
          }
        />
        <Kpi
          label="Open liability"
          value={`${openDecimal} USDC`}
          sub={`${utilization.toFixed(1)}% committed`}
        />
        <Kpi
          label="Free capacity"
          value={`${freeDecimal} USDC`}
          sub={free < 0n ? "Over-committed" : "Available for new bets"}
          valueColor={free < 0n ? "#dc2626" : undefined}
        />
        <Kpi
          label="Updated"
          value={new Date(state.updatedAt).toLocaleString()}
          sub={state.updatedBy ? `by ${state.updatedBy.slice(0, 8)}…` : undefined}
        />
      </section>

      <BankAdjuster initial={state} />

      <section style={{ marginTop: 32 }}>
        <h2
          className="mono"
          style={{
            fontSize: 11,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            color: "var(--color-fg-subtle)",
            marginBottom: 12,
          }}
        >
          Recent ledger
        </h2>
        {!ledger || ledger.entries.length === 0 ? (
          <p style={{ fontSize: 13, color: "var(--color-fg-muted)" }}>No entries.</p>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <Th>When</Th>
                <Th>Type</Th>
                <Th align="right">Delta (USDC)</Th>
                <Th>Ref</Th>
                <Th>Memo</Th>
              </tr>
            </thead>
            <tbody>
              {ledger.entries.map((e) => (
                <tr key={e.id}>
                  <Td>{new Date(e.createdAt).toLocaleString()}</Td>
                  <Td>{TYPE_LABELS[e.type] ?? e.type}</Td>
                  <Td align="right" mono>
                    {fromMicro(BigInt(e.deltaMicro))}
                  </Td>
                  <Td>
                    {e.refType ? `${e.refType}/${(e.refId ?? "—").slice(0, 12)}` : "—"}
                  </Td>
                  <Td>{e.memo ?? "—"}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}

function Kpi({
  label,
  value,
  sub,
  valueColor,
}: {
  label: string;
  value: string;
  sub?: string;
  valueColor?: string;
}) {
  return (
    <div
      style={{
        background: "var(--color-bg-subtle)",
        border: "1px solid var(--color-border)",
        borderRadius: 10,
        padding: "14px 16px",
        display: "flex",
        flexDirection: "column",
        gap: 4,
      }}
    >
      <span
        className="mono"
        style={{
          fontSize: 11,
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          color: "var(--color-fg-subtle)",
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontSize: 22,
          fontVariantNumeric: "tabular-nums",
          color: valueColor,
        }}
      >
        {value}
      </span>
      {sub && <span style={{ fontSize: 12, color: "var(--color-fg-muted)" }}>{sub}</span>}
    </div>
  );
}

const tableStyle: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: 13,
};

function Th({ children, align }: { children?: React.ReactNode; align?: "right" }) {
  return (
    <th
      style={{
        textAlign: align ?? "left",
        padding: "6px 10px",
        borderBottom: "1px solid var(--color-border)",
        fontWeight: 500,
        fontSize: 11,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        color: "var(--color-fg-muted)",
      }}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  align,
  mono,
}: {
  children: React.ReactNode;
  align?: "right";
  mono?: boolean;
}) {
  return (
    <td
      style={{
        textAlign: align ?? "left",
        padding: "6px 10px",
        borderBottom: "1px solid var(--color-border)",
        fontVariantNumeric: mono ? "tabular-nums" : "normal",
      }}
    >
      {children}
    </td>
  );
}
