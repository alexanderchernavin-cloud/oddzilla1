import Link from "next/link";
import { notFound } from "next/navigation";
import { serverApi } from "@/lib/server-fetch";
import { fromMicro } from "@oddzilla/types";
import { RsEditor } from "./rs-editor";

export const dynamic = "force-dynamic";

interface BettorProfile {
  id: string;
  email: string;
  nickname: string | null;
  status: string;
  riskScore: string;
  createdAt: string;
  lastLoginAt: string | null;
  stats: {
    ticketsCount: number;
    wonCount: number;
    openCount: number;
    stakedMicro: string;
    payoutMicro: string;
    openMaxLossMicro: string;
    winRate: number;
    lastBetAt: string | null;
  };
  decisions: Array<{
    id: string;
    decision: string;
    reasonMessage: string | null;
    stakeMicro: string;
    potentialPayoutMicro: string;
    createdAt: string;
  }>;
}

export default async function BettorProfilePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const data = await serverApi<BettorProfile>(`/admin/riskzilla/bettors/${id}`);
  if (!data) notFound();

  const stake = fromMicro(BigInt(data.stats.stakedMicro));
  const payout = fromMicro(BigInt(data.stats.payoutMicro));
  const openLoss = fromMicro(BigInt(data.stats.openMaxLossMicro));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <Link
        href="/admin/riskzilla/bettors"
        style={{ fontSize: 12, color: "var(--color-fg-muted)", textDecoration: "none" }}
      >
        ← Back to bettors
      </Link>

      <header
        style={{
          display: "grid",
          gridTemplateColumns: "1fr auto",
          gap: 16,
          alignItems: "start",
        }}
      >
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0 }}>
            {data.nickname ?? data.email}
          </h1>
          <p style={{ fontSize: 13, color: "var(--color-fg-muted)", margin: "4px 0 0" }}>
            {data.email} · status <code>{data.status}</code> · joined{" "}
            {new Date(data.createdAt).toLocaleDateString()}
            {data.lastLoginAt && (
              <> · last login {new Date(data.lastLoginAt).toLocaleDateString()}</>
            )}
          </p>
        </div>
        <RsEditor userId={data.id} initial={data.riskScore} />
      </header>

      <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
        <Kpi label="Tickets" value={String(data.stats.ticketsCount)} sub={`${data.stats.wonCount} wins`} />
        <Kpi label="Win rate" value={`${(data.stats.winRate * 100).toFixed(1)}%`} />
        <Kpi label="Staked" value={`${stake} USDC`} />
        <Kpi label="Paid out" value={`${payout} USDC`} />
        <Kpi label="Open exposure" value={`${openLoss} USDC`} sub={`${data.stats.openCount} open tickets`} />
        <Kpi
          label="Last bet"
          value={
            data.stats.lastBetAt
              ? new Date(data.stats.lastBetAt).toLocaleString()
              : "—"
          }
        />
      </section>

      <section>
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
          Recent risk decisions
        </h2>
        {data.decisions.length === 0 ? (
          <p style={{ fontSize: 13, color: "var(--color-fg-muted)" }}>
            No decisions logged yet.
          </p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr>
                <Th>When</Th>
                <Th>Decision</Th>
                <Th>Reason</Th>
                <Th align="right">Stake</Th>
                <Th align="right">Potential</Th>
              </tr>
            </thead>
            <tbody>
              {data.decisions.map((d) => (
                <tr key={d.id}>
                  <Td>{new Date(d.createdAt).toLocaleString()}</Td>
                  <Td>{d.decision}</Td>
                  <Td>{d.reasonMessage ?? "—"}</Td>
                  <Td align="right" mono>
                    {fromMicro(BigInt(d.stakeMicro))}
                  </Td>
                  <Td align="right" mono>
                    {fromMicro(BigInt(d.potentialPayoutMicro))}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
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
      <span style={{ fontSize: 18, fontVariantNumeric: "tabular-nums" }}>{value}</span>
      {sub && <span style={{ fontSize: 12, color: "var(--color-fg-muted)" }}>{sub}</span>}
    </div>
  );
}

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
