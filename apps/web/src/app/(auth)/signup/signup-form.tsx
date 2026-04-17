"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { clientApi, ApiFetchError } from "@/lib/api-client";

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
    try {
      await clientApi("/auth/signup", {
        method: "POST",
        body: JSON.stringify({
          email: email.trim(),
          password,
          displayName: displayName.trim() || undefined,
        }),
      });
      router.push("/account");
      router.refresh();
    } catch (err) {
      if (err instanceof ApiFetchError) {
        setError(
          err.body.error === "email_in_use"
            ? "An account with this email already exists."
            : err.body.error === "validation_error"
              ? err.body.issues?.[0]?.message ?? "Check your inputs."
              : err.body.message,
        );
      } else {
        setError("Could not reach the server. Try again.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="mt-8 space-y-4" onSubmit={onSubmit} noValidate>
      <label className="block">
        <span className="text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
          Email
        </span>
        <input
          type="email"
          name="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="mt-2 w-full rounded-[10px] border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-2 outline-none focus:border-[var(--color-accent)]"
        />
      </label>
      <label className="block">
        <span className="text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
          Display name (optional)
        </span>
        <input
          type="text"
          name="displayName"
          autoComplete="nickname"
          maxLength={64}
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          className="mt-2 w-full rounded-[10px] border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-2 outline-none focus:border-[var(--color-accent)]"
        />
      </label>
      <label className="block">
        <span className="text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
          Password
        </span>
        <input
          type="password"
          name="password"
          autoComplete="new-password"
          required
          minLength={8}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mt-2 w-full rounded-[10px] border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-2 outline-none focus:border-[var(--color-accent)]"
        />
      </label>

      {error ? (
        <p
          role="alert"
          className="rounded-[10px] border border-[color:var(--color-negative)]/30 bg-[color:var(--color-negative)]/10 px-3 py-2 text-sm text-[var(--color-negative)]"
        >
          {error}
        </p>
      ) : null}

      <button type="submit" disabled={submitting} className="btn btn-primary w-full">
        {submitting ? "Creating account…" : "Create account"}
      </button>
    </form>
  );
}
