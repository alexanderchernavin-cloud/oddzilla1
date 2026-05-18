// User-facing ZillaPass endpoints.
//
// GET /zillapass/me — returns the user's active tasks (with per-period
// progress folded in), aggregate counters for the top-bar chip, and
// the user's pass state (level / xp / streak).
//
// No progress mutation today — placement / win hooks land in a follow-up
// once the predicate vocabulary is locked. Until then `current_count`
// stays at 0 for every task and `state` is created lazily at default
// values on first read.

import type { FastifyInstance } from "fastify";
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  zillapassTasks,
  zillapassUserProgress,
  zillapassUserState,
} from "@oddzilla/db";
import type {
  ZillapassActiveTaskDto,
  ZillapassMeResponse,
  ZillapassUserStateDto,
} from "@oddzilla/types";
import {
  nudgeMarketTabChange,
  nudgeMatchViewed,
  nudgeSportViewed,
} from "./writer.js";

// Normalised period anchor. Daily = today, weekly = monday of this
// week, season = '2026-01-01' (a single fixed anchor for the V1 cut
// since seasons are short-lived and the operator can wipe season
// rows directly when rolling a new season). Writers consult the same
// helper so reads + writes share a key.
function periodStart(
  period: "daily" | "weekly" | "season",
  now: Date,
): string {
  if (period === "daily") {
    return now.toISOString().slice(0, 10);
  }
  if (period === "weekly") {
    const day = now.getUTCDay(); // 0 = Sunday
    const mondayOffset = day === 0 ? -6 : 1 - day;
    const monday = new Date(now);
    monday.setUTCDate(now.getUTCDate() + mondayOffset);
    return monday.toISOString().slice(0, 10);
  }
  // season — fixed anchor for V1
  return "2026-01-01";
}

// Builds the `/zillapass/me`-shaped response for a user. Extracted so
// /zillapass/track can return the same shape inline after a nudge,
// saving the chip a second roundtrip and letting the UI flip the
// progress bar within the same render tick.
async function buildMeResponse(
  app: FastifyInstance,
  userId: string,
): Promise<ZillapassMeResponse> {
  const now = new Date();
  const todayUtc = now.toISOString().slice(0, 10);

  // ── Stage advancement check (cross-day) ──────────────────────────────
  // If the user stamped completion on a prior UTC day, advance them
  // to the next set now and clear the stamp. State row is upserted
  // so it materialises lazily on the first advancement. Pre-stage
  // users (no row) skip this entirely — they start at set 1.
  const [stateBefore] = await app.db
    .select()
    .from(zillapassUserState)
    .where(eq(zillapassUserState.userId, userId))
    .limit(1);

  let currentSetNumber = stateBefore?.currentSetNumber ?? 1;
  if (
    stateBefore?.lastSetCompletedDate &&
    stateBefore.lastSetCompletedDate < todayUtc
  ) {
    currentSetNumber = stateBefore.currentSetNumber + 1;
    await app.db
      .update(zillapassUserState)
      .set({
        currentSetNumber,
        lastSetCompletedDate: null,
        updatedAt: now,
      })
      .where(eq(zillapassUserState.userId, userId));
  }

  // Active task catalog filtered to the user's current set.
  const tasks = await app.db
    .select()
    .from(zillapassTasks)
    .where(
      and(
        eq(zillapassTasks.active, true),
        eq(zillapassTasks.setNumber, currentSetNumber),
      ),
    )
    .orderBy(asc(zillapassTasks.sortOrder), asc(zillapassTasks.id));

  // Bundle the per-(user, task, period_start) progress lookups into
  // one IN-list query. Each task pulls its own period anchor; the
  // composite IN over (task_id, period_start) is fine here because
  // active task counts stay tiny.
  let progressRows: Array<{
    taskId: number;
    periodStart: string;
    currentCount: number;
    completedAt: Date | null;
  }> = [];
  if (tasks.length > 0) {
    const taskIds = tasks.map((t) => t.id);
    const fetched = await app.db
      .select({
        taskId: zillapassUserProgress.taskId,
        periodStart: zillapassUserProgress.periodStart,
        currentCount: zillapassUserProgress.currentCount,
        completedAt: zillapassUserProgress.completedAt,
      })
      .from(zillapassUserProgress)
      .where(
        and(
          eq(zillapassUserProgress.userId, userId),
          inArray(zillapassUserProgress.taskId, taskIds),
        ),
      );
    progressRows = fetched;
  }

  const progressByTask = new Map<string, (typeof progressRows)[number]>();
  for (const p of progressRows) {
    progressByTask.set(`${p.taskId}:${p.periodStart}`, p);
  }

  const activeTasks: ZillapassActiveTaskDto[] = tasks.map((t) => {
    const key = `${t.id}:${periodStart(t.period, now)}`;
    const p = progressByTask.get(key);
    return {
      id: t.id,
      slug: t.slug,
      title: t.title,
      description: t.description,
      targetCount: t.targetCount,
      currentCount: p?.currentCount ?? 0,
      period: t.period,
      rewardKind: t.rewardKind,
      rewardPayload: t.rewardPayload,
      ctaHref: t.ctaHref,
      ctaLabel: t.ctaLabel,
      sortOrder: t.sortOrder,
      completedAt: p?.completedAt ? p.completedAt.toISOString() : null,
    };
  });

  const completedTasks = activeTasks.filter((t) => t.completedAt !== null)
    .length;

  // Build the response state from the pre-advancement row + the
  // (possibly bumped) currentSetNumber. Avoids a second SELECT; we
  // already know the final advanced state from the path above.
  // Defaults mirror the column defaults so a fresh user sees a
  // consistent shape.
  const advanced =
    stateBefore?.lastSetCompletedDate !== undefined &&
    stateBefore?.lastSetCompletedDate !== null &&
    stateBefore.lastSetCompletedDate < todayUtc;
  const state: ZillapassUserStateDto = stateBefore
    ? {
        level: stateBefore.level,
        xp: stateBefore.xp,
        activeStreakDays: stateBefore.activeStreakDays,
        lastActiveDate: stateBefore.lastActiveDate ?? null,
        currentSetNumber,
        lastSetCompletedDate: advanced
          ? null
          : stateBefore.lastSetCompletedDate ?? null,
      }
    : {
        level: 1,
        xp: 0,
        activeStreakDays: 0,
        lastActiveDate: null,
        currentSetNumber: 1,
        lastSetCompletedDate: null,
      };

  return {
    totalActiveTasks: activeTasks.length,
    completedTasks,
    tasks: activeTasks,
    state,
  };
}

