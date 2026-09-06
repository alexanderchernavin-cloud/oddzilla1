// /admin/custom-events/[id] — one custom event: its markets, prices,
// liability trading and settlement.

import Link from "next/link";
import { notFound } from "next/navigation";
import { serverApi } from "@/lib/server-fetch";
import { EventEditor, type EventDetail, type TournamentOption } from "./event-editor";

interface StructureResponse {
  categories: Array<{
    name: string;
    tournaments: Array<{ id: number; name: string; riskTier: number | null }>;
  }>;
}

export default async function CustomEventPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!/^\d+$/.test(id)) notFound();
  // The structure comes along so the header can offer a tournament
  // picker. An event that cannot be moved is an event filed in the wrong
  // place forever.
  const [data, structure] = await Promise.all([
    serverApi<EventDetail>(`/admin/custom-events/events/${id}`),
    serverApi<StructureResponse>("/admin/custom-events/structure"),
  ]);
  if (!data) notFound();

  const tournamentOptions: TournamentOption[] = (structure?.categories ?? []).flatMap(
    (c) =>
      c.tournaments.map((t) => ({
        id: t.id,
        name: t.name,
        categoryName: c.name,
        riskTier: t.riskTier,
      })),
  );

  return (
    <div className="space-y-6">
      <div className="text-xs">
        <Link className="underline" href="/admin/custom-events">
          Custom events
        </Link>
        <span className="mx-2 text-[var(--color-fg-muted)]">/</span>
        <span>
          {data.event.homeTeam} vs {data.event.awayTeam}
        </span>
      </div>
      <EventEditor detail={data} tournaments={tournamentOptions} />
    </div>
  );
}
