"use client";

import Link from "next/link";
import type { CSSProperties, MouseEvent } from "react";
import { SportGlyph } from "@/components/ui/sport-glyph";
import { Pill, LiveDot, TeamMark } from "@/components/ui/primitives";
import { useBetSlip } from "@/lib/bet-slip";
import type { SlipSelection } from "@oddzilla/types";

export interface ListMatch {
  id: string;
  homeTeam: string;
  awayTeam: string;
  scheduledAt: string | null;
  status: "not_started" | "live" | "closed" | "cancelled" | "suspended";
  bestOf?: number | null;
  liveScore?: { home?: number; away?: number } | null;
  tournament: { id: number; name: string };
  matchWinner: {
    marketId: string;
    home: { outcomeId: string; price: string | null; probability?: string | null };
    away: { outcomeId: string; price: string | null; probability?: string | null };
  } | null;
}

interface Props {
  match: ListMatch;
  sportSlug: string;
  sportShort: string;
}

export function MatchRow({ match, sportSlug, sportShort }: Props) {
  const slip = useBetSlip();
  const isLive = match.status === "live";

  function handlePick(side: "home" | "away", e: MouseEvent<HTMLButtonElement>) {
    e.preventDefault();
    e.stopPropagation();
    if (!match.matchWinner) return;
    const o = match.matchWinner[side];
    if (!o.price) return;
    const selection: SlipSelection = {
      matchId: match.id,
      marketId: match.matchWinner.marketId,
      outcomeId: o.outcomeId,
      odds: o.price,
      probability: o.probability ?? undefined,
      homeTeam: match.homeTeam,
      awayTeam: match.awayTeam,
      marketLabel: "Match winner",
      outcomeLabel: side === "home" ? match.homeTeam : match.awayTeam,
      sportSlug,
    };
    if (slip.has(selection.marketId, selection.outcomeId)) {
      slip.remove(selection.marketId, selection.outcomeId);
    } else {
      slip.add(selection);
    }
  }

  const homePicked = match.matchWinner
    ? slip.has(match.matchWinner.marketId, match.matchWinner.home.outcomeId)
    : false;
  const awayPicked = match.matchWinner
    ? slip.has(match.matchWinner.marketId, match.matchWinner.away.outcomeId)
    : false;

  const whenLabel = (() => {
    if (isLive) return null;
    if (!match.scheduledAt) return null;
    const d = new Date(match.scheduledAt);
    const now = new Date();
    const sameDay =
      d.getUTCFullYear() === now.getUTCFullYear() &&
      d.getUTCMonth() === now.getUTCMonth() &&
      d.getUTCDate() === now.getUTCDate();
    const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    return sameDay ? `Today · ${time}` : d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) + ` · ${time}`;
  })();

  const homePrice = match.matchWinner?.home.price
    ? Number(match.matchWinner.home.price)
    : null;
  const awayPrice = match.matchWinner?.away.price
    ? Number(match.matchWinner.away.price)
    : null;

  return (
    <Link
      href={`/match/${match.id}`}
      style={{ textDecoration: "none", color: "inherit" }}
    >
      <article
        className="card"
        style={{
          borderRadius: "var(--r-md)",
          overflow: "hidden",
          transition: "border-color 160ms var(--ease)",
          cursor: "pointer",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "6px 12px",
            borderBottom: "1px solid var(--hairline)",
            fontSize: 11.5,
            color: "var(--fg-muted)",
            minWidth: 0,
          }}
        >
          <SportGlyph sport={sportSlug} size={13} />
          <span
            className="mono"
            style={{
              fontSize: 10.5,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: "var(--fg-dim)",
              flexShrink: 0,
            }}
          >
            {sportShort}
          </span>
          <span style={{ color: "var(--fg-dim)", flexShrink: 0 }}>·</span>
          <span
            style={{
              color: "var(--fg-muted)",
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {truncate(match.tournament.name, 32)}
          </span>
          {match.bestOf && (
            <>
              <span style={{ color: "var(--fg-dim)", flexShrink: 0 }}>·</span>
              <span
                className="mono"
                style={{ fontSize: 10.5, color: "var(--fg-dim)", flexShrink: 0 }}
              >
                BO{match.bestOf}
              </span>
            </>
          )}

          <div style={{ flex: 1, minWidth: 4 }} />

          {isLive ? (
            <Pill tone="live">
              <LiveDot size={6} /> LIVE
            </Pill>
          ) : (
            whenLabel && (
              <span
                className="mono"
                style={{ fontSize: 11, color: "var(--fg-muted)", flexShrink: 0 }}
              >
                {whenLabel}
              </span>
            )
          )}
        </div>

        <div
          style={{
            display: "grid",
            // mark · name · score · odds. Score column collapses to 0 when no
            // live data is present (auto), the name takes everything else.
            gridTemplateColumns: "auto minmax(0, 1fr) auto auto",
            columnGap: 10,
            rowGap: 4,
            padding: "8px 12px",
            alignItems: "center",
          }}
        >
          <TeamRow
            name={match.homeTeam}
            score={match.liveScore?.home}
            isLive={isLive}
            label="1"
            price={homePrice}
            selected={homePicked}
            locked={!homePrice}
            onPick={(e) => handlePick("home", e)}
          />
          <TeamRow
            name={match.awayTeam}
            score={match.liveScore?.away}
            isLive={isLive}
            label="2"
            price={awayPrice}
            selected={awayPicked}
            locked={!awayPrice}
            onPick={(e) => handlePick("away", e)}
          />
        </div>
      </article>
    </Link>
  );
}

// Cap the rendered length and append ".." (two dots) when a name is too
// long, per UX preference. CSS ellipsis still kicks in below this length
// when the column itself is narrower than the truncated string — both
// layers together keep mobile rows on one line at any viewport width.
function truncate(name: string, max: number): string {
  if (name.length <= max) return name;
  return name.slice(0, max).trimEnd() + "..";
}

function TeamRow({
  name,
  score,
  isLive,
  label,
  price,
  selected,
  locked,
  onPick,
}: {
  name: string;
  score?: number;
  isLive?: boolean;
  label: "1" | "2";
  price: number | null;
  selected: boolean;
  locked: boolean;
  onPick: (e: MouseEvent<HTMLButtonElement>) => void;
}) {
  const tag = name
    .split(/\s+/)
    .slice(0, 3)
    .map((w) => w[0])
    .join("")
    .slice(0, 4);
  const showScore = isLive && typeof score === "number";
  return (
    <>
      <TeamMark tag={tag} size={22} />
      <span
        style={{
          fontSize: 14,
          fontWeight: 500,
          letterSpacing: "-0.005em",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          minWidth: 0,
        }}
      >
        {truncate(name, 24)}
      </span>
      <span
        className="mono tnum"
        style={{
          fontSize: 13,
          fontWeight: 600,
          color: "var(--fg)",
          minWidth: showScore ? 18 : 0,
          textAlign: "right",
          opacity: showScore ? 1 : 0,
        }}
      >
        {showScore ? score : ""}
      </span>
      <RowOddBtn
        label={label}
        price={price}
        selected={selected}
        locked={locked}
        onClick={onPick}
      />
    </>
  );
}

// Inline odds button used in the list card. One per team row, so the
// whole odds column is a single ~70px wide track instead of 2x ~80px.
// Compact: 32px tall, label + price side-by-side, mono price. Selection
// state matches the bet slip's accent like the larger OddButton.
function RowOddBtn({
  label,
  price,
  selected,
  locked,
  onClick,
}: {
  label: string;
  price: number | null;
  selected: boolean;
  locked: boolean;
  onClick: (e: MouseEvent<HTMLButtonElement>) => void;
}) {
  const baseStyle: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 6,
    width: "clamp(64px, 18vw, 88px)",
    height: 32,
    padding: "0 9px",
    background: selected ? "var(--accent)" : "var(--surface-2)",
    color: selected ? "var(--accent-fg)" : "var(--fg)",
    border: "1px solid",
    borderColor: selected ? "var(--accent)" : "var(--border)",
    borderRadius: 8,
    cursor: locked ? "not-allowed" : "pointer",
    fontFamily: "inherit",
    transition: "all 140ms var(--ease)",
    opacity: locked ? 0.5 : 1,
  };
  return (
    <button type="button" disabled={locked} onClick={onClick} style={baseStyle}>
      <span
        className="mono"
        style={{
          fontSize: 10.5,
          color: selected
            ? "color-mix(in oklab, var(--accent-fg) 70%, transparent)"
            : "var(--fg-muted)",
          fontWeight: 600,
        }}
      >
        {label}
      </span>
      <span
        className="mono tnum"
        style={{
          fontSize: 13,
          fontWeight: 600,
          letterSpacing: "-0.01em",
        }}
      >
        {locked || price == null ? "—" : price.toFixed(2)}
      </span>
    </button>
  );
}
