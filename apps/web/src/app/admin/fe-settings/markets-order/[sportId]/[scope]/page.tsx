import Link from "next/link";
import { notFound } from "next/navigation";
import {
  isCustomScope,
  isMarketScope,
  isSubEventScope,
  mapScopeNumber,
} from "@oddzilla/types/market-scope";
import { serverApi } from "@/lib/server-fetch";
import { tabLabel, type ScopeTab } from "../../scope-label";
import { MarketOrderEditor, type MarketEntry } from "./market-order-editor";

interface DetailResponse {
  sport: { id: number; slug: string; name: string };
  scope: string;
  label: string | null;
  groups: ScopeTab[];
  ordered: Array<MarketEntry & { displayOrder: number }>;
  unranked: MarketEntry[];
}

function scopeHint(data: DetailResponse): string {
  const s = data.scope;
  if (s === "match")
    return "Order the markets on the Match tab — the base event, with no map and no sub-event.";
  if (s === "top")
    return "Curated highlights tab. Empty by default; markets you add render on the storefront's Top tab and inline on match cards.";
  const n = mapScopeNumber(s);
  if (n != null) {
    return `Order the markets on the Map ${n} tab — markets carrying \`map=${n}\`. Independent from every other Map N list.`;
  }
  if (isSubEventScope(s)) {
    const label = data.label ?? "this sub-event";
    return `Order the markets on the "${label}" tab. This is a sub-event the feed carries for this sport; its markets and its title are the feed's, only the order is yours.`;
  }
  if (isCustomScope(s)) {
    const label = data.groups.find((g) => g.scope === s)?.label ?? "this group";
    return `Curated custom tab "${label}". Empty by default; add markets from anywhere on this sport and they render as their own tab on the match-detail page.`;
  }
  return "";
}

export default async function ScopeEditorPage({
  params,
}: {
  params: Promise<{ sportId: string; scope: string }>;
}) {
  const { sportId, scope } = await params;
  if (!isMarketScope(scope)) notFound();

  // 404s for a tab this sport does not have — a Map 3 URL on football, or a
  // deleted custom group.
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

      <div className="mt-6 flex flex-wrap items-center gap-2">
        <nav className="inline-flex flex-wrap rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-1 text-xs">
          {data.groups.map((tab) => {
            const active = tab.scope === data.scope;
            return (
              <Link
                key={tab.scope}
                href={`/admin/fe-settings/markets-order/${sportId}/${tab.scope}`}
                title={tab.scope}
                className={
                  "rounded px-3 py-1.5 uppercase tracking-[0.15em] " +
                  (active
                    ? "bg-[var(--color-fg)] text-[var(--color-bg)]"
                    : "text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]")
                }
              >
                {tabLabel(tab)}
              </Link>
            );
          })}
        </nav>
        <Link
          href={`/admin/fe-settings/markets-order/${sportId}/groups`}
          className="rounded-md border border-dashed border-[var(--color-border)] px-3 py-2 text-xs uppercase tracking-[0.15em] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
        >
          Manage groups
        </Link>
      </div>

      <p className="mt-3 text-sm text-[var(--color-fg-muted)]">
        {scopeHint(data)}
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
