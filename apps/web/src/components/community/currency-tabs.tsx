import Link from "next/link";
// Runtime values must come from the /currencies subpath — Next.js webpack
// can't resolve the ".js" re-exports in the package root (see
// `apps/web/src/components/shell/bet-slip-rail.tsx` for the same workaround).
import { SUPPORTED_CURRENCIES, type Currency } from "@oddzilla/types/currencies";

// Per-currency stats toggle on /u/[nickname]. Driven by `?currency=`
// rather than client state so the server-rendered numbers stay
// authoritative (Decision D4 in docs/COMMUNITY_PLAN.md).

export function CurrencyTabs({
  nickname,
  active,
}: {
  nickname: string;
  active: Currency;
}) {
  return (
    <div
      role="tablist"
      aria-label="Currency"
      className="inline-flex rounded-[10px] border border-[var(--color-border-strong)] p-1"
    >
      {SUPPORTED_CURRENCIES.map((c) => {
        const isActive = c === active;
        return (
          <Link
            key={c}
            role="tab"
            aria-selected={isActive}
            href={`/u/${encodeURIComponent(nickname)}?currency=${c}`}
            className={
              "rounded-[8px] px-3 py-1.5 text-xs uppercase tracking-[0.15em] transition " +
              (isActive
                ? "bg-[var(--color-bg-elevated)] text-[var(--color-fg)]"
                : "text-[var(--color-fg-subtle)] hover:text-[var(--color-fg)]")
            }
          >
            {c}
          </Link>
        );
      })}
    </div>
  );
}
