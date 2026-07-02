"use client";

// Privacy policy link under the login / signup card — signup consent
// language should always sit one click away from the policy it
// references.

import Link from "next/link";
import { useTranslations } from "@/lib/i18n";

export function AuthFooterLink() {
  const t = useTranslations("shell");
  return (
    <div style={{ textAlign: "center", marginTop: 20 }}>
      <Link
        href="/privacy"
        style={{
          fontSize: 12,
          color: "var(--fg-dim)",
          textDecoration: "underline",
        }}
      >
        {t("privacyPolicy")}
      </Link>
    </div>
  );
}
