"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { ApiFetchError, clientApi } from "@/lib/api-client";

export function ComposeForm() {
  const router = useRouter();
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSending(true);
    setError(null);
    try {
      const result = await clientApi<{ threadId: string }>(
        "/admin/emails/compose",
        {
          method: "POST",
          body: JSON.stringify({
            to: to.trim(),
            subject: subject.trim(),
            textBody: body,
          }),
        },
      );
      router.push(`/admin/emails/${result.threadId}`);
    } catch (err) {
      if (err instanceof ApiFetchError) {
        setError(err.body.message || err.body.error || "send_failed");
      } else {
        setError("Network error.");
      }
      setSending(false);
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      className="mt-6 max-w-3xl space-y-4 rounded-[14px] border border-[var(--color-border)] bg-[var(--color-bg-card)] p-5"
    >
      <Field label="To">
        <input
          type="email"
          required
          value={to}
          onChange={(e) => setTo(e.target.value)}
          placeholder="user@example.com"
          className="h-9 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 text-sm outline-none focus:border-[var(--color-fg)]"
        />
      </Field>
      <Field label="Subject">
        <input
          type="text"
          required
          maxLength={998}
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          className="h-9 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 text-sm outline-none focus:border-[var(--color-fg)]"
        />
      </Field>
      <Field label="Message">
        <textarea
          required
          rows={12}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Plain text. Paragraph breaks → blank line."
          className="w-full resize-y rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-sm outline-none focus:border-[var(--color-fg)]"
        />
      </Field>
      {error && (
        <p role="alert" className="text-xs text-[var(--color-danger)]">
          {error}
        </p>
      )}
      <div className="flex items-center justify-end gap-2">
        <button
          type="submit"
          disabled={sending || !to || !subject || !body}
          className="rounded-md bg-[var(--color-fg)] px-4 py-1.5 text-sm font-medium text-[var(--color-bg)] disabled:opacity-50"
        >
          {sending ? "Sending…" : "Send"}
        </button>
      </div>
    </form>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs uppercase tracking-wider text-[var(--color-fg-subtle)]">
        {label}
      </span>
      {children}
    </label>
  );
}
