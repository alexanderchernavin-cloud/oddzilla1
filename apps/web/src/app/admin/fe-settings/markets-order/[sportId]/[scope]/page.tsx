import Link from "next/link";
import { notFound } from "next/navigation";
import { serverApi } from "@/lib/server-fetch";
import {
  MarketOrderEditor,
  type MarketEntry,
} from "./market-order-editor";

const SCOPES = ["match", "map", "top"] as const;
type Scope = (typeof SCOPES)[number];

interface DetailResponse {
  sport: { id: number; slug: string; name: string };
  scope: Scope;
  ordered: Array<MarketEntry & { displayOrder: number }>;
  unranked: MarketEntry[];
}

const SCOPE_LABELS: Record<Scope, string> = {
  match: "Match",
  map: "Map",
  top: "Top",
};

const SCOPE_HINTS: Record<Scope, string> = {
  match:
    "Order the markets that appear on the Match tab — i.e. those without a `map` specifier.",
  map:
    "One ordering shared across every Map N tab on the match page. Pool is markets that carry a `map` specifier.",
  top:
    "Curated highlights tab. Empty by default; markets you add render on the storefront's Top tab and inline on match cards.",
};

function isScope(s: string): s is Scope {
  return (SCOPES as readonly string[]).includes(s);
}

export default async function ScopeEditorPage({
  params,
}: {
  params: Promise<{ sportId: string; scope: string }>;
}) {
  const { sportId, scope } = await params;
  if (!isScope(scope)) notFound();

  const data = await serverApi<DetailResponse>(
    `/admin/fe-settings/markets-order/${sportId}/${scope}`,
  );
  if (!data) notFound();

  return (
    <div>
      <Link
        href="/admin/fe-settings/markets-order"
        className="text-xs uppercase tracking-[0.15em] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
      >
        ← All sports
      </Link>
      <h2 className="mt-3 text-lg font-medium">{data.sport.name}</h2>
      <p className="mt-1 font-mono text-xs text-[var(--color-fg-muted)]">
        {data.sport.slug}
      </p>

      <nav className="mt-6 inline-flex rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-1 text-xs">
        {SCOPES.map((s) => {
          const active = s === data.scope;
          return (
            <Link
              key={s}
              href={`/admin/fe-settings/markets-order/${sportId}/${s}`}
              className={
                "rounded px-3 py-1.5 uppercase tracking-[0.15em] " +
                (active
                  ? "bg-[var(--color-fg)] text-[var(--color-bg)]"
                  : "text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]")
              }
            >
              {SCOPE_LABELS[s]}
            </Link>
          );
        })}
      </nav>

      <p className="mt-3 text-sm text-[var(--color-fg-muted)]">
        {SCOPE_HINTS[data.scope]}
      </p>

      <MarketOrderEditor
        sportId={data.sport.id}
        scope={data.scope}
        initialOrdered={data.ordered.map(({ providerMarketId, label }) => ({
          providerMarketId,
          label,
        }))}
        initialUnranked={data.unranked}
      />
    </div>
  );
}
