"use client";

import { useEffect } from "react";

// Detect a stale-manifest ChunkLoadError on the live page and reload
// once to pick up the fresh HTML + webpack manifest.
//
// Every Next.js deploy that rebuilds web replicas invalidates the
// chunk hashes referenced by in-flight tabs' webpack runtime. The
// next dynamic-import-triggering action (route nav, notification
// deeplink, code-split component mount) throws ChunkLoadError before
// the chunk evaluates. Reloading the page realigns the runtime with
// the new manifest — the chunk URL the new HTML asks for resolves
// cleanly.
//
// Two listeners because webpack's failure mode varies:
//   • `error` event — synchronous throw from the webpack runtime
//     during script tag insertion / parse.
//   • `unhandledrejection` — the chunk-load promise rejects and no
//     awaiter catches it (router prefetch is the most common path).
//
// Recursion guard via sessionStorage so a genuine asset corruption
// (chunk truly missing, CDN cache poisoning, etc.) doesn't trap the
// user in an infinite reload loop. The guard self-clears after
// RELOAD_GUARD_TTL_MS so the NEXT deploy still triggers a fresh
// reload — we lose nothing by being conservative here.

const RELOAD_GUARD_KEY = "oz:chunk-error-reloaded-at";
const RELOAD_GUARD_TTL_MS = 5000;

const CHUNK_MESSAGE_RE = /Loading (chunk|CSS chunk)/i;

function isChunkLoadError(value: unknown): boolean {
  if (value == null || typeof value !== "object") return false;
  const v = value as { name?: unknown; message?: unknown };
  if (v.name === "ChunkLoadError") return true;
  return typeof v.message === "string" && CHUNK_MESSAGE_RE.test(v.message);
}

function reloadOnce(): void {
  try {
    const at = sessionStorage.getItem(RELOAD_GUARD_KEY);
    if (at && Number(at) > Date.now() - RELOAD_GUARD_TTL_MS) return;
    sessionStorage.setItem(RELOAD_GUARD_KEY, String(Date.now()));
  } catch {
    // sessionStorage can throw in private-mode browsers / cross-origin
    // iframes. Fall through to the reload — losing the recursion guard
    // is a worse failure than a possible reload loop in an edge env.
  }
  window.location.reload();
}

export function ChunkErrorHandler(): null {
  useEffect(() => {
    const onError = (e: ErrorEvent) => {
      // ErrorEvent.error is the thrown value (preferred); .message is
      // a stringified fallback that some browsers populate when the
      // original error object can't cross a security boundary.
      if (isChunkLoadError(e.error) || CHUNK_MESSAGE_RE.test(e.message)) {
        reloadOnce();
      }
    };
    const onRejection = (e: PromiseRejectionEvent) => {
      if (isChunkLoadError(e.reason)) reloadOnce();
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);
  return null;
}
