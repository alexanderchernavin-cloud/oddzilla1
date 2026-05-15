// /community/notifications/* + /community/me/preferences (Phase 12).
//
// Three concerns share this file because they're a single feature
// from the BE's perspective:
//
//   • emit-helper — exported `emitNotification()` consumed by other
//     modules at trigger sites (apply-same-play, analyses, competitions,
//     achievements). Handles pref gating + group-key collapse + insert.
//
//   • bettor routes — list / mark-read / mark-all / preferences. Hot
//     read on panel open; writes on toggle and click.
//
//   • competition auto-enable — the small `ensureCompetitionUpdatesEnabled`
//     helper that the join handler calls so a first-time joiner gets
//     leaderboard/deadline notifications without touching the toggle
//     manually (PRD acceptance criteria NOTIF_25/NOTIF_26).
//
// Design choices repeated from the migration preamble:
//   • Defaults live in two places — DB column defaults AND the
//     `DEFAULT_PREFS` object below. They MUST stay in lockstep.
//     A user with no `user_preferences` row is treated identically
//     to one with all-default values; that lets existing accounts
//     keep working without a backfill.
//   • Pref gating happens at emit time (not read time). A user who
//     toggles "Picks Copied" OFF stops seeing new pick_copied
//     notifications immediately, but past panel rows survive.
//   • Self-emit is silently dropped (apply-same-play on your own
//     ticket, etc.). Returning silently rather than 400ing means
//     callers don't have to special-case the actor==recipient path.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  userNotifications,
  userPreferences,
  users,
} from "@oddzilla/db";
import type {
  MarkReadResponse,
  NotificationItem,
  NotificationListResponse,
  NotificationPayload,
  NotificationType,
  PreferencesResponse,
  PreferencesUpdateRequest,
} from "@oddzilla/types";
import { BadRequestError, NotFoundError } from "../../lib/errors.js";

// ─── Constants ──────────────────────────────────────────────────────────────

// Map notification type → the user_preferences column it gates on.
// Exhaustive at compile time so a future enum value forces a
// reviewer to pick a category. Categories follow PRD's settings
// table verbatim: `analysis_shared` belongs to "Community Highlights"
// (not Picks Copied) per the PRD's own classification.
const TYPE_TO_PREF: Record<NotificationType, keyof typeof DEFAULT_PREFS> = {
  pick_copied: "prefPicksCopied",
  bet_inspired: "prefPicksCopied",
  new_follower: "prefNewFollowers",
  analysis_shared: "prefCommunityHighlights",
  leaderboard_move: "prefCompetitionUpdates",
  competition_deadline: "prefCompetitionUpdates",
  community_digest: "prefCommunityHighlights",
  challenge_completed: "prefAchievementsRewards",
  achievement_unlocked: "prefAchievementsRewards",
  level_up: "prefAchievementsRewards",
  loot_acquired: "prefAchievementsRewards",
};

// Defaults must mirror the column defaults in the migration. A
// missing row is treated as a freshly-inserted one — no backfill
// required for existing users.
const DEFAULT_PREFS = {
  prefPicksCopied: true,
  prefNewFollowers: true,
  prefCompetitionUpdates: false,
  prefCompetitionUpdatesSet: false,
  prefCommunityHighlights: true,
  prefAchievementsRewards: true,
  privacyShowWinLossRecord: true,
  privacyAllowProfileDiscovery: true,
} as const;

// Group-key dedup window. Within this period, repeated emits with
// the same (user, type, group_key) collapse onto one row. PRD's
// "3 people copied your bet" example assumes a bursty ~hour-scale
// window; 24h covers a viral-pick day without collapsing across
// match-day boundaries.
const DEDUP_WINDOW_HOURS = 24;

// Read/write rate limits — same shape as analyses & feed.
const writeRateLimit = { rateLimit: { max: 30, timeWindow: "1 minute" } };
const readRateLimit = { rateLimit: { max: 60, timeWindow: "1 minute" } };

const PAGE_SIZE_DEFAULT = 50;

