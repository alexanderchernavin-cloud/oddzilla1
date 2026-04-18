import { serverApi } from "@/lib/server-fetch";
import type { TicketListResponse } from "@oddzilla/types";
import { BetHistory } from "./bet-history";

export default async function BetsPage() {
  const data = await serverApi<TicketListResponse>("/bets?limit=100");
  const tickets = data?.tickets ?? [];
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Bets</h1>
      <p className="mt-2 text-sm text-[var(--color-fg-muted)]">
        Your placement history. Pending tickets update live once the bet-delay
        worker finalizes them.
      </p>
      <BetHistory initialTickets={tickets} />
    </div>
  );
}
