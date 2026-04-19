"use client";

import Link from "next/link";
import type { MouseEvent } from "react";
import { SportGlyph } from "@/components/ui/sport-glyph";
import { Pill, LiveDot, OddButton, TeamMark } from "@/components/ui/primitives";
import { I } from "@/components/ui/icons";
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
    home: { outcomeId: string; price: string | null };
    away: { outcomeId: string; price: string | null };
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
            gap: 10,
            padding: "10px 14px",
            borderBottom: "1px solid var(--hairline)",
            fontSize: 11.5,
            color: "var(--fg-muted)",
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
            }}
          >
            {sportShort}
          </span>
          <span style={{ color: "var(--fg-dim)" }}>·</span>
          <span style={{ color: "var(--fg-muted)" }}>{match.tournament.name}</span>
          {match.bestOf && (
            <>
              <span style={{ color: "var(--fg-dim)" }}>·</span>
              <span className="mono" style={{ fontSize: 10.5, color: "var(--fg-dim)" }}>
                BO{match.bestOf}
              </span>
            </>
          )}

          <div style={{ flex: 1 }} />

          {isLive ? (
            <Pill tone="live">
              <LiveDot size={6} /> LIVE
            </Pill>
          ) : (
            whenLabel && (
              <span className="mono" style={{ fontSize: 11, color: "var(--fg-muted)" }}>
                {whenLabel}
              </span>
            )
          )}
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr auto",
            gap: 16,
            padding: 14,
            alignItems: "center",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <TeamLine name={match.homeTeam} score={match.liveScore?.home} isLive={isLive} />
            <TeamLine name={match.awayTeam} score={match.liveScore?.away} isLive={isLive} />
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 6,
              width: "clamp(150px, 40vw, 200px)",
            }}
          >
            <OddButton
              price={match.matchWinner?.home.price ? Number(match.matchWinner.home.price) : null}
              label="1"
              selected={homePicked}
              locked={!match.matchWinner?.home.price}
              onClick={(e) => handlePick("home", e)}
            />
            <OddButton
              price={match.matchWinner?.away.price ? Number(match.matchWinner.away.price) : null}
              label="2"
              selected={awayPicked}
              locked={!match.matchWinner?.away.price}
              onClick={(e) => handlePick("away", e)}
            />
          </div>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "8px 14px",
            borderTop: "1px solid var(--hairline)",
            fontSize: 11.5,
            color: "var(--fg-dim)",
          }}
        >
          <span style={{ flex: 1 }} />
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            Open match <I.Chev size={11} />
          </span>
        </div>
      </article>
    </Link>
  );
}

function TeamLine({
  name,
  score,
  isLive,
}: {
  name: string;
  score?: number;
  isLive?: boolean;
}) {
  const tag = name
    .split(/\s+/)
    .slice(0, 3)
    .map((w) => w[0])
    .join("")
    .slice(0, 4);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <TeamMark tag={tag} size={28} />
      <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.2, minWidth: 0 }}>
        <span
          style={{
            fontSize: 14,
            fontWeight: 500,
            letterSpacing: "-0.005em",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {name}
        </span>
      </div>
      <div style={{ flex: 1 }} />
      {isLive && typeof score === "number" && (
        <span
          className="mono tnum"
          style={{ fontSize: 16, fontWeight: 600, color: "var(--fg)" }}
        >
          {score}
        </span>
      )}
    </div>
  );
}
