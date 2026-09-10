"use client";

import { useState, useTransition, type FormEvent } from "react";
import { clientApi, ApiFetchError } from "@/lib/api-client";
import { LINE_KEYS, type LineKey } from "@oddzilla/types/slotzilla";
import {
  normaliseCorpusSummary,
  type SlotzillaCorpusFetchRequest,
  type SlotzillaCorpusFetchResponse,
  type SlotzillaCorpusSummaryDto,
} from "./slotzilla-admin-types";
import { normaliseLineFrequencies, parseIntField } from "./format";
import {
  ErrorBanner,
  Field,
  LoadFailed,
  NoticeBanner,
  Section,
  ghostButtonStyle,
  hintStyle,
  inputStyle,
  monoMuted,
  primaryButtonStyle,
  rowStyle,
  tableStyle,
  tdStyle,
  thStyle,
} from "./ui";

// The corpus: finished basketball matches whose timelines were pulled
// from the statistics host so the calibrator has line frequencies to fit
// against. The summary says how big it is; the form grows it. A fetch
// walks one day-list per date and one timeline per new match at the
// host's pace, so it is slow by design and rate-limited to 5 an hour.

const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

function defaultRange(): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to.getTime() - 7 * 86_400_000);
  return { from: isoDate(from), to: isoDate(to) };
}

const FETCH_RESULT_LABELS: Record<string, string> = {
  matchesSeen: "Matches listed",
  matchesFetched: "Timelines fetched",
  eventsInserted: "Events inserted",
  skipped: "Skipped (already held or not ended)",
};

