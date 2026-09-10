"use client";

import { Fragment, useCallback, useEffect, useState, useTransition } from "react";
import { clientApi, ApiFetchError } from "@/lib/api-client";
import { formatMatchClock, formatMultiplier } from "@oddzilla/types/slotzilla";
import {
  unwrapList,
  type SlotzillaAdminGameDto,
  type SlotzillaAdminSpinDto,
  type SlotzillaGameClockDto,
  type SlotzillaSpinLogResponse,
} from "./slotzilla-admin-types";
import { formatBp, formatIsoRelative, microToUnits } from "./format";
import { useInterval } from "./use-interval";
import {
  Chip,
  ErrorBanner,
  GameStatusChip,
  LoadFailed,
  ReelCell,
  Section,
  SpinStatusChip,
  dangerSmallButtonStyle,
  hintStyle,
  inputStyle,
  monoMuted,
  rowStyle,
  smallButtonStyle,
  tableStyle,
  tdStyle,
  thStyle,
} from "./ui";

// The games desk. One row per slotzilla_games row the api lists, polled
// every 10 s while this tab is open; a row expands into its spin log.
// Pause / Resume / Void are the three operator actions the contract
// gives the game — Void is confirmed because it refunds every open spin
// and ends the game for good.

const POLL_MS = 10_000;
const CURRENCIES = ["USDC", "OZ"] as const;
const STATUS_FILTERS = ["", "live", "paused", "scheduled", "ended", "voided"] as const;

/** A running clock that has not been re-read in this long is shown as stale rather than advanced forever. */
const CLOCK_ADVANCE_CAP_SECONDS = 6 * 3600;

/** The clock as it is NOW: the last reading plus the wall time since, while running. */
function clockNow(clock: SlotzillaGameClockDto | null | undefined, nowMs: number): number | null {
  if (!clock || clock.seconds === null || clock.seconds === undefined) return null;
  if (!clock.running || !clock.readAt) return clock.seconds;
  const readMs = Date.parse(clock.readAt);
  if (!Number.isFinite(readMs)) return clock.seconds;
  const elapsed = Math.max(0, Math.floor((nowMs - readMs) / 1000));
  return clock.seconds + Math.min(elapsed, CLOCK_ADVANCE_CAP_SECONDS);
}

