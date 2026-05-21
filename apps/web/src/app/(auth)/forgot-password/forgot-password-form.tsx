"use client";

import { useState, type FormEvent } from "react";
import { clientApi, ApiFetchError } from "@/lib/api-client";
import { Button } from "@/components/ui/primitives";
import { useTranslations } from "@/lib/i18n";

export function ForgotPasswordForm() {
  const t = useTranslations("auth");
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await clientApi("/auth/forgot-password", {
        method: "POST",
        body: JSON.stringify({ email: email.trim() }),
      });
      setSubmitted(true);
    } catch (err) {
      if (err instanceof ApiFetchError && err.status === 429) {
        setError(t("errorRateLimited"));
      } else {
        setError(t("errorNetwork"));
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (submitted) {
    return (
      <p
        role="status"
        style={{
          marginTop: 28,
          padding: "14px 16px",
          background: "var(--surface-2)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          fontSize: 13.5,
          lineHeight: 1.5,
          color: "var(--fg)",
        }}
      >
        {t("forgotSent")}
      </p>
    );
  }

  return (
    <form
      onSubmit={onSubmit}
      noValidate
      style={{ marginTop: 28, display: "flex", flexDirection: "column", gap: 10 }}
    >
      <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <span
          className="mono"
          style={{
            fontSize: 10.5,
            letterSpacing: "0.1em",
            textTransform: "uppercase",
            color: "var(--fg-dim)",
            fontWeight: 600,
          }}
        >
          {t("email")}
        </span>
        <input
          type="email"
          name="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="oz-auth-input"
          style={{
            height: 44,
            padding: "0 14px",
            background: "var(--surface-2)",
            border: "1px solid var(--border)",
            borderRadius: 10,
            outline: "none",
            fontFamily: "inherit",
            fontSize: 14,
            color: "var(--fg)",
          }}
        />
      </label>
      {error && (
        <p
          role="alert"
          style={{
            fontSize: 12.5,
            color: "var(--negative)",
            marginTop: 4,
            lineHeight: 1.45,
          }}
        >
          {error}
        </p>
      )}
      <Button
        variant="primary"
        size="lg"
        type="submit"
        disabled={submitting}
        style={{ width: "100%", marginTop: 8 }}
      >
        {submitting ? t("submitting") : t("forgotCta")}
      </Button>
    </form>
  );
}
