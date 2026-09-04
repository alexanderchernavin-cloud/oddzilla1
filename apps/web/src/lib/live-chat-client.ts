// REST wrappers for the /live-chat surface. Server handlers live in
// services/api/src/modules/live-chat/routes.ts.
//
// Only fetch shape lives here — the room hook combines these with
// WS frames into a coherent state machine.

import { clientApi } from "./api-client";
import type {
  LiveChatBetPin,
  LiveChatCrowdPicks,
  LiveChatRoomState,
  LiveChatUserMessage,
  PickOutcome,
  ReactionKind,
} from "@oddzilla/types";

export async function fetchRoomSnapshot(
  matchId: string,
): Promise<LiveChatRoomState> {
  return clientApi<LiveChatRoomState>(`/live-chat/match/${matchId}/room`);
}

export async function sendChatMessage(
  matchId: string,
  text: string,
): Promise<LiveChatUserMessage> {
  const res = await clientApi<{ message: LiveChatUserMessage }>(
    `/live-chat/match/${matchId}/messages`,
    {
      method: "POST",
      body: JSON.stringify({ text }),
    },
  );
  return res.message;
}

export async function submitChatPick(
  matchId: string,
  pick: PickOutcome,
): Promise<{ myPick: PickOutcome; crowdPicks: LiveChatCrowdPicks }> {
  return clientApi<{ myPick: PickOutcome; crowdPicks: LiveChatCrowdPicks }>(
    `/live-chat/match/${matchId}/picks`,
    {
      method: "POST",
      body: JSON.stringify({ pick }),
    },
  );
}

export async function sendChatReaction(
  matchId: string,
  reaction: ReactionKind,
): Promise<void> {
  await clientApi<void>(`/live-chat/match/${matchId}/reactions`, {
    method: "POST",
    body: JSON.stringify({ reaction }),
  });
}

export async function fetchMyBet(
  matchId: string,
): Promise<LiveChatBetPin | null> {
  const res = await clientApi<{ betPin: LiveChatBetPin | null }>(
    `/live-chat/match/${matchId}/my-bet`,
  );
  return res.betPin;
}

// Batch viewer-count lookup. Anonymous (storefront list pages render
// for logged-out visitors). Returns 0 for any matchId without an
// active room — ws-gateway DELs the key on the 0-viewer transition,
// so absent === empty room.
//
// The endpoint caps one call at MAX_VIEWERS_BATCH (200) ids; the /sports
// tab lists live + upcoming across every traditional sport and routinely
// exceeds that, so the lookup is chunked and merged here instead of 400ing.
const VIEWERS_BATCH = 200;

export async function fetchViewerCounts(
  matchIds: readonly string[],
): Promise<Record<string, number>> {
  if (matchIds.length === 0) return {};
  const chunks: string[][] = [];
  for (let i = 0; i < matchIds.length; i += VIEWERS_BATCH) {
    chunks.push(matchIds.slice(i, i + VIEWERS_BATCH));
  }
  const results = await Promise.all(
    chunks.map((ids) =>
      clientApi<{ counts: Record<string, number> }>(
        `/live-chat/viewers?matchIds=${encodeURIComponent(ids.join(","))}`,
      ),
    ),
  );
  const counts: Record<string, number> = {};
  for (const r of results) Object.assign(counts, r.counts);
  return counts;
}
