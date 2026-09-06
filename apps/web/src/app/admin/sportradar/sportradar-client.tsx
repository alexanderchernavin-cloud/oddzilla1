"use client";

// The mapping desk. Three jobs on one screen:
//
//   1. Show all three ids for a fixture side by side — ours, the feed
//      provider's, and Sportradar's. That is the artefact people asked
//      for, and having it visible is what makes a bad pair obvious.
//   2. Import a pasted batch of Sportradar fixtures and auto-match it.
//      Preview first (a dry run writes nothing), then commit.
//   3. Work the review queue: confirm, reject, correct, or drop.
//
// Only CONFIRMED mappings reach the storefront, so an unworked queue
// means a missing tracker — never a wrong one.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { clientApi, ApiFetchError } from "@/lib/api-client";

export interface SportOption {
  id: number;
  slug: string;
  name: string;
  srSportId: number | null;
}

export interface MappingRow {
  matchId: string;
  providerUrn: string;
  provider: string;
  providerMatchId: string;
  homeTeam: string;
  awayTeam: string;
  scheduledAt: string | null;
  matchStatus: string;
  sportId: number;
  sportSlug: string;
  sportName: string;
  tournamentName: string;
  lmtSupported: boolean;
  srMatchId: number | null;
  srSportId: number | null;
  mapStatus: "candidate" | "confirmed" | "rejected" | null;
  source: "admin" | "auto" | "llm" | null;
  confidence: number | null;
  evidence: {
    srHomeTeam?: string;
    srAwayTeam?: string;
    srHomeTeamAlt?: string;
    srAwayTeamAlt?: string;
    srStartsAt?: string;
    srTournament?: string;
    kickoffDeltaMinutes?: number;
    homeScore?: number;
    awayScore?: number;
    sidesSwapped?: boolean;
    /** Only one side matched by name; proposed on kickoff + that side. */
    weak?: boolean;
    alternatives?: Array<{
      srMatchId: number;
      score: number;
      homeTeam: string;
      awayTeam: string;
    }>;
    llm?: { verdict?: string; reason?: string; model?: string; at?: string };
  } | null;
  reviewedAt: string | null;
}

interface ImportPreview {
  dryRun: boolean;
  fixturesParsed: number;
  parseErrors: Array<{ line: number; reason: string; raw: string }>;
  matchesConsidered: number;
  proposed: number;
  wouldAutoConfirm: number;
  queuedForReview: number;
  unmatched: number;
  written?: number;
  skippedTaken?: number;
  preview: Array<{
    matchId: string;
    homeTeam: string;
    awayTeam: string;
    srMatchId: number;
    srHomeTeam: string;
    srAwayTeam: string;
    confidence: number;
    autoConfirm: boolean;
    sidesSwapped: boolean;
  }>;
}

const TABS = [
  { key: "candidate", label: "Review queue" },
  { key: "unmapped", label: "Unmapped" },
  { key: "confirmed", label: "Confirmed" },
  { key: "rejected", label: "Rejected" },
  { key: "all", label: "All mapped" },
] as const;

function fmtKickoff(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toISOString().replace("T", " ").slice(0, 16) + "Z";
}

