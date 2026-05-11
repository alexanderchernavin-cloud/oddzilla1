// Caddy's active health check probes this endpoint to decide whether
// each web replica should receive traffic. Keep it cheap — no DB / API
// calls, no SSR. Just confirm the Node process is up and responding.
//
// Middleware is excluded from this path via the matcher in
// src/middleware.ts so we don't pay the CSP-nonce / silent-refresh cost
// on every 5s probe across N replicas.

import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(
    { status: "ok", replica: process.env.REPLICA_NAME ?? "web" },
    { status: 200 },
  );
}
