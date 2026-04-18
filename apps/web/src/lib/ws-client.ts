// Auto-reconnect WS client. Empty NEXT_PUBLIC_WS_URL means "same origin" —
// in prod the browser opens wss://<current-host>/ws which Caddy forwards to
// the ws-gateway container. In dev we connect to ws://localhost:3002 directly.

const RAW_WS_URL = process.env.NEXT_PUBLIC_WS_URL;

function resolveWsBase(): string {
  if (RAW_WS_URL && RAW_WS_URL.length > 0) return RAW_WS_URL;
  if (typeof window === "undefined") return ""; // SSR — path-only; never opens
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}`;
}

export function openSocket(path = "/ws"): WebSocket {
  return new WebSocket(`${resolveWsBase()}${path}`);
}
