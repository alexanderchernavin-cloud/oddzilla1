import Link from "next/link";
import { notFound } from "next/navigation";
import { serverApi } from "@/lib/server-fetch";
import {
  MarketOrderEditor,
  type MarketEntry,
} from "./market-order-editor";

interface DetailResponse {
  sport: { id: number; slug: string; name: string };
  scope: string;
  maxMapNumber: number;
  ordered: Array<MarketEntry & { displayOrder: number }>;
  unranked: MarketEntry[];
}

const MAP_SCOPE_RE = /^map_([1-9][0-9]*)$/;

function isValidScope(s: string): boolean {
  return s === "match" || s === "top" || MAP_SCOPE_RE.test(s);
}

function mapScopeIndex(s: string): number | null {
  const m = s.match(MAP_SCOPE_RE);
  return m ? Number(m[1]) : null;
}

function scopeLabel(s: string): string {
  if (s === "match") return "Match";
  if (s === "top") return "Top";
  const n = mapScopeIndex(s);
  return n != null ? `Map ${n}` : s;
}

function scopeHint(s: string): string {
  if (s === "match")
    return "Order the markets that appear on the Match tab — i.e. those without a `map` specifier.";
  if (s === "top")
    return "Curated highlights tab. Empty by default; markets you add render on the storefront's Top tab and inline on match cards.";
  const n = mapScopeIndex(s);
  if (n != null) {
    return `Order the markets that appear on the Map ${n} tab — markets carrying \`map=${n}\`. Independent from every other Map N list.`;
  }
  return "";
}

function buildScopes(maxMapNumber: number): string[] {
  const out: string[] = ["match"];
  for (let n = 1; n <= maxMapNumber; n++) out.push(`map_${n}`);
  out.push("top");
  return out;
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

  const scopes = buildScopes(data.maxMapNumber);

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

      <nav className="mt-6 inline-flex flex-wrap rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-1 text-xs">
        {scopes.map((s) => {
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
              {scopeLabel(s)}
            </Link>
          );
        })}
      </nav>

      <p className="mt-3 text-sm text-[var(--color-fg-muted)]">
        {scopeHint(data.scope)}
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
