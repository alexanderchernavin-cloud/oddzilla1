"use client";

// Inline "manage cookie preferences" button — re-opens the consent
// banner. Used on /privacy; the shell footer has its own copy.

import { useTranslations } from "@/lib/i18n";
import { requestConsentReopen } from "@/lib/cookie-consent";

export function CookiePreferencesButton() {
  const t = useTranslations("shell");
  return (
    <button
      type="button"
      onClick={requestConsentReopen}
      style={{
        padding: "8px 14px",
        fontSize: 13,
        fontWeight: 600,
        background: "var(--accent)",
        color: "var(--accent-fg)",
        border: "1px solid var(--accent)",
        borderRadius: 8,
        cursor: "pointer",
      }}
    >
      {t("cookiePreferences")}
    </button>
  );
}
