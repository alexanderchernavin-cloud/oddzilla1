"use client";

// SlotZilla reel primitives: the symbol glyph, one reel, the paytable
// grid and the line-description helper. Kept apart from the panel so
// the panel stays readable; nothing here holds state.
//
// Symbols are drawn with text and CSS only (no images, no emoji): the
// point value as a digit for P3 / P2 / FT, a cross for a miss, a
// stylised F for a foul and a dot for an empty window. Each carries a
// `data-sym` so the tint is the stylesheet's call (globals.css,
// SlotZilla section) and reads the same in both themes.

import type { ReactNode } from "react";
import {
  formatMultiplier,
  formatWindowCountdown,
  SLOT_SYMBOLS,
} from "@oddzilla/types/slotzilla";
import type {
  LineKey,
  PaytableLines,
  SlotSymbol,
  SlotTeam,
} from "@oddzilla/types/slotzilla";

type Translate = (key: string, values?: Record<string, string | number>) => string;

export function SymbolGlyph({ symbol, size = 36 }: { symbol: SlotSymbol; size?: number }) {
  let body: ReactNode;
  switch (symbol) {
    case "P3":
      body = "3";
      break;
    case "P2":
      body = "2";
      break;
    case "FT":
      body = "1";
      break;
    case "MISS":
      body = <span className="oz-slz-cross" aria-hidden />;
      break;
    case "FOUL":
      body = "F";
      break;
    default:
      body = <span className="oz-slz-dot" aria-hidden />;
  }
  return (
    <span
      className="oz-slz-sym display"
      data-sym={symbol}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.62) }}
    >
      {body}
    </span>
  );
}

export interface ReelProps {
  from: number;
  /** null while the window has no symbol worth showing yet. */
  symbol: SlotSymbol | null;
  team: SlotTeam | null;
  /** The clock is inside this window right now. */
  lit: boolean;
  /** The service will not change this symbol again. */
  final: boolean;
  homeTeam: string;
  awayTeam: string;
  t: Translate;
  /** Feed period, so the label counts down inside it. */
  period?: number | null;
  /** Reel already settled into a paying line (tints the frame). */
  paying?: boolean;
}

/**
 * The strip a spinning reel shows. The paying symbols twice over so the
 * loop has something to repeat, and the animation translates it by
 * exactly half its height — which is why the first half must equal the
 * second: the wrap point then lands on an identical frame and the loop
 * is seamless.
 *
 * NONE is left out. It is the commonest real outcome, but a blank
 * tumbling past reads as a gap in the reel rather than a symbol.
 */
const SPIN_FACE: readonly SlotSymbol[] = ["P2", "MISS", "P3", "FOUL", "FT", "MISS"];
const SPIN_STRIP: readonly SlotSymbol[] = [...SPIN_FACE, ...SPIN_FACE];

export function Reel({ from, symbol, team, lit, final, homeTeam, awayTeam, t, paying, period }: ReelProps) {
  const teamName = team === "home" ? homeTeam : team === "away" ? awayTeam : null;
  const stateLabel = lit ? t("reelLive") : t("reelPending");
  // A symbol the service may still revise (its window is not final):
  // say so under it, unless the reel is lit — "now" already says the
  // window is still being played.
  const subLabel = teamName ?? (symbol && !final && !lit ? t("reelTentative") : null);
  return (
    <div
      className="oz-slz-reel"
      data-lit={lit ? "true" : "false"}
      data-final={final ? "true" : "false"}
      data-paying={paying ? "true" : "false"}
      data-empty={symbol == null ? "true" : "false"}
    >
      <span className="oz-slz-reel-label mono">{formatWindowCountdown(from, period)}</span>
      {/*
        A reel with no symbol yet SPINS, like the machine it is meant to
        be: the strip below is the symbol set repeated, translated on a
        loop inside a clipped window, so what a bettor sees is symbols
        flying past until the window resolves. A dashed circle and the
        word "Waiting" said the same thing and looked like a form field.

        The strip is `aria-hidden` and the state is announced in the foot
        instead — a screen reader wants "waiting", not the eight symbols
        currently flickering past.
      */}
      <span className="oz-slz-reel-face">
        {symbol ? (
          <SymbolGlyph symbol={symbol} />
        ) : (
          <span className="oz-slz-reel-spinner" aria-hidden>
            <span className="oz-slz-reel-strip">
              {SPIN_STRIP.map((s, i) => (
                <SymbolGlyph key={`${s}-${i}`} symbol={s} />
              ))}
            </span>
          </span>
        )}
      </span>
      <span className="oz-slz-reel-foot">
        {symbol ? (
          <>
            <span className="oz-slz-reel-name">{t(`symbol.${symbol}`)}</span>
            {subLabel ? <span className="oz-slz-reel-team">{subLabel}</span> : null}
          </>
        ) : (
          <span className="oz-slz-reel-name" style={{ color: "var(--fg-dim)" }}>
            {stateLabel}
          </span>
        )}
      </span>
    </div>
  );
}

/** "Two 2-pointers" / "Three fouls" for a line key; empty for none. */
export function describeLine(t: Translate, line: LineKey | null): string {
  if (!line) return t("noLine");
  const [kind, sym] = line.split(":") as ["any2" | "all3", SlotSymbol];
  const symbol = t(`symbolPlural.${sym}`);
  return kind === "all3" ? t("lineAll3", { symbol }) : t("lineAny2", { symbol });
}

/** The symbol a settled spin's line is on, for tinting the history strip. */
export function lineSymbol(line: LineKey | null): SlotSymbol | null {
  if (!line) return null;
  const sym = line.split(":")[1];
  return (SLOT_SYMBOLS as readonly string[]).includes(sym ?? "") ? (sym as SlotSymbol) : null;
}

export function Paytable({ lines, t }: { lines: PaytableLines; t: Translate }) {
  return (
    <table className="oz-slz-paytable">
      <thead>
        <tr>
          <th scope="col">{t("paytableSymbol")}</th>
          <th scope="col">{t("payAny2")}</th>
          <th scope="col">{t("payAll3")}</th>
        </tr>
      </thead>
      <tbody>
        {SLOT_SYMBOLS.map((s) => {
          const any2 = lines[`any2:${s}`];
          const all3 = lines[`all3:${s}`];
          return (
            <tr key={s}>
              <th scope="row">
                <SymbolGlyph symbol={s} size={22} />
                <span>{t(`symbol.${s}`)}</span>
              </th>
              <td className="mono">{typeof any2 === "number" ? `×${formatMultiplier(any2)}` : "—"}</td>
              <td className="mono">{typeof all3 === "number" ? `×${formatMultiplier(all3)}` : "—"}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
