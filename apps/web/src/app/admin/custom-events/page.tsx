// /admin/custom-events — the operator's own book.
//
// Two panels: the structure under the Custom sport (categories and the
// tournaments inside them), and the events themselves. Markets and
// pricing live one level down, on the event page, because that is where
// an operator spends their time and a market editor does not belong in a
// list row.

import Link from "next/link";
import { serverApi } from "@/lib/server-fetch";
import {
  CustomEventsClient,
  type StructureResponse,
  type EventRow,
} from "./custom-events-client";

interface EventsResponse {
  events: EventRow[];
}

export default async function CustomEventsPage() {
  const [structure, events] = await Promise.all([
    serverApi<StructureResponse>("/admin/custom-events/structure"),
    serverApi<EventsResponse>("/admin/custom-events/events?limit=200"),
  ]);

  if (!structure) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-semibold">Custom events</h1>
        <p className="text-sm text-[var(--color-fg-muted)]">
          The Custom sport is missing. It is seeded by the
          <code className="mx-1">custom_events</code> migration — run
          <code className="mx-1">make migrate</code> and reload.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <h1 className="text-xl font-semibold">Custom events</h1>
        <p className="max-w-3xl text-sm text-[var(--color-fg-muted)]">
          Events that come from no feed. They are ordinary catalog rows, so
          they appear on the storefront, take bets, and settle through the
          same path as everything else. Structure them with categories and
          tournaments below, then open an event to write its markets and
          set prices.
        </p>
        <p className="max-w-3xl text-sm text-[var(--color-fg-muted)]">
          Stake limits come from the tournament&apos;s risk tier. A tournament
          with no tier is underwritten at the strictest one, so bets on it
          will be small until you set a tier on{" "}
          <Link className="underline" href="/admin/tournaments">
            Tournaments
          </Link>
          .
        </p>
      </header>

      <CustomEventsClient
        structure={structure}
        events={events?.events ?? []}
      />
    </div>
  );
}
