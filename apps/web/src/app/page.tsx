import Link from "next/link";
import { getSessionClaims } from "@/lib/auth";

const sports = [
  { slug: "cs2", name: "Counter-Strike 2" },
  { slug: "dota2", name: "Dota 2" },
  { slug: "lol", name: "League of Legends" },
  { slug: "valorant", name: "Valorant" },
];

export default async function HomePage() {
  const claims = await getSessionClaims();
  const signedIn = Boolean(claims);

  return (
    <main className="mx-auto max-w-6xl px-6 py-16">
      <header className="flex items-center justify-between border-b border-[var(--color-border)] pb-6">
        <div>
          <p className="text-xs uppercase tracking-[0.18em] text-[var(--color-fg-subtle)]">
            Oddzilla
          </p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">Esports sportsbook</h1>
        </div>
        <nav className="flex items-center gap-3 text-sm">
          {signedIn ? (
            <>
              <Link href="/account" className="btn btn-ghost">
                Account
              </Link>
              {claims?.role === "admin" ? (
                <Link href="/admin" className="btn btn-primary">
                  Admin
                </Link>
              ) : (
                <Link href="/wallet" className="btn btn-primary">
                  Wallet
                </Link>
              )}
            </>
          ) : (
            <>
              <Link href="/login" className="btn btn-ghost">
                Log in
              </Link>
              <Link href="/signup" className="btn btn-primary">
                Sign up
              </Link>
            </>
          )}
        </nav>
      </header>

      <section className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {sports.map((s) => (
          <Link
            key={s.slug}
            href={`/sport/${s.slug}`}
            className="card p-6 transition-colors hover:border-[var(--color-border-strong)]"
          >
            <p className="text-xs uppercase tracking-[0.18em] text-[var(--color-fg-subtle)]">
              {s.slug}
            </p>
            <p className="mt-2 text-lg font-medium">{s.name}</p>
            <p className="mt-4 text-sm text-[var(--color-fg-muted)]">
              Match winner and map winner markets.
            </p>
          </Link>
        ))}
      </section>

      <footer className="mt-20 text-xs text-[var(--color-fg-subtle)]">
        <p>Oddzilla MVP.</p>
      </footer>
    </main>
  );
}