export function SportradarDesk({
  summary,
  sports,
  rows,
  total,
  page,
  pageSize,
  status,
  sportId,
  q,
}: {
  summary: { candidate: number; confirmed: number; rejected: number; unmapped: number; lmtSports: number };
  sports: SportOption[];
  rows: MappingRow[];
  total: number;
  page: number;
  pageSize: number;
  status: string;
  sportId: string;
  q: string;
}) {
  const router = useRouter();
  const [search, setSearch] = useState(q);

  const navigate = (patch: Record<string, string>) => {
    const params = new URLSearchParams({ status, page: "1" });
    if (sportId) params.set("sportId", sportId);
    if (search) params.set("q", search);
    for (const [k, v] of Object.entries(patch)) {
      if (v) params.set(k, v);
      else params.delete(k);
    }
    router.push(`/admin/sportradar?${params.toString()}`);
  };

  const lastPage = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <header>
        <h1 style={{ fontSize: 22, margin: 0 }}>Sportradar mapping</h1>
        <p style={{ color: "var(--color-fg-muted, #888)", fontSize: 13, marginTop: 6, maxWidth: 760 }}>
          Links an Oddzilla match to its Sportradar fixture so the Live Match
          Tracker can be mounted. Our own match id and the Oddin / Fonbet id
          come from the feed; the Sportradar id does not exist in either feed
          and has to be supplied here. Only <strong>confirmed</strong> rows
          reach the storefront.
        </p>
      </header>

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <Kpi label="Awaiting review" value={summary.candidate} tone={summary.candidate > 0 ? "warn" : "ok"} />
        <Kpi label="Confirmed" value={summary.confirmed} tone="ok" />
        <Kpi label="Mappable, unmapped" value={summary.unmapped} />
        <Kpi label="Rejected" value={summary.rejected} />
        <Kpi label="Sports LMT covers" value={summary.lmtSports} />
      </div>

      <SyncPanel sports={sports.filter((s) => s.srSportId !== null)} />

      <ImportPanel sports={sports.filter((s) => s.srSportId !== null)} />

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={`/admin/sportradar?status=${t.key}${sportId ? `&sportId=${sportId}` : ""}`}
            style={{
              padding: "6px 12px",
              borderRadius: 999,
              fontSize: 13,
              textDecoration: "none",
              border: "1px solid var(--color-border, #333)",
              background: status === t.key ? "var(--color-accent, #4a6)" : "transparent",
              color: status === t.key ? "#fff" : "inherit",
            }}
          >
            {t.label}
          </Link>
        ))}

        <select
          value={sportId}
          onChange={(e) => navigate({ sportId: e.target.value })}
          style={{ padding: "6px 10px", borderRadius: 6 }}
        >
          <option value="">All sports</option>
          {sports.map((s) => (
            <option key={s.id} value={String(s.id)}>
              {s.name}
              {s.srSportId === null ? " (no LMT)" : ""}
            </option>
          ))}
        </select>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            navigate({});
          }}
          style={{ display: "flex", gap: 6 }}
        >
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Team name…"
            style={{ padding: "6px 10px", borderRadius: 6, minWidth: 180 }}
          />
          <button type="submit" style={btn()}>
            Search
          </button>
        </form>
      </div>

      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "1px solid var(--color-border, #333)" }}>
              <th style={th()}>Match</th>
              <th style={th()}>Oddzilla id</th>
              <th style={th()}>Feed id</th>
              <th style={th()}>Sportradar</th>
              <th style={th()}>Confidence</th>
              <th style={th()}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6} style={{ padding: 24, color: "var(--color-fg-muted, #888)" }}>
                  Nothing here.
                </td>
              </tr>
            ) : (
              rows.map((r) => <Row key={r.matchId} row={r} />)
            )}
          </tbody>
        </table>
      </div>

      <div style={{ display: "flex", gap: 10, alignItems: "center", fontSize: 13 }}>
        <span style={{ color: "var(--color-fg-muted, #888)" }}>
          {total} row{total === 1 ? "" : "s"} · page {page} of {lastPage}
        </span>
        {page > 1 ? (
          <Link href={pageHref(status, sportId, q, page - 1)} style={btn()}>
            Previous
          </Link>
        ) : null}
        {page < lastPage ? (
          <Link href={pageHref(status, sportId, q, page + 1)} style={btn()}>
            Next
          </Link>
        ) : null}
      </div>
    </div>
  );
}

function pageHref(status: string, sportId: string, q: string, page: number): string {
  const params = new URLSearchParams({ status, page: String(page) });
  if (sportId) params.set("sportId", sportId);
  if (q) params.set("q", q);
  return `/admin/sportradar?${params.toString()}`;
}

