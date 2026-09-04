"use client";

// Automation signals card on the RiskZilla bettor profile (migration
// 0098). Renders the precomputed per-bettor behaviour rollup — score,
// alert state, per-component averages, confirm-time stats — with
// Acknowledge / Rescore actions. Everything shown here is a signal for a
// human to weigh next to PnL and velocity, never an automatic block.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { clientApi, ApiFetchError } from "@/lib/api-client";

export interface BehaviourProfileDto {
  score: number | null;
  maxSessionScore: number | null;
  sessionsScored: number;
  sessionsInsufficient: number;
  pendingSessions: number;
  features: Record<string, unknown>;
  alert: boolean;
  alertSince: string | null;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  scoredAt: string | null;
  threshold: number;
  minSessions: number;
}

const REASON_LABELS: Record<string, string> = {
  straight_line_movement: "Straight-line pointer movement",
  constant_speed_movement: "Constant-speed pointer movement",
  low_heading_variety: "Low heading variety",
  clicks_without_pointer_approach: "Clicks without pointer approach",
  metronomic_click_timing: "Metronomic click timing",
};

function pct(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${Math.round(v * 100)}%`;
}

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function fmt3(v: number | null): string {
  return v == null ? "—" : v.toFixed(3);
}

export function BehaviourPanel({
  userId,
  initial,
}: {
  userId: string;
  initial: BehaviourProfileDto;
}) {
  const router = useRouter();
  const [data, setData] = useState<BehaviourProfileDto>(initial);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const act = (path: string, body?: unknown) => {
    setError(null);
    startTransition(async () => {
      try {
        const res = await clientApi<{ behaviour: BehaviourProfileDto }>(
          `/admin/riskzilla/bettors/${userId}/behaviour/${path}`,
          { method: "POST", body: JSON.stringify(body ?? {}) },
        );
        setData(res.behaviour);
        router.refresh();
      } catch (err) {
        setError(err instanceof ApiFetchError ? err.message : "request failed");
      }
    });
  };

  const f = data.features ?? {};
  const confirm = (f.confirm as Record<string, unknown> | undefined) ?? {};
  const reasonCounts = (f.reasonCounts as Record<string, number> | undefined) ?? {};
  const reasons = Object.entries(reasonCounts).sort((a, b) => b[1] - a[1]);
  const scoreColor = data.alert
    ? "#dc2626"
    : data.score != null && data.score >= 0.5
      ? "#f59e0b"
      : undefined;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
          gap: 12,
        }}
      >
        <Kpi
          label="Automation score"
          value={pct(data.score)}
          valueColor={scoreColor}
          sub={
            data.score == null
              ? "Not enough data yet"
              : `Alert threshold ${pct(data.threshold)} over ≥ ${data.minSessions} sessions`
          }
        />
        <Kpi
          label="Sessions"
          value={String(data.sessionsScored)}
          sub={`${data.sessionsInsufficient} too thin to score · ${data.pendingSessions} awaiting sweep`}
        />
        <Kpi label="Peak session" value={pct(data.maxSessionScore)} />
        <Kpi
          label="Confirm time"
          value={
            num(confirm.medianMs) == null ? "—" : `${Math.round(num(confirm.medianMs)!)} ms`
          }
          sub={
            num(confirm.n)
              ? `median of ${num(confirm.n)} tickets · ${pct(num(confirm.fastShare))} at the floor (< ${num(confirm.fastCutoffMs) ?? "—"} ms)`
              : "No quote-to-place data yet"
          }
        />
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 16,
          alignItems: "start",
        }}
      >
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
          <tbody>
            <FeatureRow
              label="Straightness"
              value={fmt3(num(f.avgStraightness))}
              hint="chord / path over 6 points; interpolated moves sit near 1.000"
            />
            <FeatureRow
              label="Speed variation"
              value={fmt3(num(f.avgSpeedCv))}
              hint="coefficient of variation; hands accelerate and decelerate"
            />
            <FeatureRow
              label="Heading entropy"
              value={fmt3(num(f.avgHeadingEntropy))}
              hint="0 = straight lines, 1 = every direction equally"
            />
            <FeatureRow
              label="Clicks without approach"
              value={pct(num(f.avgClicksWithoutApproach))}
              hint="no pointer sample in the 1.5 s before the click"
            />
            <FeatureRow
              label="Click rhythm variation"
              value={fmt3(num(f.avgClickIntervalCv))}
              hint="coefficient of variation of inter-click gaps"
            />
          </tbody>
        </table>
        <div style={{ fontSize: 12.5 }}>
          <div
            className="mono"
            style={{
              fontSize: 11,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: "var(--color-fg-muted)",
              marginBottom: 6,
            }}
          >
            Signals that fired
          </div>
          {reasons.length === 0 ? (
            <span style={{ color: "var(--color-fg-muted)" }}>None across scored sessions.</span>
          ) : (
            <ul style={{ margin: 0, paddingLeft: 16 }}>
              {reasons.map(([k, n]) => (
                <li key={k}>
                  {REASON_LABELS[k] ?? k}{" "}
                  <span style={{ color: "var(--color-fg-muted)" }}>· {n} session{n === 1 ? "" : "s"}</span>
                </li>
              ))}
            </ul>
          )}
          <p style={{ fontSize: 11.5, color: "var(--color-fg-muted)", margin: "10px 0 0" }}>
            {data.scoredAt
              ? `Last rolled up ${new Date(data.scoredAt).toLocaleString()}.`
              : "Never rolled up."}
            {data.alert && data.alertSince && (
              <> Alert raised {new Date(data.alertSince).toLocaleString()}.</>
            )}
            {data.acknowledgedAt && (
              <> Acknowledged {new Date(data.acknowledgedAt).toLocaleString()}.</>
            )}
          </p>
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        {data.alert && (
          <button
            type="button"
            disabled={pending}
            onClick={() => act("acknowledge", { undo: !!data.acknowledgedAt })}
            style={btnStyle(data.acknowledgedAt ? "neutral" : "primary", pending)}
          >
            {data.acknowledgedAt ? "Re-open alert" : "Acknowledge alert"}
          </button>
        )}
        <button
          type="button"
          disabled={pending}
          onClick={() => act("rescore")}
          style={btnStyle("neutral", pending)}
        >
          {pending ? "Working…" : "Rescore now"}
        </button>
        <span style={{ fontSize: 11.5, color: "var(--color-fg-muted)" }}>
          Rescore scores every unscored session for this bettor immediately
          instead of waiting for the 5-minute sweep.
        </span>
      </div>
      {error && <span style={{ fontSize: 12, color: "#dc2626" }}>{error}</span>}
    </div>
  );
}

function btnStyle(kind: "primary" | "neutral", disabled: boolean): React.CSSProperties {
  return {
    height: 32,
    padding: "0 12px",
    borderRadius: 6,
    border: "1px solid var(--color-border)",
    background: kind === "primary" ? "var(--accent, #16a34a)" : "var(--color-bg-subtle)",
    color: kind === "primary" ? "#fff" : "var(--color-fg)",
    cursor: disabled ? "default" : "pointer",
    fontSize: 12,
    fontWeight: 600,
    opacity: disabled ? 0.7 : 1,
  };
}

function FeatureRow({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <tr>
      <td style={{ padding: "5px 8px", borderBottom: "1px solid var(--color-border)" }}>
        <div>{label}</div>
        <div style={{ fontSize: 11, color: "var(--color-fg-subtle)" }}>{hint}</div>
      </td>
      <td
        style={{
          padding: "5px 8px",
          borderBottom: "1px solid var(--color-border)",
          textAlign: "right",
          fontVariantNumeric: "tabular-nums",
          verticalAlign: "top",
        }}
      >
        {value}
      </td>
    </tr>
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
      <span style={{ fontSize: 18, fontVariantNumeric: "tabular-nums", color: valueColor }}>
        {value}
      </span>
      {sub && <span style={{ fontSize: 12, color: "var(--color-fg-muted)" }}>{sub}</span>}
    </div>
  );
}
