"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { clientApi, ApiFetchError } from "@/lib/api-client";

export interface FeedStatusProducer {
  key: string;
  afterMs: number;
  afterIso: string | null;
  staleSeconds: number | null;
  updatedAt: string;
}

export interface FeedStatus {
  producers: FeedStatusProducer[];
}

interface RecoveryResponse {
  ok: true;
  cursorMs: number;
  hours: number;
  flushedMarkets: number;
  flushedOutcomes: number;
  activeMarketsBefore: number;
}

export function RecoveryPanel({ initialStatus }: { initialStatus: FeedStatus }) {
  const router = useRouter();
  // 48h default: matches the API default after the 2026-04-29 incident.
  // Two days catches every future fixture whose last odds_change is up to
  // 48h stale, which is the common case when probability columns go
  // missing on idle pre-match markets. Oddin's hard cap is 72h.
  const [hours, setHours] = useState(48);
  const [flushOdds, setFlushOdds] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<RecoveryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setSubmitting(true);
    setError(null);
    setResult(null);
    try {
      const body = await clientApi<RecoveryResponse>("/admin/feed/recovery", {
        method: "POST",
        body: JSON.stringify({ flushOdds, hours }),
      });
      setResult(body);
      setConfirming(false);
      // Refresh SSR data so the producer-cursor table updates.
      router.refresh();
    } catch (err) {
      setError(
        err instanceof ApiFetchError
          ? err.body.message ?? err.body.error ?? "Recovery request failed."
          : "Could not reach the server.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20, maxWidth: 680 }}>
      <ProducerTable producers={initialStatus.producers} />

      <div
        className="card"
        style={{
          padding: 20,
          borderRadius: 12,
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        <h2 style={{ margin: 0, fontSize: 15, fontWeight: 500 }}>Replay from Oddin</h2>

        <label
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 6,
            fontSize: 13,
            color: "var(--color-fg-muted)",
          }}
        >
          <span
            className="mono"
            style={{
              fontSize: 10.5,
              letterSpacing: "0.1em",
              textTransform: "uppercase",
            }}
          >
            Rewind cursor (hours, 1–72)
          </span>
          <input
            type="number"
            min={1}
            max={72}
            step={1}
            value={hours}
            onChange={(e) => setHours(Math.max(1, Math.min(72, Number(e.target.value) || 1)))}
            style={{
              height: 38,
              padding: "0 12px",
              background: "var(--surface-2)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              outline: "none",
              fontFamily: "inherit",
              fontSize: 14,
              color: "var(--color-fg)",
              width: 120,
            }}
          />
        </label>

        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            fontSize: 13,
            color: "var(--color-fg-muted)",
          }}
        >
          <input
            type="checkbox"
            checked={flushOdds}
            onChange={(e) => setFlushOdds(e.target.checked)}
          />
          <span>
            Flush odds — suspend every active market and clear published
            odds, raw odds, and probability until the replay re-populates
            them. Recommended: prevents stale probabilities from feeding
            Tiple / Tippot pricing while recovery is in flight.
          </span>
        </label>

        {error && (
          <p
            role="alert"
            style={{
              margin: 0,
              fontSize: 12.5,
              color: "var(--negative, #f87171)",
              lineHeight: 1.45,
            }}
          >
            {error}
          </p>
        )}

        {result && (
          <div
            style={{
              padding: 12,
              borderRadius: 8,
              background: "var(--surface-2)",
              fontSize: 12.5,
              lineHeight: 1.5,
            }}
          >
            Recovery requested. Cursor rewound to{" "}
            <span className="mono">
              {new Date(result.cursorMs).toISOString()}
            </span>
            . {result.flushedMarkets > 0
              ? `Suspended ${result.flushedMarkets} market${result.flushedMarkets === 1 ? "" : "s"} and cleared ${result.flushedOutcomes} outcome price${result.flushedOutcomes === 1 ? "" : "s"}.`
              : `${result.activeMarketsBefore} active market${result.activeMarketsBefore === 1 ? "" : "s"} were left in place.`}{" "}
            Feed-ingester should start re-populating within seconds.
          </div>
        )}

        {confirming ? (
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button
              type="button"
              onClick={submit}
              disabled={submitting}
              style={{
                height: 38,
                padding: "0 16px",
                borderRadius: 8,
                border: "none",
                background: "var(--color-fg)",
                color: "var(--color-bg)",
                fontWeight: 500,
                fontSize: 13,
                cursor: submitting ? "wait" : "pointer",
              }}
            >
              {submitting ? "Requesting..." : "Yes — trigger recovery"}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              disabled={submitting}
              style={{
                height: 38,
                padding: "0 14px",
                borderRadius: 8,
                border: "1px solid var(--border)",
                background: "transparent",
                color: "var(--color-fg-muted)",
                fontSize: 13,
                cursor: "pointer",
              }}
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            style={{
              alignSelf: "flex-start",
              height: 38,
              padding: "0 16px",
              borderRadius: 8,
              border: "none",
              background: "var(--color-fg)",
              color: "var(--color-bg)",
              fontWeight: 500,
              fontSize: 13,
              cursor: "pointer",
            }}
          >
            Reset odds and recover from Oddin
          </button>
        )}
      </div>
    </div>
  );
}

function ProducerTable({ producers }: { producers: FeedStatusProducer[] }) {
  if (producers.length === 0) {
    return (
      <p
        style={{
          margin: 0,
          fontSize: 13,
          color: "var(--color-fg-muted)",
        }}
      >
        No producer cursors recorded yet — the feed-ingester has not booted
        or the AMQP connection never established.
      </p>
    );
  }

  return (
    <div
      className="card"
      style={{ padding: 0, borderRadius: 12, overflow: "hidden" }}
    >
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr
            style={{
              background: "var(--surface-2)",
              textAlign: "left",
              color: "var(--color-fg-muted)",
              fontSize: 11,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
            }}
          >
            <th style={{ padding: "10px 14px", fontWeight: 500 }}>Producer</th>
            <th style={{ padding: "10px 14px", fontWeight: 500 }}>Cursor (UTC)</th>
            <th style={{ padding: "10px 14px", fontWeight: 500 }}>Lag</th>
            <th style={{ padding: "10px 14px", fontWeight: 500 }}>Updated</th>
          </tr>
        </thead>
        <tbody>
          {producers.map((p) => {
            const name = p.key === "producer:1" ? "pre-match" : p.key === "producer:2" ? "live" : p.key;
            return (
              <tr key={p.key} style={{ borderTop: "1px solid var(--border)" }}>
                <td style={{ padding: "10px 14px" }}>{name}</td>
                <td
                  className="mono"
                  style={{ padding: "10px 14px", fontSize: 12 }}
                >
                  {p.afterIso ?? "—"}
                </td>
                <td style={{ padding: "10px 14px" }}>
                  {p.staleSeconds == null
                    ? "—"
                    : p.staleSeconds < 60
                      ? `${p.staleSeconds}s`
                      : p.staleSeconds < 3600
                        ? `${Math.floor(p.staleSeconds / 60)}m`
                        : `${Math.floor(p.staleSeconds / 3600)}h ${Math.floor((p.staleSeconds % 3600) / 60)}m`}
                </td>
                <td
                  className="mono"
                  style={{ padding: "10px 14px", fontSize: 12 }}
                >
                  {new Date(p.updatedAt).toISOString().replace("T", " ").slice(0, 19)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
