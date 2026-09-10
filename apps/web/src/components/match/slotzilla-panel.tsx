"use client";

// SlotZilla panel on the match page: three reels over 15 seconds of
// live play-by-play, a stake row, the Spin button, auto-play, the last
// spins and the paytable. Mounted above the match tracker whenever the
// api reports a game for the match; hides itself when the game is over
// and the bettor has nothing on it.
//
// State comes from useSlotzilla (snapshot + frames + the locally
// running clock). This file only decides what to draw:
//   - the reels are the OPEN spin's windows while one runs, then the
//     settled spin's reels until the next spin, else a preview of the
//     three windows the next spin would cover;
//   - the reel whose window the clock is inside right now is lit;
//   - a window's symbol is shown as soon as the service has one, marked
//     tentative until the window is final.
//
// On a phone (<= 1099px) the panel collapses to a one-line strip —
// clock, last result, Spin — and expands on tap; the split is CSS on
// `data-expanded`, so SSR and hydration agree.

import { useEffect, useMemo, useState } from "react";
import type { MouseEvent } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  firstWindowFor,
  formatMatchClock,
  formatMultiplier,
  formatWindowLabel,
  roundWindows,
  windowStartOf,
} from "@oddzilla/types/slotzilla";
import type { SlotSymbol, SlotzillaSpinView, SlotzillaWindow } from "@oddzilla/types/slotzilla";
import { fromMicroMoney } from "@oddzilla/types/money";
import { isCurrency } from "@oddzilla/types/currencies";
import { useBetSlip } from "@/lib/bet-slip";
import { useTranslations } from "@/lib/i18n";
import { useSlotzilla } from "@/lib/use-slotzilla";
import { LiveDot } from "@/components/ui/primitives";
import { I } from "@/components/ui/icons";
import { describeLine, lineSymbol, Paytable, Reel, SymbolGlyph } from "./slotzilla-reel";

const MICRO = 1_000_000n;
const STAKE_PRESETS = [0.1, 0.3, 0.5, 1, 5] as const;
const STAKE_STEP = MICRO / 10n;
const DEFAULT_STAKE = MICRO / 2n;
const KNOWN_ERRORS = new Set([
  "clock_stopped",
  "game_not_live",
  "game_paused",
  "disabled",
  "slot_match_limit",
  "insufficient_balance",
  "stake_out_of_bounds",
  "velocity_bets_per_minute_exceeded",
  "open_spin",
  "sign_in",
  "network",
]);

function unitsToMicro(units: number): bigint {
  return BigInt(Math.round(units * 1_000_000));
}

function clampStake(stake: bigint, min: bigint, max: bigint): bigint {
  if (max > 0n && stake > max) return max;
  if (stake < min) return min;
  return stake;
}

interface DisplayReel {
  from: number;
  symbol: SlotSymbol | null;
  team: "home" | "away" | null;
  final: boolean;
}

/** The three reels to draw for a spin, filled from the shared windows while it runs. */
function reelsForSpin(spin: SlotzillaSpinView, windows: SlotzillaWindow[]): DisplayReel[] {
  const byFrom = new Map(windows.map((w) => [w.from, w]));
  return spin.windows.map((from, i) => {
    const settled = spin.status !== "open";
    const own = spin.reels[i];
    const shared = byFrom.get(from);
    if (own) return { from, symbol: own, team: spin.reelTeams[i] ?? null, final: true };
    if (settled) return { from, symbol: null, team: null, final: true };
    if (shared) return { from, symbol: shared.symbol, team: shared.team, final: shared.final };
    return { from, symbol: null, team: null, final: false };
  });
}

