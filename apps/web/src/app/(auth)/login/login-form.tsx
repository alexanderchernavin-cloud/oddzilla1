"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { clientApi, ApiFetchError } from "@/lib/api-client";
import { Button } from "@/components/ui/primitives";
import { useTranslations } from "@/lib/i18n";

export function LoginForm({ next }: { next: string }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const t = useTranslations("auth");

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await clientApi("/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: email.trim(), password }),
      });
      // Defence-in-depth open-redirect check at the client layer too.
      // The page already calls safeNextPath, but a future caller might
      // forget; "//evil.com/x" through router.push would navigate cross
      // origin and leak the just-set session cookie.
      const safe =
        next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\")
          ? next
          : "/";
      router.push(safe);
      router.refresh();
    } catch (err) {
      if (err instanceof ApiFetchError) {
        if (err.body.error === "invalid_credentials") {
          setError(t("errorInvalid"));
        } else if (err.body.error === "account_blocked") {
          setError(t("errorInvalid"));
        } else if (err.status === 429) {
          setError(t("errorRateLimited"));
        } else {
          setError(err.body.message || t("errorInvalid"));
        }
      } else {
        setError(t("errorNetwork"));
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      noValidate
      style={{ marginTop: 28, display: "flex", flexDirection: "column", gap: 10 }}
    >
      <Field
        label={t("email")}
        type="email"
        name="email"
        autoComplete="email"
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      <Field
        label={t("password")}
        type="password"
        name="password"
        autoComplete="current-password"
        required
        value={password}
        onChange={(e) => setPassword(e.target.value)}
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
        {submitting ? t("submitting") : t("loginCta")}
      </Button>
    </form>
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
