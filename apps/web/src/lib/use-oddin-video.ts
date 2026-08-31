"use client";

// useOddinVideo — is there a first-party Oddin stream for this match, and
// what does the browser SDK need to play it?
//
// One GET /video/match/:id answers both (see services/api/src/modules/video).
// Failure of any kind — route 503 because the key isn't configured, match not
// in Oddin's stream catalog, upstream catalog unreachable — collapses to the
// same "not available" state, so the caller renders no player and no tab.
//
// The poll exists because availability is not static: Oddin adds matches to
// the catalog over time, so a page opened well before kickoff would otherwise
// never learn a stream had appeared. It stops once the match is over. Going
// live needs no poll — the SDK's own `waitForLive` arms on an upcoming match
// and attaches the instant the stream comes up.

import { useEffect, useState } from "react";
import { clientApi } from "./api-client";
import { useSessionUserId } from "./session-user";
import type { OddinVideoAvailability } from "@oddzilla/types/video";

const UNAVAILABLE: OddinVideoAvailability = {
  available: false,
  signInRequired: false,
  matchUrn: null,
  baseUrl: null,
  apiKey: null,
  status: null,
  startsAt: null,
};

// Server-side this is a Redis read against a 60s-cached catalog snapshot, so
// the cost of re-asking is negligible; 2 minutes keeps it firmly in the noise.
const POLL_MS = 120_000;

export interface OddinVideoState {
  availability: OddinVideoAvailability;
  /** False until the first response lands, so callers can avoid a layout flash. */
  loaded: boolean;
}

export function useOddinVideo(matchId: string, enabled = true): OddinVideoState {
  const [state, setState] = useState<OddinVideoState>({
    availability: UNAVAILABLE,
    loaded: false,
  });

  // Watching is signed-in-only, so the answer differs per viewer. Keying the
  // effect on the session id re-asks the moment a bettor logs in or out,
  // instead of leaving a stale sign-in prompt (or a stale credential) up
  // until the next poll.
  const userId = useSessionUserId();

  useEffect(() => {
    if (!enabled || !matchId) {
      setState({ availability: UNAVAILABLE, loaded: true });
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = () => {
      clientApi<OddinVideoAvailability>(`/video/match/${matchId}`)
        .then((res) => {
          if (cancelled) return;
          setState({ availability: res, loaded: true });
          // Nothing more to learn once Oddin says the stream is done.
          if (res.status === "ended") return;
          timer = setTimeout(tick, POLL_MS);
        })
        .catch(() => {
          if (cancelled) return;
          setState({ availability: UNAVAILABLE, loaded: true });
          // Keep polling on failure: a 503 today (key unset, catalog down)
          // may be a 200 tomorrow, and the cost is one Redis read.
          timer = setTimeout(tick, POLL_MS);
        });
    };

    tick();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [matchId, enabled, userId]);

  return state;
}