export function GamesTab({ initial, rtpTargetBp }: { initial: unknown; rtpTargetBp: number | null }) {
  const [games, setGames] = useState<SlotzillaAdminGameDto[] | null>(() =>
    initial === null ? null : unwrapList<SlotzillaAdminGameDto>(initial, "games"),
  );
  const [statusFilter, setStatusFilter] = useState<(typeof STATUS_FILTERS)[number]>("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [spins, setSpins] = useState<Record<string, SlotzillaSpinLogResponse | "loading" | "failed">>({});
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const load = useCallback(async (filter: string) => {
    const qs = filter ? `?status=${encodeURIComponent(filter)}` : "";
    const raw = await clientApi<unknown>(`/admin/slotzilla/games${qs}`);
    setGames(unwrapList<SlotzillaAdminGameDto>(raw, "games"));
  }, []);

  const loadSpins = useCallback(async (matchId: string, cursor?: string | null) => {
    const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
    try {
      const raw = await clientApi<unknown>(`/admin/slotzilla/games/${encodeURIComponent(matchId)}/spins${qs}`);
      const page: SlotzillaSpinLogResponse = {
        spins: unwrapList<SlotzillaAdminSpinDto>(raw, "spins"),
        nextCursor:
          typeof raw === "object" && raw !== null && typeof (raw as { nextCursor?: unknown }).nextCursor === "string"
            ? (raw as { nextCursor: string }).nextCursor
            : null,
      };
      setSpins((p) => {
        const prev = p[matchId];
        if (cursor && prev && prev !== "loading" && prev !== "failed") {
          return { ...p, [matchId]: { spins: [...prev.spins, ...page.spins], nextCursor: page.nextCursor } };
        }
        return { ...p, [matchId]: page };
      });
    } catch {
      setSpins((p) => ({ ...p, [matchId]: "failed" }));
    }
  }, []);

  // The 10 s poll refreshes the list and the one open spin log together.
  const poll = useCallback(async () => {
    try {
      await load(statusFilter);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiFetchError ? err.message : "Could not refresh the games.");
    }
    if (expanded) await loadSpins(expanded);
    setNowMs(Date.now());
  }, [load, loadSpins, statusFilter, expanded]);

  useInterval(() => void poll(), POLL_MS);
  useInterval(() => setNowMs(Date.now()), 1000);

  // Filter changes and a null SSR seed reload the LIST immediately. Only
  // the list: the open spin log rides the 10 s poll, so a row click never
  // refetches the table.
  useEffect(() => {
    if (initial !== null && statusFilter === "") return;
    let cancelled = false;
    load(statusFilter)
      .then(() => {
        if (!cancelled) setError(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof ApiFetchError ? err.message : "Could not load the games.");
      });
    return () => {
      cancelled = true;
    };
  }, [load, statusFilter, initial]);

  const toggle = (matchId: string) => {
    if (expanded === matchId) {
      setExpanded(null);
      return;
    }
    setExpanded(matchId);
    setSpins((p) => (p[matchId] ? p : { ...p, [matchId]: "loading" }));
    void loadSpins(matchId);
  };

  const act = (matchId: string, action: "pause" | "resume" | "void") => {
    if (
      action === "void" &&
      !window.confirm(
        "Void this game? Every open spin is refunded (stake unlocked, no payout) and the game ends for good. This cannot be undone.",
      )
    ) {
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        await clientApi<unknown>(`/admin/slotzilla/games/${encodeURIComponent(matchId)}/${action}`, {
          method: "POST",
        });
        await load(statusFilter);
        if (expanded === matchId) await loadSpins(matchId);
      } catch (err) {
        setError(err instanceof ApiFetchError ? err.message : `Could not ${action} the game.`);
      }
    });
  };

  if (games === null) {
    return (
      <>
        <LoadFailed what="the games" onRetry={() => void poll()} pending={pending} />
        {error ? <ErrorBanner>{error}</ErrorBanner> : null}
      </>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <Section
        title={`Games — ${games.length}`}
        aside={
          <label style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 12.5 }}>
            <span style={monoMuted}>Status</span>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as (typeof STATUS_FILTERS)[number])}
              style={{ ...inputStyle, height: 30, fontSize: 12.5 }}
              aria-label="Filter by status"
            >
              {STATUS_FILTERS.map((s) => (
                <option key={s || "all"} value={s}>
                  {s || "All"}
                </option>
              ))}
            </select>
          </label>
        }
      >
        <p style={hintStyle}>
          Every basketball fixture with a confirmed Sportradar mapping inside the scheduling window is
          picked up by the feed worker automatically. Refreshes every 10 s. Click a row for its spin log.
          Return is realised payout over stake per currency; the target is {formatBp(rtpTargetBp)}.
        </p>
        {games.length === 0 ? (
          <p style={hintStyle}>No games{statusFilter ? ` with status ${statusFilter}` : ""}.</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>Match</th>
                  <th style={thStyle}>Status</th>
                  <th style={thStyle}>Coverage</th>
                  <th style={thStyle}>Clock</th>
                  <th style={{ ...thStyle, textAlign: "right" }}>Spins</th>
                  {CURRENCIES.map((c) => (
                    <th key={c} style={{ ...thStyle, textAlign: "right" }}>
                      {c} stake / payout
                    </th>
                  ))}
                  <th style={thStyle}>Return</th>
                  <th style={thStyle} />
                </tr>
              </thead>
              <tbody>
                {games.map((g) => {
                  const open = expanded === g.matchId;
                  const seconds = clockNow(g.clock, nowMs);
                  const log = spins[g.matchId];
                  const canPause = g.status === "live";
                  const canResume = g.status === "paused";
                  const canVoid = g.status === "live" || g.status === "paused" || g.status === "scheduled";
                  return (
                    <Fragment key={g.matchId}>
                      <tr
                        onClick={() => toggle(g.matchId)}
                        style={{
                          ...rowStyle,
                          cursor: "pointer",
                          background: open ? "color-mix(in oklab, var(--accent, #16a34a) 6%, transparent)" : undefined,
                        }}
                      >
                        <td style={tdStyle}>
                          <div style={{ fontWeight: 600 }}>
                            {g.homeTeam ?? "?"} <span style={monoMuted}>vs</span> {g.awayTeam ?? "?"}
                          </div>
                          <div style={monoMuted}>
                            {g.tournament ?? "—"} · match {g.matchId}
                            {g.srMatchId ? ` · sr ${g.srMatchId}` : ""}
                          </div>
                          {g.note ? <div style={{ ...monoMuted, fontStyle: "italic" }}>{g.note}</div> : null}
                        </td>
                        <td style={tdStyle}>
                          <GameStatusChip status={g.status} />
                          {g.pausedAt ? (
                            <div style={{ ...monoMuted, fontSize: 11 }}>paused {formatIsoRelative(g.pausedAt, nowMs)}</div>
                          ) : null}
                        </td>
                        <td style={tdStyle}>
                          {g.coverageLevel === 2 ? (
                            <Chip tone="accent" title="Level 2: scorers and assists on events">
                              Players
                            </Chip>
                          ) : g.coverageLevel !== null && g.coverageLevel !== undefined ? (
                            <Chip tone="muted" title="Team-only events">
                              L{g.coverageLevel}
                            </Chip>
                          ) : (
                            <span style={monoMuted}>—</span>
                          )}
                        </td>
                        <td style={tdStyle}>
                          <ClockCell clock={g.clock} seconds={seconds} feedLagMs={g.feedLagMs} nowMs={nowMs} />
                        </td>
                        <td style={{ ...tdStyle, textAlign: "right" }} className="mono">
                          {g.spinsCount ?? 0}
                        </td>
                        {CURRENCIES.map((c) => {
                          const t = g.totals?.[c];
                          return (
                            <td key={c} style={{ ...tdStyle, textAlign: "right", whiteSpace: "nowrap" }} className="mono">
                              {t ? (
                                <>
                                  {microToUnits(t.stakeMicro, 2)} <span style={monoMuted}>/</span> {microToUnits(t.payoutMicro, 2)}
                                </>
                              ) : (
                                <span style={monoMuted}>—</span>
                              )}
                            </td>
                          );
                        })}
                        <td style={{ ...tdStyle, whiteSpace: "nowrap" }}>
                          <ReturnCell game={g} targetBp={rtpTargetBp} />
                        </td>
                        <td style={{ ...tdStyle, textAlign: "right", whiteSpace: "nowrap" }}>
                          <span style={{ display: "inline-flex", gap: 6 }} onClick={(e) => e.stopPropagation()}>
                            {canPause ? (
                              <button type="button" disabled={pending} onClick={() => act(g.matchId, "pause")} style={smallButtonStyle}>
                                Pause
                              </button>
                            ) : null}
                            {canResume ? (
                              <button type="button" disabled={pending} onClick={() => act(g.matchId, "resume")} style={smallButtonStyle}>
                                Resume
                              </button>
                            ) : null}
                            {canVoid ? (
                              <button type="button" disabled={pending} onClick={() => act(g.matchId, "void")} style={dangerSmallButtonStyle}>
                                Void
                              </button>
                            ) : null}
                          </span>
                        </td>
                      </tr>
                      {open ? (
                        <tr style={rowStyle}>
                          <td colSpan={7 + CURRENCIES.length} style={{ ...tdStyle, padding: "8px 8px 14px 24px" }}>
                            <SpinLog
                              log={log}
                              onMore={(cursor) => void loadSpins(g.matchId, cursor)}
                              onRetry={() => void loadSpins(g.matchId)}
                            />
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>
      {error ? <ErrorBanner>{error}</ErrorBanner> : null}
    </div>
  );
}

function ClockCell({
  clock,
  seconds,
  feedLagMs,
  nowMs,
}: {
  clock: SlotzillaGameClockDto | null | undefined;
  seconds: number | null;
  feedLagMs: number | null | undefined;
  nowMs: number;
}) {
  if (seconds === null) return <span style={monoMuted}>—</span>;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <span className="mono" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
        {formatMatchClock(seconds)}
        {clock?.period !== null && clock?.period !== undefined ? <span style={monoMuted}>P{clock.period}</span> : null}
        {clock?.running ? <Chip tone="accent">running</Chip> : <Chip tone="muted">stopped</Chip>}
      </span>
      <span style={{ ...monoMuted, fontSize: 11 }}>
        read {formatIsoRelative(clock?.readAt, nowMs)}
        {typeof feedLagMs === "number" ? ` · lag ${(feedLagMs / 1000).toFixed(1)}s` : ""}
      </span>
    </div>
  );
}

function ReturnCell({ game, targetBp }: { game: SlotzillaAdminGameDto; targetBp: number | null }) {
  const parts = CURRENCIES.map((c) => {
    const t = game.totals?.[c];
    if (!t || t.returnBp === null || t.returnBp === undefined) return null;
    return (
      <span key={c} className="mono" style={{ fontSize: 12 }}>
        {c} {formatBp(t.returnBp)}
      </span>
    );
  }).filter(Boolean);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      {parts.length === 0 ? <span style={monoMuted}>—</span> : parts}
      <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
        <span style={{ ...monoMuted, fontSize: 11 }}>target {formatBp(targetBp)}</span>
        {game.alarm ? (
          <Chip tone="negative" title="Realised return above target + alarm margin over the minimum spin count">
            alarm
          </Chip>
        ) : null}
      </span>
    </div>
  );
}

function SpinLog({
  log,
  onMore,
  onRetry,
}: {
  log: SlotzillaSpinLogResponse | "loading" | "failed" | undefined;
  onMore: (cursor: string) => void;
  onRetry: () => void;
}) {
  if (!log || log === "loading") return <p style={hintStyle}>Loading spins…</p>;
  if (log === "failed") {
    return (
      <p style={{ ...hintStyle, display: "flex", gap: 10, alignItems: "center" }}>
        Couldn&apos;t load the spin log.
        <button type="button" onClick={onRetry} style={smallButtonStyle}>
          Retry
        </button>
      </p>
    );
  }
  if (log.spins.length === 0) return <p style={hintStyle}>No spins on this game yet.</p>;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <table style={{ ...tableStyle, fontSize: 12.5 }}>
        <thead>
          <tr>
            <th style={thStyle}>Placed</th>
            <th style={thStyle}>Bettor</th>
            <th style={thStyle}>Window</th>
            <th style={thStyle}>Reels</th>
            <th style={thStyle}>Line</th>
            <th style={{ ...thStyle, textAlign: "right" }}>Mult</th>
            <th style={{ ...thStyle, textAlign: "right" }}>Stake</th>
            <th style={{ ...thStyle, textAlign: "right" }}>Payout</th>
            <th style={thStyle}>Status</th>
          </tr>
        </thead>
        <tbody>
          {log.spins.map((s) => (
            <tr key={s.id} style={rowStyle}>
              <td style={{ ...tdStyle, whiteSpace: "nowrap" }} className="mono">
                {s.placedAt ? new Date(s.placedAt).toLocaleTimeString() : "—"}
                {s.autoplay ? (
                  <>
                    {" "}
                    <Chip tone="muted">auto</Chip>
                  </>
                ) : null}
              </td>
              <td style={{ ...tdStyle, ...monoMuted, maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {s.nickname ?? s.userEmail ?? s.userId ?? "—"}
              </td>
              <td style={tdStyle} className="mono">
                {typeof s.windowFrom === "number" ? `${formatMatchClock(s.windowFrom)}–${formatMatchClock(s.windowFrom + 14)}` : "—"}
              </td>
              <td style={tdStyle}>
                <span style={{ display: "inline-flex", gap: 4 }}>
                  {[0, 1, 2].map((i) => (
                    <ReelCell key={i} symbol={s.reels?.[i] ?? null} team={s.reelTeams?.[i] ?? null} />
                  ))}
                </span>
              </td>
              <td style={tdStyle} className="mono">
                {s.lineKey ?? <span style={monoMuted}>—</span>}
              </td>
              <td style={{ ...tdStyle, textAlign: "right" }} className="mono">
                {typeof s.multiplierX100 === "number" ? `×${formatMultiplier(s.multiplierX100)}` : "—"}
              </td>
              <td style={{ ...tdStyle, textAlign: "right", whiteSpace: "nowrap" }} className="mono">
                {microToUnits(s.stakeMicro, 2)} {s.currency}
              </td>
              <td style={{ ...tdStyle, textAlign: "right", whiteSpace: "nowrap" }} className="mono">
                {microToUnits(s.payoutMicro, 2)}
              </td>
              <td style={tdStyle}>
                <SpinStatusChip status={s.status} />
                {s.voidReason ? <div style={{ ...monoMuted, fontSize: 11 }}>{s.voidReason}</div> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {log.nextCursor ? (
        <div>
          <button type="button" onClick={() => onMore(log.nextCursor as string)} style={smallButtonStyle}>
            Load more
          </button>
        </div>
      ) : null}
    </div>
  );
}
