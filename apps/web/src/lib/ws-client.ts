// Phase 1 stub. Auto-reconnect WS client with JWT on connect lands in phase 4.

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:3002";

export function openSocket(path = "/ws"): WebSocket {
  return new WebSocket(`${WS_URL}${path}`);
}
