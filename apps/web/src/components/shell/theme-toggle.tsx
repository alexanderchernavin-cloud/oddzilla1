"use client";

import { useEffect, useState } from "react";
import { I } from "@/components/ui/icons";

// Storage key must match the inline pre-hydration script in
// `apps/web/src/app/layout.tsx`.
const STORAGE_KEY = "oz:theme";

export function ThemeToggle() {
  const [theme, setTheme] = useState<"dark" | "light">("light");

  useEffect(() => {
    // The pre-hydration script in the root layout has already set
    // <html data-theme>. Trust localStorage as the source of truth and
    // re-apply it here as a safety net — if anything else stripped the
    // attribute (extension, hydration corner case), this restores it.
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(STORAGE_KEY);
    } catch {
      // storage disabled — fall through to attribute / default
    }
    const fromAttr = document.documentElement.getAttribute("data-theme");
    const initial = stored === "light" || stored === "dark"
      ? stored
      : fromAttr === "dark"
        ? "dark"
        : "light";
    setTheme(initial);
    if (fromAttr !== initial) {
      document.documentElement.setAttribute("data-theme", initial);
    }
  }, []);

  function toggle() {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // quota/disabled — ignore
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
      aria-label="Toggle theme"
      style={{
        width: 36,
        height: 36,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        background: "transparent",
        border: 0,
        borderRadius: 999,
        cursor: "pointer",
        color: "var(--fg-muted)",
        position: "relative",
      }}
    >
      {theme === "dark" ? <I.Sun size={16} /> : <I.Moon size={16} />}
    </button>
  );
}
