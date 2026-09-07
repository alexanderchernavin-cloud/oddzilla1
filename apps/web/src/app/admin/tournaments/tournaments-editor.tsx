"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useTransition,
  type ChangeEvent,
  type FormEvent,
} from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { clientApi, ApiFetchError } from "@/lib/api-client";
import type { SortKey } from "./sort";
import { PinOrderControls } from "@/components/admin/pin-order-controls";

// Mirrors the API allowlist (services/api/src/modules/admin/tournaments.ts).
const ACCEPTED_MIME = [
  "image/svg+xml",
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;
const ACCEPTED_EXTENSIONS = [".svg", ".png", ".jpg", ".jpeg", ".webp"] as const;
const MAX_UPLOAD_BYTES = 1 * 1024 * 1024;

export interface TournamentRow {
  id: number;
  sportId: number;
  sportSlug: string;
  sportName: string;
  categoryId: number;
  categoryName: string;
  slug: string;
  name: string;
  riskTier: number | null;
  riskTierLocked: boolean;
  /**
   * Who decided the tier (migration 0106): "manual" an operator,
   * "zagi" a ZillaAGI review, "auto" the Oddin feed OR nothing yet.
   * The last case is why this exists — "auto" on a row with no tier
   * means unreviewed, not automatic.
   */
  riskTierSource: "auto" | "manual" | "zagi" | string;
  /** ZillaAGI's one-line justification, when it set the tier. */
  riskTierNote: string | null;
  /**
   * Operator pin position within this tournament's own CATEGORY
   * (migration 0104), or null when unpinned. Pinned tournaments head
   * their country's bucket in the sidebar tree; the rest keep the
   * tier / live-count / name default behind them.
   */
  displayOrder: number | null;
  active: boolean;
  logoUrl: string | null;
  brandColor: string | null;
}

// RiskZilla's per-tier settings run 1..10; "auto" hands the tier back to
// Oddin's REST metadata (migration 0094 lock semantics).
const RISK_TIERS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;

/**
 * Who decided this row's tier.
 *
 * The distinction worth drawing is not manual-vs-automatic, it is
 * reviewed-vs-not. "auto" on a tiered row means Oddin supplied the
 * number; "auto" on an untiered row means nobody has looked at it yet
 * and RiskZilla is underwriting it at the strictest tier. Those are very
 * different states and used to render identically.
 */
function TierSourceMark({ row }: { row: TournamentRow }) {
  // The lock is the older, narrower signal; where the two disagree the
  // lock wins, because it is what the feed actually honours.
  const source = row.riskTierLocked ? "manual" : row.riskTierSource;

  if (source === "manual") {
    return (
      <span
        className="text-[10px] uppercase tracking-[0.12em]"
        style={{ color: "var(--color-accent)" }}
        title={
          // A note survives on a manual row only when the operator
          // CONFIRMED the tier rather than changing it, so it still
          // describes this number — and it is the only record of why the
          // number is what it is. Overriding clears it server-side.
          row.riskTierNote
            ? `Confirmed by an operator. Neither the Oddin REST refresh nor ZillaAGI will change it. Original reasoning: ${row.riskTierNote}`
            : "Assigned by an operator. Neither the Oddin REST refresh nor ZillaAGI will overwrite it."
        }
      >
        manual
      </span>
    );
  }

  if (source === "zagi") {
    return (
      <span
        className="rounded-[4px] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em]"
        style={{
          color: "var(--color-positive)",
          border: "1px solid var(--color-positive)",
        }}
        title={
          row.riskTierNote
            ? `ZillaAGI review: ${row.riskTierNote}`
            : "Assigned by a ZillaAGI review. Pick a tier here to override it."
        }
      >
        ZAGI
      </span>
    );
  }

  return (
    <span
      className="text-[10px] uppercase tracking-[0.12em]"
      style={{ color: "var(--color-fg-subtle)" }}
      title={
        row.riskTier != null
          ? "Filled from Oddin's tournament metadata."
          : "Not reviewed yet. ZillaAGI picks these up automatically; until then RiskZilla underwrites at tier 10, the strictest."
      }
    >
      auto
    </span>
  );
}

/**
 * Tell the ZillaAGI status strip that a row's provenance moved.
 *
 * The strip's counts come from a client fetch of `zagi-status` run once
 * on mount, and the confirm button lives deep inside the table — so
 * without this a confirm would leave "reviewed / manual" wrong for the
 * rest of the session. `router.refresh()` re-renders the server rows but
 * never re-runs a client effect, and paging to the next page does not
 * remount the panel either (same component, same position in the tree).
 * One module-scoped listener set is the smallest thing that keeps the two
 * halves of the page telling the same story.
 */
const tierStatusListeners = new Set<() => void>();

function notifyTierStatusChanged() {
  for (const listener of tierStatusListeners) listener();
}

/**
 * Endorse the tier an automatic source already picked.
 *
 * The tier is a liability budget, and both automatic sources are
 * PROVISIONAL by construction: Oddin's number can be replaced by its own
 * next REST refresh, and a ZillaAGI verdict carries a standing +1 safety
 * margin precisely because nobody has looked at it. Saying "that number
 * is right" used to mean opening the edit form and re-picking the same
 * tier out of a ten-item dropdown — enough friction that a tier nobody
 * disagreed with stayed marked unreviewed, and the list gave an operator
 * no way to work down it.
 *
 * This posts the tier that is ALREADY stored, so the value never moves.
 * What changes is provenance: `risk_tier_source` becomes `manual` and
 * `risk_tier_locked` goes true, which is what stops the REST refresh
 * (`UpdateTournamentRiskTier` skips locked rows) and any future ZillaAGI
 * pass (its selector takes only untiered, unlocked rows) from touching
 * it. Audit-logged like every other tier write, and reversible from the
 * edit form's "Auto / ZAGI" option.
 *
 * No confirm dialog: the write cannot change the number, so the worst a
 * stray click does is pin a tier that was already in force.
 *
 * Deliberately NOT offered on an untiered row — there is no number to
 * endorse, and locking NULL would fix the tournament at the strictest
 * tier while hiding it from the reviewer that would otherwise price it.
 */
function ConfirmTierButton({
  id,
  tier,
  label,
}: {
  id: number;
  tier: number;
  label: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function confirm() {
    setError(null);
    startTransition(async () => {
      try {
        await clientApi(`/admin/tournaments/${id}`, {
          method: "PATCH",
          body: JSON.stringify({ riskTier: tier }),
        });
        router.refresh();
        notifyTierStatusChanged();
      } catch (e) {
        setError(e instanceof ApiFetchError ? e.body.message : "Confirm failed.");
      }
    });
  }

  const title = `Confirm T${tier} for ${label} — keeps this exact tier and marks it operator-assigned, so neither the feed nor ZillaAGI changes it`;

  return (
    <span className="inline-flex items-center gap-1">
      <button
        type="button"
        onClick={confirm}
        disabled={pending}
        title={error ?? title}
        aria-label={title}
        className="inline-flex h-[20px] w-[20px] items-center justify-center rounded-[5px]"
        style={{
          // Filled rather than outlined: the ZAGI badge sitting right
          // beside it is already an outlined green pill, and two green
          // outlines read as one label instead of a label and a control.
          // The glyph takes the page ground so it inverts correctly —
          // --positive is a dark green in light mode and a light green in
          // dark, and there is no --positive-fg to pair with it.
          background: error ? "var(--color-negative)" : "var(--color-positive)",
          color: "var(--color-bg)",
          border: "none",
          cursor: pending ? "default" : "pointer",
          opacity: pending ? 0.45 : 1,
        }}
      >
        <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true" focusable="false">
          <path
            d="M3 8.5 L6.5 12 L13 4.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.25"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {error && (
        <span className="text-[10px]" style={{ color: "var(--color-negative)" }}>
          {error}
        </span>
      )}
    </span>
  );
}

export interface SportOption {
  id: number;
  slug: string;
  name: string;
  tournamentCount: number;
  missingLogoCount: number;
}

export interface CategoryOption {
  id: number;
  name: string;
  tournamentCount: number;
}

// SORT_KEYS lives in ./sort because it is a runtime VALUE that the server
// page also needs — see the note there before moving it back.
export type { SortKey } from "./sort";

const SOURCE_LABELS: Record<string, string> = {
  auto: "Auto (unreviewed or from feed)",
  zagi: "ZAGI (reviewed by ZillaAGI)",
  manual: "Manual (set by an operator)",
};

interface ListShape {
  total: number;
  missingLogoCount: number;
  limit: number;
  offset: number;
  tournaments: TournamentRow[];
}

interface Filters {
  sportId: string;
  categoryId: string;
  /** "" | "1".."10" | "unset" */
  tier: string;
  /** "" | "auto" | "zagi" | "manual" */
  source: string;
  sort: SortKey;
  dir: "asc" | "desc";
  q: string;
  missingLogo: boolean;
  offset: number;
  limit: number;
}

/**
 * One place that turns the filter state into a query string, so the
 * filter bar, the column headers and the pager cannot disagree about
 * which filters survive a click. Paging is the only thing that keeps its
 * offset; changing a filter or a sort resets to the first page, because
 * page 4 of the old result set says nothing about the new one.
 */
function filtersToQuery(f: Filters, overrides: Partial<Filters> = {}): string {
  const next = { ...f, ...overrides };
  const p = new URLSearchParams();
  if (next.sportId) p.set("sportId", next.sportId);
  // A category is only meaningful inside its sport.
  if (next.sportId && next.categoryId) p.set("categoryId", next.categoryId);
  if (next.tier) p.set("tier", next.tier);
  if (next.source) p.set("source", next.source);
  if (next.sort !== "default") {
    p.set("sort", next.sort);
    p.set("dir", next.dir);
  }
  if (next.q.trim()) p.set("q", next.q.trim());
  if (next.missingLogo) p.set("missingLogo", "1");
  if (overrides.offset !== undefined && overrides.offset > 0) {
    p.set("offset", String(overrides.offset));
  }
  const qs = p.toString();
  return `/admin/tournaments${qs ? `?${qs}` : ""}`;
}

export function TournamentsEditor({
  initialList,
  sports,
  categories,
  currentFilters,
}: {
  initialList: ListShape;
  sports: SportOption[];
  categories: CategoryOption[];
  currentFilters: Filters;
}) {
  return (
    <div className="space-y-6">
      <ZagiTierPanel currentSportId={currentFilters.sportId} />
      <FilterBar
        sports={sports}
        categories={categories}
        current={currentFilters}
        total={initialList.total}
        missingLogoCount={initialList.missingLogoCount}
      />
      <TournamentTable list={initialList} current={currentFilters} />
      <Pager list={initialList} current={currentFilters} />
    </div>
  );
}

interface ZagiStatus {
  untiered: number;
  pending: number;
  exhausted: number;
  bySource: { auto: number; manual: number; zagi: number };
  enabled: boolean;
  model: string | null;
}

interface ZagiProposal {
  tournamentId: number;
  name: string;
  sportSlug: string;
  categoryName: string;
  tier: number;
  proposedTier: number;
  clamped: boolean;
  outright: boolean;
  why: string;
}

interface ZagiRunResult {
  eligible: number;
  reviewed: number;
  assigned: number;
  clamped: number;
  outrights: number;
  undecided: number;
  batches: number;
  model: string | null;
  dryRun: boolean;
  errors: string[];
  proposals: ZagiProposal[];
  proposalsTruncated: boolean;
}

/**
 * ZillaAGI risk-tier review.
 *
 * The background sweeper does this on its own every 30 minutes; this
 * panel exists so an operator can drain the backlog now, and — more
 * usefully — see what the model WOULD do before it does it. Preview is
 * the default action for that reason: assigning a tier always raises the
 * book's exposure, because an unreviewed tournament is already priced at
 * the strictest tier.
 */
function ZagiTierPanel({ currentSportId }: { currentSportId: string }) {
  const router = useRouter();
  const [status, setStatus] = useState<ZagiStatus | null>(null);
  const [result, setResult] = useState<ZagiRunResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"preview" | "run" | null>(null);
  const [limit, setLimit] = useState(50);
  const [scoped, setScoped] = useState(true);

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await clientApi<ZagiStatus>("/admin/tournaments/zagi-status"));
    } catch {
      // A missing status strip must not break the page it sits on.
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  // Confirming a tier down in the table moves a row from `zagi` / `auto`
  // to `manual`, which is two of the numbers in this strip.
  useEffect(() => {
    const listener = () => void loadStatus();
    tierStatusListeners.add(listener);
    return () => {
      tierStatusListeners.delete(listener);
    };
  }, [loadStatus]);

  async function run(dryRun: boolean) {
    setBusy(dryRun ? "preview" : "run");
    setError(null);
    setResult(null);
    try {
      const body: Record<string, unknown> = { limit, dryRun };
      if (scoped && currentSportId) body.sportId = Number(currentSportId);
      const res = await clientApi<ZagiRunResult>("/admin/tournaments/zagi-review", {
        method: "POST",
        body: JSON.stringify(body),
      });
      setResult(res);
      await loadStatus();
      // Written tiers change the rows underneath us.
      if (!dryRun && res.assigned > 0) router.refresh();
    } catch (err) {
      setError(
        err instanceof ApiFetchError
          ? err.message
          : "Could not reach the review endpoint.",
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="card space-y-3 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold tracking-tight">
            ZillaAGI risk-tier review
          </h2>
          <p className="mt-1 max-w-3xl text-xs text-[var(--color-fg-muted)]">
            A tournament with no tier is underwritten at <strong>T10</strong>, the
            strictest setting — so it is never over-exposed, just invisible and
            under-traded. ZillaAGI reads each competition&apos;s name, sport and
            category and proposes a tier; code then tightens it and never
            loosens it: <strong>+1</strong> always, because no verdict here is
            reviewed by a person first (so ZAGI can never assign T1),{" "}
            <strong>+3</strong> for season-long outright markets, and a
            per-sport ceiling on top (only football, basketball, tennis and
            American football can reach T1 at all; a handball world title stops
            at T2). It runs automatically every 30 minutes and never touches a
            tier an operator has set.
          </p>
        </div>
        {status && (
          <span
            className="shrink-0 text-[10px] uppercase tracking-[0.12em]"
            style={{
              color: status.enabled
                ? "var(--color-positive)"
                : "var(--color-fg-subtle)",
            }}
            title={
              status.enabled
                ? `Model: ${status.model ?? "unknown"}`
                : "Set ZAGI_API_KEY and ZAGI_BASE_URL to enable."
            }
          >
            {status.enabled ? `online · ${status.model}` : "not configured"}
          </span>
        )}
      </div>

      {status && (
        <div className="flex flex-wrap gap-x-6 gap-y-1 font-mono text-xs text-[var(--color-fg-muted)]">
          <span>
            untiered <strong className="text-[var(--color-fg)]">{status.untiered}</strong>
          </span>
          <span>
            queued <strong className="text-[var(--color-fg)]">{status.pending}</strong>
          </span>
          <span>
            reviewed <strong className="text-[var(--color-fg)]">{status.bySource.zagi}</strong>
          </span>
          <span>
            manual <strong className="text-[var(--color-fg)]">{status.bySource.manual}</strong>
          </span>
          {status.exhausted > 0 && (
            <span title="Untiered rows the model declined three times. Assign these by hand.">
              stuck <strong style={{ color: "var(--color-warning)" }}>{status.exhausted}</strong>
            </span>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="block text-xs text-[var(--color-fg-subtle)]">Batch size</span>
          <select
            value={String(limit)}
            onChange={(e) => setLimit(Number(e.target.value))}
            disabled={busy !== null}
            className="mt-1 rounded-[10px] border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
          >
            {[25, 50, 100, 200].map((n) => (
              <option key={n} value={String(n)}>
                {n} tournaments
              </option>
            ))}
          </select>
        </label>

        {currentSportId && (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={scoped}
              onChange={(e) => setScoped(e.target.checked)}
              disabled={busy !== null}
            />
            Only the filtered sport
          </label>
        )}

        <button
          type="button"
          className="btn"
          disabled={busy !== null || status?.enabled === false}
          onClick={() => void run(true)}
        >
          {busy === "preview" ? "Previewing…" : "Preview"}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy !== null || status?.enabled === false}
          onClick={() => void run(false)}
        >
          {busy === "run" ? "Reviewing…" : "Review and assign"}
        </button>
        {busy !== null && (
          <span className="text-xs text-[var(--color-fg-muted)]">
            Model calls run {limit <= 25 ? "a batch" : `${Math.ceil(limit / 25)} batches`} at
            a time — this can take a couple of minutes.
          </span>
        )}
      </div>

      {error && (
        <p className="text-xs" style={{ color: "var(--color-negative)" }}>
          {error}
        </p>
      )}

      {result && (
        <div className="space-y-2">
          <p className="font-mono text-xs text-[var(--color-fg-muted)]">
            {result.dryRun ? "preview" : "applied"} · considered {result.eligible} ·
            decided {result.reviewed} ·{" "}
            {result.dryRun ? "would assign" : "assigned"} {result.dryRun ? result.reviewed : result.assigned} ·
            outrights {result.outrights} · ceiling-clamped {result.clamped} ·
            undecided {result.undecided}
            {result.errors.length > 0 ? ` · errors ${result.errors.length}` : ""}
          </p>
          {result.errors.length > 0 && (
            <p className="text-xs" style={{ color: "var(--color-warning)" }}>
              {result.errors.slice(0, 2).join("; ")}
            </p>
          )}
          {result.proposals.length > 0 && (
            <div className="max-h-[320px] overflow-auto rounded-[10px] border border-[var(--color-border)]">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-[var(--color-bg-elevated)] text-[var(--color-fg-subtle)]">
                  <tr>
                    <th className="px-3 py-2 text-left">Tier</th>
                    <th className="px-3 py-2 text-left">Tournament</th>
                    <th className="px-3 py-2 text-left">Sport</th>
                    <th className="px-3 py-2 text-left">Reasoning</th>
                  </tr>
                </thead>
                <tbody>
                  {result.proposals.map((p) => (
                    <tr
                      key={p.tournamentId}
                      className="border-t border-[var(--color-border)]"
                    >
                      <td className="px-3 py-1.5 font-mono">
                        T{p.tier}
                        <span
                          className="ml-1 text-[10px] text-[var(--color-fg-subtle)]"
                          title={[
                            `ZillaAGI proposed T${p.proposedTier}`,
                            "+1 safety margin",
                            p.outright ? "+3 outright market" : null,
                            p.clamped ? "tightened further by the sport ceiling" : null,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        >
                          ←T{p.proposedTier}
                          {p.outright && (
                            <span style={{ color: "var(--color-warning)" }}> outright</span>
                          )}
                        </span>
                      </td>
                      <td className="px-3 py-1.5">{p.name}</td>
                      <td className="px-3 py-1.5 text-[var(--color-fg-muted)]">
                        {p.sportSlug}
                      </td>
                      <td className="px-3 py-1.5 text-[var(--color-fg-muted)]">{p.why}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {result.proposalsTruncated && (
            <p className="text-xs text-[var(--color-fg-subtle)]">
              Showing the first {result.proposals.length}.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function FilterBar({
  sports,
  categories,
  current,
  total,
  missingLogoCount,
}: {
  sports: SportOption[];
  categories: CategoryOption[];
  current: Filters;
  total: number;
  missingLogoCount: number;
}) {
  const router = useRouter();
  const [q, setQ] = useState(current.q);
  const [sportId, setSportId] = useState(current.sportId);
  const [categoryId, setCategoryId] = useState(current.categoryId);
  const [tier, setTier] = useState(current.tier);
  const [source, setSource] = useState(current.source);
  const [missingOnly, setMissingOnly] = useState(current.missingLogo);

  function applyFilters(e?: FormEvent) {
    e?.preventDefault();
    router.push(
      filtersToQuery(current, {
        sportId,
        categoryId,
        tier,
        source,
        q,
        missingLogo: missingOnly,
      }),
    );
  }

  function clearFilters() {
    setQ("");
    setSportId("");
    setCategoryId("");
    setTier("");
    setSource("");
    setMissingOnly(false);
    router.push("/admin/tournaments");
  }

  // The category list is fetched for the sport the PAGE was rendered
  // with, so a freshly-picked sport has none yet. Reset the selection and
  // disable the control rather than offering another sport's countries.
  function onSportChange(next: string) {
    setSportId(next);
    if (next !== current.sportId) setCategoryId("");
  }

  const categoriesReady = sportId !== "" && sportId === current.sportId;
  const totalTournaments = sports.reduce((acc, s) => acc + s.tournamentCount, 0);
  const anyFilter =
    current.q ||
    current.sportId ||
    current.categoryId ||
    current.tier ||
    current.source ||
    current.missingLogo ||
    current.sort !== "default";

  return (
    <form
      onSubmit={applyFilters}
      className="card flex flex-wrap items-end gap-3 p-4"
    >
      <label className="block">
        <span className="block text-xs text-[var(--color-fg-subtle)]">Sport</span>
        <select
          value={sportId}
          onChange={(e) => onSportChange(e.target.value)}
          className="mt-1 min-w-[200px] rounded-[10px] border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-2 outline-none focus:border-[var(--color-accent)]"
        >
          <option value="">All sports ({totalTournaments} tournaments)</option>
          {sports.map((s) => (
            <option key={s.id} value={String(s.id)}>
              {s.name} — {s.tournamentCount} · {s.missingLogoCount} missing
            </option>
          ))}
        </select>
      </label>

      <label className="block">
        <span className="block text-xs text-[var(--color-fg-subtle)]">Category</span>
        <select
          value={categoryId}
          onChange={(e) => setCategoryId(e.target.value)}
          disabled={!categoriesReady}
          title={
            categoriesReady
              ? undefined
              : "Pick a sport and apply first — categories belong to one sport."
          }
          className="mt-1 min-w-[170px] rounded-[10px] border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-2 outline-none focus:border-[var(--color-accent)] disabled:opacity-50"
        >
          <option value="">
            {categoriesReady ? `All categories (${categories.length})` : "Pick a sport"}
          </option>
          {categories.map((c) => (
            <option key={c.id} value={String(c.id)}>
              {c.name} — {c.tournamentCount}
            </option>
          ))}
        </select>
      </label>

      <label className="block">
        <span className="block text-xs text-[var(--color-fg-subtle)]">Risk tier</span>
        <select
          value={tier}
          onChange={(e) => setTier(e.target.value)}
          className="mt-1 min-w-[130px] rounded-[10px] border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-2 outline-none focus:border-[var(--color-accent)]"
        >
          <option value="">Any tier</option>
          <option value="unset">Unset (priced as T10)</option>
          {RISK_TIERS.map((t) => (
            <option key={t} value={String(t)}>
              T{t}
            </option>
          ))}
        </select>
      </label>

      <label className="block">
        <span className="block text-xs text-[var(--color-fg-subtle)]">Assigned by</span>
        <select
          value={source}
          onChange={(e) => setSource(e.target.value)}
          className="mt-1 min-w-[150px] rounded-[10px] border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-2 outline-none focus:border-[var(--color-accent)]"
        >
          <option value="">Any source</option>
          {(["auto", "zagi", "manual"] as const).map((s) => (
            <option key={s} value={s}>
              {SOURCE_LABELS[s]}
            </option>
          ))}
        </select>
      </label>

      <label className="block flex-1 min-w-[220px]">
        <span className="block text-xs text-[var(--color-fg-subtle)]">Search</span>
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Tournament name or slug"
          className="mt-1 w-full rounded-[10px] border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-2 outline-none focus:border-[var(--color-accent)]"
        />
      </label>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={missingOnly}
          onChange={(e) => setMissingOnly(e.target.checked)}
        />
        Missing logo only ({missingLogoCount})
      </label>

      <button type="submit" className="btn btn-primary">
        Apply
      </button>
      {anyFilter && (
        <button
          type="button"
          onClick={clearFilters}
          className="text-xs uppercase tracking-[0.15em] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
        >
          Clear
        </button>
      )}

      <span className="ml-auto text-xs text-[var(--color-fg-muted)]">
        {total} match{total === 1 ? "" : "es"}
      </span>
    </form>
  );
}

/**
 * A column header that sorts.
 *
 * Clicking the active column flips direction; clicking a new one starts
 * ascending. Clicking the active column while already descending returns
 * to the default order — the pin-order view — because that is the only
 * arrangement in which the reorder arrows are meaningful, and it would
 * otherwise be unreachable without clearing every filter.
 */
function SortHeader({
  label,
  sortKey,
  current,
  className = "",
}: {
  label: string;
  sortKey: SortKey;
  current: Filters;
  className?: string;
}) {
  const active = current.sort === sortKey;
  const next: Partial<Filters> = active
    ? current.dir === "asc"
      ? { sort: sortKey, dir: "desc" }
      : { sort: "default", dir: "asc" }
    : { sort: sortKey, dir: "asc" };

  return (
    <th className={`px-4 py-3 text-left ${className}`}>
      <Link
        href={filtersToQuery(current, next)}
        scroll={false}
        className="inline-flex items-center gap-1 uppercase tracking-[0.15em] hover:text-[var(--color-fg)]"
        style={active ? { color: "var(--color-accent)" } : undefined}
        title={
          active && current.dir === "desc"
            ? "Sorted descending — click again for the default pin order"
            : `Sort by ${label.toLowerCase()}`
        }
      >
        {label}
        <span aria-hidden className="text-[9px]">
          {active ? (current.dir === "asc" ? "▲" : "▼") : "↕"}
        </span>
      </Link>
    </th>
  );
}

function TournamentTable({ list, current }: { list: ListShape; current: Filters }) {
  if (list.tournaments.length === 0) {
    return (
      <p className="text-sm text-[var(--color-fg-muted)]">
        No tournaments match the current filters.
      </p>
    );
  }
  return (
    <div className="card overflow-hidden">
      <table className="w-full text-sm">
        <thead className="border-b border-[var(--color-border)] text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
          <tr>
            <th className="px-4 py-3 text-left">Logo</th>
            <SortHeader label="Tournament" sortKey="name" current={current} />
            <SortHeader label="Sport" sortKey="sport" current={current} />
            <SortHeader label="Category" sortKey="category" current={current} />
            <SortHeader label="Risk tier" sortKey="tier" current={current} />
            <th className="px-4 py-3 text-left">Order in category</th>
            <th className="px-4 py-3 text-left">Logo URL</th>
            <th className="px-4 py-3 text-left">Color</th>
            <th className="px-4 py-3" />
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--color-border)]">
          {list.tournaments.map((row) => (
            <TournamentEditableRow
              key={row.id}
              row={row}
              // Ends of the PINNED run inside this row's own category.
              // Read from the page, which is ordered pinned-first per
              // category, so the run is contiguous here. An active filter
              // can hide part of it and grey an arrow that had somewhere
              // to go — the server computes every move against the true
              // list, so only the disabled state is ever affected.
              first={row.displayOrder === 1}
              last={isLastPinnedInCategory(list.tournaments, row)}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

// True when no pinned tournament sits below this one in the same
// category — the down arrow then has nowhere to go. Unpinned rows report
// true so the arrow they never render stays consistent with the server's
// own no-op.
function isLastPinnedInCategory(
  rows: TournamentRow[],
  row: TournamentRow,
): boolean {
  const position = row.displayOrder;
  if (position == null) return true;
  return !rows.some(
    (r) =>
      r.categoryId === row.categoryId &&
      r.displayOrder != null &&
      r.displayOrder > position,
  );
}

function TournamentEditableRow({
  row,
  first,
  last,
}: {
  row: TournamentRow;
  first: boolean;
  last: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState(false);
  const [logoUrl, setLogoUrl] = useState(row.logoUrl ?? "");
  const [brandColor, setBrandColor] = useState(row.brandColor ?? "");
  // "auto" = unlocked (Oddin REST owns the value); "1".."10" = manual.
  const [riskTier, setRiskTier] = useState(
    row.riskTierLocked && row.riskTier != null ? String(row.riskTier) : "auto",
  );
  const [error, setError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [removing, setRemoving] = useState(false);

  function startEdit() {
    setLogoUrl(row.logoUrl ?? "");
    setBrandColor(row.brandColor ?? "");
    setRiskTier(row.riskTierLocked && row.riskTier != null ? String(row.riskTier) : "auto");
    setError(null);
    setEditing(true);
  }
  function cancelEdit() {
    setEditing(false);
    setError(null);
  }

  function save() {
    setError(null);
    if (brandColor.trim() && !/^#[0-9A-Fa-f]{6}$/.test(brandColor.trim())) {
      setError("Brand color must look like #RRGGBB.");
      return;
    }
    startTransition(async () => {
      try {
        await clientApi(`/admin/tournaments/${row.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            logoUrl: logoUrl.trim(),
            brandColor: brandColor.trim(),
            riskTier: riskTier === "auto" ? null : Number(riskTier),
          }),
        });
        setEditing(false);
        router.refresh();
      } catch (e) {
        setError(e instanceof ApiFetchError ? e.body.message : "Save failed.");
      }
    });
  }

  function removeLogo() {
    if (!row.logoUrl && !logoUrl) return;
    setError(null);
    setRemoving(true);
    startTransition(async () => {
      try {
        await clientApi(`/admin/tournaments/${row.id}/logo`, { method: "DELETE" });
        setLogoUrl("");
        router.refresh();
      } catch (e) {
        setError(e instanceof ApiFetchError ? e.body.message : "Remove failed.");
      } finally {
        setRemoving(false);
      }
    });
  }

  async function onFilePicked(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (!file) return;
    setError(null);
    if (
      !ACCEPTED_MIME.includes(file.type as (typeof ACCEPTED_MIME)[number]) &&
      !ACCEPTED_EXTENSIONS.some((ext) => file.name.toLowerCase().endsWith(ext))
    ) {
      setError("Use SVG, PNG, JPEG, or WebP.");
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setError("Max 1 MB.");
      return;
    }
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`/api/admin/tournaments/${row.id}/logo`, {
        method: "POST",
        body: fd,
        credentials: "include",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { message?: string }
          | null;
        throw new Error(body?.message ?? `Upload failed (${res.status})`);
      }
      const data = (await res.json()) as { logoUrl?: string };
      if (typeof data.logoUrl === "string") setLogoUrl(data.logoUrl);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  return (
    <tr>
      <td className="px-4 py-3">
        <LogoPreview
          url={editing ? logoUrl.trim() || null : row.logoUrl}
          name={row.name}
          color={editing ? brandColor.trim() || null : row.brandColor}
        />
      </td>
      <td className="px-4 py-3">
        <div className="font-medium">{row.name}</div>
        <div className="font-mono text-[10px] text-[var(--color-fg-subtle)]">{row.slug}</div>
      </td>
      <td className="px-4 py-3 text-[var(--color-fg-muted)]">{row.sportSlug}</td>
      <td className="px-4 py-3 text-[var(--color-fg-muted)]">{row.categoryName}</td>
      <td className="px-4 py-3 align-top">
        {editing ? (
          <select
            value={riskTier}
            onChange={(e) => setRiskTier(e.target.value)}
            disabled={pending}
            className="rounded-[8px] border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-2 py-1 font-mono text-xs outline-none focus:border-[var(--color-accent)]"
          >
            <option value="auto">
              {row.riskTier != null
                ? `Auto / ZAGI (now T${row.riskTier})`
                : "Auto / ZAGI (unset - priced as T10)"}
            </option>
            {RISK_TIERS.map((t) => (
              <option key={t} value={String(t)}>
                T{t} manual
              </option>
            ))}
          </select>
        ) : (
          <span className="inline-flex items-center gap-2 font-mono text-xs">
            {row.riskTier != null ? (
              `T${row.riskTier}`
            ) : (
              <span
                className="rounded-[4px] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em]"
                style={{
                  color: "var(--color-warning)",
                  border: "1px solid var(--color-warning)",
                }}
                title="No risk tier. RiskZilla underwrites this tournament at tier 10, the strictest, until ZillaAGI reviews it or an operator assigns one here."
              >
                unset
              </span>
            )}
            <TierSourceMark row={row} />
            {/* Only an automatic tier can be endorsed — a manual row is
                already the operator's, and an untiered one has no number
                to agree with. Same "lock wins" reading of the two
                signals that TierSourceMark uses. */}
            {row.riskTier != null &&
            !row.riskTierLocked &&
            row.riskTierSource !== "manual" ? (
              <ConfirmTierButton id={row.id} tier={row.riskTier} label={row.name} />
            ) : null}
          </span>
        )}
      </td>
      {/* Pinned tournaments head their category's bucket in the sidebar
          tree; everything unpinned stays on tier / live count / name. */}
      <td className="px-4 py-3 align-top">
        <PinOrderControls
          basePath="/admin/tournaments"
          id={row.id}
          displayOrder={row.displayOrder}
          first={first}
          last={last}
          label={row.name}
        />
      </td>
      <td className="px-4 py-3 align-top">
        {editing ? (
          <input
            type="url"
            value={logoUrl}
            onChange={(e) => setLogoUrl(e.target.value)}
            placeholder="https://…/logo.png"
            disabled={pending}
            className="w-full min-w-[280px] rounded-[8px] border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-2 py-1 font-mono text-xs outline-none focus:border-[var(--color-accent)]"
          />
        ) : row.logoUrl ? (
          <a
            href={row.logoUrl}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-xs text-[var(--color-fg-muted)] underline-offset-2 hover:underline"
          >
            {truncate(row.logoUrl, 48)}
          </a>
        ) : (
          <span className="text-xs text-[var(--color-fg-subtle)]">—</span>
        )}
      </td>
      <td className="px-4 py-3 align-top">
        {editing ? (
          <input
            type="text"
            value={brandColor}
            onChange={(e) => setBrandColor(e.target.value)}
            placeholder="#RRGGBB"
            disabled={pending}
            className="w-[110px] rounded-[8px] border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-2 py-1 font-mono text-xs outline-none focus:border-[var(--color-accent)]"
          />
        ) : row.brandColor ? (
          <span className="inline-flex items-center gap-2 font-mono text-xs">
            <span
              aria-hidden
              style={{
                width: 12,
                height: 12,
                borderRadius: 3,
                background: row.brandColor,
                border: "1px solid var(--color-border)",
              }}
            />
            {row.brandColor}
          </span>
        ) : (
          <span className="text-xs text-[var(--color-fg-subtle)]">—</span>
        )}
      </td>
      <td className="px-4 py-3 align-top text-right">
        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPTED_MIME.join(",")}
          onChange={onFilePicked}
          style={{ display: "none" }}
        />
        {editing ? (
          <div className="flex flex-col items-end gap-1">
            <div className="flex justify-end gap-3">
              <button
                type="button"
                onClick={save}
                disabled={pending}
                className="text-xs uppercase tracking-[0.15em] text-[var(--color-accent)] hover:opacity-80 disabled:opacity-50"
              >
                Save
              </button>
              <button
                type="button"
                onClick={cancelEdit}
                disabled={pending}
                className="text-xs uppercase tracking-[0.15em] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
            {error ? (
              <span role="alert" className="text-[11px] text-[var(--color-negative)]">
                {error}
              </span>
            ) : null}
          </div>
        ) : (
          <div className="flex flex-col items-end gap-1">
            <div className="flex flex-wrap justify-end gap-3">
              <button
                type="button"
                onClick={startEdit}
                disabled={uploading || removing}
                className="text-xs uppercase tracking-[0.15em] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] disabled:opacity-50"
              >
                Edit
              </button>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading || removing}
                className="text-xs uppercase tracking-[0.15em] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] disabled:opacity-50"
              >
                {uploading ? "Uploading…" : "Upload"}
              </button>
              {row.logoUrl ? (
                <button
                  type="button"
                  onClick={removeLogo}
                  disabled={uploading || removing}
                  className="text-xs uppercase tracking-[0.15em] text-[var(--color-fg-muted)] hover:text-[var(--color-negative)] disabled:opacity-50"
                >
                  {removing ? "Removing…" : "Remove"}
                </button>
              ) : null}
            </div>
            {error ? (
              <span role="alert" className="text-[11px] text-[var(--color-negative)]">
                {error}
              </span>
            ) : null}
            <span className="text-[10px] text-[var(--color-fg-subtle)]">
              SVG · PNG · JPEG · WebP · ≤1 MB
            </span>
          </div>
        )}
      </td>
    </tr>
  );
}

function LogoPreview({
  url,
  name,
  color,
}: {
  url: string | null;
  name: string;
  color: string | null;
}) {
  const [failed, setFailed] = useState(false);
  const showImg = !!url && !failed && (url.startsWith("http") || url.startsWith("/"));
  const initials = name
    .split(/\s+/)
    .slice(0, 3)
    .map((w) => w[0])
    .join("")
    .slice(0, 4)
    .toUpperCase();
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 36,
        height: 36,
        borderRadius: 8,
        background: "var(--color-bg-elevated)",
        border: "1px solid var(--color-border)",
        fontFamily: "var(--font-geist-mono, monospace)",
        fontSize: 11,
        color: "var(--color-fg-muted)",
        position: "relative",
        overflow: "hidden",
      }}
    >
      {color ? (
        <span
          aria-hidden
          style={{
            position: "absolute",
            top: 3,
            right: 3,
            width: 6,
            height: 6,
            borderRadius: 999,
            background: color,
            zIndex: 2,
          }}
        />
      ) : null}
      {showImg ? (
        <img
          src={url ?? undefined}
          alt={name}
          onError={() => setFailed(true)}
          loading="lazy"
          decoding="async"
          style={{ width: "100%", height: "100%", objectFit: "contain", padding: 3 }}
        />
      ) : (
        initials
      )}
    </span>
  );
}

function Pager({ list, current }: { list: ListShape; current: Filters }) {
  if (list.total <= list.limit) return null;
  const router = useRouter();
  const page = Math.floor(list.offset / list.limit) + 1;
  const lastPage = Math.ceil(list.total / list.limit);

  // Through the shared builder, or page 2 quietly drops the category,
  // tier, source and sort the operator is looking at.
  function go(offset: number) {
    router.push(filtersToQuery(current, { offset }));
  }

  return (
    <div className="flex items-center justify-between text-xs text-[var(--color-fg-muted)]">
      <span>
        Page {page} of {lastPage}
      </span>
      <div className="flex gap-3">
        <button
          type="button"
          onClick={() => go(Math.max(0, list.offset - list.limit))}
          disabled={list.offset === 0}
          className="rounded border border-[var(--color-border)] px-3 py-1 disabled:opacity-40"
        >
          ← Prev
        </button>
        <button
          type="button"
          onClick={() => go(list.offset + list.limit)}
          disabled={list.offset + list.limit >= list.total}
          className="rounded border border-[var(--color-border)] px-3 py-1 disabled:opacity-40"
        >
          Next →
        </button>
      </div>
    </div>
  );
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}
