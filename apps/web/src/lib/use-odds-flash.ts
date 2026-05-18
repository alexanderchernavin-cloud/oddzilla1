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
// 2.5 s total: holds a clearly-visible tint for ~0.5 s then fades.
// The previous 10 s window left the cell in a long low-contrast tail
// where the background was mostly-transparent — odds digits looked
// washed out mid-fade. Keeping the entire animation under three
// seconds means the cell never sits in that dim middle for long.
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
    // Slightly stronger tint than before (32 % vs 22 %) so the flash
    // is clearly seen during its short window. Both up and down keep
    // mid-readable contrast against fg text on either theme.
    const tint =
      dir === "up"
        ? "color-mix(in oklab, var(--positive) 32%, transparent)"
        : "color-mix(in oklab, var(--negative) 32%, transparent)";

    // Cancel any in-flight flash so the newest direction wins instead
    // of stacking on top of a fading old one.
    for (const a of el.getAnimations()) {
      // Only cancel animations we own. We tag them with `id` below.
      if ((a as Animation & { id?: string }).id === "oz-value-flash") {
        a.cancel();
      }
    }

    // Hold the tint for ~0.5 s then fade to transparent over 2 s.
    // Total = 2.5 s. The previous 10 s window left the cell in a long
    // low-contrast tail; the digit text looked washed out for most of
    // the animation. Keeping it under three seconds means the cell
    // doesn't sit in the mid-fade twilight for long.
    const anim = el.animate(
      [
        { backgroundColor: tint, offset: 0 },
        { backgroundColor: tint, offset: 0.2 },
        { backgroundColor: "transparent", offset: 1 },
      ],
      { duration: 2500, easing: "ease-out", fill: "none" },
    );
    (anim as Animation & { id?: string }).id = "oz-value-flash";
  }, [value, ref]);
}

// Backwards-compatible alias. Existing odds-button call sites read
// cleaner as `useOddsFlash`; new scoreboard call sites read cleaner
// as `useValueFlash`. Both hit the same implementation.
export const useOddsFlash = useValueFlash;
