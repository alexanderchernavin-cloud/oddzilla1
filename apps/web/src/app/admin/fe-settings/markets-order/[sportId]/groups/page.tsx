import Link from "next/link";
import { notFound } from "next/navigation";
import { serverApi } from "@/lib/server-fetch";
import { GroupsManager, type GroupsResponse } from "./groups-manager";

export default async function GroupsPage({
  params,
}: {
  params: Promise<{ sportId: string }>;
}) {
  const { sportId } = await params;

  const data = await serverApi<GroupsResponse>(
    `/admin/fe-settings/market-groups/${sportId}`,
  );
  if (!data) notFound();

  return (
    <div>
      <Link
        href={`/admin/fe-settings/markets-order/${sportId}/match`}
        className="text-xs uppercase tracking-[0.15em] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
      >
        ← Back to markets order
      </Link>
      <h2 className="mt-3 text-lg font-medium">
        {data.sport.name} — market groups
      </h2>
      <p className="mt-1 font-mono text-xs text-[var(--color-fg-muted)]">
        {data.sport.slug}
      </p>
      <p className="mt-4 max-w-2xl text-sm text-[var(--color-fg-muted)]">
        The tabs shown on the match-detail page, in render order. Feed tabs
        (Match, Map N, and whichever sub-events this sport carries — 1st half,
        Corners, Players …) can be reordered; custom groups can also be renamed
        and deleted. A custom group is a curated tab like Top — it only appears
        on the storefront once you add markets to it via its tab editor. The
        storefront&apos;s All tab always renders first and is not configurable.
      </p>

      <GroupsManager sportId={data.sport.id} initial={data} />
    </div>
  );
}
