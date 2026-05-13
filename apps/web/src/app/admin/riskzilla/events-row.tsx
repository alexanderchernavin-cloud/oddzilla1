"use client";

import Link from "next/link";
import { useState } from "react";
import { fromMicro } from "@oddzilla/types/money";

export interface EventSelectionDto {
  marketId: string;
  providerMarketId: number;
  marketName: string;
  outcomeId: string;
  outcomeName: string | null;
  oddsAtPlacement: string;
  matchId: string | null;
  matchLabel: string | null;
  result: string | null;
}

export interface EventDto {
  id: string;
  cursor: string;
  ticketId: string | null;
  userId: string;
  userEmail: string | null;
  userNickname: string | null;
  decision: string;
  reasonMessage: string | null;
  currency: string;
  stakeMicro: string;
  potentialPayoutMicro: string;
  matchId: string | null;
  matchLabel: string | null;
  sportId: number | null;
  sportSlug: string | null;
  tournamentId: number | null;
  tournamentName: string | null;
  riskTier: number | null;
  rsAtDecision: string;
  bankAtDecisionMicro: string;
  decisionMeta: unknown;
  selections: EventSelectionDto[];
  createdAt: string;
}

const DECISION_COLOR: Record<string, string> = {
  accepted: "#16a34a",
  rejected_min_stake: "#f59e0b",
  rejected_max_payout: "#f59e0b",
  rejected_match_liability: "#dc2626",
  rejected_bet_factor: "#dc2626",
  rejected_bank_limit: "#dc2626",
  rejected_user_blocked: "#94a3b8",
  rejected_market_factor: "#dc2626",
};

const DECISION_LABEL: Record<string, string> = {
  accepted: "ACCEPTED",
  rejected_min_stake: "MIN STAKE",
  rejected_max_payout: "MAX PAYOUT",
  rejected_match_liability: "MATCH LIAB",
  rejected_bet_factor: "BET FACTOR",
  rejected_bank_limit: "BANK",
  rejected_user_blocked: "USER BLOCKED",
  rejected_market_factor: "MARKET FACTOR",
};

export function EventRow({ row }: { row: EventDto }) {
  const [expanded, setExpanded] = useState(false);
  const color = DECISION_COLOR[row.decision] ?? "var(--color-fg)";
  const label = DECISION_LABEL[row.decision] ?? row.decision.toUpperCase();
  const stake = fromMicro(BigInt(row.stakeMicro));
  const payout = fromMicro(BigInt(row.potentialPayoutMicro));
  const ts = new Date(row.createdAt);

  return (
    <article
      style={{
        border: "1px solid var(--color-border)",
        borderRadius: 8,
        padding: "8px 12px",
        display: "grid",
        gridTemplateColumns: "100px 110px 1fr 1fr auto auto",
        gap: 12,
        alignItems: "center",
        fontSize: 13,
        background: "var(--color-bg)",
      }}
    >
      <span
        className="mono"
        style={{
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: "0.06em",
          color,
        }}
      >
        {label}
      </span>
      <span
        className="mono"
        style={{
          fontSize: 11,
          color: "var(--color-fg-muted)",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {ts.toLocaleTimeString()}
      </span>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        <Link
          href={`/admin/riskzilla/bettors/${row.userId}`}
          style={{ color: "var(--color-fg)", textDecoration: "none" }}
        >
          {row.userNickname ?? row.userEmail ?? row.userId.slice(0, 8)}
        </Link>
        {row.riskTier != null && (
          <span style={{ color: "var(--color-fg-muted)", marginLeft: 6 }}>
            · tier {row.riskTier}
          </span>
        )}
      </span>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {row.matchLabel ?? "—"}
        {row.sportSlug && (
          <span style={{ color: "var(--color-fg-muted)", marginLeft: 6 }}>
            · {row.sportSlug}
          </span>
        )}
      </span>
      <span style={{ fontVariantNumeric: "tabular-nums", textAlign: "right" }}>
        {stake} → {payout} {row.currency}
      </span>
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        style={{
          height: 24,
          padding: "0 8px",
          background: "transparent",
          border: "1px solid var(--color-border)",
          borderRadius: 4,
          fontSize: 11,
          color: "var(--color-fg-muted)",
          cursor: "pointer",
        }}
      >
        {expanded ? "Hide" : "Detail"}
      </button>
      {expanded && (
        <pre
          style={{
            gridColumn: "1 / -1",
            margin: "6px 0 0 0",
            padding: "10px 12px",
            background: "var(--color-bg-subtle)",
            border: "1px solid var(--color-border)",
            borderRadius: 6,
            fontSize: 11,
            fontFamily: "var(--font-mono, monospace)",
            color: "var(--color-fg-muted)",
            overflowX: "auto",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {JSON.stringify(
            {
              decision: row.decision,
              reason: row.reasonMessage,
              rsAtDecision: row.rsAtDecision,
              bankAtDecisionMicro: row.bankAtDecisionMicro,
              tournament: row.tournamentName,
              riskTier: row.riskTier,
              ticketId: row.ticketId,
              meta: row.decisionMeta,
            },
            null,
            2,
          )}
        </pre>
      )}
    </article>
  );
}
