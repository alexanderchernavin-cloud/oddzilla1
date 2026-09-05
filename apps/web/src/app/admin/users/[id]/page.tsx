import { notFound } from "next/navigation";
import Link from "next/link";
import { fromMicro, fromMicroMoney } from "@oddzilla/types/money";
import {
  BETTOR_LABELS,
  riskFactorToPercent,
  type BettorLabel,
} from "@oddzilla/types/bettor-labels";
import { serverApi } from "@/lib/server-fetch";
import { readRzCurrencyFromSearchParams, type RzCurrency } from "@/app/admin/riskzilla/currency";
import { NotesEditor } from "@/app/admin/riskzilla/bettors/[id]/notes-editor";
import {
  BehaviourPanel,
  type BehaviourProfileDto,
} from "@/app/admin/riskzilla/bettors/[id]/behaviour-panel";
import { BettorAuditLog } from "@/components/admin/bettor-audit-log";
import { SEVERITY_COLOR } from "@/components/admin/alerts-banner";
import type { AlertDto, AlertListResponse } from "@/app/admin/alerts/alerts-client";
import { LabelChip } from "../label-chip";
import { UserEditForm } from "./user-edit-form";
import { DeleteUserButton } from "./delete-user-button";
import { AdjustBalanceForm } from "./adjust-balance-form";
import { ZillapassStageForm } from "./zillapass-stage-form";
import { LabelsEditor } from "./labels-editor";
import { ConstraintsEditor } from "./constraints-editor";

// ── DTOs ─────────────────────────────────────────────────────────────

interface OddsAdjustmentSummary {
  global: { adjustmentBp: number } | null;
  counts: { sport: number; tournament: number; match: number };
}

interface PromoVisibilitySummaryKind {
  global: { visible: boolean } | null;
  counts: { sport: number; tournament: number; match: number };
}

interface PromoVisibilitySummary {
  zillaflash: PromoVisibilitySummaryKind;
  combi_boost: PromoVisibilitySummaryKind;
}

interface DetailResponse {
  user: {
    id: string;
    email: string;
    status: "active" | "blocked" | "pending_kyc";
    role: "user" | "admin" | "support";
    kycStatus: "none" | "pending" | "approved" | "rejected";
    displayName: string | null;
    nickname: string | null;
    countryCode: string | null;
    globalLimitMicro: string;
    betDelaySeconds: number;
    notes: string | null;
    labels: string[];
    riskScore: string;
    emailVerifiedAt: string | null;
    createdAt: string;
    lastLoginAt: string | null;
    balanceMicro: string;
    lockedMicro: string;
  };
  identity: {
    devicesSeen: number;
    ipsSeen: number;
    sessionsTotal: number;
    sessionsActive: number;
    lastIp: string | null;
    lastUserAgent: string | null;
  };
  stats: {
    totalTickets: number;
    openTickets: number;
    settledTickets: number;
    totalStakeMicro: string;
    totalPayoutMicro: string;
  };
  recentTickets: Array<{
    id: string;
    status: string;
    stakeMicro: string;
    potentialPayoutMicro: string;
    actualPayoutMicro: string | null;
    placedAt: string;
    settledAt: string | null;
  }>;
  zillapass: {
    currentSetNumber: number;
    lastSetCompletedDate: string | null;
  };
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

interface RiskProfile {
  currency: string;
  wallets: Array<{ currency: string; balanceMicro: string; lockedMicro: string }>;
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
    avgOdds: number | null;
    avgStakeMicro: string;
    maxStakeMicro: string;
    rejectedCount: number;
    winRate: number;
    lastBetAt: string | null;
  };
  pnlByPhase: { live: PhaseStats; prematch: PhaseStats };
  pnlBySport: SportStats[];
  biggestStakes: Array<{
    ticketId: string;
    status: string;
    betType: string;
    stakeMicro: string;
    potentialPayoutMicro: string;
    actualPayoutMicro: string;
    placedAt: string;
    settledAt: string | null;
  }>;
  biggestWins: Array<{
    ticketId: string;
    betType: string;
    stakeMicro: string;
    payoutMicro: string;
    netMicro: string;
    settledAt: string | null;
  }>;
  decisions: Array<{
    id: string;
    decision: string;
    reasonMessage: string | null;
    stakeMicro: string;
    potentialPayoutMicro: string;
    createdAt: string;
  }>;
  behaviour: BehaviourProfileDto;
}

