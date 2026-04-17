"use client";

// Subscribes to the shared WS connection for ticket-state frames pushed
// on the user channel (API placement + bet-delay finalize).

import { useEffect, useRef } from "react";
import {
  ensureSharedConnection,
  getShared,
  type TicketFrame,
} from "./use-live-odds";

export function useTicketStream(onFrame: (frame: TicketFrame) => void): void {
  // Stable reference so we don't re-register on every render while still
  // reading the freshest handler.
  const latest = useRef(onFrame);
  latest.current = onFrame;

  useEffect(() => {
    const conn = getShared();
    const listener = (frame: TicketFrame) => latest.current(frame);
    conn.ticketListeners.add(listener);
    ensureSharedConnection();
    return () => {
      conn.ticketListeners.delete(listener);
    };
  }, []);
}