// ─── Redis cache / rate-limit keys for emit ─────────────────────────────────
//
// The emit helper is reachable from unauthenticated /community/copy
// (60/min/IP) and authenticated /community/analyses/:id/inspire
// (30/min/IP); chained through inspiration / pick_copied each insert is
// up to 3 DB roundtrips against a single target user's notification
// rows. We cap per-target emits at 60/min via INCR — well above any
// real-user burst (PRD's "3 people copied your bet" expects a handful
// per minute peak) but well below the amplification an attacker can
// drive. On Redis blip we fail open: emit goes through, count just
// isn't tracked for that minute.
const EMIT_RATE_KEY = (userId: string) => `notif:emit:${userId}`;
const EMIT_RATE_WINDOW_SECONDS = 60;
const EMIT_RATE_MAX = 60;

// Prefs cache. Same shape as the DB row; serialised as JSON. Hit on
// every emit, so caching saves the first roundtrip on the hot path.
// Invalidated when PATCH /me/preferences writes (below).
const PREFS_CACHE_KEY = (userId: string) => `notif:prefs:${userId}`;
const PREFS_CACHE_TTL_SECONDS = 60;

type CachedPrefs = {
  prefPicksCopied: boolean;
  prefNewFollowers: boolean;
  prefCompetitionUpdates: boolean;
  prefCompetitionUpdatesSet: boolean;
  prefCommunityHighlights: boolean;
  prefAchievementsRewards: boolean;
  privacyShowWinLossRecord: boolean;
  privacyAllowProfileDiscovery: boolean;
};

// ─── emitNotification (exported helper) ─────────────────────────────────────

export interface EmitOptions {
  // Recipient.
  userId: string;
  type: NotificationType;
  // Who caused it. Pass NULL for system emits (digest, level_up).
  // If actorId === userId the call is a no-op (self-emit guard).
  actorId?: string | null;
  // Per-type payload schema; see packages/types/src/community.ts.
  // Stored as a snapshot in JSONB so post-emit edits to actor/match/
  // analysis don't rewrite history.
  payload: NotificationPayload;
  // Optional path the panel routes to on click. The panel handles
  // 404s — no need to FK-validate here.
  deepLink?: string | null;
  // Opaque batching key. NULL = no batching (each emit is its own
  // row). When set, an existing row with the same (user, type, key)
  // within the dedup window absorbs this emit (group_count++, payload
  // refreshed, marked unread).
  groupKey?: string | null;
}

