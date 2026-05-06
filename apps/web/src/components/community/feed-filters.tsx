import Link from "next/link";
// Runtime imports must come from the /currencies subpath.
import {
  SUPPORTED_CURRENCIES,
  type Currency,
} from "@oddzilla/types/currencies";

// Filter pills for /community. Server-rendered as <Link> rows so the
// active filter is encoded in the URL. The same pattern handles state
// for back/forward, deep-linking, and SEO without a client component.

interface SportEntry {
  id: number;
  slug: string;
  name: string;
}

export function FeedFilters({
  sports,
  activeSportId,
  activeCurrency,
}: {
  sports: SportEntry[];
  activeSportId: number | null;
  activeCurrency: Currency | null;
}) {
  return (
    <div className="mt-6 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <CurrencyPill href={pillHref(null, activeSportId)} active={activeCurrency === null}>
          All currencies
        </CurrencyPill>
        {SUPPORTED_CURRENCIES.map((c) => (
          <CurrencyPill
            key={c}
            href={pillHref(c, activeSportId)}
            active={activeCurrency === c}
          >
            {c}
          </CurrencyPill>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <SportPill href={pillHref(activeCurrency, null)} active={activeSportId === null}>
          All sports
        </SportPill>
        {sports.map((s) => (
          <SportPill
            key={s.id}
            href={pillHref(activeCurrency, s.id)}
            active={activeSportId === s.id}
          >
            {s.name}
          </SportPill>
        ))}
      </div>
    </div>
  );
}

function pillHref(currency: Currency | null, sportId: number | null): string {
  const parts: string[] = [];
  if (currency) parts.push(`currency=${currency}`);
  if (sportId !== null) parts.push(`sport=${sportId}`);
  return parts.length === 0 ? "/community" : `/community?${parts.join("&")}`;
}

function CurrencyPill({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={
        "rounded-full border px-3 py-1 text-xs uppercase tracking-[0.15em] transition " +
        (active
          ? "border-[var(--color-accent)] bg-[var(--color-accent)]/15 text-[var(--color-accent)]"
          : "border-[var(--color-border-strong)] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]")
      }
    >
      {children}
    </Link>
  );
}

function SportPill(props: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  // Same visual as CurrencyPill but exported separately so future
  // styling tweaks for sport vs. currency can diverge without an extra
  // boolean prop.
  return <CurrencyPill {...props} />;
}
