// /slotzilla — the SlotZilla section: a match selector over every
// basketball fixture the game covers, and the game itself for the one
// selected. The selection rides the URL (`?match=<id>`) so a link from
// the lobby strip, a chat message or a push lands on the right game.
//
// The list is fetched here for the first paint and re-polled by the
// hub every 15 s; the game panel has its own snapshot + frame wiring
// (use-slotzilla.ts), so this page needs no further server state.

import { serverApi } from "@/lib/server-fetch";
import { getTranslations } from "@/lib/i18n/server";
import { TodayLabel } from "@/components/lobby/today-label";
import { SlotzillaHub } from "@/components/slotzilla/slotzilla-hub";
import type { SlotzillaLiveGame } from "@oddzilla/types/slotzilla";

export const dynamic = "force-dynamic";

interface PageProps {
  searchParams?: Promise<{ match?: string | string[] }>;
}

export default async function SlotzillaPage({ searchParams }: PageProps) {
  const resolved = (await searchParams) ?? {};
  const raw = resolved.match;
  const wanted = typeof raw === "string" && /^\d{1,20}$/u.test(raw) ? raw : null;

  const [data, t] = await Promise.all([
    serverApi<{ games: SlotzillaLiveGame[] }>("/slotzilla/games"),
    getTranslations("slotzilla"),
  ]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 20,
        padding: "28px 32px 60px",
      }}
    >
      {/* Same kicker row the lobby and the section pages open with, so
          the search bar's collapsed row is absorbed the same way. */}
      <header className="oz-lobby-header">
        <div className="oz-lobby-header-content">
          <TodayLabel />
        </div>
      </header>

      <header className="oz-slz-hub-head">
        <span className="oz-slz-kicker mono">{t("hub.kicker")}</span>
        <h1 className="oz-slz-hub-title display">{t("hub.title")}</h1>
        <p className="oz-slz-hub-intro">{t("hub.intro")}</p>
      </header>

      <SlotzillaHub initial={data?.games ?? []} wanted={wanted} />
    </div>
  );
}