// Fire-and-forget by convention. Returns the row id (or NULL when
// pref-gated / self-emitted / rate-capped) but callers should not
// branch on the return — the contract is "best effort, never block
// the user-facing action."
export async function emitNotification(
  app: FastifyInstance,
  opts: EmitOptions,
): Promise<string | null> {
  // 1. Self-emit guard. Apply-same-play on your own ticket triggers
  // this; the no-op keeps the call site simple.
  if (opts.actorId && opts.actorId === opts.userId) return null;

  // 2. Audit SEC-C1: skip emits whose ACTOR or RECIPIENT is an AI
  // seed bettor. A notification fired BY an AI account is the
  // visibility leak — it surfaces the seed account by name + avatar
  // in the real user's panel. Notifications TO an AI account are
  // harmless (no one reads them), but we drop those too for
  // projection-table cleanliness on a single cheap PK lookup. System
  // emits (actorId == null) always pass this gate. The lookup is
  // bounded by `IN (...)` so actor and recipient stay one round-trip.
  const idsToCheck: string[] = [];
  if (opts.actorId) idsToCheck.push(opts.actorId);
  idsToCheck.push(opts.userId);
  const aiRows = await app.db
    .select({ id: users.id, isAi: users.isAi })
    .from(users)
    .where(inArray(users.id, idsToCheck));
  const aiSet = new Set(aiRows.filter((r) => r.isAi).map((r) => r.id));
  if (opts.actorId && aiSet.has(opts.actorId)) {
    app.log.warn(
      { actorId: opts.actorId, userId: opts.userId, type: opts.type },
      "notification emit dropped — actor flagged is_ai",
    );
    return null;
  }
  if (aiSet.has(opts.userId)) {
    // Recipient is_ai. Expected for emits TO a seed bettor (harmless,
    // no one reads them) — but if a real user is mis-flagged is_ai
    // they silently receive zero notifications across all 11 types.
    // Logging here surfaces that misclassification to ops without
    // adding a cost to the hot path.
    app.log.warn(
      { userId: opts.userId, type: opts.type, actorId: opts.actorId ?? null },
      "notification emit dropped — recipient flagged is_ai",
    );
    return null;
  }

  // 3. Per-target rate cap (audit SEC-H3). Closes the amplification
  // path where an attacker uses /community/copy or
  // /analyses/:id/inspire to drive notification inserts against a
  // victim. Same INCR + EXPIRE shape as auth/service.ts login-fail
  // tracking. Fail open on Redis blip — the calling path is
  // best-effort and we'd rather drop a metric than 500 the
  // user-facing action.
  try {
    const key = EMIT_RATE_KEY(opts.userId);
    const count = await app.redis.incr(key);
    if (count === 1) {
      await app.redis.expire(key, EMIT_RATE_WINDOW_SECONDS);
    }
    if (count > EMIT_RATE_MAX) {
      app.log.warn(
        { userId: opts.userId, type: opts.type, count },
        "notification emit rate-capped",
      );
      return null;
    }
  } catch {
    // Redis blip — proceed without the cap.
  }

  // 4. Pref gate. Try Redis cache first; on miss, read the row (or
  // use defaults) and cache. The column lookup is exhaustive over
  // NotificationType so an unknown type is a compile error, not a
  // runtime fall-through.
  let prefs: CachedPrefs | typeof DEFAULT_PREFS;
  let cached: string | null = null;
  try {
    cached = await app.redis.get(PREFS_CACHE_KEY(opts.userId));
  } catch {
    // Redis blip — fall through to DB read.
  }
  if (cached) {
    try {
      prefs = JSON.parse(cached) as CachedPrefs;
    } catch {
      prefs = DEFAULT_PREFS;
    }
  } else {
    const [prefRow] = await app.db
      .select({
        prefPicksCopied: userPreferences.prefPicksCopied,
        prefNewFollowers: userPreferences.prefNewFollowers,
        prefCompetitionUpdates: userPreferences.prefCompetitionUpdates,
        prefCompetitionUpdatesSet: userPreferences.prefCompetitionUpdatesSet,
        prefCommunityHighlights: userPreferences.prefCommunityHighlights,
        prefAchievementsRewards: userPreferences.prefAchievementsRewards,
        privacyShowWinLossRecord: userPreferences.privacyShowWinLossRecord,
        privacyAllowProfileDiscovery:
          userPreferences.privacyAllowProfileDiscovery,
      })
      .from(userPreferences)
      .where(eq(userPreferences.userId, opts.userId))
      .limit(1);
    prefs = prefRow ?? DEFAULT_PREFS;
    // Cache the resolved prefs (including the defaults case — a
    // user without a row gets the same gating decisions repeatedly).
    try {
      await app.redis.set(
        PREFS_CACHE_KEY(opts.userId),
        JSON.stringify(prefs),
        "EX",
        PREFS_CACHE_TTL_SECONDS,
      );
    } catch {
      // ignore — best effort
    }
  }
  if (!prefs[TYPE_TO_PREF[opts.type]]) return null;

  // 4. Group collapse. Look for an existing groupable row in the
  // window; if found, refresh it.
  if (opts.groupKey) {
    const [existing] = await app.db
      .select({ id: userNotifications.id })
      .from(userNotifications)
      .where(
        and(
          eq(userNotifications.userId, opts.userId),
          eq(userNotifications.type, opts.type),
          eq(userNotifications.groupKey, opts.groupKey),
          sql`${userNotifications.createdAt} > now() - (${DEDUP_WINDOW_HOURS} || ' hours')::interval`,
        ),
      )
      .orderBy(desc(userNotifications.createdAt))
      .limit(1);
    if (existing) {
      await app.db
        .update(userNotifications)
        .set({
          actorId: opts.actorId ?? null,
          payload: opts.payload as object,
          deepLink: opts.deepLink ?? null,
          groupCount: sql`${userNotifications.groupCount} + 1`,
          createdAt: new Date(),
          readAt: null,
        })
        .where(eq(userNotifications.id, existing.id));
      return existing.id;
    }
  }

  // 5. Fresh insert.
  const [inserted] = await app.db
    .insert(userNotifications)
    .values({
      userId: opts.userId,
      type: opts.type,
      actorId: opts.actorId ?? null,
      payload: opts.payload as object,
      deepLink: opts.deepLink ?? null,
      groupKey: opts.groupKey ?? null,
    })
    .returning({ id: userNotifications.id });
  return inserted?.id ?? null;
}

