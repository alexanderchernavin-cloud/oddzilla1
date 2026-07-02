// First-party FE analytics — wire shapes shared by the storefront
// tracker (apps/web/src/lib/analytics/), the collect endpoint
// (services/api/src/modules/analytics/), and the admin dashboard
// (services/api/src/modules/admin/analytics.ts + /admin/analytics).

export const ANALYTICS_EVENT_KINDS = [
  "page_view",
  "click",
  "heartbeat",
  "session_end",
] as const;

export type AnalyticsEventKind = (typeof ANALYTICS_EVENT_KINDS)[number];

// Server-enforced caps (zod) — the client stays under them by design.
export const ANALYTICS_MAX_EVENTS_PER_REQUEST = 200;
export const ANALYTICS_MAX_MOUSE_BATCHES_PER_REQUEST = 20;
// Mirrors the DB CHECK on analytics_mouse_batches.point_count.
export const ANALYTICS_MAX_POINTS_PER_BATCH = 1000;

// Click target descriptor captured at the click event. Everything is
// best-effort and length-capped server-side; `text` is a short trimmed
// snippet, never full content.
export type AnalyticsClickPayload = {
  // Compact human descriptor precomputed at capture time
  // ("button#place-bet", "a[/match/123]", 'button "Place bet"') so the
  // admin "top clicked elements" aggregation is a plain GROUP BY.
  label: string;
  tag: string;
  id?: string;
  testid?: string;
  cls?: string;
  text?: string;
  href?: string;
  // Viewport px at click time.
  x: number;
  y: number;
  // Scroll offsets, so clicks can be mapped into page space.
  sx?: number;
  sy?: number;
};

export type AnalyticsWireEvent = {
  // Per-session monotonic counter (shared with mouse batches) — exact
  // journey order + server-side apply-once under batch re-delivery.
  seq: number;
  kind: AnalyticsEventKind;
  // Client clock, epoch ms. The server clamps to a sane window.
  ts: number;
  path?: string;
  section?: string;
  payload?: Record<string, unknown>;
};

export type AnalyticsMouseWireBatch = {
  seq: number;
  path: string;
  startTs: number;
  durationMs: number;
  viewportW: number;
  viewportH: number;
  // [dtMs, x, y] — dt relative to startTs, x/y viewport px.
  points: [number, number, number][];
};

export type AnalyticsCollectRequest = {
  sessionId: string;
  // Session start per the client clock, epoch ms.
  startedAt: number;
  // Sent on the first flush of a session (and harmless on repeats).
  meta?: {
    entryPath?: string;
    referrer?: string;
    viewportW?: number;
    viewportH?: number;
  };
  events: AnalyticsWireEvent[];
  mouse?: AnalyticsMouseWireBatch[];
};

// ── Admin dashboard shapes ────────────────────────────────────────────

export type AdminAnalyticsOverview = {
  rangeDays: number;
  totals: {
    sessions: number;
    identifiedSessions: number;
    uniqueUsers: number;
    pageViews: number;
    clicks: number;
    avgSessionSeconds: number;
    medianSessionSeconds: number;
  };
  sessionsPerDay: { day: string; sessions: number; pageViews: number }[];
  topSections: { section: string; views: number; share: number }[];
  topPaths: { path: string; views: number }[];
  topClickTargets: { label: string; clicks: number }[];
};

export type AdminAnalyticsSessionSummary = {
  id: string;
  userId: string | null;
  userEmail: string | null;
  startedAt: string;
  lastSeenAt: string;
  durationSeconds: number;
  entryPath: string | null;
  exitPath: string | null;
  pageViewCount: number;
  clickCount: number;
  eventCount: number;
  mouseBatchCount: number;
};

export type AdminAnalyticsEventRow = {
  seq: number;
  kind: string;
  occurredAt: string;
  path: string | null;
  section: string | null;
  payload: Record<string, unknown> | null;
};

export type AdminAnalyticsSessionDetail = {
  session: AdminAnalyticsSessionSummary & {
    referrer: string | null;
    userAgent: string | null;
    viewportW: number | null;
    viewportH: number | null;
  };
  events: AdminAnalyticsEventRow[];
  // Paths that have mouse trails, so the UI offers replay per page.
  mousePaths: { path: string; batchCount: number; pointCount: number }[];
};

export type AdminAnalyticsMouseTrail = {
  seq: number;
  startedAt: string;
  durationMs: number;
  viewportW: number | null;
  viewportH: number | null;
  points: [number, number, number][];
};
