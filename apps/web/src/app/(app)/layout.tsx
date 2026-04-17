import { redirect } from "next/navigation";
import Link from "next/link";
import { getSessionUser } from "@/lib/auth";
import { LogoutButton } from "@/components/logout-button";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();
  // middleware already blocks unauthenticated access; this catches edge
  // cases where the cookie exists but the session was revoked server-side.
  if (!user) redirect("/login");

  return (
    <div className="min-h-dvh">
      <header className="border-b border-[var(--color-border)]">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <Link href="/" className="block">
            <p className="text-xs uppercase tracking-[0.18em] text-[var(--color-fg-subtle)]">
              Oddzilla
            </p>
            <p className="text-sm font-medium">{user.displayName ?? user.email}</p>
          </Link>
          <nav className="flex items-center gap-4 text-sm text-[var(--color-fg-muted)]">
            <Link href="/account" className="hover:text-[var(--color-fg)]">
              Account
            </Link>
            <Link href="/wallet" className="hover:text-[var(--color-fg)]">
              Wallet
            </Link>
            <Link href="/bets" className="hover:text-[var(--color-fg)]">
              Bets
            </Link>
            {user.role === "admin" ? (
              <Link href="/admin" className="hover:text-[var(--color-fg)]">
                Admin
              </Link>
            ) : null}
            <LogoutButton />
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
    </div>
  );
}
