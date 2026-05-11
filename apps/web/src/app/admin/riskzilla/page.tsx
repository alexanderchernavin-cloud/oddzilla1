import { serverApi } from "@/lib/server-fetch";
import { fromMicro } from "@oddzilla/types/money";
import { readRzCurrencyFromSearchParams } from "./currency";

export const dynamic = "force-dynamic";

interface DashboardKpis {
  currency: string;
  bankApplies: boolean;
  bankLimitMicro: string;
  openLiabilityMicro: string;
  userBalancesMicro: string;
  userLockedMicro: string;
  freeCapacityMicro: string;
  bankUtilization: number;
  openTicketsCount: number;
  openMaxLossMicro: string;
  todayBankDeltaMicro: string;
  rejections24h: { total: number; byDecision: Record<string, number> };
  topRiskMatches: Array<{
    matchId: string;
    label: string;
    sportSlug: string | null;
    openTicketsCount: number;
    openMaxLossMicro: string;
  }>;
  bettorRsHistogram: Array<{ bucket: string; count: number }>;
}

const REJECTION_LABELS: Record<string, string> = {
  rejected_min_stake: "Min stake",
  rejected_max_payout: "Max payout",
  rejected_match_liability: "Match liability",
  rejected_bet_factor: "Bet factor",
  rejected_bank_limit: "Bank limit",
  rejected_user_blocked: "User blocked",
  rejected_market_factor: "Market factor",
};

export default async function RiskzillaDashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const currency = readRzCurrencyFromSearchParams(sp);
  const data = await serverApi<DashboardKpis>(
    `/admin/riskzilla/dashboard?currency=${currency}`,
  );
  if (!data) {
    return (
      <p style={{ color: "var(--color-fg-muted)" }}>
        Couldn&apos;t load dashboard. Reload or check the API service status.
      </p>
    );
  }

  const utilizationPct = (data.bankUtilization * 100).toFixed(1);
  const free = BigInt(data.freeCapacityMicro);
  const freeColor = free < 0n ? "#dc2626" : undefined;
  const cur = data.currency;
  const bankApplies = data.bankApplies;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      {!bankApplies && (
        <div
          style={{
            border: "1px solid var(--color-border)",
            borderRadius: 8,
            padding: "10px 14px",
            background: "var(--color-bg-subtle)",
            fontSize: 13,
            color: "var(--color-fg-muted)",
          }}
        >
          Viewing <strong style={{ color: "var(--color-fg)" }}>{cur}</strong>{" "}
          (demo). Operator bank panels are hidden — they apply to USDC only.
        </div>
      )}
      <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
        {bankApplies && (
          <>
            <Kpi
              label="Bank limit"
              value={`${fromMicro(BigInt(data.bankLimitMicro))} ${cur}`}
              sub="Operator ceiling on total exposure"
            />
            <Kpi
              label="Bettor balances"
              value={`${fromMicro(BigInt(data.userBalancesMicro))} ${cur}`}
              sub={
                BigInt(data.userLockedMicro) > 0n
                  ? `Withdrawable now · ${fromMicro(BigInt(data.userLockedMicro))} more locked in open bets`
                  : "Withdrawable on demand"
              }
            />
            <Kpi
              label="Open liability"
              value={`${fromMicro(BigInt(data.openLiabilityMicro))} ${cur}`}
              sub={`${utilizationPct}% of bank committed`}
            />
            <Kpi
              label="Free capacity"
              value={`${fromMicro(free)} ${cur}`}
              sub="bank − balances − liability"
              valueColor={freeColor}
            />
          </>
        )}
        <Kpi
          label="Open tickets"
          value={String(data.openTicketsCount)}
          sub={`${fromMicro(BigInt(data.openMaxLossMicro))} ${cur} max loss`}
        />
        {bankApplies && (
          <Kpi
            label="Bank delta today"
            value={`${fromMicro(BigInt(data.todayBankDeltaMicro))} ${cur}`}
          />
        )}
        {!bankApplies && (
          <Kpi
            label="Bettor balances"
            value={`${fromMicro(BigInt(data.userBalancesMicro))} ${cur}`}
            sub={
              BigInt(data.userLockedMicro) > 0n
                ? `${fromMicro(BigInt(data.userLockedMicro))} locked in open bets`
                : "Free across all OZ wallets"
            }
          />
        )}
        <Kpi
          label="Rejections (24h)"
          value={String(data.rejections24h.total)}
          sub={`${cur} placements only`}
        />
      </section>

      <section>
        <SectionHeader title={`Rejections by reason (24h, ${cur})`} />
        {data.rejections24h.total === 0 ? (
          <Empty>No rejections in the last 24 hours.</Empty>
        ) : (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr auto",
              gap: 6,
              rowGap: 4,
              fontSize: 13,
              maxWidth: 480,
            }}
          >
            {Object.entries(data.rejections24h.byDecision).map(([k, v]) => (
              <RowKv key={k} label={REJECTION_LABELS[k] ?? k} value={String(v)} />
            ))}
          </div>
        )}
      </section>

      <section>
        <SectionHeader title="Top exposure by match" />
        {data.topRiskMatches.length === 0 ? (
          <Empty>No open tickets right now.</Empty>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <Th>Match</Th>
                <Th>Sport</Th>
                <Th align="right">Open tickets</Th>
                <Th align="right">Max loss ({cur})</Th>
              </tr>
            </thead>
            <tbody>
              {data.topRiskMatches.map((m) => (
                <tr key={m.matchId}>
                  <Td>{m.label}</Td>
                  <Td>{m.sportSlug ?? "—"}</Td>
                  <Td align="right">{m.openTicketsCount}</Td>
                  <Td align="right" mono>
                    {fromMicro(BigInt(m.openMaxLossMicro))}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <SectionHeader title="Bettors by risk score" />
        {data.bettorRsHistogram.length === 0 ? (
          <Empty>No bettors yet.</Empty>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "auto auto auto", gap: 8, fontSize: 13, maxWidth: 360 }}>
            {data.bettorRsHistogram.map((b) => (
              <RowKv key={b.bucket} label={b.bucket} value={String(b.count)} />
            ))}
          </div>
        )}
      </section>
    </div>
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
        background: "var(--color-bg-subtle, var(--surface-2))",
        border: "1px solid var(--color-border, var(--border))",
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
          color: "var(--color-fg-subtle, var(--fg-dim))",
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
      {sub && (
        <span style={{ fontSize: 12, color: "var(--color-fg-muted)" }}>{sub}</span>
      )}
    </div>
  );
}

function SectionHeader({ title }: { title: string }) {
  return (
    <h2
      className="mono"
      style={{
        fontSize: 11,
        letterSpacing: "0.14em",
        textTransform: "uppercase",
        color: "var(--color-fg-subtle, var(--fg-dim))",
        margin: "0 0 12px 0",
      }}
    >
      {title}
    </h2>
  );
}

function RowKv({ label, value }: { label: string; value: string }) {
  return (
    <>
      <span style={{ color: "var(--color-fg-muted)" }}>{label}</span>
      <span style={{ fontVariantNumeric: "tabular-nums" }}>{value}</span>
    </>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p style={{ fontSize: 13, color: "var(--color-fg-muted)" }}>{children}</p>
  );
}

const tableStyle: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: 13,
};

function Th({ children, align }: { children: React.ReactNode; align?: "right" }) {
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

function Td({ children, align, mono }: { children: React.ReactNode; align?: "right"; mono?: boolean }) {
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
