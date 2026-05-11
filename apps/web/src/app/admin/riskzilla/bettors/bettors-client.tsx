"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { clientApi, ApiFetchError } from "@/lib/api-client";
import { fromMicro } from "@oddzilla/types/money";
import type { RzCurrency } from "../currency-switch";

export interface BettorDto {
  id: string;
  email: string;
  nickname: string | null;
  status: string;
  riskScore: string;
  ticketsCount: number;
  wonCount: number;
  pnlMicro: string;
  stakedMicro: string;
  payoutMicro: string;
  winRate: number;
  lastBetAt: string | null;
}

const SORTS = [
  { key: "recent", label: "Recent activity" },
  { key: "risk_score", label: "RS (high first)" },
  { key: "pnl", label: "PnL (worst first)" },
  { key: "stake", label: "Total staked" },
  { key: "win_rate", label: "Win rate" },
] as const;

export function BettorsClient({
  initial,
  currency,
}: {
  initial: BettorDto[];
  currency: RzCurrency;
}) {
  const [rows, setRows] = useState<BettorDto[]>(initial);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<(typeof SORTS)[number]["key"]>("recent");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset to server-rendered rows when the page-level currency
  // switches — keeps the list in sync with the URL without a refresh.
  useEffect(() => {
    setRows(initial);
  }, [initial]);

  useEffect(() => {
    const tid = setTimeout(() => {
      setLoading(true);
      const params = new URLSearchParams();
      params.set("limit", "100");
      params.set("sort", sort);
      params.set("currency", currency);
      if (q.trim()) params.set("q", q.trim());
      clientApi<{ entries: BettorDto[] }>(`/admin/riskzilla/bettors?${params}`)
        .then((res) => {
          setRows(res.entries);
          setError(null);
        })
        .catch((err) =>
          setError(err instanceof ApiFetchError ? err.message : "fetch failed"),
        )
        .finally(() => setLoading(false));
    }, 200);
    return () => clearTimeout(tid);
  }, [q, sort, currency]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <input
          type="search"
          placeholder="Search email or nickname"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{
            height: 36,
            padding: "0 12px",
            background: "var(--color-bg)",
            border: "1px solid var(--color-border)",
            borderRadius: 8,
            color: "var(--color-fg)",
            fontSize: 13,
            minWidth: 240,
          }}
        />
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as typeof sort)}
          style={{
            height: 36,
            padding: "0 12px",
            background: "var(--color-bg)",
            border: "1px solid var(--color-border)",
            borderRadius: 8,
            color: "var(--color-fg)",
            fontSize: 13,
          }}
        >
          {SORTS.map((s) => (
            <option key={s.key} value={s.key}>
              {s.label}
            </option>
          ))}
        </select>
        {loading && (
          <span style={{ alignSelf: "center", color: "var(--color-fg-muted)", fontSize: 12 }}>
            loading…
          </span>
        )}
      </div>

      {error && (
        <div style={{ fontSize: 12.5, color: "#dc2626" }}>{error}</div>
      )}

      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          fontSize: 13,
        }}
      >
        <thead>
          <tr>
            <Th>Bettor</Th>
            <Th align="right">RS</Th>
            <Th align="right">Tickets</Th>
            <Th align="right">Win rate</Th>
            <Th align="right">Staked ({currency})</Th>
            <Th align="right">PnL op ({currency})</Th>
            <Th>Status</Th>
            <Th>Last bet</Th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <Td>—</Td>
              <Td colSpan={7} align="right">
                <span style={{ color: "var(--color-fg-muted)" }}>
                  No bettors match.
                </span>
              </Td>
            </tr>
          ) : (
            rows.map((r) => (
              <tr key={r.id}>
                <Td>
                  <Link
                    href={`/admin/riskzilla/bettors/${r.id}`}
                    style={{ color: "var(--color-fg)", textDecoration: "none" }}
                  >
                    {r.nickname ?? r.email}
                  </Link>
                </Td>
                <Td align="right" mono>
                  {r.riskScore}
                </Td>
                <Td align="right" mono>
                  {r.ticketsCount}
                </Td>
                <Td align="right" mono>
                  {(r.winRate * 100).toFixed(1)}%
                </Td>
                <Td align="right" mono>
                  {fromMicro(BigInt(r.stakedMicro))}
                </Td>
                <Td
                  align="right"
                  mono
                  color={
                    BigInt(r.pnlMicro) >= 0n ? "#16a34a" : "#dc2626"
                  }
                >
                  {fromMicro(BigInt(r.pnlMicro))}
                </Td>
                <Td>{r.status}</Td>
                <Td>
                  {r.lastBetAt ? new Date(r.lastBetAt).toLocaleDateString() : "—"}
                </Td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

function Th({ children, align }: { children: React.ReactNode; align?: "right" }) {
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
        color: color,
      }}
    >
      {children}
    </td>
  );
}
