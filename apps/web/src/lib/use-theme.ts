"use client";

// useDocumentTheme — reactive view of the storefront's current theme.
//
// The theme is owned by ThemeToggle which mutates `<html data-theme>`
// directly (and persists to localStorage); it does NOT route through
// React state. To let other client components react to theme changes
// (e.g. the Oddin Disir iframe, which carries the theme in its URL),
// we observe the attribute on <html> and surface it as a hook value.
//
// Polarity matches the CSS in globals.css and ThemeToggle's own
// logic: the *light* theme is the default — the only signal for dark
// is an explicit `data-theme="dark"` on <html>. A missing or
// "light"-valued attribute both mean light. SSR returns "light" so
// the first paint and the post-hydration value agree for the common
// (untoggled) case.

import { useEffect, useState } from "react";

export type DocumentTheme = "dark" | "light";

function readTheme(): DocumentTheme {
  if (typeof document === "undefined") return "light";
  const v = document.documentElement.getAttribute("data-theme");
  return v === "dark" ? "dark" : "light";
}

export function useDocumentTheme(): DocumentTheme {
  const [theme, setTheme] = useState<DocumentTheme>("light");

  useEffect(() => {
    setTheme(readTheme());
    if (typeof document === "undefined") return;
    const observer = new MutationObserver(() => {
      setTheme(readTheme());
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);

  return theme;
}
