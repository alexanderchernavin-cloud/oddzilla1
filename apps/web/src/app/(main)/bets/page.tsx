import { serverApi } from "@/lib/server-fetch";
import type { TicketListResponse } from "@oddzilla/types";
import { getTranslations } from "@/lib/i18n/server";
import { BetHistory } from "./bet-history";

export default async function BetsPage() {
  const [data, t] = await Promise.all([
    serverApi<TicketListResponse>("/bets?limit=100"),
    getTranslations("bets"),
  ]);
  const tickets = data?.tickets ?? [];
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
      <BetHistory initialTickets={tickets} />
    </div>
  );
}
