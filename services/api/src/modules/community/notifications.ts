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
  prefCommunityHighlights: false,
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
// pref-gated / self-emitted) but callers should not branch on the
// return — the contract is "best effort, never block the user-facing
// action."
export async function emitNotification(
  app: FastifyInstance,
  opts: EmitOptions,
): Promise<string | null> {
  // 1. Self-emit guard. Apply-same-play on your own ticket triggers
  // this; the no-op keeps the call site simple.
  if (opts.actorId && opts.actorId === opts.userId) return null;

  // 2. Audit SEC-C1: skip emits whose ACTOR is an AI seed bettor.
  // A notification fired BY an AI account is the visibility leak —
  // it surfaces the seed account by name + avatar in the real user's
  // panel. Notifications TO an AI account are harmless (no one reads
  // them), but we drop those too for projection-table cleanliness on
  // a single cheap PK lookup. System emits (actorId == null) always
  // pass this gate. The lookup is bounded by `IN (...)` so authored
  // and recipient stay one round-trip.
  const idsToCheck: string[] = [];
  if (opts.actorId) idsToCheck.push(opts.actorId);
  idsToCheck.push(opts.userId);
  const aiRows = await app.db
    .select({ id: users.id, isAi: users.isAi })
    .from(users)
    .where(inArray(users.id, idsToCheck));
  const aiSet = new Set(aiRows.filter((r) => r.isAi).map((r) => r.id));
  if (opts.actorId && aiSet.has(opts.actorId)) return null;
  if (aiSet.has(opts.userId)) return null;

  // 3. Pref gate. Read the row (or use defaults). The column lookup
  // is exhaustive over NotificationType so an unknown type is a
  // compile error, not a runtime fall-through.
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
  const prefs = prefRow ?? DEFAULT_PREFS;
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

async function loadUnreadCount(
  app: FastifyInstance,
  userId: string,
): Promise<number> {
  const rows = await app.db.execute<{ count: number }>(sql`
    SELECT COUNT(*)::int AS count
      FROM user_notifications
     WHERE user_id = ${userId} AND read_at IS NULL
  `);
  return Number(rows[0]?.count ?? 0);
}

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

      const rows = await app.db
        .select({
          id: userNotifications.id,
          type: userNotifications.type,
          payload: userNotifications.payload,
          deepLink: userNotifications.deepLink,
          groupCount: userNotifications.groupCount,
          readAt: userNotifications.readAt,
          createdAt: userNotifications.createdAt,
        })
        .from(userNotifications)
        .where(eq(userNotifications.userId, u.id))
        .orderBy(desc(userNotifications.createdAt))
        .limit(q.pageSize);

      const items: NotificationItem[] = rows.map((r) => {
        const payload = (r.payload as Record<string, unknown> | null) ?? {};
        const actor = payload.actorNickname;
        return {
          id: r.id,
          type: r.type as NotificationType,
          actorNickname: typeof actor === "string" ? actor : null,
          payload,
          deepLink: r.deepLink,
          groupCount: r.groupCount,
          read: r.readAt !== null,
          createdAt: r.createdAt.toISOString(),
        };
      });
      return { items, unreadCount: await loadUnreadCount(app, u.id) };
    },
  );

  // ─── POST /community/notifications/:id/read ──────────────────────────────
  //
  // Mark one row as read. Idempotent — double-tap returns the current
  // unreadCount without erroring. 404 only on truly unknown ids.
  app.post(
    "/community/notifications/:id/read",
    { config: writeRateLimit },
    async (request): Promise<MarkReadResponse> => {
      const u = request.requireAuth();
      const { id } = idParams.parse(request.params);
      const updated = await app.db
        .update(userNotifications)
        .set({ readAt: new Date() })
        .where(
          and(
            eq(userNotifications.id, id),
            eq(userNotifications.userId, u.id),
            sql`${userNotifications.readAt} IS NULL`,
          ),
        )
        .returning({ id: userNotifications.id });
      if (updated.length === 0) {
        // No-op when already read; 404 only when the id genuinely
        // isn't ours.
        const [exists] = await app.db
          .select({ id: userNotifications.id })
          .from(userNotifications)
          .where(
            and(
              eq(userNotifications.id, id),
              eq(userNotifications.userId, u.id),
            ),
          )
          .limit(1);
        if (!exists) throw new NotFoundError();
      }
      return { unreadCount: await loadUnreadCount(app, u.id) };
    },
  );

  // ─── POST /community/notifications/read-all ──────────────────────────────
  //
  // Bulk mark-read for the "Mark all read" link in the panel header.
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

      return loadPreferences(app, u.id);
    },
  );
}
