"use client";

// useDocumentTheme — reactive view of the storefront's current theme.
//
// The theme is owned by ThemeToggle which mutates `<html data-theme>`
// directly (and persists to localStorage); it does NOT route through
// React state. To let other client components react to theme changes
// (e.g. the Oddin Disir iframe, which carries the theme in its URL),
// we observe the attribute on <html> and surface it as a hook value.
//
// SSR-safe: returns "dark" until the client hydrates, matching the
// dark-by-default boot script in app/layout.tsx.

import { useEffect, useState } from "react";

export type DocumentTheme = "dark" | "light";

function readTheme(): DocumentTheme {
  if (typeof document === "undefined") return "dark";
  const v = document.documentElement.getAttribute("data-theme");
  return v === "light" ? "light" : "dark";
}

export function useDocumentTheme(): DocumentTheme {
  const [theme, setTheme] = useState<DocumentTheme>("dark");

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
