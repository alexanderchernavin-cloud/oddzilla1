"use client";

// SlotZilla on the home page: one card per basketball match that is
// taking spins right now, linking into the SlotZilla section with that
// match selected. Polls GET /slotzilla/live every 30 s and renders
// nothing while the list is empty, so the lobby is byte-identical to
// before whenever no game is on.

import { useEffect, useState } from "react";
import Link from "next/link";
import { formatCountdown } from "@oddzilla/types/slotzilla";
import type { SlotzillaLiveGame } from "@oddzilla/types/slotzilla";
import { clientApi } from "@/lib/api-client";
import { useTranslations } from "@/lib/i18n";
import { LiveDot } from "@/components/ui/primitives";
import { SportGlyph } from "@/components/ui/sport-glyph";

const POLL_MS = 30_000;

export function SlotzillaLive() {
  const t = useTranslations("slotzilla");
  const [games, setGames] = useState<SlotzillaLiveGame[]>([]);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      clientApi<{ games: SlotzillaLiveGame[] }>("/slotzilla/live")
        .then((res) => {
          if (!cancelled) setGames(res.games ?? []);
        })
        .catch(() => {
          // Non-essential surface: a failed poll keeps the last list.
        });
    };
    load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  if (games.length === 0) return null;

  return (
    <section className="oz-slz-lobby" aria-label={t("title")}>
      <header className="oz-slz-lobby-head">
        <div className="oz-slz-head-title">
          <span className="oz-slz-kicker mono">{t("lobbyKicker")}</span>
          <span className="oz-slz-title display">{t("title")}</span>
        </div>
        <span className="oz-slz-head-spacer" />
        <span className="oz-slz-tagline">{t("tagline")}</span>
      </header>
      <div className="oz-slz-lobby-row">
        {games.map((g) => {
          const paused = g.status === "paused";
          const score =
            g.score.home != null && g.score.away != null ? `${g.score.home}:${g.score.away}` : null;
          return (
            <Link key={g.matchId} href={`/slotzilla?match=${g.matchId}`} className="oz-slz-card">
              <span className="oz-slz-card-top">
                <SportGlyph sport={g.sportSlug} size={13} />
                <span className="oz-slz-card-tournament">{g.tournament ?? ""}</span>
                <span className="oz-slz-card-clock mono">
                  {!paused && g.clock.running ? <LiveDot size={6} /> : null}
                  {g.clock.seconds == null ? "—" : formatCountdown(g.clock.seconds, g.clock.period, g.clock)}
                </span>
              </span>
              <span className="oz-slz-card-teams">
                <span className="oz-slz-card-team">{g.homeTeam}</span>
                <span className="oz-slz-card-score mono">{score ?? "–"}</span>
                <span className="oz-slz-card-team">{g.awayTeam}</span>
              </span>
              <span className="oz-slz-card-cta">
                {paused ? t("lobbyPaused") : t("lobbyCta")}
              </span>
            </Link>
          );
        })}
      </div>
    </section>
  );
}
