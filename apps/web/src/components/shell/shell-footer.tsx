"use client";

// Slim storefront footer at the bottom of the main content column.
// Carries the compliance links: Privacy & Cookies Policy plus a
// "Cookie preferences" button that re-opens the consent banner so a
// visitor can change or withdraw consent at any time (GDPR art. 7(3)
// — withdrawing must be as easy as giving).

import Link from "next/link";
import { useTranslations } from "@/lib/i18n";
import { requestConsentReopen } from "@/lib/cookie-consent";

export function ShellFooter() {
  const t = useTranslations("shell");
  return (
    <footer
      style={{
        marginTop: 40,
        padding: "16px 0 24px",
        borderTop: "1px solid var(--border)",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 16,
        flexWrap: "wrap",
        fontSize: 12,
        color: "var(--fg-dim)",
      }}
    >
      <div style={{ lineHeight: 1.5 }}>
        {t("responsibleGambling")} {t("ageNotice")}
      </div>
      <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
        <Link
          href="/privacy"
          style={{ color: "var(--fg-muted)", textDecoration: "underline" }}
        >
          {t("privacyPolicy")}
        </Link>
        <button
          type="button"
          onClick={requestConsentReopen}
          style={{
            background: "transparent",
            border: 0,
            padding: 0,
            font: "inherit",
            color: "var(--fg-muted)",
            textDecoration: "underline",
            cursor: "pointer",
          }}
        >
          {t("cookiePreferences")}
        </button>
      </div>
    </footer>
  );
}
