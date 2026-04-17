"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { clientApi } from "@/lib/api-client";

export function LogoutButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function onClick() {
    setPending(true);
    try {
      await clientApi("/auth/logout", { method: "POST" });
    } catch {
      // Even if the server call fails, the client-side redirect is safe —
      // the cookies are scoped httpOnly so we can't clear them from JS, but
      // the next request will be unauthenticated and redirect to /login.
    }
    router.push("/login");
    router.refresh();
    setPending(false);
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending}
      className="rounded-[8px] border border-[var(--color-border-strong)] px-3 py-1.5 text-xs uppercase tracking-[0.15em] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] disabled:opacity-50"
    >
      {pending ? "…" : "Log out"}
    </button>
  );
}
