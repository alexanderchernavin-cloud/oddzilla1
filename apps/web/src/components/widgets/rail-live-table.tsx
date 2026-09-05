"use client";

// RailLiveTable — mounts Sportradar's Live Table in the right rail while
// the bettor is looking at ONE tournament.
//
// There is no /tournament/:id route in this storefront: a tournament view
// is the sport page narrowed by `?tournament=N` (the sidebar's tournament
// links, the sport page's filter chip). So the trigger is read from the
// route rather than pushed through a context the way the match page does
// it — a sport page that carries no tournament filter is not a tournament
// view, and this renders nothing.
//
// The Sportradar reference is resolved server-side from a confirmed match
// mapping under that tournament (GET /catalog/tournaments/:id/sportradar,
// 60 s cached). Most tournaments have none, in which case the fetch
// answers null and the rail is unchanged — the same "no mapping, no
// widget, no gap" rule the tracker follows.

import { useEffect, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { clientApi } from "@/lib/api-client";
import type { SportradarMatchRef } from "@oddzilla/types/sportradar";
import {
  SportradarLiveTable,
  liveTableCoversSport,
} from "./sportradar-live-table";

interface Response {
  sportradar: SportradarMatchRef | null;
}

export function RailLiveTable() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const onSportPage = pathname?.startsWith("/sport/") ?? false;
  const raw = searchParams.get("tournament");
  const tournamentId = onSportPage && raw && /^\d+$/.test(raw) ? raw : null;

  const [ref, setRef] = useState<SportradarMatchRef | null>(null);

  useEffect(() => {
    if (!tournamentId) {
      setRef(null);
      return;
    }
    let cancelled = false;
    // Clear first: switching tournaments must not leave the previous
    // competition's table on screen while the new lookup is in flight.
    setRef(null);
    clientApi<Response>(`/catalog/tournaments/${tournamentId}/sportradar`)
      .then((res) => {
        if (!cancelled) setRef(res.sportradar);
      })
      .catch(() => {
        // A missing table is not worth surfacing — the rail simply keeps
        // the bet slip and whatever else it already carries.
        if (!cancelled) setRef(null);
      });
    return () => {
      cancelled = true;
    };
  }, [tournamentId]);

  if (!tournamentId || !ref) return null;
  // A mapped fixture in a knockout or ranking sport still has no table —
  // see liveTableCoversSport for why that has to be decided here.
  if (!liveTableCoversSport(ref.srSportId)) return null;
  return (
    <SportradarLiveTable
      key={tournamentId}
      srMatchId={ref.srMatchId}
      srSportId={ref.srSportId}
    />
  );
}
