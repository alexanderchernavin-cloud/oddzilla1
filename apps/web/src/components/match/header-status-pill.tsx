"use client";

// Reactive LIVE / Upcoming pill for the match-detail page header.
// Subscribes to the shared WebSocket via `useLiveMatchStatus(matchId)`
// and overlays the latest lifecycle tick on top of the SSR snapshot.
// Without this, the pill stays frozen at whatever match.status was at
// render time — feed-ingester / settlement flip the DB row to
// 'closed' but the indicator only refreshed on a hard reload.

import { useTranslations } from "@/lib/i18n";
import { useLiveMatchStatus } from "@/lib/use-live-odds";
import { Pill, LiveDot } from "@/components/ui/primitives";
import { LocalDateTime } from "./local-datetime";

type Status = "not_started" | "live" | "closed" | "cancelled" | "suspended";

interface Props {
  matchId: string;
  initialStatus: Status;
  scheduledAt: string | null;
}

export function MatchHeaderStatusPill({
  matchId,
  initialStatus,
  scheduledAt,
}: Props) {
  const liveTick = useLiveMatchStatus(matchId);
  const status: Status = liveTick?.status ?? initialStatus;
  const tMatch = useTranslations("match");
  const tCommon = useTranslations("common");
  const tHome = useTranslations("home");

  if (status === "live") {
    return (
      <Pill tone="live">
        <LiveDot size={6} /> {tMatch("live")}
      </Pill>
    );
  }
  if (status === "closed") {
    return <Pill>{tCommon("ended")}</Pill>;
  }
  if (status === "cancelled") {
    return <Pill>{tCommon("cancelled")}</Pill>;
  }
  // not_started / suspended fall through to the upcoming pill —
  // suspended pre-match is still notionally an upcoming fixture from
  // the bettor's POV.
  return (
    <Pill>
      {tHome("upcoming")}
      {" · "}
      <LocalDateTime iso={scheduledAt} mode="match-detail" />
    </Pill>
  );
}