function Row({ row }: { row: MappingRow }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [srId, setSrId] = useState(row.srMatchId ? String(row.srMatchId) : "");

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      setEditing(false);
      startTransition(() => router.refresh());
    } catch (e) {
      setError(e instanceof ApiFetchError ? e.body.message : "Request failed.");
    }
  };

  const ev = row.evidence;

  return (
    <tr style={{ borderBottom: "1px solid var(--color-border, #222)", verticalAlign: "top" }}>
      <td style={td()}>
        <div style={{ fontWeight: 600 }}>
          {row.homeTeam} v {row.awayTeam}
        </div>
        <div style={{ color: "var(--color-fg-muted, #888)", fontSize: 12 }}>
          {row.sportName} · {row.tournamentName}
        </div>
        <div style={{ color: "var(--color-fg-muted, #888)", fontSize: 12 }}>
          {fmtKickoff(row.scheduledAt)} · {row.matchStatus}
          {row.lmtSupported ? "" : " · no LMT for this sport"}
        </div>
      </td>

      <td style={td()}>
        <Link href={`/match/${row.matchId}`} className="mono" style={{ fontSize: 12 }}>
          {row.matchId}
        </Link>
      </td>

      <td style={{ ...td(), fontSize: 12 }} className="mono">
        <div>{row.provider}</div>
        <div style={{ color: "var(--color-fg-muted, #888)" }}>{row.providerMatchId}</div>
      </td>

      <td style={td()}>
        {editing ? (
          <div style={{ display: "flex", gap: 6 }}>
            <input
              value={srId}
              onChange={(e) => setSrId(e.target.value)}
              placeholder="72221238"
              style={{ width: 130, padding: "4px 8px", borderRadius: 6 }}
            />
            <button
              type="button"
              style={btn()}
              disabled={pending}
              onClick={() =>
                act(() =>
                  clientApi(`/admin/sportradar/mappings/${row.matchId}`, {
                    method: "PUT",
                    body: JSON.stringify({
                      srMatchId: Number(srId.replace(/^sr:match:/iu, "")),
                    }),
                  }),
                )
              }
            >
              Save
            </button>
            <button type="button" style={btn()} onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        ) : row.srMatchId === null ? (
          <span style={{ color: "var(--color-fg-muted, #888)" }}>—</span>
        ) : (
          <>
            <div className="mono" style={{ fontSize: 12 }}>
              {row.srMatchId}
              {row.srSportId !== null ? (
                <span style={{ color: "var(--color-fg-muted, #888)" }}> · sport {row.srSportId}</span>
              ) : null}
            </div>
            {ev?.srHomeTeam ? (
              <div style={{ color: "var(--color-fg-muted, #888)", fontSize: 12 }}>
                {ev.srHomeTeam}
                {ev.srHomeTeamAlt ? ` (${ev.srHomeTeamAlt})` : ""} v {ev.srAwayTeam}
                {ev.srAwayTeamAlt ? ` (${ev.srAwayTeamAlt})` : ""}
              </div>
            ) : null}
            {ev?.sidesSwapped ? (
              <div style={{ fontSize: 11, color: "#c93" }}>home/away swapped</div>
            ) : null}
            {ev?.weak ? (
              <div style={{ fontSize: 11, color: "#c93" }}>
                one side matched by name only
              </div>
            ) : null}
            {ev?.alternatives?.length ? (
              <details style={{ fontSize: 11, marginTop: 4 }}>
                <summary style={{ cursor: "pointer", color: "var(--color-fg-muted, #888)" }}>
                  {ev.alternatives.length} runner-up
                  {ev.alternatives.length === 1 ? "" : "s"}
                </summary>
                {ev.alternatives.map((a) => (
                  <div key={a.srMatchId} className="mono">
                    {a.srMatchId} · {a.score.toFixed(2)} · {a.homeTeam} v {a.awayTeam}
                  </div>
                ))}
              </details>
            ) : null}
          </>
        )}
      </td>

      <td style={td()}>
        <StatusChip status={row.mapStatus} source={row.source} />
        {row.confidence !== null ? (
          <div className="mono" style={{ fontSize: 12, marginTop: 4 }}>
            {row.confidence.toFixed(3)}
          </div>
        ) : null}
        {ev?.kickoffDeltaMinutes !== undefined ? (
          <div style={{ fontSize: 11, color: "var(--color-fg-muted, #888)" }}>
            kickoff Δ {ev.kickoffDeltaMinutes} min
          </div>
        ) : null}
        {ev?.llm?.reason ? (
          <div
            title={ev.llm.model ? `decided by ${ev.llm.model}` : undefined}
            style={{ fontSize: 11, color: "var(--color-fg-muted, #888)", marginTop: 2 }}
          >
            AI: {ev.llm.reason}
          </div>
        ) : null}
      </td>

      <td style={td()}>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {row.mapStatus === "candidate" ? (
            <>
              <button
                type="button"
                style={btn("ok")}
                disabled={pending}
                onClick={() =>
                  act(() =>
                    clientApi(`/admin/sportradar/mappings/${row.matchId}/confirm`, {
                      method: "POST",
                    }),
                  )
                }
              >
                Confirm
              </button>
              <button
                type="button"
                style={btn("warn")}
                disabled={pending}
                onClick={() =>
                  act(() =>
                    clientApi(`/admin/sportradar/mappings/${row.matchId}/reject`, {
                      method: "POST",
                    }),
                  )
                }
              >
                Reject
              </button>
            </>
          ) : null}
          <button type="button" style={btn()} onClick={() => setEditing(true)}>
            {row.srMatchId === null ? "Set id" : "Edit"}
          </button>
          {row.mapStatus !== null ? (
            <button
              type="button"
              style={btn()}
              disabled={pending}
              onClick={() =>
                act(() =>
                  clientApi(`/admin/sportradar/mappings/${row.matchId}`, {
                    method: "DELETE",
                  }),
                )
              }
            >
              Clear
            </button>
          ) : null}
        </div>
        {error ? <div style={{ color: "#e66", fontSize: 12, marginTop: 4 }}>{error}</div> : null}
      </td>
    </tr>
  );
}

