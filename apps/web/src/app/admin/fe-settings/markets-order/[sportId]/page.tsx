import Link from "next/link";
import { notFound } from "next/navigation";
import { serverApi } from "@/lib/server-fetch";
import { MarketOrderEditor, type MarketEntry } from "./market-order-editor";

interface DetailResponse {
  sport: { id: number; slug: string; name: string };
  ordered: Array<MarketEntry & { displayOrder: number }>;
  unranked: MarketEntry[];
}

export default async function SportMarketsOrderPage({
  params,
}: {
  params: Promise<{ sportId: string }>;
}) {
  const { sportId } = await params;
  const data = await serverApi<DetailResponse>(
    `/admin/fe-settings/markets-order/${sportId}`,
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
      <p className="mt-3 text-sm text-[var(--color-fg-muted)]">
        Drag — or use the up/down buttons — to set the storefront order for
        this sport. Markets in the Unranked column render after the ordered
        list, sorted by provider market id ascending.
      </p>

      <MarketOrderEditor
        sportId={data.sport.id}
        initialOrdered={data.ordered.map(({ providerMarketId, label }) => ({
          providerMarketId,
          label,
        }))}
        initialUnranked={data.unranked}
      />
    </div>
  );
}
