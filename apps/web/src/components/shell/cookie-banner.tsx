"use client";

// GDPR / ePrivacy cookie consent banner.
//
// Shown until the visitor makes a choice; re-openable from the footer
// "Cookie preferences" button and from /privacy so consent can be
// changed or withdrawn at any time (art. 7(3)).
//
// The choices are real: "Necessary only" (or unchecking the media
// category under Customize) stores embeds=false and the third-party
// stream players + Oddin widgets do not mount. Both first-layer
// buttons are one click and visually equal — rejecting must be as
// easy as accepting. Do not wire any option to silently behave like
// "Accept all"; a consent record that contradicts what the site does
// is invalid consent plus a deceptive-design finding.

import Link from "next/link";
import { useState } from "react";
import { useTranslations } from "@/lib/i18n";
import {
  useConsentReopenListener,
  useCookieConsent,
  writeConsent,
} from "@/lib/cookie-consent";

export function CookieBanner() {
  const t = useTranslations("cookieConsent");
  const { ready, consent } = useCookieConsent();
  const [reopened, setReopened] = useState(false);
  const [expanded, setExpanded] = useState(false);
  // Checkbox state for the Customize panel; seeded from the stored
  // choice when re-opening so the user edits what's in force.
  const [embedsChecked, setEmbedsChecked] = useState(consent?.embeds ?? false);
  const [analyticsChecked, setAnalyticsChecked] = useState(
    consent?.analytics ?? false,
  );

  useConsentReopenListener(() => {
    setEmbedsChecked(consent?.embeds ?? false);
    setAnalyticsChecked(consent?.analytics ?? false);
    setReopened(true);
  });

  const open = ready && (consent === null || reopened);
  if (!open) return null;

  function decide(choice: { embeds: boolean; analytics: boolean }) {
    writeConsent(choice);
    setReopened(false);
    setExpanded(false);
  }

  const buttonBase: React.CSSProperties = {
    padding: "9px 16px",
    fontSize: 13,
    fontWeight: 600,
    borderRadius: 8,
    cursor: "pointer",
    lineHeight: 1.2,
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

        {expanded && (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 10,
              padding: "12px 12px",
              marginBottom: 12,
              background: "var(--surface-2)",
              border: "1px solid var(--border)",
              borderRadius: 8,
            }}
          >
            <label
              style={{
                display: "flex",
                gap: 10,
                alignItems: "flex-start",
                fontSize: 12.5,
              }}
            >
              <input
                type="checkbox"
                checked
                disabled
                style={{ marginTop: 2 }}
                aria-label={t("catNecessaryTitle")}
              />
              <span>
                <span style={{ fontWeight: 600 }}>{t("catNecessaryTitle")}</span>
                <br />
                <span style={{ color: "var(--fg-muted)" }}>
                  {t("catNecessaryBody")}
                </span>
              </span>
            </label>
            <label
              style={{
                display: "flex",
                gap: 10,
                alignItems: "flex-start",
                fontSize: 12.5,
                cursor: "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={embedsChecked}
                onChange={(e) => setEmbedsChecked(e.target.checked)}
                style={{ marginTop: 2 }}
                aria-label={t("catEmbedsTitle")}
              />
              <span>
                <span style={{ fontWeight: 600 }}>{t("catEmbedsTitle")}</span>
                <br />
                <span style={{ color: "var(--fg-muted)" }}>
                  {t("catEmbedsBody")}
                </span>
              </span>
            </label>
            <label
              style={{
                display: "flex",
                gap: 10,
                alignItems: "flex-start",
                fontSize: 12.5,
                cursor: "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={analyticsChecked}
                onChange={(e) => setAnalyticsChecked(e.target.checked)}
                style={{ marginTop: 2 }}
                aria-label={t("catAnalyticsTitle")}
              />
              <span>
                <span style={{ fontWeight: 600 }}>{t("catAnalyticsTitle")}</span>
                <br />
                <span style={{ color: "var(--fg-muted)" }}>
                  {t("catAnalyticsBody")}
                </span>
              </span>
            </label>
          </div>
        )}

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={() => decide({ embeds: true, analytics: true })}
            style={{
              ...buttonBase,
              background: "var(--accent)",
              color: "var(--accent-fg)",
              border: "1px solid var(--accent)",
            }}
          >
            {t("acceptAll")}
          </button>
          <button
            type="button"
            onClick={() => decide({ embeds: false, analytics: false })}
            style={{
              ...buttonBase,
              background: "var(--accent)",
              color: "var(--accent-fg)",
              border: "1px solid var(--accent)",
            }}
          >
            {t("necessaryOnly")}
          </button>
          {expanded ? (
            <button
              type="button"
              onClick={() =>
                decide({ embeds: embedsChecked, analytics: analyticsChecked })
              }
              style={{
                ...buttonBase,
                background: "transparent",
                color: "var(--fg)",
                border: "1px solid var(--border-strong)",
              }}
            >
              {t("saveChoices")}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              style={{
                ...buttonBase,
                background: "transparent",
                color: "var(--fg)",
                border: "1px solid var(--border-strong)",
              }}
            >
              {t("customize")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
