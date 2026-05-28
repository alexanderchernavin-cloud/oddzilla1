"use client";

// Subscribes to the shared WS connection for live support_message
// frames. The api publishes these on `user:{userId}` whenever a
// bettor posts or an operator replies; ws-gateway forwards verbatim.
// The widget hook re-renders on each frame to update the local
// message list + unread badge without polling.

import { useEffect, useRef } from "react";
import type { SupportMessageFrame } from "@oddzilla/types";
import {
  ensureSharedConnection,
  getShared,
} from "./use-live-odds";

export function useSupportStream(
  onFrame: (frame: SupportMessageFrame) => void,
): void {
  const latest = useRef(onFrame);
  latest.current = onFrame;

  useEffect(() => {
    const conn = getShared();
    const listener = (frame: SupportMessageFrame) => latest.current(frame);
    conn.supportListeners.add(listener);
    ensureSharedConnection();
    return () => {
      conn.supportListeners.delete(listener);
    };
  }, []);
}
