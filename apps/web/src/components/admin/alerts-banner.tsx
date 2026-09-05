"use client";

// "Active alerts" strip for the risk pages (RiskZilla layout). Polls the
// alert-center summary every 30 s and renders the severity breakdown
// with a link into /admin/alerts. Quiet when nothing is active so it
// never competes with the page below it.

import { useEffect, useState } from "react";
import Link from "next/link";
import { clientApi } from "@/lib/api-client";

export interface AlertSummary {
  critical: number;
  serious: number;
  warning: number;
  active: number;
  open: number;
  acknowledged: number;
  assignedToMe: number;
  resolved24h: number;
}

export const SEVERITY_COLOR: Record<string, string> = {
  critical: "#dc2626",
  serious: "#ea580c",
  warning: "#d97706",
};

export function AlertsBanner({ initial }: { initial?: AlertSummary | null }) {
  const [summary, setSummary] = useState<AlertSummary | null>(initial ?? null);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      clientApi<AlertSummary>("/admin/riskzilla/alerts/summary")
        .then((s) => {
          if (!cancelled) setSummary(s);
        })
        .catch(() => {
          // Banner is informational; a failed poll keeps the last value.
        });
    void load();
    const t = window.setInterval(load, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, []);

  if (!summary) return null;
  const quiet = summary.active === 0;
  const accent = summary.critical > 0 ? SEVERITY_COLOR.critical : summary.serious > 0 ? SEVERITY_COLOR.serious : SEVERITY_COLOR.warning;

  return (
    <div
      role="status"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 14,
        flexWrap: "wrap",
        padding: "8px 14px",
        marginBottom: 16,
        borderRadius: 8,
        border: `1px solid ${quiet ? "var(--color-border)" : accent}`,
        borderLeftWidth: quiet ? 1 : 4,
        background: quiet
          ? "var(--color-bg-subtle)"
          : `color-mix(in oklab, ${accent} 7%, transparent)`,
        fontSize: 13,
      }}
    >
      <strong style={{ color: quiet ? "var(--color-fg-muted)" : "var(--color-fg)" }}>
        {quiet ? "No active alerts" : "Active alerts"}
      </strong>
      {!quiet ? (
        <span style={{ display: "inline-flex", gap: 12, flexWrap: "wrap" }}>
          <Count n={summary.critical} label="critical" color={SEVERITY_COLOR.critical!} />
          <Count n={summary.serious} label="serious" color={SEVERITY_COLOR.serious!} />
          <Count n={summary.warning} label="warning" color={SEVERITY_COLOR.warning!} />
          {summary.assignedToMe > 0 ? (
            <span style={{ color: "var(--color-fg-muted)" }}>· {summary.assignedToMe} assigned to you</span>
          ) : null}
        </span>
      ) : (
        <span style={{ color: "var(--color-fg-muted)" }}>
          {summary.resolved24h} resolved in the last 24 h
        </span>
      )}
      <span style={{ flex: 1 }} />
      <Link
        href="/admin/alerts"
        style={{ color: "var(--color-fg)", fontSize: 12, textDecoration: "none" }}
      >
        open alert center →
      </Link>
    </div>
  );
}

function Count({ n, label, color }: { n: number; label: string; color: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, color: n > 0 ? color : "var(--color-fg-muted)" }}>
      <span
        aria-hidden
        style={{ width: 8, height: 8, borderRadius: 999, background: n > 0 ? color : "var(--color-border)" }}
      />
      <span className="mono" style={{ fontVariantNumeric: "tabular-nums" }}>
        {n}
      </span>
      {label}
    </span>
  );
}
