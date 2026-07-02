"use client";

// Slim storefront footer at the bottom of the main content column.
// Carries the responsible-gambling notice and the Privacy & Cookies
// Policy link.

import Link from "next/link";
import { useTranslations } from "@/lib/i18n";

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
      </div>
    </footer>
  );
}
