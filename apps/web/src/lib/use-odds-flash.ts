"use client";

import { useEffect, useRef, type RefObject } from "react";

// Briefly tints the background of `ref` green when `value` rises and
// red when it falls. Skips the initial render and skips null values
// (the "locked"/"unknown" affordance handles those). On a new tick
// mid-fade we cancel the previous animation and start a new one so
// direction is always current.
//
// Used for odds buttons (publishedOdds up/down), scoreboard cells
// (kills/rounds/series score per map), and any other live numeric
// surface where the user benefits from a moment of "this just changed"
// highlight. The hook is agnostic to what the number means — the caller
// decides which DOM element gets tinted by passing its ref.
//
// 10s total: holds a soft tint for ~1s for instant readability, then
// fades to transparent over the remaining 9s. Long enough that a glance
// at the page surfaces "what just moved", short enough not to bleed
// into the next batch of ticks.
export function useValueFlash(
  value: number | null,
  ref: RefObject<HTMLElement | null>,
) {
  // Track the previous value seen by THIS instance. The first effect
  // run records the SSR/initial value without flashing — flashing on
  // mount would light the whole page green/red on every navigation.
  const prevRef = useRef<number | null>(value);

  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = value;

    if (prev == null || value == null) return;
    if (value === prev) return;

    const el = ref.current;
    if (!el) return;
    if (typeof el.animate !== "function") return; // no Web Animations API

    const dir = value > prev ? "up" : "down";
    const tint =
      dir === "up"
        ? "color-mix(in oklab, var(--positive) 22%, transparent)"
        : "color-mix(in oklab, var(--negative) 22%, transparent)";

    // Cancel any in-flight flash so the newest direction wins instead
    // of stacking on top of a fading old one.
    for (const a of el.getAnimations()) {
      // Only cancel animations we own. We tag them with `id` below.
      if ((a as Animation & { id?: string }).id === "oz-value-flash") {
        a.cancel();
      }
    }

    // Hold the tint for ~1s, then fade to transparent over the next 9s.
    // `easing: "ease-out"` shapes the fade so most of the colour is
    // gone in the first few seconds — the lingering tail is just a
    // gentle reminder.
    const anim = el.animate(
      [
        { backgroundColor: tint, offset: 0 },
        { backgroundColor: tint, offset: 0.1 },
        { backgroundColor: "transparent", offset: 1 },
      ],
      { duration: 10000, easing: "ease-out", fill: "none" },
    );
    (anim as Animation & { id?: string }).id = "oz-value-flash";
  }, [value, ref]);
}

// Backwards-compatible alias. Existing odds-button call sites read
// cleaner as `useOddsFlash`; new scoreboard call sites read cleaner
// as `useValueFlash`. Both hit the same implementation.
export const useOddsFlash = useValueFlash;
