// First-party FE analytics tracker (core, framework-free). Captures the
// bettor journey — page views, every click (with a compact target
// descriptor), sampled mouse trails (~8 Hz while the pointer moves) and
// visibility heartbeats — batches them in memory, and flushes to
// POST /analytics/collect every few seconds. The final flush on
// pagehide / tab-hide rides sendBeacon (fetch keepalive fallback) so
// closing the tab doesn't lose the tail of the session.
//
// Sessions are per-tab (sessionStorage): a client-generated UUID plus a
// monotonic `seq` counter shared by events and mouse batches. The seq
// is persisted on every allocation so a reload continues the same
// stream, and the server dedupes on (session_id, seq) — re-delivery is
// harmless. Sessions renew after 30 min of inactivity.
//
// Auth rides the normal access cookie (credentials: include /
// sendBeacon's default cookie behaviour) — anonymous visitors are
// tracked too, and the session row links to the user on the first
// authed flush.

import type {
  AnalyticsClickPayload,
  AnalyticsCollectRequest,
  AnalyticsEventKind,
  AnalyticsMouseWireBatch,
  AnalyticsWireEvent,
} from "@oddzilla/types";

// Mirrors ANALYTICS_MAX_EVENTS_PER_REQUEST / _MOUSE_BATCHES_PER_REQUEST
// in packages/types/src/analytics.ts (the server-enforced caps). Kept as
// local literals because apps/web may only `import type` from
// @oddzilla/types — a value import makes Next's webpack bundle the whole
// source barrel, whose `.js`-extension ESM imports it can't resolve
// (tsc NodeNext maps .js → .ts; webpack doesn't). Every other web file
// follows the same type-only rule.
const MAX_EVENTS_PER_REQUEST = 200;
const MAX_MOUSE_BATCHES_PER_REQUEST = 20;

const RAW_API_URL = process.env.NEXT_PUBLIC_API_URL;
// Same fallback logic as lib/api-client.ts — empty env means same-origin
// /api through Caddy.
const API_BASE = RAW_API_URL && RAW_API_URL.length > 0 ? RAW_API_URL : "/api";
const COLLECT_URL = `${API_BASE}/analytics/collect`;

const STORAGE_KEY = "oz:analytics:session";
const IDLE_RENEW_MS = 30 * 60 * 1000;
const FLUSH_INTERVAL_MS = 5_000;
const HEARTBEAT_INTERVAL_MS = 30_000;

// Mouse sampling: at most one point per 120 ms, and only when the
// pointer actually travelled. A segment closes on flush / navigation /
// point cap and becomes one wire batch.
const MOUSE_SAMPLE_MS = 120;
const MOUSE_MIN_MOVE_PX = 3;
const MOUSE_SEGMENT_MAX_POINTS = 400;
const MOUSE_SEGMENT_MIN_POINTS = 3;

// Memory guards for a tab that can't reach the API.
const EVENT_QUEUE_CAP = 600;
const MOUSE_QUEUE_CAP = 60;

type PersistedSession = {
  id: string;
  startedAt: number;
  seq: number;
  lastActivity: number;
};

type MouseSegment = {
  path: string;
  startTs: number;
  lastTs: number;
  lastX: number;
  lastY: number;
  points: [number, number, number][];
};

let initialized = false;
let disabled = false;
// Consent gate (GDPR / ePrivacy): session-level behavioural tracking
// with identity linkage sits outside every audience-measurement
// exemption, so nothing is captured, stored, or flushed until the
// cookie banner's "analytics" category is granted. Starts false; the
// AnalyticsTracker mount syncs it from the stored consent and keeps it
// in sync when the user changes their choice.
let consentGranted = false;
let session: PersistedSession | null = null;
let events: AnalyticsWireEvent[] = [];
let mouseBatches: AnalyticsMouseWireBatch[] = [];
let segment: MouseSegment | null = null;
let currentPath = "";
let flushing = false;

function isTrackablePath(path: string): boolean {
  // Prod admin lives on its own host, but in dev both share localhost —
  // keep operator navigation out of the bettor dataset either way.
  return !path.startsWith("/admin");
}

export function sectionFromPath(path: string): string {
  const clean = path.split("?")[0]!.split("#")[0]!;
  const segs = clean.split("/").filter(Boolean);
  if (segs.length === 0) return "lobby";
  const first = segs[0]!.toLowerCase();
  if (first === "u") return "profile";
  return first.slice(0, 40);
}

function loadSession(): PersistedSession {
  const now = Date.now();
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as PersistedSession;
      if (
        typeof parsed.id === "string" &&
        typeof parsed.seq === "number" &&
        now - (parsed.lastActivity ?? 0) < IDLE_RENEW_MS
      ) {
        return parsed;
      }
    }
  } catch {
    // Corrupt/blocked storage — fall through to a fresh session.
  }
  return { id: crypto.randomUUID(), startedAt: now, seq: 0, lastActivity: now };
}

function persistSession() {
  if (!session) return;
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    // Storage full/blocked — the in-memory session still works for this
    // page's lifetime.
  }
}

