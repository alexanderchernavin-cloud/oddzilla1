import Link from "next/link";
import { notFound } from "next/navigation";
import { serverApi } from "@/lib/server-fetch";
import { fromMicroMoney } from "@oddzilla/types/money";
import { RsEditor } from "./rs-editor";
import { readRzCurrencyFromSearchParams } from "../../currency";

export const dynamic = "force-dynamic";

interface WalletDto {
  currency: string;
  balanceMicro: string;
  lockedMicro: string;
}

interface PhaseStats {
  ticketsCount: number;
  wonCount: number;
  stakedMicro: string;
  payoutMicro: string;
  operatorPnlMicro: string;
}

interface SportStats {
  sportSlug: string;
  sportName: string;
  ticketCount: number;
  wonCount: number;
  stakedMicro: string;
  payoutMicro: string;
  operatorPnlMicro: string;
}

interface BiggestStake {
  ticketId: string;
  status: string;
  betType: string;
  stakeMicro: string;
  potentialPayoutMicro: string;
  actualPayoutMicro: string;
  placedAt: string;
  settledAt: string | null;
}

interface BiggestWin {
  ticketId: string;
  betType: string;
  stakeMicro: string;
  payoutMicro: string;
  netMicro: string;
  settledAt: string | null;
}

interface BettorProfile {
  currency: string;
  id: string;
  email: string;
  nickname: string | null;
  status: string;
  riskScore: string;
  createdAt: string;
  lastLoginAt: string | null;
  wallets: WalletDto[];
  stats: {
    ticketsCount: number;
    wonCount: number;
    lostCount: number;
    openCount: number;
    stakedMicro: string;
    payoutMicro: string;
    operatorPnlMicro: string;
    openMaxLossMicro: string;
    openPotentialPayoutMicro: string;
    winRate: number;
    lastBetAt: string | null;
  };
  pnlByPhase: { live: PhaseStats; prematch: PhaseStats };
  pnlBySport: SportStats[];
  biggestStakes: BiggestStake[];
  biggestWins: BiggestWin[];
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
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const currency = readRzCurrencyFromSearchParams(sp);
  const data = await serverApi<BettorProfile>(
    `/admin/riskzilla/bettors/${id}?currency=${currency}`,
  );
  if (!data) notFound();

  const usdcWallet = data.wallets.find((w) => w.currency === "USDC");
  const ozWallet = data.wallets.find((w) => w.currency === "OZ");
  const cur = data.currency;
  const backHref = `/admin/riskzilla/bettors${cur === "USDC" ? "" : `?cur=${cur}`}`;

  const totalStake = fromMicroMoney(BigInt(data.stats.stakedMicro));
  const totalPayout = fromMicroMoney(BigInt(data.stats.payoutMicro));
  const pnlMicro = BigInt(data.stats.operatorPnlMicro);
  const pnlForBettor = -pnlMicro; // bettor's PnL is the inverse of operator's
  const openLoss = fromMicroMoney(BigInt(data.stats.openMaxLossMicro));
  const openPotential = fromMicroMoney(BigInt(data.stats.openPotentialPayoutMicro));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
      <Link
        href={backHref}
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

      <Section title="Wallets">
        {data.wallets.length === 0 ? (
          <Empty>No wallets — user has never been credited.</Empty>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
            {usdcWallet && (
              <Kpi
                label="USDC balance"
                value={`${fromMicroMoney(BigInt(usdcWallet.balanceMicro))} USDC`}
                sub={`${fromMicroMoney(BigInt(usdcWallet.lockedMicro))} locked`}
              />
            )}
            {ozWallet && (
              <Kpi
                label="OZ balance (demo)"
                value={`${fromMicroMoney(BigInt(ozWallet.balanceMicro))} OZ`}
                sub={`${fromMicroMoney(BigInt(ozWallet.lockedMicro))} locked`}
              />
            )}
            {data.wallets
              .filter((w) => w.currency !== "USDC" && w.currency !== "OZ")
              .map((w) => (
                <Kpi
                  key={w.currency}
                  label={`${w.currency} balance`}
                  value={`${fromMicroMoney(BigInt(w.balanceMicro))} ${w.currency}`}
                  sub={`${fromMicroMoney(BigInt(w.lockedMicro))} locked`}
                />
              ))}
          </div>
        )}
      </Section>

