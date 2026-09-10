"use client";

import { useEffect, useRef } from "react";

/**
 * Run `fn` every `ms` while mounted; `null` pauses. The callback is read
 * through a ref so the interval survives re-renders without restarting
 * (restarting on every render is how a 10 s poll turns into one on every
 * keystroke of a filter box).
 */
export function useInterval(fn: () => void, ms: number | null): void {
  const ref = useRef(fn);
  useEffect(() => {
    ref.current = fn;
  });
  useEffect(() => {
    if (ms === null) return;
    const id = setInterval(() => ref.current(), ms);
    return () => clearInterval(id);
  }, [ms]);
}