// Auto-enable Competition Updates on first competition join. Only
// flips the flag if the user has not manually toggled it
// (`pref_competition_updates_set = FALSE`). Idempotent — re-joining
// or joining a second comp is a no-op once the flag is ON.
//
// Implemented as a single UPSERT so the read-modify-write is atomic
// against a concurrent /me/preferences PATCH; without that, a race
// could overwrite a user's just-set OFF with our auto-enable.
export async function ensureCompetitionUpdatesEnabled(
  app: FastifyInstance,
  userId: string,
): Promise<void> {
  await app.db.execute(sql`
    INSERT INTO user_preferences (user_id, pref_competition_updates)
    VALUES (${userId}, TRUE)
    ON CONFLICT (user_id) DO UPDATE
       SET pref_competition_updates = TRUE,
           updated_at = now()
     WHERE user_preferences.pref_competition_updates_set = FALSE
  `);
  // Invalidate the prefs cache — the UPSERT may have flipped
  // pref_competition_updates from FALSE to TRUE, and the next emit
  // for leaderboard_move / competition_deadline needs the fresh
  // value to gate correctly.
  try {
    await app.redis.del(PREFS_CACHE_KEY(userId));
  } catch {
    // ignore — best effort
  }
}

// ─── Routes ─────────────────────────────────────────────────────────────────

const listQuery = z.object({
  pageSize: z.coerce.number().int().min(1).max(100).default(PAGE_SIZE_DEFAULT),
});

const idParams = z.object({
  id: z
    .string()
    .regex(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      "id_invalid",
    ),
});

