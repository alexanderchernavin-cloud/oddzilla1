"use client";

import { useEffect, useRef, type RefObject } from "react";

// Briefly tints the background of `ref` green when `price` rises and red
// when it falls. Skips the initial render and skips null prices (the
// "locked" affordance handles those). On a new tick mid-fade we cancel
// the previous animation and start a new one so direction is always
// current.
//
// 10s total: holds a soft tint for ~1s for instant readability, then
// fades to transparent over the remaining 9s. Long enough that a glance
// at the page surfaces "what just moved", short enough not to bleed
// into the next batch of ticks.
export function useOddsFlash(
  price: number | null,
  ref: RefObject<HTMLElement | null>,
) {
  // Track the previous price seen by THIS instance. The first effect
  // run records the SSR/initial value without flashing — flashing on
  // mount would light the whole page green/red on every navigation.
  const prevRef = useRef<number | null>(price);

  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = price;

    if (prev == null || price == null) return;
    if (price === prev) return;

    const el = ref.current;
    if (!el) return;
    if (typeof el.animate !== "function") return; // no Web Animations API

    const dir = price > prev ? "up" : "down";
    const tint =
      dir === "up"
        ? "color-mix(in oklab, var(--positive) 22%, transparent)"
        : "color-mix(in oklab, var(--negative) 22%, transparent)";

    // Cancel any in-flight flash so the newest direction wins instead
    // of stacking on top of a fading old one.
    for (const a of el.getAnimations()) {
      // Only cancel animations we own. We tag them with `id` below.
      if ((a as Animation & { id?: string }).id === "oz-odds-flash") {
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
    (anim as Animation & { id?: string }).id = "oz-odds-flash";
  }, [price, ref]);
}