function ensureSession(): PersistedSession {
  const now = Date.now();
  if (!session || now - session.lastActivity >= IDLE_RENEW_MS) {
    // Renewing mid-page: drop queued data tied to the old session rather
    // than splicing two sessions together.
    if (session) {
      events = [];
      mouseBatches = [];
      segment = null;
    }
    session = loadSession();
  }
  session.lastActivity = now;
  return session;
}

function nextSeq(): number {
  const s = ensureSession();
  const seq = s.seq;
  s.seq += 1;
  persistSession();
  return seq;
}

function enqueue(kind: AnalyticsEventKind, fields: Partial<AnalyticsWireEvent> = {}) {
  if (disabled || !consentGranted || !isTrackablePath(currentPath)) return;
  if (events.length >= EVENT_QUEUE_CAP) return;
  events.push({
    seq: nextSeq(),
    kind,
    ts: Date.now(),
    path: currentPath || undefined,
    section: currentPath ? sectionFromPath(currentPath) : undefined,
    ...fields,
  });
}

// ── Mouse sampling ────────────────────────────────────────────────────

function closeSegment() {
  if (!segment) return;
  const seg = segment;
  segment = null;
  if (seg.points.length < MOUSE_SEGMENT_MIN_POINTS) return;
  if (mouseBatches.length >= MOUSE_QUEUE_CAP) return;
  if (disabled || !consentGranted || !isTrackablePath(seg.path)) return;
  mouseBatches.push({
    seq: nextSeq(),
    path: seg.path,
    startTs: seg.startTs,
    durationMs: Math.max(0, Math.round(seg.lastTs - seg.startTs)),
    viewportW: Math.max(1, window.innerWidth),
    viewportH: Math.max(1, window.innerHeight),
    points: seg.points,
  });
}

function handleMouseMove(e: MouseEvent) {
  if (disabled || !consentGranted || !currentPath || !isTrackablePath(currentPath)) return;
  const now = Date.now();
  if (segment && segment.path !== currentPath) closeSegment();
  if (!segment) {
    segment = {
      path: currentPath,
      startTs: now,
      lastTs: now,
      lastX: e.clientX,
      lastY: e.clientY,
      points: [[0, Math.round(e.clientX), Math.round(e.clientY)]],
    };
    return;
  }
  if (now - segment.lastTs < MOUSE_SAMPLE_MS) return;
  const dx = Math.abs(e.clientX - segment.lastX);
  const dy = Math.abs(e.clientY - segment.lastY);
  if (dx < MOUSE_MIN_MOVE_PX && dy < MOUSE_MIN_MOVE_PX) return;
  segment.points.push([now - segment.startTs, Math.round(e.clientX), Math.round(e.clientY)]);
  segment.lastTs = now;
  segment.lastX = e.clientX;
  segment.lastY = e.clientY;
  ensureSession();
  if (segment.points.length >= MOUSE_SEGMENT_MAX_POINTS) closeSegment();
}

// ── Click capture ─────────────────────────────────────────────────────

const INTERACTIVE_TAGS = new Set(["button", "a", "input", "select", "textarea", "label", "summary"]);

function describeClickTarget(target: EventTarget | null): Omit<AnalyticsClickPayload, "x" | "y" | "sx" | "sy"> | null {
  let el: Element | null = target instanceof Element ? target : null;
  if (!el) return null;
  let base: Element = el;
  // Walk up a few levels to the nearest interactive/annotated ancestor
  // so a click on a <span> inside a button reads as the button.
  for (let depth = 0; el && depth < 6; depth += 1) {
    const tag = el.tagName.toLowerCase();
    if (
      el.hasAttribute("data-oz-track") ||
      INTERACTIVE_TAGS.has(tag) ||
      el.getAttribute("role") === "button"
    ) {
      base = el;
      break;
    }
    el = el.parentElement;
  }

  const tag = base.tagName.toLowerCase();
  const trackId = base.getAttribute("data-oz-track") ?? undefined;
  const id = base.id || undefined;
  const href = tag === "a" ? (base.getAttribute("href") ?? undefined) : undefined;
  const text =
    (base.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 60) || undefined;
  const cls = typeof base.className === "string" ? base.className.slice(0, 80) || undefined : undefined;

  const label = trackId
    ? `[${trackId}]`
    : href
      ? `${tag}[${href.slice(0, 60)}]`
      : id
        ? `${tag}#${id}`
        : text
          ? `${tag} "${text.slice(0, 40)}"`
          : tag;

  return { label: label.slice(0, 80), tag, id, testid: trackId, cls, text, href };
}

function handleClick(e: MouseEvent) {
  const descriptor = describeClickTarget(e.target);
  if (!descriptor) return;
  const payload: AnalyticsClickPayload = {
    ...descriptor,
    x: Math.round(e.clientX),
    y: Math.round(e.clientY),
    sx: Math.round(window.scrollX),
    sy: Math.round(window.scrollY),
  };
  enqueue("click", { payload: payload as unknown as Record<string, unknown> });
}

// ── Transport ─────────────────────────────────────────────────────────

