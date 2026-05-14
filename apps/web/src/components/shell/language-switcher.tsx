"use client";

// Dropdown language picker. Two layouts:
//   - `variant="menu"`   compact row, used inside the user menu popover
//   - `variant="inline"` expanded list of pills, used in /account
//
// Locale persists in a cookie (set by the `setLocaleAction` server
// action). After the action returns we call `router.refresh()` so the
// SSR root layout re-runs with the new cookie value and the whole tree
// re-renders with the new dictionary — no client-side dictionary swap
// magic needed.

import { useRouter } from "next/navigation";
import { useTransition, type CSSProperties } from "react";
import { LOCALE_LABELS, LOCALES, useLocale, setLocaleAction, type Locale } from "@/lib/i18n";
import { I } from "@/components/ui/icons";

interface BaseProps {
  className?: string;
}

export function LanguageSwitcher({
  variant = "inline",
  className,
}: BaseProps & { variant?: "menu" | "inline" }) {
  const current = useLocale();
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function pick(next: Locale) {
    if (next === current) return;
    startTransition(async () => {
      const fd = new FormData();
      fd.set("locale", next);
      await setLocaleAction(fd);
      router.refresh();
    });
  }

  if (variant === "menu") {
    return (
      <div className={className} style={menuWrapper}>
        <div style={menuLabel}>
          <I.Globe size={14} />
          <span style={{ flex: 1 }}>{LOCALE_LABELS[current]}</span>
        </div>
        <div style={menuChips}>
          {LOCALES.map((loc) => (
            <button
              key={loc}
              type="button"
              onClick={() => pick(loc)}
              aria-pressed={loc === current}
              disabled={pending}
              style={menuChipStyle(loc === current)}
            >
              {loc.toUpperCase()}
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div
      className={className}
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 6,
      }}
    >
      {LOCALES.map((loc) => {
        const active = loc === current;
        return (
          <button
            key={loc}
            type="button"
            onClick={() => pick(loc)}
            aria-pressed={active}
            disabled={pending}
            style={inlineChipStyle(active, pending)}
          >
            {LOCALE_LABELS[loc]}
          </button>
        );
      })}
    </div>
  );
}

const menuWrapper: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
  padding: "8px 10px",
};

const menuLabel: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  fontSize: 11,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--fg-dim)",
  fontWeight: 600,
};

const menuChips: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 4,
};

function menuChipStyle(active: boolean): CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    minWidth: 32,
    height: 26,
    padding: "0 8px",
    fontSize: 10.5,
    fontWeight: 600,
    letterSpacing: "0.06em",
    background: active ? "var(--surface-2)" : "transparent",
    color: active ? "var(--fg)" : "var(--fg-muted)",
    border: `1px solid ${active ? "var(--border)" : "transparent"}`,
    borderRadius: 999,
    cursor: "pointer",
    font: "inherit",
  };
}

function inlineChipStyle(active: boolean, pending: boolean): CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    height: 34,
    padding: "0 14px",
    fontSize: 12.5,
    fontWeight: active ? 600 : 500,
    background: active ? "var(--surface-2)" : "var(--surface)",
    color: active ? "var(--fg)" : "var(--fg-muted)",
    border: `1px solid ${active ? "var(--fg)" : "var(--border)"}`,
    borderRadius: 999,
    cursor: pending ? "wait" : "pointer",
    font: "inherit",
    opacity: pending ? 0.6 : 1,
    transition:
      "background 140ms var(--ease), color 140ms var(--ease), border-color 140ms var(--ease)",
  };
}