const TABS = [
  { key: "overview", label: "Overview" },
  { key: "bets", label: "Bets" },
  { key: "settings", label: "Settings" },
  { key: "log", label: "Log" },
] as const;
type Tab = (typeof TABS)[number]["key"];

function isLabel(v: string): v is BettorLabel {
  return (BETTOR_LABELS as readonly string[]).includes(v);
}

function formatBpPct(bp: number): string {
  if (bp === 0) return "0.00%";
  const sign = bp > 0 ? "+" : "−";
  return `${sign}${(Math.abs(bp) / 100).toFixed(2)}%`;
}

function summarisePromoKind(s: PromoVisibilitySummaryKind): string {
  const total = s.counts.sport + s.counts.tournament + s.counts.match;
  if (!s.global && total === 0) return "default on";
  const globalLabel = s.global ? (s.global.visible ? "On" : "Off") : "default on";
  if (total === 0) return globalLabel;
  return `${globalLabel} · ${total} override${total === 1 ? "" : "s"}`;
}

function pct(num: number, den: number, digits = 1): string {
  if (den <= 0) return "—";
  return `${((num / den) * 100).toFixed(digits)}%`;
}

function holdPct(pnl: bigint, turnover: bigint): string {
  if (turnover <= 0n) return "—";
  // One-decimal percentage without float drift on big micro values.
  const bp = (pnl * 10000n) / turnover;
  return `${(Number(bp) / 100).toFixed(1)}%`;
}

function signedMoney(m: bigint, cur: string): string {
  return `${m > 0n ? "+" : ""}${fromMicroMoney(m)} ${cur}`;
}

function fmtDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString() : "—";
}

function fmtDateTime(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : "—";
}

// ── Page ─────────────────────────────────────────────────────────────

