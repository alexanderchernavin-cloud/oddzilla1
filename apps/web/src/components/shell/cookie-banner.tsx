"use client";

// Cookie banner, acceptance-only (operator decision 2026-07-02 for the
// UZ market): two buttons, both "Accept all", both accepting all.
// Labels match behaviour exactly — there is no reject control, offered
// or implied. Until the visitor clicks, the non-essential surfaces
// (third-party embeds + fe-analytics) stay off via the consent store.
//
// If a Reject / "Necessary only" button is ever brought back, it must
// genuinely disable the categories — see the guardrail note in
// lib/cookie-consent.ts.

import Link from "next/link";
import { useTranslations } from "@/lib/i18n";
import { acceptAll, useCookieConsent } from "@/lib/cookie-consent";

export function CookieBanner() {
  const t = useTranslations("cookieConsent");
  const { ready, consent } = useCookieConsent();

  const open = ready && consent === null;
  if (!open) return null;

  const acceptButton: React.CSSProperties = {
    padding: "9px 16px",
    fontSize: 13,
    fontWeight: 600,
    borderRadius: 8,
    cursor: "pointer",
    lineHeight: 1.2,
    background: "var(--accent)",
    color: "var(--accent-fg)",
    border: "1px solid var(--accent)",
  };

  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-label={t("title")}
      style={{
        position: "fixed",
        left: 16,
        right: 16,
        bottom: 16,
        zIndex: 9050,
        display: "flex",
        justifyContent: "center",
        pointerEvents: "none",
      }}
    >
      <div
        style={{
          pointerEvents: "auto",
          width: "100%",
          maxWidth: 680,
          background: "var(--bg-elevated)",
          border: "1px solid var(--border-strong)",
          borderRadius: 12,
          boxShadow: "0 12px 40px rgba(0, 0, 0, 0.18)",
          padding: "16px 18px",
          color: "var(--fg)",
        }}
      >
        <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 6 }}>
          {t("title")}
        </div>
        <div
          style={{
            fontSize: 12.5,
            color: "var(--fg-muted)",
            lineHeight: 1.5,
            marginBottom: 10,
          }}
        >
          {t("body")}{" "}
          <Link
            href="/privacy"
            style={{ color: "var(--fg)", textDecoration: "underline" }}
          >
            {t("learnMore")}
          </Link>
        </div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button type="button" onClick={acceptAll} style={acceptButton}>
            {t("acceptAll")}
          </button>
          <button type="button" onClick={acceptAll} style={acceptButton}>
            {t("acceptAll")}
          </button>
        </div>
      </div>
    </div>
  );
}
