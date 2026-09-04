"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { clientApi, ApiFetchError } from "@/lib/api-client";

export interface BehaviourAlertDto {
  userId: string;
  email: string;
  nickname: string | null;
  riskScore: string;
  status: string;
  score: number | null;
  maxSessionScore: number | null;
  sessionsScored: number;
  alertSince: string | null;
  acknowledgedAt: string | null;
  scoredAt: string;
  reasons: string[];
}

const REASON_SHORT: Record<string, string> = {
  straight_line_movement: "straight lines",
  constant_speed_movement: "constant speed",
  low_heading_variety: "no heading variety",
  clicks_without_pointer_approach: "teleport clicks",
  metronomic_click_timing: "metronomic clicks",
};

export function AlertsTable({ initial }: { initial: BehaviourAlertDto[] }) {
  const [rows, setRows] = useState<BehaviourAlertDto[]>(initial);
  const [includeAcked, setIncludeAcked] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setRows(initial);
  }, [initial]);

  const reload = async (withAcked: boolean) => {
    try {
      const res = await clientApi<{ entries: BehaviourAlertDto[] }>(
        `/admin/riskzilla/behaviour/alerts?includeAcknowledged=${withAcked ? "true" : "false"}&limit=200`,
      );
      setRows(res.entries);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiFetchError ? err.message : "fetch failed");
    }
  };

  const ack = async (userId: string, undo: boolean) => {
    setBusy(userId);
    setError(null);
    try {
      await clientApi(`/admin/riskzilla/bettors/${userId}/behaviour/acknowledge`, {
        method: "POST",
        body: JSON.stringify({ undo }),
      });
      await reload(includeAcked);
    } catch (err) {
      setError(err instanceof ApiFetchError ? err.message : "request failed");
    } finally {
      setBusy(null);
    }
  };

  const visible = includeAcked ? rows : rows.filter((r) => !r.acknowledgedAt);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5 }}>
        <input
          type="checkbox"
          checked={includeAcked}
          onChange={(e) => {
            setIncludeAcked(e.target.checked);
            void reload(e.target.checked);
          }}
        />
        Show acknowledged alerts too
      </label>
      {error && <div style={{ fontSize: 12.5, color: "#dc2626" }}>{error}</div>}
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr>
            <Th>Bettor</Th>
            <Th align="right">Score</Th>
            <Th align="right">Peak</Th>
            <Th align="right">Sessions</Th>
            <Th align="right">RS</Th>
            <Th>Signals</Th>
            <Th>Since</Th>
            <Th>State</Th>
            <Th />
          </tr>
        </thead>
        <tbody>
          {visible.length === 0 ? (
            <tr>
              <Td colSpan={9}>
                <span style={{ color: "var(--color-fg-muted)" }}>
                  {includeAcked ? "No alerts." : "No unacknowledged alerts."}
                </span>
              </Td>
            </tr>
          ) : (
            visible.map((r) => {
              const acked = !!r.acknowledgedAt;
              return (
                <tr key={r.userId}>
                  <Td>
                    <Link
                      href={`/admin/riskzilla/bettors/${r.userId}`}
                      style={{ color: "var(--color-fg)", textDecoration: "none" }}
                    >
                      {r.nickname ?? r.email}
                    </Link>
                    <div style={{ fontSize: 11, color: "var(--color-fg-muted)" }}>{r.email}</div>
                  </Td>
                  <Td align="right" mono color={acked ? "#f59e0b" : "#dc2626"}>
                    {r.score == null ? "—" : `${Math.round(r.score * 100)}%`}
                  </Td>
                  <Td align="right" mono>
                    {r.maxSessionScore == null ? "—" : `${Math.round(r.maxSessionScore * 100)}%`}
                  </Td>
                  <Td align="right" mono>{r.sessionsScored}</Td>
                  <Td align="right" mono>{r.riskScore}</Td>
                  <Td>
                    <span style={{ fontSize: 12, color: "var(--color-fg-muted)" }}>
                      {r.reasons.length === 0
                        ? "—"
                        : r.reasons.map((k) => REASON_SHORT[k] ?? k).join(" · ")}
                    </span>
                  </Td>
                  <Td>{r.alertSince ? new Date(r.alertSince).toLocaleString() : "—"}</Td>
                  <Td>
                    <span
                      className="mono"
                      style={{
                        fontSize: 11,
                        letterSpacing: "0.06em",
                        textTransform: "uppercase",
                        color: acked ? "#f59e0b" : "#dc2626",
                      }}
                    >
                      {acked ? "acknowledged" : "open"}
                    </span>
                  </Td>
                  <Td align="right">
                    <button
                      type="button"
                      disabled={busy === r.userId}
                      onClick={() => void ack(r.userId, acked)}
                      style={{
                        height: 28,
                        padding: "0 10px",
                        borderRadius: 6,
                        border: "1px solid var(--color-border)",
                        background: acked ? "var(--color-bg-subtle)" : "var(--accent, #16a34a)",
                        color: acked ? "var(--color-fg)" : "#fff",
                        cursor: busy === r.userId ? "default" : "pointer",
                        fontSize: 12,
                        fontWeight: 600,
                      }}
                    >
                      {busy === r.userId ? "…" : acked ? "Re-open" : "Acknowledge"}
                    </button>
                  </Td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}

function Th({ children, align }: { children?: React.ReactNode; align?: "right" }) {
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
  colSpan,
}: {
  children: React.ReactNode;
  align?: "right";
  mono?: boolean;
  color?: string;
  colSpan?: number;
}) {
  return (
    <td
      colSpan={colSpan}
      style={{
        textAlign: align ?? "left",
        padding: "6px 10px",
        borderBottom: "1px solid var(--color-border)",
        fontVariantNumeric: mono ? "tabular-nums" : "normal",
        color,
        verticalAlign: "top",
      }}
    >
      {children}
    </td>
  );
}