export function CorpusTab({ initial }: { initial: unknown }) {
  const [summary, setSummary] = useState<SlotzillaCorpusSummaryDto | null>(() => normaliseCorpusSummary(initial));
  const [range, setRange] = useState(defaultRange);
  const [maxMatches, setMaxMatches] = useState("200");
  const [result, setResult] = useState<SlotzillaCorpusFetchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const reload = async () => {
    const raw = await clientApi<unknown>("/admin/slotzilla/corpus/summary");
    setSummary(normaliseCorpusSummary(raw));
  };

  const retry = () => {
    setError(null);
    startTransition(async () => {
      try {
        await reload();
      } catch (err) {
        setError(err instanceof ApiFetchError ? err.message : "Could not load the corpus summary.");
      }
    });
  };

  const onFetch = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    setResult(null);
    const max = parseIntField(maxMatches);
    if (max === null || max < 1) {
      setError("Max matches must be a whole number of at least 1.");
      return;
    }
    if (!range.from || !range.to || range.from > range.to) {
      setError("Pick a from date on or before the to date.");
      return;
    }
    const body: SlotzillaCorpusFetchRequest = { from: range.from, to: range.to, maxMatches: max };
    startTransition(async () => {
      try {
        const raw = await clientApi<unknown>("/admin/slotzilla/corpus/fetch", {
          method: "POST",
          body: JSON.stringify(body),
        });
        setResult(typeof raw === "object" && raw !== null ? (raw as SlotzillaCorpusFetchResponse) : {});
        await reload();
      } catch (err) {
        setError(err instanceof ApiFetchError ? err.message : "The fetch failed. Check the api log.");
      }
    });
  };

  const freq = summary ? normaliseLineFrequencies(summary.byLine, summary.rounds, LINE_KEYS) : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <Section title="Corpus summary">
        {summary === null ? (
          <LoadFailed what="the corpus summary" onRetry={retry} pending={pending} />
        ) : (
          <>
            <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
              <Stat label="Matches" value={summary.matches} />
              <Stat label="Events" value={summary.events} />
              <Stat label="Rounds" value={summary.rounds} />
            </div>
            <p style={hintStyle}>
              Rounds are every spin-anchored 15-second window a match allows, sliding by one 5-second
              window — the calibrator counts them all, since a bettor can spin at any window start. Live
              games add their events to the corpus as they play.
            </p>
            {summary.rounds > 0 && freq ? (
              <table style={{ ...tableStyle, maxWidth: 520 }}>
                <thead>
                  <tr>
                    <th style={thStyle}>Line</th>
                    <th style={{ ...thStyle, textAlign: "right" }}>Share of rounds</th>
                    <th style={{ ...thStyle, textAlign: "right" }}>Rounds</th>
                  </tr>
                </thead>
                <tbody>
                  {LINE_KEYS.map((k: LineKey) => (
                    <tr key={k} style={rowStyle}>
                      <td style={tdStyle} className="mono">
                        {k}
                      </td>
                      <td style={{ ...tdStyle, textAlign: "right" }} className="mono">
                        {(freq[k] * 100).toFixed(3)}%
                      </td>
                      <td style={{ ...tdStyle, textAlign: "right", ...monoMuted }} className="mono">
                        {Math.round(freq[k] * summary.rounds).toLocaleString()}
                      </td>
                    </tr>
                  ))}
                  <tr style={rowStyle}>
                    <td style={{ ...tdStyle, ...monoMuted }}>no line (all three differ)</td>
                    <td style={{ ...tdStyle, textAlign: "right", ...monoMuted }} className="mono">
                      {Math.max(0, (1 - LINE_KEYS.reduce((acc, k) => acc + freq[k], 0)) * 100).toFixed(3)}%
                    </td>
                    <td style={tdStyle} />
                  </tr>
                </tbody>
              </table>
            ) : (
              <p style={hintStyle}>The corpus is empty. Fetch some finished matches below before fitting a paytable.</p>
            )}
          </>
        )}
      </Section>

      <form onSubmit={onFetch} style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        <Section title="Fetch finished matches">
          <p style={hintStyle}>
            Lists every basketball fixture on each day in the range, keeps the ones that have ended, and
            pulls the full timeline of each match not already held. <strong>This takes a while</strong> —
            one request per day plus one per new match, paced to the statistics host — and the button
            is limited to 5 runs an hour. The page waits for the answer; do not close the tab.
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 14, alignItems: "flex-end" }}>
            <Field label="From">
              <input
                type="date"
                value={range.from}
                max={range.to}
                onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))}
                disabled={pending}
                style={{ ...inputStyle, maxWidth: 180 }}
              />
            </Field>
            <Field label="To">
              <input
                type="date"
                value={range.to}
                min={range.from}
                onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))}
                disabled={pending}
                style={{ ...inputStyle, maxWidth: 180 }}
              />
            </Field>
            <Field label="Max matches" hint="Newest first once the cap is reached.">
              <input
                inputMode="numeric"
                value={maxMatches}
                onChange={(e) => setMaxMatches(e.target.value)}
                disabled={pending}
                style={{ ...inputStyle, maxWidth: 120, fontFamily: "var(--font-mono, ui-monospace, monospace)" }}
              />
            </Field>
            <button type="submit" disabled={pending} style={primaryButtonStyle(!pending, pending)}>
              {pending ? "Fetching…" : "Fetch"}
            </button>
            <button type="button" onClick={retry} disabled={pending} style={ghostButtonStyle(!pending)}>
              Refresh summary
            </button>
          </div>
          {result ? (
            <NoticeBanner>
              <span style={{ display: "flex", gap: 18, flexWrap: "wrap" }}>
                {Object.entries(result).map(([k, v]) => (
                  <span key={k} className="mono" style={{ fontSize: 12.5 }}>
                    {FETCH_RESULT_LABELS[k] ?? k}: {typeof v === "number" || typeof v === "string" ? v : JSON.stringify(v)}
                  </span>
                ))}
                {Object.keys(result).length === 0 ? "Done." : null}
              </span>
            </NoticeBanner>
          ) : null}
        </Section>
      </form>

      {error ? <ErrorBanner>{error}</ErrorBanner> : null}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <span style={{ display: "inline-flex", flexDirection: "column", gap: 2 }}>
      <span
        className="mono"
        style={{ fontSize: 10.5, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--color-fg-subtle, var(--fg-dim))" }}
      >
        {label}
      </span>
      <span className="mono" style={{ fontSize: 18, fontWeight: 600 }}>
        {value.toLocaleString()}
      </span>
    </span>
  );
}
