"use client";

// The SlotZilla section's body: the match selector and the game.
//
// The selector lists every covered basketball fixture (GET
// /slotzilla/games — live ones first, then the day's upcoming ones by
// kickoff) and the right-hand column mounts the SAME panel the match
// page mounts, plus the live tracker under it, since the tracker draws
// the plays the reels are made of. The selection lives in the URL so a
// link lands on a game; picking a card replaces the query without a
// navigation. Polls the list every 15 s so a game that tips off while
// the section is open moves up into "Live now" on its own.

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { formatMatchClock } from "@oddzilla/types/slotzilla";
import type { SlotzillaLiveGame } from "@oddzilla/types/slotzilla";
import { clientApi } from "@/lib/api-client";
import { useTranslations } from "@/lib/i18n";
import { LiveDot } from "@/components/ui/primitives";
import { SportGlyph } from "@/components/ui/sport-glyph";
import { SlotzillaPanel } from "@/components/match/slotzilla-panel";
import { SportradarLmt } from "@/components/widgets/sportradar-lmt";

const POLL_MS = 15_000;
const SR_BASKETBALL = 2;

function isOn(g: SlotzillaLiveGame): boolean {
  return g.status === "live" || g.status === "paused";
}

function kickoffLabel(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export function SlotzillaHub({
  initial,
  wanted,
}: {
  initial: SlotzillaLiveGame[];
  /** `?match=` from the URL, already shape-checked by the page. */
  wanted: string | null;
}) {
  const t = useTranslations("slotzilla");
  const router = useRouter();
  const [games, setGames] = useState<SlotzillaLiveGame[]>(initial);
  const [picked, setPicked] = useState<string | null>(wanted);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      clientApi<{ games: SlotzillaLiveGame[] }>("/slotzilla/games")
        .then((res) => {
          if (!cancelled) setGames(res.games ?? []);
        })
        .catch(() => {
          // Keep the last list on a failed poll; the panel has its own
          // fetch and the selector is navigation, not money.
        });
    };
    const timer = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const live = useMemo(() => games.filter(isOn), [games]);
  const upcoming = useMemo(() => games.filter((g) => !isOn(g)), [games]);

  // The URL's pick wins while it is on the list; otherwise the first
  // live game, then the next kickoff.
  const selected =
    games.find((g) => g.matchId === picked) ?? live[0] ?? upcoming[0] ?? null;

  const pick = (id: string) => {
    setPicked(id);
    router.replace(`/slotzilla?match=${id}`, { scroll: false });
  };

  if (games.length === 0) {
    return (
      <p className="oz-slz-hub-empty" style={{ color: "var(--fg-muted)", fontSize: 14, margin: 0 }}>
        {t("hub.empty")}
      </p>
    );
  }

  return (
    <div className="oz-slz-hub">
      <nav className="oz-slz-hub-list" aria-label={t("hub.selectorAria")}>
        {live.length > 0 ? (
          <>
            <span className="oz-slz-hub-section mono">{t("hub.liveNow")}</span>
            {live.map((g) => (
              <GameCard key={g.matchId} game={g} selected={selected?.matchId === g.matchId} onPick={pick} />
            ))}
          </>
        ) : null}
        {upcoming.length > 0 ? (
          <>
            <span className="oz-slz-hub-section mono">{t("hub.comingUp")}</span>
            {upcoming.map((g) => (
              <GameCard key={g.matchId} game={g} selected={selected?.matchId === g.matchId} onPick={pick} />
            ))}
          </>
        ) : null}
      </nav>

      {selected ? (
        <div className="oz-slz-hub-game" key={selected.matchId}>
          <SlotzillaPanel
            matchId={selected.matchId}
            homeTeam={selected.homeTeam}
            awayTeam={selected.awayTeam}
            defaultExpanded
          />
          <p className="oz-slz-hub-note">{t("hub.trackerNote")}</p>
          <SportradarLmt srMatchId={Number(selected.srMatchId)} sportId={SR_BASKETBALL} />
        </div>
      ) : null}
    </div>
  );
}

function GameCard({
  game,
  selected,
  onPick,
}: {
  game: SlotzillaLiveGame;
  selected: boolean;
  onPick: (id: string) => void;
}) {
  const t = useTranslations("slotzilla");
  const on = isOn(game);
  const score =
    game.score.home != null && game.score.away != null
      ? `${game.score.home}:${game.score.away}`
      : null;
  const kickoff = kickoffLabel(game.scheduledAt);
  return (
    <button
      type="button"
      className="oz-slz-hub-card"
      data-selected={selected ? "true" : "false"}
      aria-pressed={selected}
      onClick={() => onPick(game.matchId)}
    >
      <span className="oz-slz-hub-card-top">
        <SportGlyph sport={game.sportSlug} size={13} />
        <span className="oz-slz-hub-card-tournament">
          {game.tournament ?? ""}
          {/* A looping recording must say so wherever it is offered, not
              only once it is opened. */}
          {game.demo ? <span className="oz-slz-hub-demo mono">{t("hub.demoTag")}</span> : null}
        </span>
        <span className="oz-slz-hub-card-clock mono">
          {on && game.status !== "paused" && game.clock.running ? <LiveDot size={6} /> : null}
          {on
            ? game.clock.seconds == null
              ? "—"
              : formatMatchClock(game.clock.seconds)
            : kickoff
              ? t("hub.startsAt", { time: kickoff })
              : "—"}
        </span>
      </span>
      <span className="oz-slz-hub-card-teams">
        <span className="oz-slz-hub-card-team">{game.homeTeam}</span>
        <span className="oz-slz-hub-card-team">{game.awayTeam}</span>
      </span>
      <span className="oz-slz-hub-card-foot mono">
        {on ? (score ?? "–") : t("hub.upcomingTag")}
        {game.status === "paused" ? ` · ${t("lobbyPaused")}` : ""}
        {game.playerMode ? ` · ${t("hub.playersTag")}` : ""}
      </span>
    </button>
  );
}
