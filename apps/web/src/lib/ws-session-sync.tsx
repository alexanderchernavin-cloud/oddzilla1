"use client";

// Keeps the shared WebSocket's authenticated identity in step with the
// signed-in session.
//
// ws-gateway reads the `oddzilla_access` cookie once, during the HTTP
// upgrade, and never re-reads it: a socket's identity is fixed for its
// lifetime. Nothing in the storefront reloads the page on sign-in
// (login-form.tsx uses router.push + router.refresh), so a socket opened
// while logged out stays anonymous afterwards — subscribed to public
// odds, never to the private `user:{id}` channel that carries ticket
// frames. The visible failure is a live bet whose acceptance frame never
// arrives: the slip holds "Placing…" until its timeout and then does not
// clear, which invites the bettor to place the same bet twice.
//
// The same mismatch appears without any sign-in when ws-gateway restarts
// and a tab reconnects while its 15-minute access cookie has expired —
// the reconnect authenticates as anonymous and stays that way until the
// next navigation.
//
// This component publishes the SSR-resolved user id into the shared
// connection; the connection closes and reopens itself when the two
// disagree, bounded so an expired cookie can't spin. Renders nothing.

import { useEffect } from "react";
import { setExpectedSessionUser } from "./use-live-odds";
import { useSessionUserId } from "./session-user";

export function WsSessionSync() {
  const userId = useSessionUserId();
  useEffect(() => {
    setExpectedSessionUser(userId);
  }, [userId]);
  return null;
}