      <Section title={`Lifetime activity (${cur})`}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
          <Kpi
            label="Tickets"
            value={String(data.stats.ticketsCount)}
            sub={`${data.stats.wonCount} won · ${data.stats.lostCount} lost · ${data.stats.openCount} open`}
          />
          <Kpi
            label="Win rate"
            value={`${(data.stats.winRate * 100).toFixed(1)}%`}
          />
          <Kpi label="Staked" value={`${totalStake} ${cur}`} />
          <Kpi label="Paid out" value={`${totalPayout} ${cur}`} />
          <Kpi
            label="Bettor PnL"
            value={`${pnlForBettor >= 0n ? "+" : ""}${fromMicroMoney(pnlForBettor)} ${cur}`}
            valueColor={pnlForBettor >= 0n ? "#16a34a" : "#dc2626"}
            sub={pnlForBettor >= 0n ? "Bettor ahead" : "Bettor down"}
          />
          <Kpi
            label="Open exposure"
            value={`${openLoss} ${cur}`}
            sub={`${openPotential} ${cur} potential payout`}
          />
          <Kpi
            label="Last bet"
            value={
              data.stats.lastBetAt
                ? new Date(data.stats.lastBetAt).toLocaleDateString()
                : "—"
            }
            sub={
              data.stats.lastBetAt
                ? new Date(data.stats.lastBetAt).toLocaleTimeString()
                : undefined
            }
          />
        </div>
      </Section>

      <Section title="Live vs prematch">
        <p style={{ fontSize: 12, color: "var(--color-fg-muted)", margin: "0 0 12px" }}>
          Tickets are classified by whether <em>any</em> leg was already
          live (match started) at placement time.
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <PhaseCard label="Prematch" phase={data.pnlByPhase.prematch} />
          <PhaseCard label="In-play" phase={data.pnlByPhase.live} />
        </div>
      </Section>

