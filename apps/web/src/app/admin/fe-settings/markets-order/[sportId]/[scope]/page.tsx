import Link from "next/link";
import { notFound } from "next/navigation";
import { serverApi } from "@/lib/server-fetch";
import {
  MarketOrderEditor,
  type MarketEntry,
} from "./market-order-editor";

interface GroupTab {
  scope: string;
  label: string | null; // null for built-ins (label derived client-side)
  custom: boolean;
}

interface DetailResponse {
  sport: { id: number; slug: string; name: string };
  scope: string;
  maxMapNumber: number;
  groups: GroupTab[];
  ordered: Array<MarketEntry & { displayOrder: number }>;
  unranked: MarketEntry[];
}

const MAP_SCOPE_RE = /^map_([1-9][0-9]*)$/;
const CUSTOM_SCOPE_RE = /^custom_[a-z0-9]{4,32}$/;

function isValidScope(s: string): boolean {
  return (
    s === "match" || s === "top" || MAP_SCOPE_RE.test(s) || CUSTOM_SCOPE_RE.test(s)
  );
}

function mapScopeIndex(s: string): number | null {
  const m = s.match(MAP_SCOPE_RE);
  return m ? Number(m[1]) : null;
}

function tabLabel(tab: GroupTab): string {
  if (tab.label) return tab.label;
  if (tab.scope === "match") return "Match";
  if (tab.scope === "top") return "Top";
  const n = mapScopeIndex(tab.scope);
  return n != null ? `Map ${n}` : tab.scope;
}

function scopeHint(s: string, groups: GroupTab[]): string {
  if (s === "match")
    return "Order the markets that appear on the Match tab — i.e. those without a `map` specifier.";
  if (s === "top")
    return "Curated highlights tab. Empty by default; markets you add render on the storefront's Top tab and inline on match cards.";
  const n = mapScopeIndex(s);
  if (n != null) {
    return `Order the markets that appear on the Map ${n} tab — markets carrying \`map=${n}\`. Independent from every other Map N list.`;
  }
  if (CUSTOM_SCOPE_RE.test(s)) {
    const label = groups.find((g) => g.scope === s)?.label ?? "this group";
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
  if (!isValidScope(scope)) notFound();

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
        {scopeHint(data.scope, data.groups)}
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