export default async function UserDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const currency = readRzCurrencyFromSearchParams(sp);
  const rawTab = Array.isArray(sp.tab) ? sp.tab[0] : sp.tab;
  const tab: Tab = (TABS.some((t) => t.key === rawTab) ? rawTab : "overview") as Tab;

  const data = await serverApi<DetailResponse>(`/admin/users/${id}`);
  if (!data) notFound();
  const { user, identity, recentTickets, zillapass } = data;
  const isBettor = user.role === "user";

  const [profile, oddsAdjustment, promoVisibility, alertList] = isBettor
    ? await Promise.all([
        serverApi<RiskProfile>(`/admin/riskzilla/bettors/${id}?currency=${currency}`),
        serverApi<OddsAdjustmentSummary>(`/admin/users/${id}/odds-adjustment`),
        serverApi<PromoVisibilitySummary>(`/admin/users/${id}/promo-visibility`),
        serverApi<AlertListResponse>(`/admin/riskzilla/alerts?userId=${id}&status=all&limit=25`),
      ])
    : [null, null, null, null];
  const alerts = alertList?.entries ?? [];
  const activeAlerts = alerts.filter((a) => a.status !== "resolved");

  const backHref = isBettor ? "/admin/users" : "/admin/admins";
  const backLabel = isBettor ? "Bettors" : "Admins";
  const labels = user.labels.filter(isLabel);
  const rf = Number(user.riskScore);

  const buildHref = (t: Tab, c: RzCurrency) => {
    const qs = new URLSearchParams();
    if (t !== "overview") qs.set("tab", t);
    if (c !== "USDC") qs.set("cur", c);
    const s = qs.toString();
    return `/admin/users/${user.id}${s ? `?${s}` : ""}`;
  };

  return (
    <div>
      <nav className="text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
        <Link href={backHref} className="hover:text-[var(--color-fg)]">
          {backLabel}
        </Link>{" "}
        /{" "}
        <span className="normal-case tracking-normal text-[var(--color-fg)]">{user.email}</span>
      </nav>

      <header className="mt-3 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">
              {user.nickname ?? user.displayName ?? user.email}
            </h1>
            <StatusChip status={user.status} />
            {labels.map((l) => (
              <LabelChip key={l} label={l} />
            ))}
            {activeAlerts.length > 0 ? (
              <Link
                href={`/admin/alerts?userId=${user.id}`}
                className="rounded-full border px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em]"
                style={{
                  borderColor: SEVERITY_COLOR[activeAlerts[0]!.severity],
                  color: SEVERITY_COLOR[activeAlerts[0]!.severity],
                }}
                title="Open alerts about this bettor"
              >
                {activeAlerts.length} active alert{activeAlerts.length === 1 ? "" : "s"}
              </Link>
            ) : null}
          </div>
          <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
            {user.email}
            {" · joined "}
            {fmtDate(user.createdAt)}
            {user.lastLoginAt ? <> · last login {fmtDate(user.lastLoginAt)}</> : null}
          </p>
          <p className="mt-1 font-mono text-xs text-[var(--color-fg-subtle)]">{user.id}</p>
        </div>
        {isBettor ? (
          <div className="flex items-center gap-3 text-xs">
            <span className="uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">Currency</span>
            <div className="flex overflow-hidden rounded-[8px] border border-[var(--color-border-strong)]">
              {(["USDC", "OZ"] as RzCurrency[]).map((c) => (
                <Link
                  key={c}
                  href={buildHref(tab, c)}
                  className={
                    "px-3 py-1.5 font-mono " +
                    (c === currency
                      ? "bg-[var(--color-fg)] text-[var(--color-bg)]"
                      : "text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]")
                  }
                >
                  {c}
                </Link>
              ))}
            </div>
          </div>
        ) : null}
      </header>

      {!isBettor ? (
        <AdminAccountBody user={user} />
      ) : (
        <>
          <nav className="mt-6 flex gap-1 border-b border-[var(--color-border)]">
            {TABS.map((t) => (
              <Link
                key={t.key}
                href={buildHref(t.key, currency)}
                className={
                  "-mb-px border-b-2 px-3 py-2 text-sm " +
                  (t.key === tab
                    ? "border-[var(--color-fg)] text-[var(--color-fg)]"
                    : "border-transparent text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]")
                }
              >
                {t.label}
              </Link>
            ))}
          </nav>

          {tab === "overview" ? (
            <OverviewTab user={user} identity={identity} profile={profile} currency={currency} rf={rf} />
          ) : null}
          {tab === "bets" ? (
            <BetsTab
              userId={user.id}
              recentTickets={recentTickets}
              profile={profile}
              currency={currency}
            />
          ) : null}
          {tab === "settings" ? (
            <SettingsTab
              user={user}
              zillapass={zillapass}
              oddsAdjustment={oddsAdjustment}
              promoVisibility={promoVisibility}
            />
          ) : null}
          {tab === "log" ? (
            <LogTab userId={user.id} profile={profile} currency={currency} alerts={alerts} />
          ) : null}
        </>
      )}
    </div>
  );
}

// ── Tabs ─────────────────────────────────────────────────────────────

