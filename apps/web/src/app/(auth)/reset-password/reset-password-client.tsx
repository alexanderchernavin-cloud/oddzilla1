"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { clientApi, ApiFetchError } from "@/lib/api-client";
import { Button } from "@/components/ui/primitives";
import { useTranslations } from "@/lib/i18n";

export function ResetPasswordClient({ token }: { token: string | null }) {
  const t = useTranslations("auth");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!token) {
    return (
      <>
        <h1 className="display" style={{ margin: "0 0 6px", fontSize: 28, fontWeight: 500 }}>
          {t("resetTitle")}
        </h1>
        <p style={{ margin: 0, color: "var(--fg-muted)", fontSize: 13.5, lineHeight: 1.5 }}>
          {t("verifyMissingToken")}
        </p>
        <Link href="/forgot-password" style={{ display: "inline-block", marginTop: 24 }}>
          <Button variant="primary" size="lg">{t("forgotCta")}</Button>
        </Link>
      </>
    );
  }

  if (done) {
    return (
      <>
        <h1 className="display" style={{ margin: "0 0 6px", fontSize: 28, fontWeight: 500 }}>
          {t("resetSuccess")}
        </h1>
        <p style={{ margin: 0, color: "var(--fg-muted)", fontSize: 13.5, lineHeight: 1.5 }}>
          {t("resetSuccessBody")}
        </p>
        <Link href="/login" style={{ display: "inline-block", width: "100%", marginTop: 28 }}>
          <Button variant="primary" size="lg" style={{ width: "100%" }}>
            {t("loginCta")}
          </Button>
        </Link>
      </>
    );
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError(t("errorWeakPassword"));
      return;
    }
    if (password !== confirm) {
      setError(t("resetMismatch"));
      return;
    }
    setSubmitting(true);
    try {
      await clientApi("/auth/reset-password", {
        method: "POST",
        body: JSON.stringify({ token, newPassword: password }),
      });
      setDone(true);
    } catch (err) {
      if (err instanceof ApiFetchError) {
        if (err.body.error === "token_expired") setError(t("resetExpired"));
        else if (
          err.body.error === "invalid_token" ||
          err.body.error === "token_already_used"
        )
          setError(t("resetInvalid"));
        else if (err.status === 429) setError(t("errorRateLimited"));
        else setError(err.body.message || t("errorNetwork"));
      } else {
        setError(t("errorNetwork"));
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <h1
        className="display"
        style={{
          margin: "0 0 6px",
          fontSize: 28,
          fontWeight: 500,
          letterSpacing: "-0.02em",
        }}
      >
        {t("resetTitle")}
      </h1>
      <p style={{ margin: 0, color: "var(--fg-muted)", fontSize: 13.5, lineHeight: 1.5 }}>
        {t("resetSubtitle")}
      </p>

      <form
        onSubmit={onSubmit}
        noValidate
        style={{ marginTop: 28, display: "flex", flexDirection: "column", gap: 10 }}
      >
        <Field
          label={t("newPassword")}
          type="password"
          autoComplete="new-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <Field
          label={t("confirmPassword")}
          type="password"
          autoComplete="new-password"
          required
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
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
          {submitting ? t("submitting") : t("resetCta")}
        </Button>
      </form>
    </>
  );
}

function Field({
  label,
  ...rest
}: React.InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  return (
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
        {label}
      </span>
      <input
        {...rest}
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
  );
}
