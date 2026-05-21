import Link from "next/link";
import { ComposeForm } from "./compose-form";

export const dynamic = "force-dynamic";

export default function NewEmailPage() {
  return (
    <div>
      <div className="flex items-start gap-3">
        <Link
          href="/admin/emails"
          className="mt-1 text-sm text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
        >
          ← Inbox
        </Link>
      </div>
      <h1 className="mt-3 text-2xl font-semibold tracking-tight">New email</h1>
      <p className="mt-1 max-w-2xl text-sm text-[var(--color-fg-muted)]">
        Starts a new thread. Goes out via Resend from{" "}
        <code>noreply@oddzilla.cc</code>; replies will route back into this
        inbox once SendGrid Inbound Parse is set up on the MX records.
      </p>
      <ComposeForm />
    </div>
  );
}
