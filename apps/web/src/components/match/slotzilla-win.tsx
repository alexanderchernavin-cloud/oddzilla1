"use client";

// The win presentation: what a settled spin looks like when it pays.
//
// Before this the reels simply stopped and a sentence appeared under
// them. That is a correct report and not a slot machine — the moment a
// bettor is here for produced no more feedback than a form validating.
//
// Three parts, in the order they fire: the paying reels light, a band
// sweeps in carrying the multiplier, and the amount counts up to the
// payout. All of it is motion over the existing layout, so nothing
// reflows and a bettor who has motion turned down still sees the
// multiplier, the amount and the line.
//
// MONEY: the count-up scales the payout as a BIGINT (invariant 1 —
// money is never a JS number). Progress is a float in [0,1]; the amount
// shown is `payout * round(p * 1000) / 1000`, so the last frame is the
// exact payout rather than a rounded approximation of it.

import { useEffect, useRef, useState } from "react";
import { fromMicroMoney } from "@oddzilla/types/money";
import { formatMultiplier, type SlotzillaSpinView } from "@oddzilla/types/slotzilla";

type Translate = (key: string, values?: Record<string, string | number>) => string;

/** How long the amount takes to reach the payout. */
const COUNT_MS = 900;
/** How long the whole celebration stays up before settling into the row. */
const HOLD_MS = 2600;

const COUNT_STEPS = 1000n;

/**
 * Counts a micro amount up to `target` over COUNT_MS, restarting whenever
 * `runId` changes. Returns the exact target when idle or finished, so the
 * figure on screen is never a rounded stand-in once the animation is over.
 */
function useCountUpMicro(target: bigint, runId: string | null): bigint {
  const [shown, setShown] = useState<bigint>(target);
  const frame = useRef<number | null>(null);

  useEffect(() => {
    if (runId === null) {
      setShown(target);
      return;
    }
    const start = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / COUNT_MS);
      // Ease-out: a payout that decelerates into place reads as landing,
      // where a linear count reads as a progress bar.
      const eased = 1 - (1 - p) * (1 - p);
      if (p >= 1) {
        setShown(target);
        return;
      }
      const scaled = (target * BigInt(Math.round(eased * 1000))) / COUNT_STEPS;
      setShown(scaled);
      frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    };
  }, [target, runId]);

  return shown;
}

export interface SlotzillaWinProps {
  /** The settled spin to celebrate, or null for anything else. */
  spin: SlotzillaSpinView | null;
  t: Translate;
}

/**
 * The band that appears over the reels when a spin pays. Renders nothing
 * for a spin that is open, lost or void — losing quietly is the right
 * behaviour, and a "you lost" animation is the one piece of slot
 * grammar this product should not borrow.
 */
export function SlotzillaWin({ spin, t }: SlotzillaWinProps) {
  const won = spin?.status === "won" && spin.payoutMicro !== "0";
  const runId = won && spin ? spin.id : null;

  // Held so the band can play out after the spin stops being the
  // displayed one; without it a fast auto-play would cut its own
  // celebration off mid-count.
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!runId) return;
    setVisible(true);
    const timer = setTimeout(() => setVisible(false), HOLD_MS);
    return () => clearTimeout(timer);
  }, [runId]);

  const target = won && spin ? BigInt(spin.payoutMicro) : 0n;
  const shown = useCountUpMicro(target, visible ? runId : null);

  if (!won || !spin || !visible) return null;

  return (
    <div className="oz-slz-win" role="status" data-visible="true">
      <span className="oz-slz-win-sheen" aria-hidden />
      <span className="oz-slz-win-mult display">
        ×{formatMultiplier(spin.multiplierX100 ?? 0)}
      </span>
      <span className="oz-slz-win-amount mono">
        +{fromMicroMoney(shown)} {spin.currency}
      </span>
      <span className="oz-sr-only">
        {t("win", {
          line: "",
          multiplier: formatMultiplier(spin.multiplierX100 ?? 0),
          amount: `${fromMicroMoney(target)} ${spin.currency}`,
        })}
      </span>
    </div>
  );
}