function OverviewTab({
  user,
  identity,
  profile,
  currency,
  rf,
}: {
  user: DetailResponse["user"];
  identity: DetailResponse["identity"];
  profile: RiskProfile | null;
  currency: RzCurrency;
  rf: number;
}) {
  const s = profile?.stats;
  const turnover = BigInt(s?.stakedMicro ?? "0");
  const pnl = BigInt(s?.operatorPnlMicro ?? "0");
  const settled = (s?.wonCount ?? 0) + (s?.lostCount ?? 0);
  const liveTickets = profile?.pnlByPhase.live.ticketsCount ?? 0;
  const totalTickets = s?.ticketsCount ?? 0;
  const openLoss = BigInt(s?.openMaxLossMicro ?? "0");
  const wallet = profile?.wallets.find((w) => w.currency === currency);

  return (
    <div className="mt-6 flex flex-col gap-8">
      {!profile ? (
        <p className="text-sm text-[var(--color-negative)]">
          Risk profile unavailable. KPIs and PnL are hidden until the RiskZilla endpoint answers.
        </p>
      ) : null}

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <Kpi
          label="Turnover"
          value={`${fromMicroMoney(turnover)} ${currency}`}
          sub={`${totalTickets} tickets`}
        />
        <Kpi
          label="Company PnL"
          value={signedMoney(pnl, currency)}
          tone={pnl > 0n ? "positive" : pnl < 0n ? "negative" : undefined}
          sub={`hold ${holdPct(pnl, turnover)}`}
        />
        <Kpi
          label="Win rate"
          value={pct(s?.wonCount ?? 0, settled, 0)}
          sub={`${s?.wonCount ?? 0}/${settled} settled · live ${pct(liveTickets, totalTickets, 0)}`}
        />
        <Kpi
          label="Avg odds"
          value={s?.avgOdds == null ? "—" : s.avgOdds.toFixed(2)}
          sub={`reject rate ${pct(s?.rejectedCount ?? 0, totalTickets, 1)}`}
        />
        <Kpi
          label="Avg / max stake"
          value={`${fromMicroMoney(BigInt(s?.avgStakeMicro ?? "0"))} ${currency}`}
          sub={`max ${fromMicroMoney(BigInt(s?.maxStakeMicro ?? "0"))} ${currency}`}
        />
        <Kpi
          label="Open exposure"
          value={`${fromMicroMoney(openLoss)} ${currency}`}
          sub={`${s?.openCount ?? 0} open · ${fromMicroMoney(BigInt(s?.openPotentialPayoutMicro ?? "0"))} potential`}
        />
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <Card title="Identity">
          <dl className="grid grid-cols-[minmax(120px,auto)_1fr] gap-x-6 gap-y-2 text-sm">
            <Field label="Bettor ID" mono>
              {user.id}
            </Field>
            <Field label="Email">
              {user.email}{" "}
              <span className="ml-2 text-xs text-[var(--color-fg-subtle)]">
                {user.emailVerifiedAt ? `verified ${fmtDate(user.emailVerifiedAt)}` : "unverified"}
              </span>
            </Field>
            <Field label="Nickname">{user.nickname ?? user.displayName ?? "—"}</Field>
            <Field label="Country">{user.countryCode ?? "—"}</Field>
            <Field label="KYC">
              <span className="text-xs uppercase tracking-[0.12em]">{user.kycStatus}</span>
            </Field>
            <Field label="Devices / IPs seen" mono>
              {identity.devicesSeen} / {identity.ipsSeen}{" "}
              <span className="ml-2 text-xs text-[var(--color-fg-subtle)]">
                {identity.sessionsActive} active of {identity.sessionsTotal} sessions
              </span>
            </Field>
            <Field label="Last IP" mono>
              {identity.lastIp ?? "—"}
            </Field>
            <Field label="Last agent">
              <span
                className="block truncate text-xs text-[var(--color-fg-muted)]"
                title={identity.lastUserAgent ?? ""}
              >
                {identity.lastUserAgent ?? "—"}
              </span>
            </Field>
            <Field label="Wallet" mono>
              {wallet
                ? `${fromMicroMoney(BigInt(wallet.balanceMicro))} ${currency} · ${fromMicroMoney(BigInt(wallet.lockedMicro))} locked`
                : `0 ${currency}`}
              {currency === "USDC" ? null : (
                <span className="ml-2 text-xs text-[var(--color-fg-subtle)]">
                  USDC {fromMicroMoney(BigInt(user.balanceMicro))}
                </span>
              )}
            </Field>
            <Field label="Joined">{fmtDateTime(user.createdAt)}</Field>
            <Field label="Last login">{fmtDateTime(user.lastLoginAt)}</Field>
            <Field label="Last bet">{fmtDateTime(s?.lastBetAt ?? null)}</Field>
          </dl>
        </Card>

        <Card
          title="Global constraints"
          aside={
            <span className="font-mono text-xs text-[var(--color-fg-muted)]">
              risk factor {rf.toFixed(1)} · {riskFactorToPercent(rf)}%
            </span>
          }
        >
          <ConstraintsEditor
            userId={user.id}
            riskScore={user.riskScore}
            globalLimitMicro={user.globalLimitMicro}
            betDelaySeconds={user.betDelaySeconds}
            status={user.status}
          />
        </Card>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <Card title="Labels">
          <LabelsEditor userId={user.id} initial={user.labels} />
        </Card>
        <Card title="Operator notes">
          <NotesEditor userId={user.id} initial={user.notes} />
        </Card>
      </section>

      {profile ? (
        <>
          <Card
            title="PnL by sport"
            aside={
              <span className="text-xs text-[var(--color-fg-muted)]">
                settled tickets, {currency}, combo legs pro-rated
              </span>
            }
          >
            {profile.pnlBySport.length === 0 ? (
              <p className="text-sm text-[var(--color-fg-muted)]">No tickets yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead>
                    <tr className="border-b border-[var(--color-border)] text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
                      <th className="px-3 py-2 text-left font-normal">Sport</th>
                      <th className="px-3 py-2 text-right font-normal">Tickets</th>
                      <th className="px-3 py-2 text-right font-normal">Won</th>
                      <th className="px-3 py-2 text-right font-normal">Turnover</th>
                      <th className="px-3 py-2 text-right font-normal">Company PnL</th>
                      <th className="px-3 py-2 text-right font-normal">Hold</th>
                    </tr>
                  </thead>
                  <tbody>
                    {profile.pnlBySport.map((row) => {
                      const rowPnl = BigInt(row.operatorPnlMicro);
                      const rowTurnover = BigInt(row.stakedMicro);
                      return (
                        <tr
                          key={row.sportSlug}
                          className="border-b border-[var(--color-border)] last:border-b-0"
                        >
                          <td className="px-3 py-2">
                            <Link href={`/admin/logs/sports/${row.sportSlug}`} className="hover:underline">
                              {row.sportName}
                            </Link>
                          </td>
                          <td className="px-3 py-2 text-right font-mono">{row.ticketCount}</td>
                          <td className="px-3 py-2 text-right font-mono text-[var(--color-fg-muted)]">
                            {row.wonCount}
                          </td>
                          <td className="px-3 py-2 text-right font-mono">{fromMicroMoney(rowTurnover)}</td>
                          <td
                            className={
                              "px-3 py-2 text-right font-mono " +
                              (rowPnl > 0n
                                ? "text-[var(--color-positive)]"
                                : rowPnl < 0n
                                  ? "text-[var(--color-negative)]"
                                  : "")
                            }
                          >
                            {rowPnl > 0n ? "+" : ""}
                            {fromMicroMoney(rowPnl)}
                          </td>
                          <td className="px-3 py-2 text-right font-mono text-[var(--color-fg-muted)]">
                            {holdPct(rowPnl, rowTurnover)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <section className="grid gap-4 md:grid-cols-2">
            <PhaseCard label="Prematch" phase={profile.pnlByPhase.prematch} currency={currency} />
            <PhaseCard label="Live" phase={profile.pnlByPhase.live} currency={currency} />
          </section>
        </>
      ) : null}
    </div>
  );
}

function BetsTab({
  userId,
  recentTickets,
  profile,
  currency,
}: {
  userId: string;
  recentTickets: DetailResponse["recentTickets"];
  profile: RiskProfile | null;
  currency: RzCurrency;
}) {
  return (
    <div className="mt-6 flex flex-col gap-8">
      <Card
        title="Recent tickets"
        aside={
          <span className="flex items-center gap-3 text-xs text-[var(--color-fg-muted)]">
            last 20, all currencies
            <Link
              href={`/admin/riskzilla/bets?userId=${userId}${currency === "USDC" ? "" : `&cur=${currency}`}`}
              className="uppercase tracking-[0.15em] text-[var(--color-accent)] hover:underline"
            >
              Full ticket list
            </Link>
          </span>
        }
      >
        {recentTickets.length === 0 ? (
          <p className="text-sm text-[var(--color-fg-muted)]">None yet.</p>
        ) : (
          <ul className="divide-y divide-[var(--color-border)]">
            {recentTickets.map((t) => {
              const payout = t.actualPayoutMicro !== null ? BigInt(t.actualPayoutMicro) : null;
              const stake = BigInt(t.stakeMicro);
              const net = payout !== null ? payout - stake : null;
              return (
                <li key={t.id} className="flex items-center justify-between gap-4 py-3 text-sm">
                  <div className="min-w-0">
                    <p className="truncate font-mono text-xs text-[var(--color-fg-muted)]">{t.id}</p>
                    <p className="mt-1 text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
                      {t.status} · placed {fmtDateTime(t.placedAt)}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="font-mono">
                      {fromMicro(stake)} → {payout !== null ? fromMicro(payout) : "—"}
                    </p>
                    {net !== null ? (
                      <p
                        className={
                          "font-mono text-xs " +
                          (net >= 0n ? "text-[var(--color-positive)]" : "text-[var(--color-negative)]")
                        }
                      >
                        {net >= 0n ? "+" : ""}
                        {fromMicro(net)}
                      </p>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {profile ? (
        <section className="grid gap-4 lg:grid-cols-2">
          <Card title={`Biggest stakes (${currency})`}>
            {profile.biggestStakes.length === 0 ? (
              <p className="text-sm text-[var(--color-fg-muted)]">No tickets yet.</p>
            ) : (
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--color-border)] text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
                    <th className="px-3 py-2 text-left font-normal">When</th>
                    <th className="px-3 py-2 text-left font-normal">Type</th>
                    <th className="px-3 py-2 text-right font-normal">Stake</th>
                    <th className="px-3 py-2 text-right font-normal">Result</th>
                  </tr>
                </thead>
                <tbody>
                  {profile.biggestStakes.map((b) => {
                    const won =
                      b.status === "settled" && BigInt(b.actualPayoutMicro) > BigInt(b.stakeMicro);
                    const label = b.status === "settled" ? (won ? "won" : "lost") : b.status;
                    return (
                      <tr key={b.ticketId} className="border-b border-[var(--color-border)] last:border-b-0">
                        <td className="px-3 py-2">{fmtDate(b.placedAt)}</td>
                        <td className="px-3 py-2">{b.betType}</td>
                        <td className="px-3 py-2 text-right font-mono">
                          {fromMicroMoney(BigInt(b.stakeMicro))}
                        </td>
                        <td
                          className={
                            "px-3 py-2 text-right text-xs uppercase tracking-[0.12em] " +
                            (label === "won"
                              ? "text-[var(--color-positive)]"
                              : label === "lost"
                                ? "text-[var(--color-negative)]"
                                : "text-[var(--color-fg-muted)]")
                          }
                        >
                          {label}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </Card>
          <Card title="Biggest wins (USDC)">
            {profile.biggestWins.length === 0 ? (
              <p className="text-sm text-[var(--color-fg-muted)]">No winning settlements yet.</p>
            ) : (
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--color-border)] text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
                    <th className="px-3 py-2 text-left font-normal">When</th>
                    <th className="px-3 py-2 text-left font-normal">Type</th>
                    <th className="px-3 py-2 text-right font-normal">Stake</th>
                    <th className="px-3 py-2 text-right font-normal">Net win</th>
                  </tr>
                </thead>
                <tbody>
                  {profile.biggestWins.map((b) => (
                    <tr key={b.ticketId} className="border-b border-[var(--color-border)] last:border-b-0">
                      <td className="px-3 py-2">{fmtDate(b.settledAt)}</td>
                      <td className="px-3 py-2">{b.betType}</td>
                      <td className="px-3 py-2 text-right font-mono">{fromMicroMoney(BigInt(b.stakeMicro))}</td>
                      <td className="px-3 py-2 text-right font-mono text-[var(--color-positive)]">
                        +{fromMicroMoney(BigInt(b.netMicro))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </section>
      ) : null}
    </div>
  );
}

function SettingsTab({
  user,
  zillapass,
  oddsAdjustment,
  promoVisibility,
}: {
  user: DetailResponse["user"];
  zillapass: DetailResponse["zillapass"];
  oddsAdjustment: OddsAdjustmentSummary | null;
  promoVisibility: PromoVisibilitySummary | null;
}) {
  return (
    <div className="mt-6 flex flex-col gap-8">
      <Card
        title="Account"
        aside={
          <span className="text-xs text-[var(--color-fg-muted)]">
            role changes revoke live sessions
          </span>
        }
      >
        <UserEditForm user={user} />
      </Card>

      <Card title="Adjust balance">
        <AdjustBalanceForm userId={user.id} email={user.email} />
      </Card>

      <section className="grid gap-4 lg:grid-cols-2">
        <Card
          title="Odds adjustment"
          aside={
            <Link
              href={`/admin/users/${user.id}/odds-adjustment`}
              className="text-xs uppercase tracking-[0.15em] text-[var(--color-accent)] hover:underline"
            >
              Manage cascade
            </Link>
          }
        >
          <p className="text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
            Global default for this bettor
          </p>
          <p
            className="mt-2 font-mono text-2xl"
            style={{
              color:
                oddsAdjustment?.global && oddsAdjustment.global.adjustmentBp !== 0
                  ? "var(--color-fg)"
                  : "var(--color-fg-muted)",
            }}
          >
            {oddsAdjustment?.global ? formatBpPct(oddsAdjustment.global.adjustmentBp) : "no rule"}
          </p>
          <p className="mt-2 text-xs text-[var(--color-fg-muted)]">
            Per-scope overrides: {oddsAdjustment?.counts.sport ?? 0} sport ·{" "}
            {oddsAdjustment?.counts.tournament ?? 0} tournament ·{" "}
            {oddsAdjustment?.counts.match ?? 0} match
          </p>
        </Card>

        <Card
          title="Promo visibility"
          aside={
            <Link
              href={`/admin/users/${user.id}/promo-visibility`}
              className="text-xs uppercase tracking-[0.15em] text-[var(--color-accent)] hover:underline"
            >
              Manage cascade
            </Link>
          }
        >
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
            <Field label="ZillaFlash">
              {promoVisibility ? summarisePromoKind(promoVisibility.zillaflash) : "—"}
            </Field>
            <Field label="CombiBoost">
              {promoVisibility ? summarisePromoKind(promoVisibility.combi_boost) : "—"}
            </Field>
          </dl>
        </Card>
      </section>

      <Card title="ZillaPass stage">
        <ZillapassStageForm userId={user.id} initial={zillapass} />
      </Card>

      <Card title="Danger zone">
        <DeleteUserButton userId={user.id} email={user.email} />
      </Card>
    </div>
  );
}

function LogTab({
  userId,
  profile,
  currency,
  alerts,
}: {
  userId: string;
  profile: RiskProfile | null;
  currency: RzCurrency;
  alerts: AlertDto[];
}) {
  return (
    <div className="mt-6 flex flex-col gap-8">
      <Card
        title="Alerts about this bettor"
        aside={
          <Link
            href={`/admin/alerts?userId=${userId}`}
            className="text-xs uppercase tracking-[0.15em] text-[var(--color-accent)] hover:underline"
          >
            Alert center
          </Link>
        }
      >
        {alerts.length === 0 ? (
          <p className="text-sm text-[var(--color-fg-muted)]">No alerts raised for this account.</p>
        ) : (
          <ul className="divide-y divide-[var(--color-border)] text-sm">
            {alerts.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-3 py-2">
                <span
                  className="rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em]"
                  style={{ borderColor: SEVERITY_COLOR[a.severity], color: SEVERITY_COLOR[a.severity] }}
                >
                  {a.severity}
                </span>
                <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--color-fg-subtle)]">
                  {a.kindLabel}
                </span>
                <span className="min-w-0 flex-1">{a.title}</span>
                <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--color-fg-muted)]">
                  {a.status}
                </span>
                <span className="text-xs text-[var(--color-fg-subtle)]">{fmtDateTime(a.lastSeenAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card
        title="Admin activity"
        aside={<span className="text-xs text-[var(--color-fg-muted)]">tamper-evident audit chain</span>}
      >
        <BettorAuditLog userId={userId} />
      </Card>

      {profile ? (
        <>
          <Card title={`Recent risk decisions (${currency})`}>
            {profile.decisions.length === 0 ? (
              <p className="text-sm text-[var(--color-fg-muted)]">No decisions logged yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead>
                    <tr className="border-b border-[var(--color-border)] text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
                      <th className="px-3 py-2 text-left font-normal">When</th>
                      <th className="px-3 py-2 text-left font-normal">Decision</th>
                      <th className="px-3 py-2 text-left font-normal">Reason</th>
                      <th className="px-3 py-2 text-right font-normal">Stake</th>
                      <th className="px-3 py-2 text-right font-normal">Potential</th>
                    </tr>
                  </thead>
                  <tbody>
                    {profile.decisions.map((d) => (
                      <tr key={d.id} className="border-b border-[var(--color-border)] last:border-b-0">
                        <td className="whitespace-nowrap px-3 py-2">{fmtDateTime(d.createdAt)}</td>
                        <td
                          className={
                            "px-3 py-2 font-mono text-xs " +
                            (d.decision === "accepted" ? "" : "text-[var(--color-negative)]")
                          }
                        >
                          {d.decision}
                        </td>
                        <td className="px-3 py-2 text-[var(--color-fg-muted)]">{d.reasonMessage ?? "—"}</td>
                        <td className="px-3 py-2 text-right font-mono">
                          {fromMicroMoney(BigInt(d.stakeMicro))}
                        </td>
                        <td className="px-3 py-2 text-right font-mono">
                          {fromMicroMoney(BigInt(d.potentialPayoutMicro))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card
            title="Automation signals"
            aside={
              <Link
                href="/admin/riskzilla/bot-controls"
                className="text-xs uppercase tracking-[0.15em] text-[var(--color-accent)] hover:underline"
              >
                Bot controls
              </Link>
            }
          >
            <BehaviourPanel userId={userId} initial={profile.behaviour} />
          </Card>
        </>
      ) : null}
    </div>
  );
}

// Admin / support rows share the route but not the sportsbook profile:
// no tickets, no risk factor. Keep the operator controls and the audit
// trail only.
function AdminAccountBody({ user }: { user: DetailResponse["user"] }) {
  return (
    <div className="mt-6 flex flex-col gap-8">
      <Card title="Account controls">
        <UserEditForm user={user} />
      </Card>
      <Card title="Danger zone">
        <DeleteUserButton userId={user.id} email={user.email} />
      </Card>
      <Card title="Admin activity">
        <BettorAuditLog userId={user.id} />
      </Card>
    </div>
  );
}

// ── Building blocks ──────────────────────────────────────────────────

function Kpi({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "positive" | "negative";
}) {
  const toneClass =
    tone === "positive"
      ? "text-[var(--color-positive)]"
      : tone === "negative"
        ? "text-[var(--color-negative)]"
        : "";
  return (
    <div className="card p-4">
      <p className="text-[10px] uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">{label}</p>
      <p
        className={"mt-2 truncate font-mono text-xl " + toneClass}
        style={{ fontVariantNumeric: "tabular-nums" }}
      >
        {value}
      </p>
      {sub ? <p className="mt-1 truncate text-xs text-[var(--color-fg-muted)]">{sub}</p> : null}
    </div>
  );
}

function Card({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="card p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xs uppercase tracking-[0.18em] text-[var(--color-fg-subtle)]">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Field({
  label,
  mono,
  children,
}: {
  label: string;
  mono?: boolean;
  children: React.ReactNode;
}) {
  return (
    <>
      <dt className="self-center text-xs uppercase tracking-[0.12em] text-[var(--color-fg-subtle)]">
        {label}
      </dt>
      <dd className={"min-w-0 " + (mono ? "font-mono text-xs" : "")} style={{ overflowWrap: "anywhere" }}>
        {children}
      </dd>
    </>
  );
}

function StatusChip({ status }: { status: DetailResponse["user"]["status"] }) {
  const color =
    status === "active"
      ? "var(--color-positive)"
      : status === "blocked"
        ? "var(--color-negative)"
        : "var(--color-warning)";
  return (
    <span
      className="rounded-full border px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em]"
      style={{ borderColor: color, color }}
    >
      {status}
    </span>
  );
}

function PhaseCard({
  label,
  phase,
  currency,
}: {
  label: string;
  phase: PhaseStats;
  currency: string;
}) {
  const stake = BigInt(phase.stakedMicro);
  const pnl = BigInt(phase.operatorPnlMicro);
  return (
    <div className="card p-5">
      <h2 className="text-xs uppercase tracking-[0.18em] text-[var(--color-fg-subtle)]">{label}</h2>
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-sm">
        <Field label="Tickets" mono>
          {phase.ticketsCount} <span className="text-[var(--color-fg-muted)]">· {phase.wonCount} won</span>
        </Field>
        <Field label="Turnover" mono>
          {fromMicroMoney(stake)} {currency}
        </Field>
        <Field label="Company PnL" mono>
          <span
            className={
              pnl > 0n ? "text-[var(--color-positive)]" : pnl < 0n ? "text-[var(--color-negative)]" : ""
            }
          >
            {signedMoney(pnl, currency)}
          </span>
        </Field>
        <Field label="Hold" mono>
          {holdPct(pnl, stake)}
        </Field>
      </dl>
    </div>
  );
}