function StatusChip({
  status,
  source,
}: {
  status: MappingRow["mapStatus"];
  source: MappingRow["source"];
}) {
  if (status === null) {
    return <span style={{ fontSize: 12, color: "var(--color-fg-muted, #888)" }}>unmapped</span>;
  }
  const tone =
    status === "confirmed" ? "#3a7" : status === "candidate" ? "#c93" : "#888";
  return (
    <span style={{ fontSize: 12, color: tone }}>
      {status}
      {source ? ` · ${source}` : ""}
    </span>
  );
}

interface SyncResult {
  dryRun: boolean;
  proposed: number;
  autoConfirmed: number;
  written: number;
  fetchErrors: string[];
  sports: Array<{
    sportSlug: string;
    days: number;
    fixturesFetched: number;
    matchesConsidered: number;
    proposed: number;
    autoConfirmed: number;
    queuedForReview: number;
    written: number;
  }>;
}

// The primary path: pull the fixtures from Sportradar's statistics feed
// and match them. The paste import below stays for anything the feed does
// not carry, and for a one-off correction.
function SyncPanel({ sports }: { sports: SportOption[] }) {
  const router = useRouter();
  const [sportSlug, setSportSlug] = useState("");
  const [result, setResult] = useState<SyncResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (dryRun: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const res = await clientApi<SyncResult>("/admin/sportradar/sync", {
        method: "POST",
        body: JSON.stringify({
          ...(sportSlug ? { sportSlug } : {}),
          dryRun,
        }),
      });
      setResult(res);
      if (!dryRun) router.refresh();
    } catch (e) {
      setError(e instanceof ApiFetchError ? e.body.message : "Sync failed.");
      setResult(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        border: "1px solid var(--color-border, #333)",
        borderRadius: 10,
        padding: 14,
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 4 }}>Sync from Sportradar</div>
      <p style={{ fontSize: 13, color: "var(--color-fg-muted, #888)", maxWidth: 760, margin: "4px 0 10px" }}>
        Fetches each sport&apos;s fixtures for the days our own open matches
        fall on and pairs them automatically. Strong, unambiguous pairs are
        confirmed; the rest queue below. Decisions you have already made are
        never overwritten. <strong>Preview</strong> writes nothing.
      </p>

      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <select
          value={sportSlug}
          onChange={(e) => setSportSlug(e.target.value)}
          style={{ padding: "6px 10px", borderRadius: 6 }}
        >
          <option value="">All covered sports</option>
          {sports.map((s) => (
            <option key={s.slug} value={s.slug}>
              {s.name}
            </option>
          ))}
        </select>
        <button type="button" style={btn()} disabled={busy} onClick={() => run(true)}>
          {busy ? "Working…" : "Preview"}
        </button>
        <button type="button" style={btn("ok")} disabled={busy} onClick={() => run(false)}>
          Sync now
        </button>
        <AdjudicateButton />
      </div>

      {error ? <div style={{ color: "#e66", fontSize: 13, marginTop: 8 }}>{error}</div> : null}

      {result ? (
        <div style={{ fontSize: 13, marginTop: 10 }}>
          <div>
            {result.dryRun ? "Preview" : "Synced"}: {result.proposed} paired ·{" "}
            {result.autoConfirmed} auto-confirmed
            {result.dryRun ? "" : ` · ${result.written} written`}
          </div>
          {result.fetchErrors.length > 0 ? (
            <details style={{ marginTop: 6 }}>
              <summary style={{ cursor: "pointer", color: "#c93" }}>
                {result.fetchErrors.length} day
                {result.fetchErrors.length === 1 ? "" : "s"} could not be fetched
              </summary>
              {result.fetchErrors.map((e) => (
                <div key={e} className="mono" style={{ fontSize: 12 }}>
                  {e}
                </div>
              ))}
            </details>
          ) : null}
          {result.sports.length > 0 ? (
            <table style={{ borderCollapse: "collapse", fontSize: 12, marginTop: 8 }}>
              <thead>
                <tr style={{ textAlign: "left", color: "var(--color-fg-muted, #888)" }}>
                  <th style={{ padding: "2px 10px 2px 0" }}>Sport</th>
                  <th style={{ padding: "2px 10px" }}>Ours</th>
                  <th style={{ padding: "2px 10px" }}>SR</th>
                  <th style={{ padding: "2px 10px" }}>Paired</th>
                  <th style={{ padding: "2px 10px" }}>Auto</th>
                  <th style={{ padding: "2px 10px" }}>Review</th>
                </tr>
              </thead>
              <tbody>
                {result.sports.map((s) => (
                  <tr key={s.sportSlug}>
                    <td style={{ padding: "2px 10px 2px 0" }}>{s.sportSlug}</td>
                    <td style={{ padding: "2px 10px" }}>{s.matchesConsidered}</td>
                    <td style={{ padding: "2px 10px" }}>{s.fixturesFetched}</td>
                    <td style={{ padding: "2px 10px" }}>{s.proposed}</td>
                    <td style={{ padding: "2px 10px", color: "#3a7" }}>{s.autoConfirmed}</td>
                    <td style={{ padding: "2px 10px", color: "#c93" }}>{s.queuedForReview}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

interface AdjudicateResult {
  eligible: number;
  reviewed: number;
  confirmed: number;
  rejected: number;
  unsure: number;
  errors: string[];
}

// The matcher queues what it cannot settle, and nearly all of that is one
// provider abbreviating the other. A model decides those on every sweep;
// this is the on-demand handle for an operator who wants it now.
function AdjudicateButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AdjudicateResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await clientApi<AdjudicateResult>("/admin/sportradar/adjudicate", {
        method: "POST",
        body: JSON.stringify({ limit: 200 }),
      });
      setResult(res);
      router.refresh();
    } catch (e) {
      setError(e instanceof ApiFetchError ? e.body.message : "Review failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button type="button" style={btn()} disabled={busy} onClick={run}>
        {busy ? "Reviewing…" : "AI-review queue"}
      </button>
      {result ? (
        <span style={{ fontSize: 12, color: "var(--color-fg-muted, #888)" }}>
          {result.reviewed} reviewed · {result.confirmed} confirmed ·{" "}
          {result.rejected} rejected · {result.unsure} left for you
        </span>
      ) : null}
      {error ? <span style={{ fontSize: 12, color: "#e66" }}>{error}</span> : null}
    </>
  );
}

function ImportPanel({ sports }: { sports: SportOption[] }) {
  const router = useRouter();
  const [sportSlug, setSportSlug] = useState(sports[0]?.slug ?? "");
  const [text, setText] = useState("");
  const [result, setResult] = useState<ImportPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (dryRun: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const res = await clientApi<ImportPreview>("/admin/sportradar/import", {
        method: "POST",
        body: JSON.stringify({ sportSlug, text, dryRun }),
      });
      setResult(res);
      if (!dryRun) router.refresh();
    } catch (e) {
      setError(e instanceof ApiFetchError ? e.body.message : "Import failed.");
      setResult(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <details
      style={{
        border: "1px solid var(--color-border, #333)",
        borderRadius: 10,
        padding: 14,
      }}
    >
      <summary style={{ cursor: "pointer", fontWeight: 600 }}>
        Import Sportradar fixtures
      </summary>

      <p style={{ fontSize: 13, color: "var(--color-fg-muted, #888)", maxWidth: 760 }}>
        Paste one sport&apos;s fixtures. Accepted: Sportradar schedule JSON
        (<code>{"{ \"sport_events\": [...] }"}</code>), a JSON array, or one
        fixture per line as{" "}
        <code>id · kickoff · home · away · competition</code> separated by tab,
        semicolon, pipe or comma. Ids may be written{" "}
        <code>72221238</code> or <code>sr:match:72221238</code>. A bare
        <code> 2026-09-06 13:00</code> is read as UTC.
      </p>
      <p style={{ fontSize: 13, color: "var(--color-fg-muted, #888)", maxWidth: 760 }}>
        Matching is on kickoff time and team names. Strong, unambiguous pairs
        are confirmed automatically; everything else waits in the review
        queue. Rows you have already confirmed or rejected by hand are never
        overwritten. <strong>Preview</strong> writes nothing.
      </p>

      <div style={{ display: "flex", gap: 10, alignItems: "center", margin: "10px 0" }}>
        <select
          value={sportSlug}
          onChange={(e) => setSportSlug(e.target.value)}
          style={{ padding: "6px 10px", borderRadius: 6 }}
        >
          {sports.map((s) => (
            <option key={s.slug} value={s.slug}>
              {s.name} (SR sport {s.srSportId})
            </option>
          ))}
        </select>
        <button type="button" style={btn()} disabled={busy || !text.trim()} onClick={() => run(true)}>
          Preview
        </button>
        <button
          type="button"
          style={btn("ok")}
          disabled={busy || !text.trim()}
          onClick={() => run(false)}
        >
          Import
        </button>
      </div>

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={8}
        placeholder={"72221238\t2026-09-06T13:00:00Z\tEverton\tManchester United\tPremier League"}
        style={{ width: "100%", fontFamily: "monospace", fontSize: 12, padding: 8, borderRadius: 6 }}
      />

      {error ? <div style={{ color: "#e66", fontSize: 13, marginTop: 8 }}>{error}</div> : null}

      {result ? (
        <div style={{ fontSize: 13, marginTop: 10 }}>
          <div>
            {result.dryRun ? "Preview" : "Imported"}: {result.fixturesParsed} fixtures
            parsed · {result.matchesConsidered} of our matches considered ·{" "}
            {result.proposed} paired ({result.wouldAutoConfirm} auto-confirmed,{" "}
            {result.queuedForReview} queued) · {result.unmatched} of ours unmatched
            {result.skippedTaken ? ` · ${result.skippedTaken} skipped (id already mapped)` : ""}
          </div>
          {result.parseErrors.length > 0 ? (
            <details style={{ marginTop: 6 }}>
              <summary style={{ cursor: "pointer", color: "#c93" }}>
                {result.parseErrors.length} line
                {result.parseErrors.length === 1 ? "" : "s"} could not be read
              </summary>
              {result.parseErrors.map((e) => (
                <div key={e.line} className="mono" style={{ fontSize: 12 }}>
                  line {e.line}: {e.reason}
                </div>
              ))}
            </details>
          ) : null}
          {result.preview.length > 0 ? (
            <details style={{ marginTop: 6 }} open={result.dryRun}>
              <summary style={{ cursor: "pointer" }}>Pairs</summary>
              <table style={{ borderCollapse: "collapse", fontSize: 12, marginTop: 6 }}>
                <tbody>
                  {result.preview.map((p) => (
                    <tr key={p.matchId}>
                      <td style={{ padding: "2px 8px" }}>
                        {p.homeTeam} v {p.awayTeam}
                      </td>
                      <td style={{ padding: "2px 8px", color: "var(--color-fg-muted, #888)" }}>
                        {p.srHomeTeam} v {p.srAwayTeam}
                      </td>
                      <td className="mono" style={{ padding: "2px 8px" }}>
                        {p.srMatchId}
                      </td>
                      <td className="mono" style={{ padding: "2px 8px" }}>
                        {p.confidence.toFixed(3)}
                      </td>
                      <td style={{ padding: "2px 8px", color: p.autoConfirm ? "#3a7" : "#c93" }}>
                        {p.autoConfirm ? "auto" : "review"}
                        {p.sidesSwapped ? " · swapped" : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          ) : null}
        </div>
      ) : null}
    </details>
  );
}

function Kpi({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "ok" | "warn";
}) {
  return (
    <div
      style={{
        border: "1px solid var(--color-border, #333)",
        borderRadius: 10,
        padding: "10px 14px",
        minWidth: 130,
      }}
    >
      <div style={{ fontSize: 12, color: "var(--color-fg-muted, #888)" }}>{label}</div>
      <div
        style={{
          fontSize: 22,
          fontWeight: 600,
          color: tone === "warn" ? "#c93" : tone === "ok" ? "#3a7" : "inherit",
        }}
      >
        {value}
      </div>
    </div>
  );
}

function th(): React.CSSProperties {
  return { padding: "8px 10px", fontWeight: 600, fontSize: 12 };
}

function td(): React.CSSProperties {
  return { padding: "10px" };
}

function btn(tone?: "ok" | "warn"): React.CSSProperties {
  return {
    padding: "5px 10px",
    borderRadius: 6,
    fontSize: 12,
    cursor: "pointer",
    textDecoration: "none",
    border: "1px solid var(--color-border, #333)",
    background:
      tone === "ok" ? "#2c6" : tone === "warn" ? "#c63" : "transparent",
    color: tone ? "#fff" : "inherit",
  };
}