const prefsBody = z
  .object({
    notifications: z
      .object({
        picksCopied: z.boolean().optional(),
        newFollowers: z.boolean().optional(),
        competitionUpdates: z.boolean().optional(),
        communityHighlights: z.boolean().optional(),
        achievementsRewards: z.boolean().optional(),
      })
      .strict()
      .optional(),
    privacy: z
      .object({
        sharePublicly: z.boolean().optional(),
        showWinLossRecord: z.boolean().optional(),
        allowProfileDiscovery: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

// Common projection used by both GET and PATCH responses. Returning
// the same shape from both means the FE can replace state wholesale
// after a write — no second GET round-trip.
async function loadPreferences(
  app: FastifyInstance,
  userId: string,
): Promise<PreferencesResponse> {
  const [u] = await app.db
    .select({ ticketsPublic: users.ticketsPublic })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!u) throw new NotFoundError();
  const [p] = await app.db
    .select()
    .from(userPreferences)
    .where(eq(userPreferences.userId, userId))
    .limit(1);
  const prefs = p ?? DEFAULT_PREFS;
  return {
    notifications: {
      picksCopied: prefs.prefPicksCopied,
      newFollowers: prefs.prefNewFollowers,
      competitionUpdates: prefs.prefCompetitionUpdates,
      competitionUpdatesManuallySet: prefs.prefCompetitionUpdatesSet,
      communityHighlights: prefs.prefCommunityHighlights,
      achievementsRewards: prefs.prefAchievementsRewards,
    },
    privacy: {
      sharePublicly: u.ticketsPublic,
      showWinLossRecord: prefs.privacyShowWinLossRecord,
      allowProfileDiscovery: prefs.privacyAllowProfileDiscovery,
    },
  };
}

// The hot GET path used to fan out a separate `loadUnreadCount` for
// the bell badge; that COUNT is now folded into the list SELECT via a
// window function (see the GET route below), eliminating one
// round-trip per 60s poll (~167 qps savings at 10K concurrent
// pollers). The mark-read mutations get their post-write count from
// the same CTE that performs the UPDATE — single round-trip there too
// — so we don't need a shared helper anymore.

export default async function communityNotificationsRoutes(
  app: FastifyInstance,
) {
  // ─── GET /community/notifications ────────────────────────────────────────
  //
  // Returns the most-recent N for the caller, newest first. The bell
  // badge reads `unreadCount` directly from this response so the panel
  // doesn't fan out two requests on open.
  app.get(
    "/community/notifications",
    { config: readRateLimit },
    async (request): Promise<NotificationListResponse> => {
      const u = request.requireAuth();
      const q = listQuery.parse(request.query);

      // Window-function trick: COUNT(*) FILTER (WHERE read_at IS NULL)
      // OVER () runs once across the same index scan as the list
      // SELECT, so a 50-row read carries the total-unread back on each
      // row "for free" instead of doing a second COUNT roundtrip. We
      // pick it off the first row; empty result → 0.
      const rows = await app.db.execute<{
        id: string;
        type: string;
        payload: Record<string, unknown> | null;
        deep_link: string | null;
        group_count: number;
        read_at: Date | string | null;
        created_at: Date | string;
        unread_total: number;
      }>(sql`
        SELECT id,
               type::text                                                AS type,
               payload,
               deep_link,
               group_count,
               read_at,
               created_at,
               (COUNT(*) FILTER (WHERE read_at IS NULL) OVER ())::int    AS unread_total
          FROM user_notifications
         WHERE user_id = ${u.id}
         ORDER BY created_at DESC
         LIMIT ${q.pageSize}
      `);

      const items: NotificationItem[] = rows.map((r) => {
        const payload = (r.payload as Record<string, unknown> | null) ?? {};
        const actor = payload.actorNickname;
        const createdAt =
          r.created_at instanceof Date
            ? r.created_at
            : new Date(r.created_at);
        return {
          id: r.id,
          type: r.type as NotificationType,
          actorNickname: typeof actor === "string" ? actor : null,
          payload,
          deepLink: r.deep_link,
          groupCount: r.group_count,
          read: r.read_at !== null,
          createdAt: createdAt.toISOString(),
        };
      });
      // unread_total is identical on every row (window function over
      // the full result set); take it from the first or default to 0
      // when there are no rows.
      const unreadCount = Number(rows[0]?.unread_total ?? 0);
      return { items, unreadCount };
    },
  );

  // ─── POST /community/notifications/:id/read ──────────────────────────────
  //
  // Mark one row as read. Idempotent — double-tap returns the current
  // unreadCount without erroring. 404 only on truly unknown ids.
  //
  // Single-statement CTE: the UPDATE's RETURNING tells us whether the
  // row was previously unread (the WHERE clause already filtered on
  // read_at IS NULL, so any returned id means "yes, was unread"), and
  // a sibling SELECT in the same statement counts the remaining
  // unread rows. One round-trip instead of two (update + count). The
  // existence check for 404 differentiation is folded in too via the
  // `exists` CTE.
  app.post(
    "/community/notifications/:id/read",
    { config: writeRateLimit },
    async (request): Promise<MarkReadResponse> => {
      const u = request.requireAuth();
      const { id } = idParams.parse(request.params);
      const rows = await app.db.execute<{
        was_unread: boolean;
        row_exists: boolean;
        unread_total: number;
      }>(sql`
        WITH updated AS (
          UPDATE user_notifications
             SET read_at = now()
           WHERE id = ${id}
             AND user_id = ${u.id}
             AND read_at IS NULL
          RETURNING id
        ),
        ownership AS (
          SELECT 1 FROM user_notifications
           WHERE id = ${id} AND user_id = ${u.id}
        )
        SELECT
          EXISTS(SELECT 1 FROM updated)   AS was_unread,
          EXISTS(SELECT 1 FROM ownership) AS row_exists,
          (
            SELECT COUNT(*)::int FROM user_notifications
             WHERE user_id = ${u.id} AND read_at IS NULL
          )                               AS unread_total
      `);
      const r = rows[0];
      if (!r?.row_exists) throw new NotFoundError();
      return { unreadCount: Number(r.unread_total ?? 0) };
    },
  );

  // ─── POST /community/notifications/read-all ──────────────────────────────
  //
  // Bulk mark-read for the "Mark all read" link in the panel header.
  // Post-update the count is necessarily 0, so we skip the re-count
  // and return a constant — same contract, one fewer roundtrip.
  app.post(
    "/community/notifications/read-all",
    { config: writeRateLimit },
    async (request): Promise<MarkReadResponse> => {
      const u = request.requireAuth();
      await app.db
        .update(userNotifications)
        .set({ readAt: new Date() })
        .where(
          and(
            eq(userNotifications.userId, u.id),
            sql`${userNotifications.readAt} IS NULL`,
          ),
        );
      return { unreadCount: 0 };
    },
  );

  // ─── GET /community/me/preferences ───────────────────────────────────────
  //
  // Returns the unified preferences shape. `sharePublicly` is read
  // from users.ticketsPublic; everything else from user_preferences
  // (or defaults when no row).
  app.get(
    "/community/me/preferences",
    { config: readRateLimit },
    async (request): Promise<PreferencesResponse> => {
      const u = request.requireAuth();
      return loadPreferences(app, u.id);
    },
  );

  // ─── PATCH /community/me/preferences ─────────────────────────────────────
  //
  // Partial update across both halves. `notifications.competitionUpdates`
  // also flips the manual-set companion to TRUE so subsequent
  // competition joins won't auto-re-enable it. `privacy.sharePublicly`
  // is forwarded to users.ticketsPublic — same write path the betslip
  // uses, kept aligned by writing through one column.
  app.patch(
    "/community/me/preferences",
    { config: writeRateLimit },
    async (request): Promise<PreferencesResponse> => {
      const u = request.requireAuth();
      const body: PreferencesUpdateRequest = prefsBody.parse(request.body);

      const hasNotif =
        body.notifications &&
        Object.keys(body.notifications).length > 0;
      const hasPriv = body.privacy && Object.keys(body.privacy).length > 0;
      if (!hasNotif && !hasPriv) {
        throw new BadRequestError("preference_invalid", "preference_invalid");
      }

      const prefPatch: Partial<typeof userPreferences.$inferInsert> = {};
      if (body.notifications) {
        const n = body.notifications;
        if (n.picksCopied !== undefined) prefPatch.prefPicksCopied = n.picksCopied;
        if (n.newFollowers !== undefined)
          prefPatch.prefNewFollowers = n.newFollowers;
        if (n.competitionUpdates !== undefined) {
          prefPatch.prefCompetitionUpdates = n.competitionUpdates;
          // Manual toggle disables auto-enable on subsequent joins.
          prefPatch.prefCompetitionUpdatesSet = true;
        }
        if (n.communityHighlights !== undefined)
          prefPatch.prefCommunityHighlights = n.communityHighlights;
        if (n.achievementsRewards !== undefined)
          prefPatch.prefAchievementsRewards = n.achievementsRewards;
      }
      if (body.privacy) {
        if (body.privacy.showWinLossRecord !== undefined)
          prefPatch.privacyShowWinLossRecord = body.privacy.showWinLossRecord;
        if (body.privacy.allowProfileDiscovery !== undefined)
          prefPatch.privacyAllowProfileDiscovery =
            body.privacy.allowProfileDiscovery;
      }

      // Only touch user_preferences if we have user_preferences-bound
      // fields. UPSERT so first-time writers don't 404 on a missing
      // row.
      if (Object.keys(prefPatch).length > 0) {
        prefPatch.updatedAt = new Date();
        await app.db
          .insert(userPreferences)
          .values({ userId: u.id, ...prefPatch })
          .onConflictDoUpdate({
            target: userPreferences.userId,
            set: prefPatch,
          });
      }

      // sharePublicly maps to users.ticketsPublic. Written separately
      // to keep the existing betslip/visibility writers aligned to
      // one column.
      if (body.privacy?.sharePublicly !== undefined) {
        await app.db
          .update(users)
          .set({
            ticketsPublic: body.privacy.sharePublicly,
            updatedAt: new Date(),
          })
          .where(eq(users.id, u.id));
      }

      // Invalidate the per-user prefs cache so the next emit picks up
      // the new gating immediately. Without this, a user toggling
      // "Picks Copied" off could keep receiving emits for up to 60s
      // (the cache TTL).
      try {
        await app.redis.del(PREFS_CACHE_KEY(u.id));
      } catch {
        // ignore — best effort
      }

      return loadPreferences(app, u.id);
    },
  );
}
