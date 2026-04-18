"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { clientApi, ApiFetchError } from "@/lib/api-client";

export function AccountForms({
  initialDisplayName,
  initialCountryCode,
}: {
  initialDisplayName: string;
  initialCountryCode: string;
}) {
  return (
    <div className="mt-8 grid gap-6 md:grid-cols-2">
      <ProfileForm
        initialDisplayName={initialDisplayName}
        initialCountryCode={initialCountryCode}
      />
      <PasswordForm />
    </div>
  );
}

function ProfileForm({
  initialDisplayName,
  initialCountryCode,
}: {
  initialDisplayName: string;
  initialCountryCode: string;
}) {
  const router = useRouter();
  const [displayName, setDisplayName] = useState(initialDisplayName);
  const [countryCode, setCountryCode] = useState(initialCountryCode);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSubmitting(true);
    setMessage(null);
    try {
      await clientApi("/users/me", {
        method: "PATCH",
        body: JSON.stringify({
          displayName: displayName.trim() || null,
          countryCode: countryCode.trim().toUpperCase() || null,
        }),
      });
      setMessage({ kind: "ok", text: "Saved." });
      router.refresh();
    } catch (err) {
      setMessage({
        kind: "err",
        text: err instanceof ApiFetchError ? err.body.message : "Save failed.",
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="card space-y-4 p-6">
      <h2 className="text-sm uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
        Profile
      </h2>

      <label className="block">
        <span className="text-xs text-[var(--color-fg-subtle)]">Display name</span>
        <input
          type="text"
          maxLength={64}
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          className="mt-1 w-full rounded-[10px] border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-2 outline-none focus:border-[var(--color-accent)]"
        />
      </label>

      <label className="block">
        <span className="text-xs text-[var(--color-fg-subtle)]">Country (ISO-2)</span>
        <input
          type="text"
          maxLength={2}
          value={countryCode}
          onChange={(e) => setCountryCode(e.target.value)}
          className="mt-1 w-24 rounded-[10px] border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-2 uppercase outline-none focus:border-[var(--color-accent)]"
        />
      </label>

      {message ? (
        <p
          role="status"
          className={
            "text-sm " +
            (message.kind === "ok"
              ? "text-[var(--color-positive)]"
              : "text-[var(--color-negative)]")
          }
        >
          {message.text}
        </p>
      ) : null}

      <button type="submit" disabled={submitting} className="btn btn-primary">
        {submitting ? "Saving…" : "Save profile"}
      </button>
    </form>
  );
}

function PasswordForm() {
  const router = useRouter();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSubmitting(true);
    setMessage(null);
    try {
      await clientApi("/users/me/password", {
        method: "POST",
        body: JSON.stringify({
          currentPassword: current,
          newPassword: next,
        }),
      });
      // Password change revokes all sessions — the user has to log in again.
      router.push("/login");
      router.refresh();
    } catch (err) {
      setMessage({
        kind: "err",
        text:
          err instanceof ApiFetchError
            ? err.body.error === "invalid_current_password"
              ? "Current password is wrong."
              : err.body.message
            : "Change failed.",
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="card space-y-4 p-6">
      <h2 className="text-sm uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
        Change password
      </h2>
      <p className="text-xs text-[var(--color-fg-subtle)]">
        You will be signed out of every device after saving.
      </p>

      <label className="block">
        <span className="text-xs text-[var(--color-fg-subtle)]">Current password</span>
        <input
          type="password"
          autoComplete="current-password"
          required
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          className="mt-1 w-full rounded-[10px] border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-2 outline-none focus:border-[var(--color-accent)]"
        />
      </label>
      <label className="block">
        <span className="text-xs text-[var(--color-fg-subtle)]">New password</span>
        <input
          type="password"
          autoComplete="new-password"
          minLength={8}
          required
          value={next}
          onChange={(e) => setNext(e.target.value)}
          className="mt-1 w-full rounded-[10px] border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-2 outline-none focus:border-[var(--color-accent)]"
        />
      </label>

      {message ? (
        <p role="alert" className="text-sm text-[var(--color-negative)]">
          {message.text}
        </p>
      ) : null}

      <button type="submit" disabled={submitting} className="btn btn-ghost">
        {submitting ? "Changing…" : "Change password"}
      </button>
    </form>
  );
}