function buildPayload(
  evs: AnalyticsWireEvent[],
  mbs: AnalyticsMouseWireBatch[],
): AnalyticsCollectRequest {
  const s = ensureSession();
  return {
    sessionId: s.id,
    startedAt: s.startedAt,
    meta: {
      entryPath: currentPath || undefined,
      referrer: document.referrer ? document.referrer.slice(0, 600) : undefined,
      viewportW: Math.max(1, window.innerWidth),
      viewportH: Math.max(1, window.innerHeight),
    },
    events: evs,
    mouse: mbs.length > 0 ? mbs : undefined,
  };
}

function sendBeaconPayload(payload: AnalyticsCollectRequest): boolean {
  const body = JSON.stringify(payload);
  try {
    if (typeof navigator.sendBeacon === "function") {
      const blob = new Blob([body], { type: "application/json" });
      if (navigator.sendBeacon(COLLECT_URL, blob)) return true;
    }
  } catch {
    // Fall through to keepalive fetch.
  }
  try {
    void fetch(COLLECT_URL, {
      method: "POST",
      body,
      keepalive: true,
      credentials: "include",
      headers: { "content-type": "application/json" },
    });
    return true;
  } catch {
    return false;
  }
}

// Synchronous final flush (pagehide / tab-hide). Deliberately ignores
// the `flushing` guard — an in-flight fetch flush has already spliced
// its slice out of the queues, so the beacon just carries the remainder.
function flushBeacon(): void {
  closeSegment();
  if (events.length === 0 && mouseBatches.length === 0) return;
  const evs = events.splice(0, MAX_EVENTS_PER_REQUEST);
  // Beacon/keepalive bodies share a 64 KiB in-flight budget — keep the
  // final payload small; anything left beyond it is accepted loss.
  const mbs = mouseBatches.splice(0, 4);
  sendBeaconPayload(buildPayload(evs, mbs));
}

async function flush(): Promise<void> {
  if (flushing) return;
  if (events.length === 0 && mouseBatches.length === 0 && !segment) return;
  flushing = true;
  try {
    closeSegment();
    let rounds = 0;
    while ((events.length > 0 || mouseBatches.length > 0) && rounds < 3) {
      rounds += 1;
      const evs = events.splice(0, MAX_EVENTS_PER_REQUEST);
      const mbs = mouseBatches.splice(0, MAX_MOUSE_BATCHES_PER_REQUEST);
      if (evs.length === 0 && mbs.length === 0) break;
      const payload = buildPayload(evs, mbs);

      let ok = false;
      try {
        const res = await fetch(COLLECT_URL, {
          method: "POST",
          body: JSON.stringify(payload),
          credentials: "include",
          headers: { "content-type": "application/json" },
        });
        ok = res.ok;
      } catch {
        ok = false;
      }
      if (!ok) {
        // Requeue bounded — the next interval retries; server-side seq
        // dedupe makes eventual double-delivery harmless.
        events = [...evs, ...events].slice(0, EVENT_QUEUE_CAP);
        mouseBatches = [...mbs, ...mouseBatches].slice(0, MOUSE_QUEUE_CAP);
        break;
      }
    }
  } finally {
    flushing = false;
  }
}

// ── Public surface ────────────────────────────────────────────────────

function pageView(path: string) {
  if (disabled) return;
  if (segment && segment.path !== path) closeSegment();
  currentPath = path;
  if (!consentGranted || !isTrackablePath(path)) return;
  enqueue("page_view");
}

// Flip the consent gate. Withdrawal drops everything queued AND the
// stored session id — keeping an identifier in sessionStorage without
// consent would itself violate ePrivacy art. 5(3), not just the
// network flushes.
function setConsent(allowed: boolean) {
  if (consentGranted === allowed) return;
  consentGranted = allowed;
  if (!allowed) {
    events = [];
    mouseBatches = [];
    segment = null;
    session = null;
    try {
      sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      // Storage blocked — nothing persisted to remove.
    }
  }
}

function init() {
  if (initialized || typeof window === "undefined") return;
  initialized = true;

  // Keep automated browsers (E2E runs, scrapers) out of the dataset.
  if (navigator.webdriver) {
    disabled = true;
    return;
  }

  // No eager ensureSession() here: creating (and persisting) the
  // session id before the user grants analytics consent would store an
  // identifier on the device pre-consent. Sessions are created lazily
  // by nextSeq() on the first captured event, which only happens once
  // the consent gate is open.

  document.addEventListener("click", handleClick, { capture: true, passive: true });
  document.addEventListener("mousemove", handleMouseMove, { passive: true });

  const flushTimer = setInterval(() => void flush(), FLUSH_INTERVAL_MS);
  const heartbeatTimer = setInterval(() => {
    if (document.visibilityState === "visible") enqueue("heartbeat");
  }, HEARTBEAT_INTERVAL_MS);

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      flushBeacon();
    }
  });
  window.addEventListener("pagehide", () => {
    enqueue("session_end");
    flushBeacon();
    clearInterval(flushTimer);
    clearInterval(heartbeatTimer);
  });
}

export const analyticsTracker = { init, pageView, setConsent };
