import Link from "next/link";

// FE Settings groups storefront-display knobs that don't carry money math
// (which lives under /admin/margins, /admin/cashout, /admin/bet-products).
// Sub-sections are listed in a left-side nav so future panels (sidebar
// pinning, hero placement, etc.) can be added without re-shuffling the
// top-level admin nav.
const sections: { href: string; label: string }[] = [
  { href: "/admin/fe-settings/markets-order", label: "Markets display order" },
];

export default function FeSettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">FE Settings</h1>
      <p className="mt-2 text-sm text-[var(--color-fg-muted)]">
        Storefront-display configuration. Changes take effect on the next
        page load — no service restart required.
      </p>
      <div className="mt-8 grid gap-8 lg:grid-cols-[200px_1fr]">
        <nav className="flex flex-col gap-1 text-sm">
          {sections.map((s) => (
            <Link
              key={s.href}
              href={s.href}
              className="rounded-md px-3 py-2 text-[var(--color-fg-muted)] hover:bg-[var(--color-bg-elevated)] hover:text-[var(--color-fg)]"
            >
              {s.label}
            </Link>
          ))}
        </nav>
        <div>{children}</div>
      </div>
    </div>
  );
}
