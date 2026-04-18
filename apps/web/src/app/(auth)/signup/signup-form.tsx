"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { clientApi, ApiFetchError } from "@/lib/api-client";
import { Button } from "@/components/ui/primitives";

export function SignupForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);

    // Local validation first so the user sees a clear message before any
    // network round trip. The API re-validates, but showing the same rule
    // immediately is friendlier than round-tripping to a zod error.
    const trimmedEmail = email.trim();
    if (!trimmedEmail.includes("@")) {
      setError("Enter a valid email address.");
      setSubmitting(false);
      return;
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      setSubmitting(false);
      return;
    }

    try {
      await clientApi("/auth/signup", {
        method: "POST",
        body: JSON.stringify({
          email: trimmedEmail,
          password,
          displayName: displayName.trim() || undefined,
        }),
      });
      router.push("/account");
      router.refresh();
    } catch (err) {
      if (err instanceof ApiFetchError) {
        if (err.body.error === "email_in_use") {
          setError("An account with this email already exists. Try logging in.");
        } else if (err.body.error === "validation_error") {
          const first = err.body.issues?.[0];
          setError(
            first
              ? `${first.path}: ${first.message}`
              : "Check your inputs and try again.",
          );
        } else if (err.status === 429) {
          setError("Too many attempts. Wait a minute and try again.");
        } else {
          setError(err.body.message || "Signup failed.");
        }
      } else {
        setError("Could not reach the server. Check your connection.");
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
        label="Display name"
        type="text"
        name="displayName"
        autoComplete="nickname"
        maxLength={64}
        value={displayName}
        onChange={(e) => setDisplayName(e.target.value)}
      />
      <Field
        label="Email"
        type="email"
        name="email"
        autoComplete="email"
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      <Field
        label="Password (min 8 characters)"
        type="password"
        name="password"
        autoComplete="new-password"
        required
        minLength={8}
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
        {submitting ? "Creating account…" : "Create account"}
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
        style={{
          height: 42,
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
