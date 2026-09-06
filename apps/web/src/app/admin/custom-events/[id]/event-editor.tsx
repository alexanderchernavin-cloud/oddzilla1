"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { clientApi, ApiFetchError } from "@/lib/api-client";
// Subpath, never the barrel — a value import through the barrel type-checks
// and then fails `next build`. See packages/types/src/odds.ts.
import {
  bookKey,
  formatEventTitle,
  priceCustomMarket,
  type CustomPriceCell,
} from "@oddzilla/types/custom-events";

export interface OutcomeDetail {
  outcomeId: string;
  label: string;
  publishedOdds: string | null;
  probability: string | null;
  baseProbability: number | null;
  /** What the book owes if this outcome wins, micro units, USDC only. */
  exposureMicro: string;
  active: boolean;
  result: string | null;
}

export interface MarketDetail {
  id: string;
  name: string | null;
  status: number;
  specifiers: string;
  overroundBp: number;
  liabilityTrading: boolean;
  liabilityStrengthBp: number;
  liabilityMaxShiftBp: number;
  liabilityPricedAt: string | null;
  bookKey: number | null;
  outcomes: OutcomeDetail[];
}

export interface EventDetail {
  event: {
    id: string;
    providerUrn: string;
    homeTeam: string;
    awayTeam: string;
    scheduledAt: string | null;
    status: string;
    bestOf: number | null;
    /** `matchup` = two-sided card, `markets` = markets shown on the card. */
    layout: string;
    /** When betting closes. Null = no automatic close. */
    endsAt: string | null;
    tournament: { id: number; name: string; riskTier: number | null };
    categoryName: string;
  };
  markets: MarketDetail[];
}

interface DraftOutcome {
  outcomeId?: string;
  label: string;
  /** Percentage as typed. Not required to sum to 100 — pricing normalises. */
  probability: string;
  exposureMicro?: string;
  result?: string | null;
}

interface DraftMarket {
  name: string;
  overroundBp: string;
  liabilityTrading: boolean;
  liabilityStrengthBp: string;
  liabilityMaxShiftBp: string;
  outcomes: DraftOutcome[];
}

function errMessage(e: unknown, fallback: string): string {
  return e instanceof ApiFetchError ? e.body.message || fallback : fallback;
}

const MICRO = 1_000_000;
function fmtMicro(v: string): string {
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0) return "0";
  return (n / MICRO).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

export interface TournamentOption {
  id: number;
  name: string;
  categoryName: string;
  riskTier: number | null;
}

export function EventEditor({
  detail,
  tournaments,
}: {
  detail: EventDetail;
  tournaments: TournamentOption[];
}) {
  const [adding, setAdding] = useState(false);
  return (
    <div className="space-y-6">
      <EventHeader detail={detail} tournaments={tournaments} />

      <section className="space-y-4">
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-base font-semibold">Markets</h2>
          <button className="btn" onClick={() => setAdding((v) => !v)}>
            {adding ? "Cancel" : "Add market"}
          </button>
        </div>

        {adding ? (
          <MarketForm
            eventId={detail.event.id}
            onDone={() => setAdding(false)}
            initial={{
              name: "",
              overroundBp: "500",
              liabilityTrading: false,
              liabilityStrengthBp: "3000",
              liabilityMaxShiftBp: "1500",
              outcomes: [
                { label: detail.event.homeTeam, probability: "50" },
                { label: detail.event.awayTeam, probability: "50" },
              ],
            }}
          />
        ) : null}

        {detail.markets.map((m) => (
          <MarketCard key={m.id} market={m} />
        ))}
        {detail.markets.length === 0 && !adding ? (
          <p className="text-sm text-[var(--color-fg-muted)]">
            No markets yet. Add one and the event goes on sale.
          </p>
        ) : null}
      </section>
    </div>
  );
}

/**
 * ISO instant -> the value a `datetime-local` input wants, in the
 * viewer's own timezone.
 *
 * The input has no zone of its own, so it must be handed local wall-clock
 * digits. `toISOString()` would hand it UTC, which silently shifts the
 * displayed kickoff by the offset and then saves that shifted time back.
 */
