"use client";

import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "@/lib/i18n";

// Renders "Today · {Weekday}, {Mon} {D}" in the *browser's* local
// timezone, formatted in the user's chosen locale. Doing this
// server-side would emit UTC (the prod box runs in UTC) — users east
// of UTC would see yesterday's date during the evening hours. Initial
// SSR markup intentionally omits the date so hydration doesn't
// flicker; the label fills in on mount.
export function TodayLabel() {
  const locale = useLocale();
  const t = useTranslations("common");
  const [label, setLabel] = useState<string | null>(null);
  useEffect(() => {
    // Our locale slugs (en/cs/pt/ru/es) are valid BCP-47 primary
    // subtags so Intl resolves them directly to the right calendar.
    setLabel(
      new Date().toLocaleDateString(locale, {
        weekday: "long",
        month: "short",
        day: "numeric",
      }),
    );
  }, [locale]);
  return (
    <div
      className="mono"
      style={{
        fontSize: 11,
        letterSpacing: "0.14em",
        textTransform: "uppercase",
        color: "var(--fg-dim)",
      }}
    >
      {t("today")}
      {label ? ` · ${label}` : ""}
    </div>
  );
}
