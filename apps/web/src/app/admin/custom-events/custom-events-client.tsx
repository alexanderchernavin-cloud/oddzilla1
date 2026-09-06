"use client";

import { useState, useTransition, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { clientApi, ApiFetchError } from "@/lib/api-client";
// Subpath, never the barrel — see packages/types/src/odds.ts.
import { formatEventTitle } from "@oddzilla/types/custom-events";

export interface TournamentRow {
  id: number;
  name: string;
  slug: string;
  riskTier: number | null;
  eventCount: number;
}

export interface CategoryRow {
  id: number;
  name: string;
  slug: string;
  tournaments: TournamentRow[];
}

export interface StructureResponse {
  sport: { id: number; name: string; slug: string };
  categories: CategoryRow[];
}

export interface EventRow {
  id: string;
  providerUrn: string;
  homeTeam: string;
  awayTeam: string;
  scheduledAt: string | null;
  status: string;
  tournament: { id: number; name: string; riskTier: number | null };
  categoryName: string;
  marketCount: number;
}

function errMessage(e: unknown, fallback: string): string {
  return e instanceof ApiFetchError ? e.body.message || fallback : fallback;
}

export function CustomEventsClient({
  structure,
  events,
}: {
  structure: StructureResponse;
  events: EventRow[];
}) {
  return (
    <div className="space-y-8">
      <StructurePanel structure={structure} />
      <EventsPanel structure={structure} events={events} />
    </div>
  );
}

// ---------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------

function StructurePanel({ structure }: { structure: StructureResponse }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [newCategory, setNewCategory] = useState("");

  function addCategory(e: FormEvent) {
    e.preventDefault();
    const name = newCategory.trim();
    if (!name) return;
    setError(null);
    startTransition(async () => {
      try {
        await clientApi("/admin/custom-events/categories", {
          method: "POST",
          body: JSON.stringify({ name }),
        });
        setNewCategory("");
        router.refresh();
      } catch (e) {
        setError(errMessage(e, "Could not add the category."));
      }
    });
  }

  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="text-base font-semibold">Structure</h2>
        <span className="text-xs text-[var(--color-fg-muted)]">
          Sport: {structure.sport.name}
        </span>
      </div>

      <form onSubmit={addCategory} className="flex flex-wrap items-center gap-2">
        <input
          className="admin-input min-w-[16rem]"
          placeholder="New category name"
          value={newCategory}
          onChange={(e) => setNewCategory(e.target.value)}
          maxLength={120}
        />
        <button className="btn" type="submit" disabled={pending || !newCategory.trim()}>
          Add category
        </button>
        {error ? <span className="text-xs text-red-500">{error}</span> : null}
      </form>

      <div className="space-y-3">
        {structure.categories.length === 0 ? (
          <p className="text-sm text-[var(--color-fg-muted)]">
            No categories yet. Add one above.
          </p>
        ) : null}
        {structure.categories.map((c) => (
          <CategoryBlock
            key={c.id}
            category={c}
            allCategories={structure.categories}
          />
        ))}
      </div>
    </section>
  );
}