function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function EventHeader({
  detail,
  tournaments,
}: {
  detail: EventDetail;
  tournaments: TournamentOption[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const ev = detail.event;

  const initial = {
    homeTeam: ev.homeTeam,
    awayTeam: ev.awayTeam,
    tournamentId: String(ev.tournament.id),
    scheduledAt: toLocalInput(ev.scheduledAt),
    endsAt: toLocalInput(ev.endsAt),
    bestOf: ev.bestOf != null ? String(ev.bestOf) : "",
    status: ev.status,
    layout: ev.layout ?? "matchup",
  };
  const [form, setForm] = useState(initial);

  const dirty = (Object.keys(initial) as Array<keyof typeof initial>).some(
    (k) => form[k] !== initial[k],
  );
  const valid =
    !!form.homeTeam.trim() &&
    (form.layout === "markets" || !!form.awayTeam.trim()) &&
    !!form.tournamentId;

  // The tier warning follows the PICKER, not the saved row — an operator
  // moving the event to an untiered tournament should see the consequence
  // before they save, not after.
  const picked = tournaments.find((t) => String(t.id) === form.tournamentId);
  const riskTier = picked ? picked.riskTier : ev.tournament.riskTier;

  function save() {
    setError(null);
    startTransition(async () => {
      try {
        await clientApi(`/admin/custom-events/events/${ev.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            homeTeam: form.homeTeam.trim(),
            // Cleared for a question: the empty second side IS how every
            // surface tells the two shapes apart (see formatEventTitle).
            awayTeam: form.layout === "markets" ? "" : form.awayTeam.trim(),
            tournamentId: Number(form.tournamentId),
            // datetime-local carries no zone; the operator typed local
            // wall-clock time, so read it as local and send an instant.
            scheduledAt: form.scheduledAt
              ? new Date(form.scheduledAt).toISOString()
              : null,
            endsAt: form.endsAt ? new Date(form.endsAt).toISOString() : null,
            bestOf: form.bestOf ? Number(form.bestOf) : null,
            status: form.status,
            layout: form.layout,
          }),
        });
        router.refresh();
      } catch (e) {
        setError(errMessage(e, "Save failed."));
      }
    });
  }

  return (
    <header className="space-y-3 rounded border border-[var(--color-border)] p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-lg font-semibold">
          {formatEventTitle(ev.homeTeam, ev.awayTeam)}
        </h1>
        <code className="text-xs text-[var(--color-fg-muted)]">{ev.providerUrn}</code>
      </div>

      {riskTier == null ? (
        <p className="rounded bg-amber-500/10 p-2 text-xs text-amber-700">
          This tournament has no risk tier, so RiskZilla underwrites it at
          the strictest one and bets will be capped very low. Set a tier on
          Tournaments before you expect real stakes.
        </p>
      ) : null}

      <p className="text-xs text-[var(--color-fg-muted)]">
        {form.layout === "markets"
          ? "The storefront shows this event's markets on the card itself, with no match-up. Both sides' names are still used to label a bet in the slip and in bet history."
          : "The storefront shows the usual two-sided card, with the match-winner prices on it."}
        {form.endsAt
          ? " Betting stops at the closing time, and the markets suspend on their own — settle them once you know the result."
          : " With no closing time the event stays open until you suspend or settle it."}
      </p>

      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs">
          {form.layout === "markets" ? "Event title" : "Home / first side"}
          <input
            className="admin-input min-w-[16rem]"
            value={form.homeTeam}
            onChange={(e) => setForm({ ...form, homeTeam: e.target.value })}
            maxLength={120}
          />
        </label>
        {/* A question has one subject. Hidden rather than disabled: a
            greyed field still reads as something left unfilled. Switching
            back to a match-up brings it and its saved value back. */}
        {form.layout === "markets" ? null : (
          <label className="flex flex-col gap-1 text-xs">
            Away / second side
            <input
              className="admin-input"
              value={form.awayTeam}
              onChange={(e) => setForm({ ...form, awayTeam: e.target.value })}
              maxLength={120}
            />
          </label>
        )}
        <label className="flex flex-col gap-1 text-xs">
          Tournament
          <select
            className="admin-input min-w-[15rem]"
            value={form.tournamentId}
            onChange={(e) => setForm({ ...form, tournamentId: e.target.value })}
          >
            {tournaments.map((t) => (
              <option key={t.id} value={t.id}>
                {t.categoryName} — {t.name}
                {t.riskTier == null ? " (no tier)" : ` (T${t.riskTier})`}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs">
          Starts (local time)
          <input
            className="admin-input"
            type="datetime-local"
            value={form.scheduledAt}
            onChange={(e) => setForm({ ...form, scheduledAt: e.target.value })}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          Betting closes (local time)
          <input
            className="admin-input"
            type="datetime-local"
            value={form.endsAt}
            onChange={(e) => setForm({ ...form, endsAt: e.target.value })}
            title="Leave empty to keep the event open until you suspend or settle it"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          Presentation
          <select
            className="admin-input"
            value={form.layout}
            onChange={(e) => setForm({ ...form, layout: e.target.value })}
          >
            <option value="matchup">Match-up card</option>
            <option value="markets">Markets on the card</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs">
          Best of
          <input
            className="admin-input w-20"
            type="number"
            min={1}
            max={9}
            value={form.bestOf}
            onChange={(e) => setForm({ ...form, bestOf: e.target.value })}
            placeholder="—"
            disabled={form.layout === "markets"}
            title={
              form.layout === "markets"
                ? "Only meaningful on a match-up card"
                : undefined
            }
          />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          Status
          <select
            className="admin-input"
            value={form.status}
            onChange={(e) => setForm({ ...form, status: e.target.value })}
          >
            <option value="not_started">not_started</option>
            <option value="live">live</option>
            <option value="suspended">suspended</option>
            <option value="closed">closed</option>
            <option value="cancelled">cancelled</option>
          </select>
        </label>
        <button className="btn" disabled={pending || !dirty || !valid} onClick={save}>
          Save event
        </button>
        {dirty ? (
          <button
            className="btn"
            disabled={pending}
            onClick={() => {
              setForm(initial);
              setError(null);
            }}
          >
            Revert
          </button>
        ) : null}
        {error ? <span className="pb-2 text-xs text-red-500">{error}</span> : null}
      </div>
    </header>
  );
}

function MarketCard({ market }: { market: MarketDetail }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [settling, setSettling] = useState(false);

  const terminal = market.status === -3 || market.status === -4;
  const statusLabel =
    market.status === 1
      ? "open"
      : market.status === -3
        ? "settled"
        : market.status === -4
          ? "cancelled"
          : "suspended";

  function run(fn: () => Promise<unknown>, fallback: string) {
    setError(null);
    startTransition(async () => {
      try {
        await fn();
        router.refresh();
      } catch (e) {
        setError(errMessage(e, fallback));
      }
    });
  }

  return (
    <div className="space-y-3 rounded border border-[var(--color-border)] p-3">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="font-medium">{market.name ?? "Untitled market"}</h3>
        <span className="rounded bg-[var(--color-bg-elevated)] px-1.5 py-0.5 text-[11px]">
          {statusLabel}
        </span>
        {market.liabilityTrading ? (
          <span
            className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[11px] text-emerald-600"
            title="Prices follow the money on this market"
          >
            liability traded
          </span>
        ) : null}
        {market.bookKey != null ? (
          <span className="text-xs text-[var(--color-fg-muted)]">
            book {market.bookKey.toFixed(4)} ({((market.bookKey - 1) * 100).toFixed(2)}%
            margin)
          </span>
        ) : null}
        <div className="ml-auto flex flex-wrap gap-2">
          {!terminal ? (
            <>
              <button className="btn text-xs" onClick={() => setEditing((v) => !v)}>
                {editing ? "Close" : "Edit"}
              </button>
              <button
                className="btn text-xs"
                disabled={pending}
                onClick={() =>
                  run(
                    () =>
                      clientApi(`/admin/custom-events/markets/${market.id}/status`, {
                        method: "POST",
                        body: JSON.stringify({ open: market.status !== 1 }),
                      }),
                    "Could not change the market status.",
                  )
                }
              >
                {market.status === 1 ? "Suspend" : "Open"}
              </button>
              <button className="btn text-xs" onClick={() => setSettling((v) => !v)}>
                Settle
              </button>
              <button
                className="btn text-xs"
                disabled={pending}
                onClick={() =>
                  run(
                    () =>
                      clientApi(`/admin/custom-events/markets/${market.id}/cancel`, {
                        method: "POST",
                      }),
                    "Could not cancel the market.",
                  )
                }
              >
                Void
              </button>
            </>
          ) : null}
        </div>
      </div>

      {error ? <p className="text-xs text-red-500">{error}</p> : null}

      <table className="w-full text-sm">
        <thead className="text-left text-xs uppercase text-[var(--color-fg-muted)]">
          <tr>
            <th className="py-1">Outcome</th>
            <th>Your view</th>
            <th>Priced at</th>
            <th>Odds</th>
            <th>Exposure (USDC)</th>
            <th>Result</th>
          </tr>
        </thead>
        <tbody>
          {market.outcomes.map((o) => {
            const base = o.baseProbability;
            const priced = o.probability != null ? Number(o.probability) : null;
            const drift =
              base != null && priced != null ? (priced - base) * 100 : null;
            return (
              <tr key={o.outcomeId} className="border-t border-[var(--color-border)]">
                <td className="py-1">{o.label}</td>
                <td className="text-xs">
                  {base != null ? `${(base * 100).toFixed(2)}%` : "—"}
                </td>
                <td className="text-xs">
                  {priced != null ? `${(priced * 100).toFixed(2)}%` : "—"}
                  {drift != null && Math.abs(drift) >= 0.01 ? (
                    <span
                      className={
                        drift > 0 ? "ml-1 text-emerald-600" : "ml-1 text-red-500"
                      }
                    >
                      {drift > 0 ? "+" : ""}
                      {drift.toFixed(2)}pp
                    </span>
                  ) : null}
                </td>
                <td className="tnum">{o.publishedOdds ?? "—"}</td>
                <td className="tnum text-xs">{fmtMicro(o.exposureMicro)}</td>
                <td className="text-xs">{o.result ?? "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {market.liabilityTrading ? (
        <p className="text-xs text-[var(--color-fg-muted)]">
          Prices follow the money: the side carrying more exposure is
          shortened and the others lengthen, up to{" "}
          {(market.liabilityMaxShiftBp / 100).toFixed(2)} percentage points
          from your own view.
          {market.liabilityPricedAt
            ? ` Last repriced ${new Date(market.liabilityPricedAt).toLocaleTimeString()}.`
            : ""}
        </p>
      ) : null}

      {settling && !terminal ? (
        <SettleForm market={market} onDone={() => setSettling(false)} />
      ) : null}

      {editing && !terminal ? (
        <MarketForm
          marketId={market.id}
          onDone={() => setEditing(false)}
          initial={{
            name: market.name ?? "",
            overroundBp: String(market.overroundBp),
            liabilityTrading: market.liabilityTrading,
            liabilityStrengthBp: String(market.liabilityStrengthBp),
            liabilityMaxShiftBp: String(market.liabilityMaxShiftBp),
            outcomes: market.outcomes.map((o) => ({
              outcomeId: o.outcomeId,
              label: o.label,
              probability:
                o.baseProbability != null
                  ? (o.baseProbability * 100).toFixed(2)
                  : "0",
              exposureMicro: o.exposureMicro,
            })),
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * Create or edit a market.
 *
 * The price column re-computes as the operator types, through the SAME
 * function the API uses to write the prices — a preview that disagreed
 * with the save would be worse than no preview at all.
 */
function MarketForm({
  eventId,
  marketId,
  initial,
  onDone,
}: {
  eventId?: string;
  marketId?: string;
  initial: DraftMarket;
  onDone: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftMarket>(initial);

  const preview = useMemo(() => {
    try {
      const outcomes = draft.outcomes.map((o, i) => ({
        outcomeId: o.outcomeId ?? String(i + 1),
        baseProbability: Number(o.probability),
        exposureMicro: Number(o.exposureMicro ?? 0),
      }));
      if (outcomes.some((o) => !Number.isFinite(o.baseProbability) || o.baseProbability <= 0))
        return null;
      return priceCustomMarket({
        outcomes,
        overroundBp: Number(draft.overroundBp) || 0,
        liability: {
          enabled: draft.liabilityTrading,
          strengthBp: Number(draft.liabilityStrengthBp) || 0,
          maxShiftBp: Number(draft.liabilityMaxShiftBp) || 0,
        },
      });
    } catch {
      return null;
    }
  }, [draft]);

  const previewKey = preview ? bookKey(preview.map((c) => c.publishedOdds)) : null;
  const probTotal = draft.outcomes.reduce((a, o) => a + (Number(o.probability) || 0), 0);

  function setOutcome(i: number, patch: Partial<DraftOutcome>) {
    setDraft((d) => ({
      ...d,
      outcomes: d.outcomes.map((o, j) => (j === i ? { ...o, ...patch } : o)),
    }));
  }

  function submit() {
    setError(null);
    startTransition(async () => {
      try {
        const body = JSON.stringify({
          name: draft.name.trim(),
          overroundBp: Number(draft.overroundBp) || 0,
          liabilityTrading: draft.liabilityTrading,
          liabilityStrengthBp: Number(draft.liabilityStrengthBp) || 0,
          liabilityMaxShiftBp: Number(draft.liabilityMaxShiftBp) || 0,
          outcomes: draft.outcomes.map((o) => ({
            ...(o.outcomeId ? { outcomeId: o.outcomeId } : {}),
            label: o.label.trim(),
            probability: Number(o.probability),
          })),
        });
        if (marketId) {
          await clientApi(`/admin/custom-events/markets/${marketId}`, {
            method: "PATCH",
            body,
          });
        } else {
          await clientApi(`/admin/custom-events/events/${eventId}/markets`, {
            method: "POST",
            body,
          });
        }
        onDone();
        router.refresh();
      } catch (e) {
        setError(errMessage(e, "Save failed."));
      }
    });
  }

  const valid =
    draft.name.trim().length > 0 &&
    draft.outcomes.length >= 2 &&
    draft.outcomes.every((o) => o.label.trim() && Number(o.probability) > 0);

  return (
    <div className="space-y-3 rounded bg-[var(--color-bg-elevated)] p-3">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs">
          Market name
          <input
            className="admin-input min-w-[18rem]"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            placeholder="Who wins?"
            maxLength={120}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          Overround (bp)
          <input
            className="admin-input w-28"
            type="number"
            min={0}
            max={5000}
            value={draft.overroundBp}
            onChange={(e) => setDraft({ ...draft, overroundBp: e.target.value })}
          />
        </label>
        <span className="pb-2 text-xs text-[var(--color-fg-muted)]">
          {(Number(draft.overroundBp) / 100 || 0).toFixed(2)}% margin
          {previewKey != null ? ` · book ${previewKey.toFixed(4)}` : ""}
        </span>
      </div>

      <div className="space-y-2 rounded border border-[var(--color-border)] p-2">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={draft.liabilityTrading}
            onChange={(e) => setDraft({ ...draft, liabilityTrading: e.target.checked })}
          />
          Liability trading
        </label>
        <p className="text-xs text-[var(--color-fg-muted)]">
          Shifts the priced probabilities toward the side that is taking the
          money, which shortens that price and lengthens the others. A book
          pulled level earns its margin whatever the result. Only real-money
          (USDC) bets count; demo balances never move a price.
        </p>
        {draft.liabilityTrading ? (
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1 text-xs">
              Strength (bp)
              <input
                className="admin-input w-28"
                type="number"
                min={0}
                max={10000}
                value={draft.liabilityStrengthBp}
                onChange={(e) =>
                  setDraft({ ...draft, liabilityStrengthBp: e.target.value })
                }
              />
            </label>
            <label className="flex flex-col gap-1 text-xs">
              Max shift (bp)
              <input
                className="admin-input w-28"
                type="number"
                min={0}
                max={10000}
                value={draft.liabilityMaxShiftBp}
                onChange={(e) =>
                  setDraft({ ...draft, liabilityMaxShiftBp: e.target.value })
                }
              />
            </label>
            <span className="pb-2 text-xs text-[var(--color-fg-muted)]">
              Moves at most{" "}
              {((Number(draft.liabilityMaxShiftBp) || 0) / 100).toFixed(2)}pp from
              your own probability.
            </span>
          </div>
        ) : null}
      </div>

      <table className="w-full text-sm">
        <thead className="text-left text-xs uppercase text-[var(--color-fg-muted)]">
          <tr>
            <th className="py-1">Outcome</th>
            <th>Probability %</th>
            <th>Odds</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {draft.outcomes.map((o, i) => {
            const cell: CustomPriceCell | undefined = preview?.[i];
            return (
              <tr key={i} className="border-t border-[var(--color-border)]">
                <td className="py-1">
                  <input
                    className="admin-input w-full"
                    value={o.label}
                    onChange={(e) => setOutcome(i, { label: e.target.value })}
                    maxLength={120}
                  />
                </td>
                <td>
                  <input
                    className="admin-input w-24"
                    type="number"
                    step="0.01"
                    min={0}
                    value={o.probability}
                    onChange={(e) => setOutcome(i, { probability: e.target.value })}
                  />
                </td>
                <td className="tnum">
                  {cell ? cell.publishedOdds.toFixed(4) : "—"}
                  {cell && cell.shiftBp !== 0 ? (
                    <span className="ml-1 text-[11px] text-[var(--color-fg-muted)]">
                      ({cell.shiftBp > 0 ? "+" : ""}
                      {(cell.shiftBp / 100).toFixed(2)}pp)
                    </span>
                  ) : null}
                  {cell && cell.publishedOdds <= 1 ? (
                    <span className="ml-1 text-[11px] text-red-500">
                      not bettable at or below 1.00
                    </span>
                  ) : null}
                </td>
                <td className="text-right">
                  {draft.outcomes.length > 2 ? (
                    <button
                      className="btn text-xs"
                      onClick={() =>
                        setDraft({
                          ...draft,
                          outcomes: draft.outcomes.filter((_, j) => j !== i),
                        })
                      }
                    >
                      Remove
                    </button>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div className="flex flex-wrap items-center gap-2">
        <button
          className="btn text-xs"
          onClick={() =>
            setDraft({
              ...draft,
              outcomes: [...draft.outcomes, { label: "", probability: "10" }],
            })
          }
        >
          Add outcome
        </button>
        <span className="text-xs text-[var(--color-fg-muted)]">
          Entered total {probTotal.toFixed(2)}% — normalised on save, so it
          does not have to be 100.
        </span>
      </div>

      <div className="flex items-center gap-2">
        <button className="btn" disabled={pending || !valid} onClick={submit}>
          {marketId ? "Save market" : "Create market"}
        </button>
        <button className="btn" onClick={onDone} disabled={pending}>
          Cancel
        </button>
        {error ? <span className="text-xs text-red-500">{error}</span> : null}
      </div>
    </div>
  );
}

function SettleForm({
  market,
  onDone,
}: {
  market: MarketDetail;
  onDone: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, string>>(() =>
    Object.fromEntries(market.outcomes.map((o) => [o.outcomeId, "lost"])),
  );

  function submit() {
    setError(null);
    startTransition(async () => {
      try {
        await clientApi(`/admin/custom-events/markets/${market.id}/settle`, {
          method: "POST",
          body: JSON.stringify({
            results: market.outcomes.map((o) => ({
              outcomeId: o.outcomeId,
              result: results[o.outcomeId] ?? "lost",
            })),
          }),
        });
        onDone();
        router.refresh();
      } catch (e) {
        setError(errMessage(e, "Could not settle the market."));
      }
    });
  }

  return (
    <div className="space-y-2 rounded border border-[var(--color-border)] p-3">
      <p className="text-xs text-[var(--color-fg-muted)]">
        Every outcome needs a result. Settling pays out through the same
        path a feed settlement takes, and it cannot be undone from here.
      </p>
      {market.outcomes.map((o) => (
        <label key={o.outcomeId} className="flex items-center gap-2 text-sm">
          <span className="min-w-[12rem]">{o.label}</span>
          <select
            className="admin-input"
            value={results[o.outcomeId] ?? "lost"}
            onChange={(e) =>
              setResults((r) => ({ ...r, [o.outcomeId]: e.target.value }))
            }
          >
            <option value="won">won</option>
            <option value="lost">lost</option>
            <option value="void">void (refund)</option>
            <option value="half_won">half won</option>
            <option value="half_lost">half lost</option>
          </select>
        </label>
      ))}
      <div className="flex items-center gap-2">
        <button className="btn" disabled={pending} onClick={submit}>
          Settle market
        </button>
        <button className="btn" disabled={pending} onClick={onDone}>
          Cancel
        </button>
        {error ? <span className="text-xs text-red-500">{error}</span> : null}
      </div>
    </div>
  );
}