export default async function zillapassUserRoutes(app: FastifyInstance) {
  app.get("/zillapass/me", async (request): Promise<ZillapassMeResponse> => {
    const user = request.requireAuth();
    return buildMeResponse(app, user.id);
  });

  // ─── Event tracking ──────────────────────────────────────────────────────
  //
  // Frontend fires a track event on /sport/:slug + /match/:id page
  // mount (signed-in users only). Discriminated union body so we can
  // grow the event vocabulary without proliferating endpoints.
  //
  // Server-side validation is light — slug + uuid shape only. The
  // catalog is the source of truth for which slugs / ids are "real";
  // accepting a typo here at worst inflates a user's set by one
  // garbage entry, and there's no money or visibility consequence.
  const trackBody = z.discriminatedUnion("event", [
    z.object({
      event: z.literal("sport_view"),
      sportSlug: z
        .string()
        .min(1)
        .max(60)
        .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    }),
    z.object({
      event: z.literal("match_view"),
      // matches.id is a bigserial (Postgres bigint) serialised to a
      // numeric string by /catalog/matches/:id and the storefront's
      // match links. Originally accepted as `.uuid()` here, which
      // rejected every legitimate match-view POST with a silent 400.
      // Accept up to 32 digits — way past bigint's 19-digit cap; the
      // upper bound just stops a hostile client from filing a 10 MB
      // string at the JSON parser.
      matchId: z.string().regex(/^\d{1,32}$/),
      sportSlug: z
        .string()
        .min(1)
        .max(60)
        .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    }),
    // No payload — just a "I clicked a different scope tab" signal.
    // Server clamps to target_count via LEAST so a chatty client
    // can't inflate progress past the cap.
    z.object({
      event: z.literal("market_tab_change"),
    }),
  ]);

  // Returns the FRESH /zillapass/me-shaped state inline. Lets the
  // chip flip its progress bar in one round-trip — no second fetch,
  // no race between writer commit and a follow-up read.
  app.post("/zillapass/track", async (request): Promise<ZillapassMeResponse> => {
    const user = request.requireAuth();
    const body = trackBody.parse(request.body);
    if (body.event === "sport_view") {
      await nudgeSportViewed(app, user.id, body.sportSlug);
    } else if (body.event === "match_view") {
      await nudgeMatchViewed(app, user.id, body.matchId, body.sportSlug);
    } else {
      await nudgeMarketTabChange(app, user.id);
    }
    return buildMeResponse(app, user.id);
  });
}
