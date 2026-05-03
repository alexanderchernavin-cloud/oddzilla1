import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { getSessionClaims } from "@/lib/auth";
import { LogoutButton } from "@/components/logout-button";

// The middleware already checks for auth cookie presence before this runs.
// Here we verify the role.
//
// Two failure modes to distinguish:
//   - claims === null: the access cookie is present but jose couldn't verify
//     it (expired, signed with a rotated JWT_SECRET, malformed). Treat that
//     like "not signed in" and bounce to /login — otherwise admins see a
//     bare 404 with a stale cookie they can't clear without DevTools.
//   - claims.role !== "admin": real non-admin trying to peek. 404 (not 403)
//     so we don't leak that admin URLs exist.
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const claims = await getSessionClaims();
  if (!claims) redirect("/login?next=/admin");
  if (claims.role !== "admin") notFound();

  return (
    <div className="min-h-dvh">
      <header className="border-b border-[var(--color-border)]">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div>
            <p className="text-xs uppercase tracking-[0.18em] text-[var(--color-fg-subtle)]">
              Oddzilla
            </p>
            <p className="text-sm font-medium">Admin</p>
          </div>
          <nav className="flex items-center gap-4 text-sm text-[var(--color-fg-muted)]">
            <Link href="/admin" className="hover:text-[var(--color-fg)]">
              Dashboard
            </Link>
            <Link href="/admin/users" className="hover:text-[var(--color-fg)]">
              Bettors
            </Link>
            <Link href="/admin/admins" className="hover:text-[var(--color-fg)]">
              Admins
            </Link>
            <Link href="/admin/mapping" className="hover:text-[var(--color-fg)]">
              Mapping
            </Link>
            <Link href="/admin/margins" className="hover:text-[var(--color-fg)]">
              Margins
            </Link>
            <Link href="/admin/cashout" className="hover:text-[var(--color-fg)]">
              Cashout
            </Link>
            <Link href="/admin/bet-products" className="hover:text-[var(--color-fg)]">
              Products
            </Link>
            <Link href="/admin/withdrawals" className="hover:text-[var(--color-fg)]">
              Withdrawals
            </Link>
            <Link href="/admin/audit" className="hover:text-[var(--color-fg)]">
              Audit
            </Link>
            <Link href="/admin/feed" className="hover:text-[var(--color-fg)]">
              Feed
            </Link>
            <Link href="/admin/logs" className="hover:text-[var(--color-fg)]">
              Logs
            </Link>
            <Link href="/admin/fe-settings/markets-order" className="hover:text-[var(--color-fg)]">
              FE Settings
            </Link>
            <Link href="/account" className="hover:text-[var(--color-fg)]">
              Exit admin
            </Link>
            <LogoutButton />
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
    </div>
  );
}