function CategoryBlock({
  category,
  allCategories,
}: {
  category: CategoryRow;
  allCategories: CategoryRow[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState(category.name);
  const [newTournament, setNewTournament] = useState("");

  function run(fn: () => Promise<unknown>, fallback: string) {
    setError(null);
    startTransition(async () => {
      try {
        await fn();
        setNewTournament("");
        router.refresh();
      } catch (e) {
        setError(errMessage(e, fallback));
      }
    });
  }

  return (
    <div className="rounded border border-[var(--color-border)] p-3 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          className="admin-input min-w-[14rem]"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={120}
        />
        <button
          className="btn"
          disabled={pending || name.trim() === category.name || !name.trim()}
          onClick={() =>
            run(
              () =>
                clientApi(`/admin/custom-events/categories/${category.id}`, {
                  method: "PATCH",
                  body: JSON.stringify({ name: name.trim() }),
                }),
              "Rename failed.",
            )
          }
        >
          Rename
        </button>
        <button
          className="btn"
          disabled={pending || category.tournaments.length > 0}
          title={
            category.tournaments.length > 0
              ? "Delete or move its tournaments first"
              : "Delete this category"
          }
          onClick={() =>
            run(
              () =>
                clientApi(`/admin/custom-events/categories/${category.id}`, {
                  method: "DELETE",
                }),
              "Delete failed.",
            )
          }
        >
          Delete
        </button>
        {error ? <span className="text-xs text-red-500">{error}</span> : null}
      </div>

      <ul className="space-y-1 pl-3 text-sm">
        {category.tournaments.map((t) => (
          <TournamentItem
            key={t.id}
            tournament={t}
            categoryId={category.id}
            allCategories={allCategories}
          />
        ))}
        {category.tournaments.length === 0 ? (
          <li className="text-xs text-[var(--color-fg-muted)]">No tournaments yet.</li>
        ) : null}
      </ul>

      <div className="flex flex-wrap items-center gap-2 pl-3">
        <input
          className="admin-input min-w-[14rem]"
          placeholder="New tournament name"
          value={newTournament}
          onChange={(e) => setNewTournament(e.target.value)}
          maxLength={120}
        />
        <button
          className="btn"
          disabled={pending || !newTournament.trim()}
          onClick={() =>
            run(
              () =>
                clientApi("/admin/custom-events/tournaments", {
                  method: "POST",
                  body: JSON.stringify({
                    categoryId: category.id,
                    name: newTournament.trim(),
                  }),
                }),
              "Could not add the tournament.",
            )
          }
        >
          Add tournament
        </button>
      </div>
    </div>
  );
}

/**
 * One tournament: rename it, move it between categories, set its risk
 * tier, or delete it.
 *
 * The tier is editable here despite living on /admin/tournaments too. A
 * custom tournament has no feed to assign one, so it opens untiered —
 * which RiskZilla prices at the STRICTEST tier, capping stakes to almost
 * nothing. Sending an operator to a different screen to set the single
 * number that decides that was a worse answer than one more control.
 * The write mirrors the other screen's exactly rather than inventing a
 * second rule for the same column.
 */
function TournamentItem({
  tournament,
  categoryId,
  allCategories,
}: {
  tournament: TournamentRow;
  categoryId: number;
  allCategories: CategoryRow[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState(tournament.name);
  const [catId, setCatId] = useState(String(categoryId));
  const [tier, setTier] = useState(
    tournament.riskTier == null ? "" : String(tournament.riskTier),
  );

  const dirty =
    name.trim() !== tournament.name ||
    catId !== String(categoryId) ||
    tier !== (tournament.riskTier == null ? "" : String(tournament.riskTier));

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
    <li className="flex flex-wrap items-center gap-2">
      <input
        className="admin-input min-w-[12rem]"
        value={name}
        onChange={(e) => setName(e.target.value)}
        maxLength={120}
      />
      <select
        className="admin-input"
        value={catId}
        onChange={(e) => setCatId(e.target.value)}
        title="Move to another category"
      >
        {allCategories.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      <select
        className="admin-input"
        value={tier}
        onChange={(e) => setTier(e.target.value)}
        title="Risk tier: sets RiskZilla's per-match liability budget. No tier means the strictest one."
      >
        <option value="">No tier (strictest)</option>
        {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((t) => (
          <option key={t} value={t}>
            T{t}
          </option>
        ))}
      </select>
      {tier === "" ? <TierChip tier={null} /> : null}
      <span className="text-xs text-[var(--color-fg-muted)]">
        {tournament.eventCount} event{tournament.eventCount === 1 ? "" : "s"}
      </span>
      <button
        className="btn text-xs"
        disabled={pending || !dirty || !name.trim()}
        onClick={() =>
          run(
            () =>
              clientApi(`/admin/custom-events/tournaments/${tournament.id}`, {
                method: "PATCH",
                body: JSON.stringify({
                  name: name.trim(),
                  categoryId: Number(catId),
                  // Empty means "back to automatic", which is a real
                  // choice and not the same as leaving the field alone —
                  // hence null rather than omitting the key.
                  riskTier: tier === "" ? null : Number(tier),
                }),
              }),
            "Save failed.",
          )
        }
      >
        Save
      </button>
      <button
        className="btn text-xs"
        disabled={pending || tournament.eventCount > 0}
        title={
          tournament.eventCount > 0
            ? "Delete its events first"
            : "Delete this tournament"
        }
        onClick={() =>
          run(
            () =>
              clientApi(`/admin/custom-events/tournaments/${tournament.id}`, {
                method: "DELETE",
              }),
            "Delete failed.",
          )
        }
      >
        Delete
      </button>
      {error ? <span className="text-xs text-red-500">{error}</span> : null}
    </li>
  );
}

/**
 * An untiered tournament is not merely unlabelled — RiskZilla prices it at
 * the STRICTEST tier, so its stakes are tiny. Saying so here is the
 * difference between an operator understanding the limit and filing a bug.
 */
function TierChip({ tier }: { tier: number | null }) {
  if (tier == null) {
    return (
      <span
        className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] text-amber-600"
        title="No risk tier: bets are limited to the strictest tier until you set one on /admin/tournaments"
      >
        no tier
      </span>
    );
  }
  return (
    <span className="rounded bg-[var(--color-bg-elevated)] px-1.5 py-0.5 text-[11px]">
      T{tier}
    </span>
  );
}

// ---------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------

function EventsPanel({
  structure,
  events,
}: {
  structure: StructureResponse;
  events: EventRow[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const tournaments = structure.categories.flatMap((c) =>
    c.tournaments.map((t) => ({ ...t, categoryName: c.name })),
  );

  const [form, setForm] = useState({
    tournamentId: "",
    homeTeam: "",
    awayTeam: "",
    scheduledAt: "",
    endsAt: "",
    layout: "matchup",
  });
  const questionShaped = form.layout === "markets";

  function create(e: FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      try {
        const created = await clientApi<{ event: { id: string } }>(
          "/admin/custom-events/events",
          {
            method: "POST",
            body: JSON.stringify({
              tournamentId: Number(form.tournamentId),
              homeTeam: form.homeTeam.trim(),
              // Left empty for a question-shaped event: its whole title
              // is the first field, and there is no opponent to invent.
              awayTeam: questionShaped ? "" : form.awayTeam.trim(),
              // datetime-local has no zone; the operator is typing local
              // wall-clock time, so read it as local and send an instant.
              scheduledAt: form.scheduledAt
                ? new Date(form.scheduledAt).toISOString()
                : null,
              endsAt: form.endsAt
                ? new Date(form.endsAt).toISOString()
                : null,
              layout: form.layout,
            }),
          },
        );
        router.push(`/admin/custom-events/${created.event.id}`);
      } catch (e) {
        setError(errMessage(e, "Could not create the event."));
      }
    });
  }

  const canCreate =
    !!form.tournamentId &&
    !!form.homeTeam.trim() &&
    (questionShaped || !!form.awayTeam.trim()) &&
    !pending;

  return (
    <section className="space-y-3">
      <h2 className="text-base font-semibold">Events</h2>

      <form
        onSubmit={create}
        className="flex flex-wrap items-end gap-2 rounded border border-[var(--color-border)] p-3"
      >
        <label className="flex flex-col gap-1 text-xs">
          Tournament
          <select
            className="admin-input min-w-[16rem]"
            value={form.tournamentId}
            onChange={(e) => setForm({ ...form, tournamentId: e.target.value })}
          >
            <option value="">Pick one</option>
            {tournaments.map((t) => (
              <option key={t.id} value={t.id}>
                {t.categoryName} — {t.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs">
          Kind
          <select
            className="admin-input"
            value={form.layout}
            onChange={(e) => setForm({ ...form, layout: e.target.value })}
          >
            <option value="matchup">Match-up (two sides)</option>
            <option value="markets">Question (markets on the card)</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs">
          {questionShaped ? "Event title" : "Home / first side"}
          <input
            className="admin-input min-w-[18rem]"
            value={form.homeTeam}
            onChange={(e) => setForm({ ...form, homeTeam: e.target.value })}
            placeholder={
              questionShaped ? "Dima and Nastya to unite again" : undefined
            }
            maxLength={120}
          />
        </label>
        {/* A question has one subject, so the second side is not merely
            optional here — it is absent. Hiding it beats disabling it:
            a greyed field still reads as something the operator failed
            to fill in. */}
        {questionShaped ? null : (
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
          Starts (local time)
          <input
            className="admin-input"
            type="datetime-local"
            value={form.scheduledAt}
            onChange={(e) => setForm({ ...form, scheduledAt: e.target.value })}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          Betting closes (optional)
          <input
            className="admin-input"
            type="datetime-local"
            value={form.endsAt}
            onChange={(e) => setForm({ ...form, endsAt: e.target.value })}
            title="Leave empty to keep it open until you suspend or settle it"
          />
        </label>
        <button className="btn" type="submit" disabled={!canCreate}>
          Create event
        </button>
        {error ? <span className="text-xs text-red-500">{error}</span> : null}
      </form>
      <p className="text-xs text-[var(--color-fg-muted)]">
        {questionShaped
          ? "A question has no two sides: give it a title, then add markets. The storefront shows those markets on the card itself, so a bettor sees prices without opening the event."
          : "A match-up renders the usual two-sided card with the match-winner prices on it."}
      </p>

      {tournaments.length === 0 ? (
        <p className="text-sm text-[var(--color-fg-muted)]">
          Add a category and a tournament first — an event has to live
          somewhere.
        </p>
      ) : null}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase text-[var(--color-fg-muted)]">
            <tr>
              <th className="py-2">Event</th>
              <th>Tournament</th>
              <th>Starts</th>
              <th>Status</th>
              <th>Markets</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {events.map((ev) => (
              <tr key={ev.id} className="border-t border-[var(--color-border)]">
                <td className="py-2">
                  {formatEventTitle(ev.homeTeam, ev.awayTeam)}
                </td>
                <td>
                  <span className="mr-2">{ev.tournament.name}</span>
                  <TierChip tier={ev.tournament.riskTier} />
                </td>
                <td className="whitespace-nowrap text-xs">
                  {ev.scheduledAt ? new Date(ev.scheduledAt).toLocaleString() : "—"}
                </td>
                <td className="text-xs">{ev.status}</td>
                <td className="text-xs">{ev.marketCount}</td>
                <td className="text-right">
                  <Link className="btn text-xs" href={`/admin/custom-events/${ev.id}`}>
                    Open
                  </Link>
                </td>
              </tr>
            ))}
            {events.length === 0 ? (
              <tr>
                <td colSpan={6} className="py-4 text-[var(--color-fg-muted)]">
                  No custom events yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}