export function SlotzillaPanel({
  matchId,
  homeTeam,
  awayTeam,
  defaultExpanded = false,
}: {
  matchId: string;
  homeTeam: string;
  awayTeam: string;
  /**
   * Open the full panel on mobile from the first paint. The match page
   * keeps the collapsed strip (the game shares the page with the
   * markets); the SlotZilla section is the game, so it opens expanded.
   */
  defaultExpanded?: boolean;
}) {
  const t = useTranslations("slotzilla");
  const pathname = usePathname();
  const slip = useBetSlip();
  const game = useSlotzilla(matchId);
  const { state, clockSeconds } = game;

  const [expanded, setExpanded] = useState(defaultExpanded);
  const [showPaytable, setShowPaytable] = useState(false);
  const [stakeMicro, setStakeMicro] = useState<bigint>(DEFAULT_STAKE);

  const limits = state?.limits ?? null;
  const minStake = limits ? BigInt(limits.minStakeMicro) : 0n;
  const maxStake = limits ? BigInt(limits.maxStakeMicro) : 0n;
  // The slip's currency when the game takes it, else the first the
  // operator allows — one place decides, so the Spin label and the
  // request agree.
  const currencies = limits?.currencies ?? [];
  const currency = currencies.includes(slip.currency) ? slip.currency : (currencies[0] ?? slip.currency);

  // Fold the stake into the operator's bounds once they are known.
  useEffect(() => {
    if (!limits) return;
    setStakeMicro((s) => clampStake(s, minStake, maxStake));
  }, [limits, minStake, maxStake]);

  const displaySpin = state?.openSpin ?? game.lastSpin;
  const reels: DisplayReel[] = useMemo(() => {
    if (!state) return [];
    if (displaySpin) return reelsForSpin(displaySpin, state.windows);
    const base = clockSeconds ?? 0;
    return roundWindows(firstWindowFor(base, state.limits.leadSeconds)).map((from) => ({
      from,
      symbol: null,
      team: null,
      final: false,
    }));
  }, [state, displaySpin, clockSeconds]);

  if (game.missing || !game.loaded || !state) return null;
  const over = state.status === "ended" || state.status === "voided";
  if (over && !state.openSpin && !game.lastSpin && state.recentSpins.length === 0) return null;

  const block = state.spinBlock;
  const spinDisabled = !state.canSpin || game.spinning;
  const litFrom = clockSeconds == null ? null : windowStartOf(clockSeconds);
  const paying = displaySpin?.status === "won";
  const stakeLabel = `${fromMicroMoney(stakeMicro)} ${currency}`;

  const placeSpin = () => {
    void game.spin(stakeMicro, currency);
  };
  const onStripSpin = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    placeSpin();
  };
  const setStake = (next: bigint) => {
    game.clearError();
    setStakeMicro(clampStake(next, minStake, maxStake));
  };
  const toggleAutoplay = () => {
    if (game.autoplay) game.stopAutoplay();
    else game.startAutoplay(stakeMicro, currency);
  };

  // The one line under the reels that says what is happening.
  let resultLine: string;
  let resultTone: "neutral" | "win" | "loss" | "void" = "neutral";
  if (displaySpin && displaySpin.status === "open") {
    const from = displaySpin.windowFrom;
    if (clockSeconds != null && clockSeconds < from) {
      resultLine = t("startsAt", { at: formatMatchClock(from), seconds: from - clockSeconds });
    } else {
      resultLine = t("inProgress", {
        from: formatMatchClock(from),
        to: formatMatchClock(displaySpin.windows[2] + 4),
      });
    }
  } else if (displaySpin && displaySpin.status === "won") {
    resultTone = "win";
    resultLine = t("win", {
      line: describeLine(t, displaySpin.lineKey),
      multiplier: formatMultiplier(displaySpin.multiplierX100 ?? 0),
      amount: `${fromMicroMoney(BigInt(displaySpin.payoutMicro))} ${displaySpin.currency}`,
    });
  } else if (displaySpin && displaySpin.status === "lost") {
    resultTone = "loss";
    resultLine = t("loss", { line: describeLine(t, displaySpin.lineKey) });
  } else if (displaySpin && displaySpin.status === "void") {
    resultTone = "void";
    resultLine = t("void");
  } else if (state.canSpin && reels.length === 3) {
    resultLine = t("upcoming", {
      from: formatMatchClock(reels[0]!.from),
      to: formatMatchClock(reels[2]!.from + 4),
    });
  } else {
    resultLine = "";
  }

  const clockText = clockSeconds == null ? "—" : formatMatchClock(clockSeconds);
  const periodText = state.clock.period != null ? `Q${state.clock.period}` : "";
  const errorText = game.error
    ? t(KNOWN_ERRORS.has(game.error) ? `errors.${game.error}` : "errors.generic")
    : null;
  const spend = game.sessionSpend[currency] ?? 0n;
  const showBalanceHint = block === "sign_in";
  const signInHref = `/login?next=${encodeURIComponent(pathname || "/")}`;

  return (
    <section
      className="oz-slz card"
      data-expanded={expanded ? "true" : "false"}
      aria-label={t("title")}
    >
      {/* Mobile strip: the whole row expands; the Spin button inside
          places without expanding (stopPropagation). */}
      <div
        className="oz-slz-strip"
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setExpanded((v) => !v);
          }
        }}
      >
        <span className="oz-slz-strip-title display">{t("title")}</span>
        <span className="oz-slz-strip-clock mono">
          {state.status === "live" && state.clock.running ? <LiveDot size={6} /> : null}
          {clockText}
        </span>
        <span className="oz-slz-strip-result">{resultLine}</span>
        {block === "sign_in" ? (
          <Link
            href={signInHref}
            className="oz-slz-spin oz-slz-spin-sm"
            onClick={(e) => e.stopPropagation()}
          >
            {t("signInCta")}
          </Link>
        ) : (
          <button
            type="button"
            className="oz-slz-spin oz-slz-spin-sm"
            disabled={spinDisabled}
            onClick={onStripSpin}
          >
            {t("spinShort")}
          </button>
        )}
        <span className="oz-slz-strip-chev" aria-hidden>
          <I.ChevD size={14} />
        </span>
      </div>

      <div className="oz-slz-body">
        <header className="oz-slz-head">
          <div className="oz-slz-head-title">
            <span className="oz-slz-kicker mono">{t("kicker")}</span>
            <span className="oz-slz-title display">{t("title")}</span>
          </div>
          <span className="oz-slz-head-spacer" />
          <span className="oz-slz-clock mono" title={t("clockTitle")}>
            {state.status === "live" && state.clock.running ? <LiveDot size={7} /> : null}
            {clockText}
            {periodText ? <span className="oz-slz-period">{periodText}</span> : null}
          </span>
          <span className="oz-slz-tagline">{t("tagline")}</span>
        </header>

        <div className="oz-slz-reels" aria-live="polite">
          {reels.map((r) => (
            <Reel
              key={r.from}
              from={r.from}
              symbol={r.symbol}
              team={r.team}
              lit={litFrom === r.from && state.clock.running}
              final={r.final}
              paying={Boolean(paying && r.symbol && r.symbol === lineSymbol(displaySpin?.lineKey ?? null))}
              homeTeam={homeTeam}
              awayTeam={awayTeam}
              t={t}
            />
          ))}
        </div>

        <p className="oz-slz-result" data-tone={resultTone}>
          {resultLine || " "}
        </p>

        {block === "sign_in" ? (
          <div className="oz-slz-note oz-slz-note-signin">
            <div>
              <strong>{t("signInTitle")}</strong>
              <span>{t("signInBody")}</span>
            </div>
            <Link href={signInHref} className="oz-slz-spin">
              {t("signInCta")}
            </Link>
          </div>
        ) : null}
        {block === "clock_stopped" ? (
          <div className="oz-slz-note">
            <strong>{t("waitingLive")}</strong>
            <span>{t("waitingLiveBody")}</span>
          </div>
        ) : null}
        {block === "game_paused" ? <div className="oz-slz-note">{t("pausedNote")}</div> : null}
        {block === "game_not_live" ? (
          <div className="oz-slz-note">{over ? t("endedNote") : t("notLiveNote")}</div>
        ) : null}
        {block === "disabled" ? <div className="oz-slz-note">{t("disabledNote")}</div> : null}

        {!showBalanceHint && block !== "disabled" && !over ? (
          <div className="oz-slz-controls">
            <div className="oz-slz-stake">
              <span className="oz-slz-stake-label">{t("stake")}</span>
              <div className="oz-slz-presets" role="group" aria-label={t("stake")}>
                {STAKE_PRESETS.map((u) => {
                  const micro = unitsToMicro(u);
                  return (
                    <button
                      key={u}
                      type="button"
                      className="oz-slz-preset mono"
                      data-active={micro === stakeMicro ? "true" : "false"}
                      onClick={() => setStake(micro)}
                    >
                      {u}
                    </button>
                  );
                })}
              </div>
              <div className="oz-slz-stepper">
                <button
                  type="button"
                  className="oz-slz-step"
                  aria-label={t("stakeDown")}
                  onClick={() => setStake(stakeMicro - STAKE_STEP)}
                  disabled={stakeMicro - STAKE_STEP < minStake}
                >
                  −
                </button>
                <span className="oz-slz-stake-value mono">{fromMicroMoney(stakeMicro)}</span>
                <button
                  type="button"
                  className="oz-slz-step"
                  aria-label={t("stakeUp")}
                  onClick={() => setStake(stakeMicro + STAKE_STEP)}
                  disabled={maxStake > 0n && stakeMicro + STAKE_STEP > maxStake}
                >
                  +
                </button>
                {currencies.length > 1 ? (
                  <span className="oz-slz-currencies" role="group" aria-label={t("currency")}>
                    {currencies.map((c) => (
                      <button
                        key={c}
                        type="button"
                        className="oz-slz-currency mono"
                        data-active={c === currency ? "true" : "false"}
                        onClick={() => {
                          if (isCurrency(c)) slip.setCurrency(c);
                        }}
                      >
                        {c}
                      </button>
                    ))}
                  </span>
                ) : (
                  <span className="oz-slz-currency mono" data-active="true">
                    {currency}
                  </span>
                )}
              </div>
            </div>

            <div className="oz-slz-actions">
              <button
                type="button"
                className="oz-slz-spin"
                disabled={spinDisabled}
                onClick={placeSpin}
                data-busy={game.spinning ? "true" : "false"}
              >
                {game.spinning
                  ? t("spinning")
                  : block === "open_spin"
                    ? t("spinRunning")
                    : t("spin", { amount: stakeLabel })}
              </button>
              {state.limits.autoplayEnabled ? (
                game.autoplay ? (
                  <button type="button" className="oz-slz-auto oz-slz-auto-stop" onClick={toggleAutoplay}>
                    <span className="oz-slz-auto-dot" aria-hidden />
                    {t("stop")}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="oz-slz-auto"
                    onClick={toggleAutoplay}
                    disabled={block != null && block !== "open_spin" && block !== "clock_stopped"}
                  >
                    {t("autoplay")}
                  </button>
                )
              ) : null}
              <span className="oz-slz-spend mono">
                {t("sessionSpend", { amount: `${fromMicroMoney(spend)} ${currency}` })}
              </span>
            </div>
            {errorText ? (
              <p className="oz-slz-error" role="alert">
                {errorText}
              </p>
            ) : null}
          </div>
        ) : null}

        {state.recentSpins.length > 0 ? (
          <div className="oz-slz-recent">
            <span className="oz-slz-recent-label mono">{t("recent")}</span>
            <div className="oz-slz-recent-strip">
              {/* The api lists newest first; the strip reads left to
                  right in time, newest at the right edge. */}
              {[...state.recentSpins].reverse().map((s) => {
                const sym = s.status === "void" ? null : lineSymbol(s.lineKey);
                const title =
                  s.status === "void"
                    ? t("void")
                    : s.status === "won"
                      ? `${describeLine(t, s.lineKey)} · +${fromMicroMoney(BigInt(s.payoutMicro))} ${s.currency}`
                      : describeLine(t, s.lineKey);
                return (
                  <span
                    key={s.id}
                    className="oz-slz-chip"
                    data-status={s.status}
                    title={`${formatWindowLabel(s.windowFrom)} · ${title}`}
                  >
                    {sym ? <SymbolGlyph symbol={sym} size={18} /> : <span className="oz-slz-chip-none" aria-hidden />}
                  </span>
                );
              })}
            </div>
          </div>
        ) : null}

        <div className="oz-slz-foot">
          <button
            type="button"
            className="oz-slz-linkbtn"
            aria-expanded={showPaytable}
            onClick={() => setShowPaytable((v) => !v)}
          >
            {showPaytable ? t("paytableHide") : t("paytable")}
            <span style={{ display: "inline-flex", transform: showPaytable ? "rotate(180deg)" : "none" }} aria-hidden>
              <I.ChevD size={12} />
            </span>
          </button>
          <span className="oz-slz-foot-note">
            {t("paytableNote", { name: state.paytable.name })}
          </span>
        </div>
        {showPaytable ? <Paytable lines={state.paytable.lines} t={t} /> : null}
      </div>
    </section>
  );
}
