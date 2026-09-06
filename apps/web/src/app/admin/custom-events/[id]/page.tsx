// /admin/custom-events/[id] — one custom event: its markets, prices,
// liability trading and settlement.

import Link from "next/link";
import { notFound } from "next/navigation";
import { serverApi } from "@/lib/server-fetch";
import { EventEditor, type EventDetail } from "./event-editor";

export default async function CustomEventPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!/^\d+$/.test(id)) notFound();
  const data = await serverApi<EventDetail>(`/admin/custom-events/events/${id}`);
  if (!data) notFound();

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
      <EventEditor detail={data} />
    </div>
  );
}
