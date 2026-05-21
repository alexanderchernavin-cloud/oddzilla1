"use client";

// Renders a dismissible banner at the top of the main content area
// when the signed-in bettor hasn't confirmed their email. Two paths
// off the banner:
//   • "Send another" → POST /auth/resend-verification (rate-limited
//     to 3/min server-side; the button disables for 30 s after a
//     send so a double-click can't burn quota).
//   • The user opens the email and clicks the verify link, which
//     lands them on /verify-email — that page updates session state
//     and the banner disappears on next render.
//
// Dismissal is in-tab only (sessionStorage). We don't persist a
// permanent dismissal because verification is a real obligation —
// hiding it forever would defeat the point. Re-renders after a hard
// reload show it again; the user is expected to verify, not bury
// the prompt.

import { useEffect, useState } from "react";
import { clientApi, ApiFetchError } from "@/lib/api-client";
import { useTranslations } from "@/lib/i18n";

const DISMISS_KEY = "oz:email-verify-dismissed";
const RESEND_COOLDOWN_MS = 30_000;

interface Props {
  email: string;
}

export function EmailVerificationBanner({ email }: Props) {
  const t = useTranslations("auth");
  const [hidden, setHidden] = useState(true); // hydrate hidden, reveal after mount
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState<"idle" | "sent" | "error">("idle");

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const dismissed = window.sessionStorage.getItem(DISMISS_KEY) === "1";
      setHidden(dismissed);
    } catch {
      // sessionStorage may throw in restrictive contexts — fall back to visible.
      setHidden(false);
    }
  }, []);

  function dismiss() {
    setHidden(true);
    try {
      window.sessionStorage.setItem(DISMISS_KEY, "1");
    } catch {
      // ignore
    }
  }

  async function resend() {
    if (sending) return;
    setSending(true);
    setStatus("idle");
    try {
      await clientApi<{ ok: boolean; enqueued: boolean }>(
        "/auth/resend-verification",
        { method: "POST" },
      );
      setStatus("sent");
      window.setTimeout(() => setSending(false), RESEND_COOLDOWN_MS);
    } catch (err) {
      if (err instanceof ApiFetchError && err.status === 429) {
        setStatus("error");
      } else {
        setStatus("error");
      }
      setSending(false);
    }
  }

  if (hidden) return null;

  return (
    <div
      role="status"
      style={{
        margin: "0 0 16px",
        padding: "12px 16px",
        background: "var(--surface-2, #f4f2ec)",
        border: "1px solid var(--border, #e4e1d8)",
        borderRadius: 8,
        display: "flex",
        alignItems: "center",
        gap: 16,
        flexWrap: "wrap",
      }}
    >
      <div style={{ flex: 1, minWidth: 240 }}>
        <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 2 }}>
          {t("verifyBannerTitle")}
        </div>
        <div style={{ fontSize: 12.5, color: "var(--fg-muted, #5a5a5a)", lineHeight: 1.45 }}>
          {t("verifyBannerBody", { email })}
        </div>
        {status === "sent" && (
          <div style={{ fontSize: 12, marginTop: 4, color: "var(--positive, #2d7a3d)" }}>
            {t("verifyBannerSent")}
          </div>
        )}
        {status === "error" && (
          <div style={{ fontSize: 12, marginTop: 4, color: "var(--negative, #a13838)" }}>
            {t("verifyBannerError")}
          </div>
        )}
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button
          type="button"
          onClick={resend}
          disabled={sending}
          style={{
            padding: "7px 14px",
            fontSize: 12,
            fontWeight: 600,
            background: "var(--fg, #1a1a1a)",
            color: "var(--bg, #f4f2ec)",
            border: 0,
            borderRadius: 6,
            cursor: sending ? "default" : "pointer",
            opacity: sending ? 0.6 : 1,
          }}
        >
          {sending ? t("verifyBannerSending") : t("verifyBannerResend")}
        </button>
        <button
          type="button"
          onClick={dismiss}
          aria-label={t("verifyBannerDismiss")}
          style={{
            padding: "7px 10px",
            fontSize: 12,
            background: "transparent",
            color: "var(--fg-muted, #5a5a5a)",
            border: "1px solid var(--border, #e4e1d8)",
            borderRadius: 6,
            cursor: "pointer",
          }}
        >
          {t("verifyBannerDismiss")}
        </button>
      </div>
    </div>
  );
}