      <Section title="By sport">
        {data.pnlBySport.length === 0 ? (
          <Empty>No settled tickets yet.</Empty>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <Th>Sport</Th>
                <Th align="right">Tickets</Th>
                <Th align="right">Won</Th>
                <Th align="right">Staked</Th>
                <Th align="right">Paid out</Th>
                <Th align="right">Bettor PnL</Th>
              </tr>
            </thead>
            <tbody>
              {data.pnlBySport.map((s) => {
                const bettorPnl = -BigInt(s.operatorPnlMicro);
                return (
                  <tr key={s.sportSlug}>
                    <Td>{s.sportName}</Td>
                    <Td align="right" mono>{s.ticketCount}</Td>
                    <Td align="right" mono>{s.wonCount}</Td>
                    <Td align="right" mono>{fromMicroMoney(BigInt(s.stakedMicro))}</Td>
                    <Td align="right" mono>{fromMicroMoney(BigInt(s.payoutMicro))}</Td>
                    <Td
                      align="right"
                      mono
                      color={bettorPnl >= 0n ? "#16a34a" : "#dc2626"}
                    >
                      {bettorPnl >= 0n ? "+" : ""}
                      {fromMicroMoney(bettorPnl)}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Section>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }}>
        <Section title="Biggest stakes">
          {data.biggestStakes.length === 0 ? (
            <Empty>No tickets yet.</Empty>
          ) : (
            <table style={tableStyle}>
              <thead>
                <tr>
                  <Th>When</Th>
                  <Th>Type</Th>
                  <Th align="right">Stake</Th>
                  <Th align="right">Status</Th>
                </tr>
              </thead>
              <tbody>
                {data.biggestStakes.map((b) => (
                  <tr key={b.ticketId}>
                    <Td>{new Date(b.placedAt).toLocaleDateString()}</Td>
                    <Td>{b.betType}</Td>
                    <Td align="right" mono>
                      {fromMicroMoney(BigInt(b.stakeMicro))}
                    </Td>
                    <Td>
                      <StatusBadge
                        status={b.status}
                        win={
                          b.status === "settled" &&
                          BigInt(b.actualPayoutMicro) > BigInt(b.stakeMicro)
                        }
                      />
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>

        <Section title="Biggest wins">
          {data.biggestWins.length === 0 ? (
            <Empty>No winning settlements yet.</Empty>
          ) : (
            <table style={tableStyle}>
              <thead>
                <tr>
                  <Th>When</Th>
                  <Th>Type</Th>
                  <Th align="right">Stake</Th>
                  <Th align="right">Net win</Th>
                </tr>
              </thead>
              <tbody>
                {data.biggestWins.map((b) => (
                  <tr key={b.ticketId}>
                    <Td>
                      {b.settledAt
                        ? new Date(b.settledAt).toLocaleDateString()
                        : "—"}
                    </Td>
                    <Td>{b.betType}</Td>
                    <Td align="right" mono>
                      {fromMicroMoney(BigInt(b.stakeMicro))}
                    </Td>
                    <Td align="right" mono color="#16a34a">
                      +{fromMicroMoney(BigInt(b.netMicro))}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>
      </div>

      <Section title="Recent risk decisions">
        {data.decisions.length === 0 ? (
          <Empty>No decisions logged yet.</Empty>
        ) : (
          <table style={tableStyle}>
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
                    {fromMicroMoney(BigInt(d.stakeMicro))}
                  </Td>
                  <Td align="right" mono>
                    {fromMicroMoney(BigInt(d.potentialPayoutMicro))}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2
        className="mono"
        style={{
          fontSize: 11,
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          color: "var(--color-fg-subtle)",
          margin: "0 0 12px 0",
        }}
      >
        {title}
      </h2>
      {children}
    </section>
  );
}

function PhaseCard({ label, phase }: { label: string; phase: PhaseStats }) {
  const stake = BigInt(phase.stakedMicro);
  const payout = BigInt(phase.payoutMicro);
  const bettorPnl = payout - stake;
  return (
    <div
      style={{
        background: "var(--color-bg-subtle)",
        border: "1px solid var(--color-border)",
        borderRadius: 10,
        padding: "14px 16px",
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gap: 6,
      }}
    >
      <span
        className="mono"
        style={{
          fontSize: 11,
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          color: "var(--color-fg-subtle)",
          gridColumn: "1 / -1",
        }}
      >
        {label}
      </span>
      <span style={{ fontSize: 12, color: "var(--color-fg-muted)" }}>Tickets</span>
      <span style={{ fontVariantNumeric: "tabular-nums", textAlign: "right", fontSize: 13 }}>
        {phase.ticketsCount} <span style={{ color: "var(--color-fg-muted)" }}>· {phase.wonCount} won</span>
      </span>
      <span style={{ fontSize: 12, color: "var(--color-fg-muted)" }}>Staked</span>
      <span style={{ fontVariantNumeric: "tabular-nums", textAlign: "right", fontSize: 13 }}>
        {fromMicroMoney(stake)}
      </span>
      <span style={{ fontSize: 12, color: "var(--color-fg-muted)" }}>Paid out</span>
      <span style={{ fontVariantNumeric: "tabular-nums", textAlign: "right", fontSize: 13 }}>
        {fromMicroMoney(payout)}
      </span>
      <span style={{ fontSize: 12, color: "var(--color-fg-muted)" }}>Bettor PnL</span>
      <span
        style={{
          fontVariantNumeric: "tabular-nums",
          textAlign: "right",
          fontSize: 13,
          color: bettorPnl >= 0n ? "#16a34a" : "#dc2626",
        }}
      >
        {bettorPnl >= 0n ? "+" : ""}
        {fromMicroMoney(bettorPnl)}
      </span>
    </div>
  );
}

function StatusBadge({ status, win }: { status: string; win: boolean }) {
  const color =
    status === "accepted" || status === "pending_delay"
      ? "var(--color-fg-muted)"
      : win
        ? "#16a34a"
        : status === "settled"
          ? "#dc2626"
          : "var(--color-fg-muted)";
  const label = status === "settled" ? (win ? "won" : "lost") : status;
  return (
    <span
      className="mono"
      style={{
        fontSize: 11,
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        color,
      }}
    >
      {label}
    </span>
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
          fontSize: 18,
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

function Td({
  children,
  align,
  mono,
  color,
}: {
  children: React.ReactNode;
  align?: "right";
  mono?: boolean;
  color?: string;
}) {
  return (
    <td
      style={{
        textAlign: align ?? "left",
        padding: "6px 10px",
        borderBottom: "1px solid var(--color-border)",
        fontVariantNumeric: mono ? "tabular-nums" : "normal",
        color,
      }}
    >
      {children}
    </td>
  );
}
