// Predicate writers for ZillaPass. Each call site that wants to nudge
// progress imports the matching helper here; the writer dispatches to
// every active task carrying the matching `predicate_key` so multiple
// tasks tied to the same predicate (different target counts, different
// periods) update together.
//
// Writers are best-effort: they swallow errors and log them so a
// transient DB hiccup on the engagement path never breaks the
// originating action (placing a bet, opening a page, saving a profile).

import { and, eq, inArray, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import {
  zillapassTasks,
  zillapassUserProgress,
  zillapassUserState,
  users,
  tickets,
  ticketSelections,
  markets,
  matches,
  tournaments,
  categories,
  sports,
  type ZillapassTask,
} from "@oddzilla/db";

// Period-anchor helper. Daily = UTC date, weekly = monday-of-week,
// season = fixed anchor. MUST stay byte-identical with the same
// function in routes.ts — both produce the period_start key the row is
// stored under, so a drift means a writer increments yesterday while a
// read pulls today and shows 0.
function periodStartKey(
  period: "daily" | "weekly" | "season",
  now: Date,
): string {
  if (period === "daily") {
    return now.toISOString().slice(0, 10);
  }
  if (period === "weekly") {
    const day = now.getUTCDay();
    const mondayOffset = day === 0 ? -6 : 1 - day;
    const monday = new Date(now);
    monday.setUTCDate(now.getUTCDate() + mondayOffset);
    return monday.toISOString().slice(0, 10);
  }
  return "2026-01-01";
}

// ─── profile_complete ───────────────────────────────────────────────────────
//
// Fires from PATCH /community/me/profile (nickname set) and PUT
// /community/me/avatar (avatar equipped). Either entry point re-reads
// the user row to evaluate both fields, so the order of writes doesn't
// matter — the predicate flips when both are populated.

export async function nudgeProfileComplete(
  app: FastifyInstance,
  userId: string,
): Promise<void> {
  try {
    const [u] = await app.db
      .select({
        nickname: users.nickname,
        avatarTemplateId: users.avatarTemplateId,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!u) return;
    const isComplete =
      u.nickname !== null && u.avatarTemplateId !== null;
    if (!isComplete) return;

    const tasks = await activeTasksByPredicate(app, "profile_complete");
    for (const task of tasks) {
      await upsertProgress(app, userId, task, {
        nextCount: task.targetCount,
        nextState: null,
      });
    }
    await maybeStampSetCompletion(app, userId);
  } catch (err) {
    app.log.warn(
      { err: (err as Error).message, userId },
      "zillapass profile_complete nudge failed",
    );
  }
}

// ─── sports_viewed ──────────────────────────────────────────────────────────
//
// progress_state = { sports: [slug, ...] }. count = sports.length.

export async function nudgeSportViewed(
  app: FastifyInstance,
  userId: string,
  sportSlug: string,
): Promise<void> {
  try {
    const tasks = await activeTasksByPredicate(app, "sports_viewed");
    for (const task of tasks) {
      await upsertProgressWithSet(app, userId, task, (state) => {
        const sports = new Set<string>(
          Array.isArray(state.sports) ? (state.sports as string[]) : [],
        );
        sports.add(sportSlug);
        return {
          state: { sports: [...sports] },
          count: sports.size,
        };
      });
    }
    await maybeStampSetCompletion(app, userId);
  } catch (err) {
    app.log.warn(
      { err: (err as Error).message, userId, sportSlug },
      "zillapass sports_viewed nudge failed",
    );
  }
}

// ─── matches_viewed_diff_sports ─────────────────────────────────────────────
//
// progress_state = { sports: [slug, ...], matches: [matchId, ...] }.
// count = sports.size. Re-opening the same matchId is a no-op (it's
// already in `matches`, so neither set grows). Opening a *different*
// match from a sport already counted leaves count unchanged but the
// matchId joins the set (still bounded — a user can only see so many
// matches a day).

export async function nudgeMatchViewed(
  app: FastifyInstance,
  userId: string,
  matchId: string,
  sportSlug: string,
): Promise<void> {
  try {
    const tasks = await activeTasksByPredicate(
      app,
      "matches_viewed_diff_sports",
    );
    for (const task of tasks) {
      await upsertProgressWithSet(app, userId, task, (state) => {
        const matches = new Set<string>(
          Array.isArray(state.matches) ? (state.matches as string[]) : [],
        );
        const sports = new Set<string>(
          Array.isArray(state.sports) ? (state.sports as string[]) : [],
        );
        if (matches.has(matchId)) {
          // Already counted — leave state untouched.
          return {
            state: { matches: [...matches], sports: [...sports] },
            count: sports.size,
          };
        }
        matches.add(matchId);
        sports.add(sportSlug);
        return {
          state: { matches: [...matches], sports: [...sports] },
          count: sports.size,
        };
      });
    }
    await maybeStampSetCompletion(app, userId);
  } catch (err) {
    app.log.warn(
      { err: (err as Error).message, userId, matchId, sportSlug },
      "zillapass matches_viewed_diff_sports nudge failed",
    );
  }
}

// ─── bets_prematch / bets_live / bets_sport_<slug> / bets_product_<kind> ────
//
// Fires from the bet placement route AFTER the placement transaction
// commits. One DB round-trip pulls the ticket's bet_type, every leg's
// match status, and every leg's sport slug. From that we fan out:
//
//   bets_prematch / bets_live  — singles only (legCount === 1, which
//                                ⟺ bet_type='single'). Picks live
//                                when the single leg's match is `live`,
//                                prematch otherwise. Mutually exclusive
//                                so one placement bumps exactly one.
//
//   bets_sport_<slug>          — fires when EVERY leg's sport is the
//                                same slug. Singles trivially qualify;
//                                a pure-CS2 5-fold combo bumps
//                                `bets_sport_cs2` by 1. Mixed-sport
//                                multibets fire no sport task — the
//                                user has a clear path to progress
//                                (place a pure-sport bet next time).
//                                BetBuilder is bound to one match by
//                                construction so it qualifies as
//                                pure-sport for the match's sport.
//
//   bets_product_<kind>        — keyed on the ticket's bet_type:
//                                'combo' / 'tiple' / 'tippot'. Singles
//                                + betbuilder are ignored here; set 4
//                                seeds tasks only for the three
//                                multi-leg products the user picks
//                                explicitly in the slip.

export async function nudgeBetPlaced(
  app: FastifyInstance,
  userId: string,
  ticketId: string,
): Promise<void> {
  try {
    const [ticket] = await app.db
      .select({ betType: tickets.betType })
      .from(tickets)
      .where(eq(tickets.id, ticketId))
      .limit(1);
    if (!ticket) return;

    const legs = await app.db
      .select({
        matchStatus: matches.status,
        sportSlug: sports.slug,
      })
      .from(ticketSelections)
      .innerJoin(markets, eq(markets.id, ticketSelections.marketId))
      .innerJoin(matches, eq(matches.id, markets.matchId))
      .innerJoin(tournaments, eq(tournaments.id, matches.tournamentId))
      .innerJoin(categories, eq(categories.id, tournaments.categoryId))
      .innerJoin(sports, eq(sports.id, categories.sportId))
      .where(eq(ticketSelections.ticketId, ticketId));
    const firstLeg = legs[0];
    if (!firstLeg) return;

    // Singles vs everything else: singles bump prematch/live, every
    // other product (combo / tiple / tippot / betbuilder) skips that
    // path and lands in product / sport dispatch below. 1-leg
    // ⟺ bet_type='single' since combo / tiple / tippot / betbuilder
    // all enforce min-2-legs at placement time.
    if (legs.length === 1) {
      const predicateKey =
        firstLeg.matchStatus === "live" ? "bets_live" : "bets_prematch";
      await incrementByPredicate(app, userId, predicateKey, 1);
    }

    // Sport task: every leg must share the same sport slug. Mixed-sport
    // multibets bump no sport task. Singles trivially qualify with
    // their one leg's sport.
    const firstSport = firstLeg.sportSlug;
    const allSameSport = legs.every((l) => l.sportSlug === firstSport);
    if (allSameSport && firstSport) {
      await incrementByPredicate(
        app,
        userId,
        `bets_sport_${firstSport}`,
        1,
      );
    }

    // Product task: keyed off the ticket's bet_type. Singles +
    // betbuilder don't have tasks in set 4 — only combo / tiple /
    // tippot do, so we only fire when bet_type matches one of them.
    if (
      ticket.betType === "combo" ||
      ticket.betType === "tiple" ||
      ticket.betType === "tippot"
    ) {
      await incrementByPredicate(
        app,
        userId,
        `bets_product_${ticket.betType}`,
        1,
      );
    }

    await maybeStampSetCompletion(app, userId);
  } catch (err) {
    app.log.warn(
      { err: (err as Error).message, userId, ticketId },
      "zillapass bet_placed nudge failed",
    );
  }
}

// ─── market_tab_changes ─────────────────────────────────────────────────────
//
// Fires from the match-page market tab toggle (Match / All / Top /
// Map N) every time the user picks a different scope. Pure counter
// — no dedup. Server clamps to target_count via LEAST so a chatty
// client can't inflate the value past the cap.

export async function nudgeMarketTabChange(
  app: FastifyInstance,
  userId: string,
): Promise<void> {
  try {
    await incrementByPredicate(app, userId, "market_tab_changes", 1);
    await maybeStampSetCompletion(app, userId);
  } catch (err) {
    app.log.warn(
      { err: (err as Error).message, userId },
      "zillapass market_tab_change nudge failed",
    );
  }
}

// ─── Stage / set-completion stamping ────────────────────────────────────────
//
// Called at the end of every nudge. Cheap when there's nothing to do:
// short-circuits if the user has already stamped completion for the
// current set (last_set_completed_date IS NOT NULL).
//
// Logic:
//   1. Load user state (defaults if no row exists: set 1, stamp NULL).
//   2. If stamp is set, return — already done.
//   3. Load every active task with `set_number = current_set_number`.
//      Empty set ⇒ nothing to complete ⇒ return.
//   4. Load progress rows for those tasks for today's relevant period
//      (per task.period). If every task has a row with completed_at
//      IS NOT NULL, stamp last_set_completed_date = TODAY (UTC) via
//      UPSERT so a state row is materialised lazily.
//
// The reader (/zillapass/me) handles the cross-day advancement: stamp
// < today ⇒ current_set_number += 1, stamp ← NULL. Splitting the
// concern this way means the writer never needs to know about
// "tomorrow" — it just records that the set is done.

export async function maybeStampSetCompletion(
  app: FastifyInstance,
  userId: string,
): Promise<void> {
  const [stateRow] = await app.db
    .select({
      currentSetNumber: zillapassUserState.currentSetNumber,
      lastSetCompletedDate: zillapassUserState.lastSetCompletedDate,
    })
    .from(zillapassUserState)
    .where(eq(zillapassUserState.userId, userId))
    .limit(1);

  const currentSetNumber = stateRow?.currentSetNumber ?? 1;
  const lastSetCompletedDate = stateRow?.lastSetCompletedDate ?? null;
  if (lastSetCompletedDate !== null) return; // already stamped

  const currentSetTasks = await app.db
    .select()
    .from(zillapassTasks)
    .where(
      and(
        eq(zillapassTasks.active, true),
        eq(zillapassTasks.setNumber, currentSetNumber),
      ),
    );
  if (currentSetTasks.length === 0) return;

  const now = new Date();
  const today = periodStartKey("daily", now);

  // Pull this user's progress rows for the current set's tasks. The
  // period_start per task can differ (season vs daily), so we filter
  // with a single IN list on task_id, then per-row match the right
  // period_start. Cheap — the set has ~3 tasks today.
  const progressRows = await app.db
    .select({
      taskId: zillapassUserProgress.taskId,
      periodStart: zillapassUserProgress.periodStart,
      completedAt: zillapassUserProgress.completedAt,
    })
    .from(zillapassUserProgress)
    .where(
      and(
        eq(zillapassUserProgress.userId, userId),
        inArray(
          zillapassUserProgress.taskId,
          currentSetTasks.map((t) => t.id),
        ),
      ),
    );

  const byKey = new Map<string, (typeof progressRows)[number]>();
  for (const p of progressRows) byKey.set(`${p.taskId}:${p.periodStart}`, p);

  for (const task of currentSetTasks) {
    const period = periodStartKey(task.period, now);
    const p = byKey.get(`${task.id}:${period}`);
    if (!p || p.completedAt === null) return; // not all complete
  }

  // All complete — stamp today. UPSERT so the state row is created if
  // this is the user's first interaction.
  await app.db
    .insert(zillapassUserState)
    .values({
      userId,
      currentSetNumber,
      lastSetCompletedDate: today,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: zillapassUserState.userId,
      set: {
        lastSetCompletedDate: today,
        updatedAt: now,
      },
    });
}

// ─── Internals ──────────────────────────────────────────────────────────────

// Counter-only increment that doesn't need read-modify-write — atomic
// `current_count + delta` clamped at target. ON CONFLICT lets two
// concurrent nudges merge correctly (postgres serialises the row
// update under the constraint).
async function incrementByPredicate(
  app: FastifyInstance,
  userId: string,
  predicateKey: string,
  delta: number,
): Promise<void> {
  const tasks = await activeTasksByPredicate(app, predicateKey);
  if (tasks.length === 0) return;
  const now = new Date();
  // Pre-converted ISO string for embedding inside `sql\`\`` template
  // fragments: drizzle's typed builders bind JS Date → ISO TIMESTAMPTZ
  // correctly, but Date objects embedded in sql template literals get
  // bound via the driver's default toString() (the human-readable
  // "Sun May 17 2026 21:56:24 GMT+0000 (Coordinated Universal Time)"
  // form), which postgres rejects as TIMESTAMPTZ. We pre-convert and
  // add an explicit ::timestamptz cast so the value is unambiguously
  // a timestamp.
  const nowIso = now.toISOString();
  for (const task of tasks) {
    const period = periodStartKey(task.period, now);
    await app.db
      .insert(zillapassUserProgress)
      .values({
        userId,
        taskId: task.id,
        periodStart: period,
        currentCount: Math.min(delta, task.targetCount),
        progressState: {},
        completedAt:
          delta >= task.targetCount ? now : null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          zillapassUserProgress.userId,
          zillapassUserProgress.taskId,
          zillapassUserProgress.periodStart,
        ],
        set: {
          currentCount: sql`LEAST(${zillapassUserProgress.currentCount} + ${delta}, ${task.targetCount})`,
          // Stamp completedAt the moment the SQL increment crosses
          // target; preserve any existing non-NULL value (re-completes
          // shouldn't refresh the timestamp).
          completedAt: sql`COALESCE(
            ${zillapassUserProgress.completedAt},
            CASE WHEN LEAST(${zillapassUserProgress.currentCount} + ${delta}, ${task.targetCount}) >= ${task.targetCount}
                 THEN ${nowIso}::timestamptz
                 ELSE NULL
            END
          )`,
          updatedAt: now,
        },
      });
  }
}


async function activeTasksByPredicate(
  app: FastifyInstance,
  predicateKey: string,
): Promise<ZillapassTask[]> {
  return app.db
    .select()
    .from(zillapassTasks)
    .where(
      and(
        eq(zillapassTasks.active, true),
        eq(zillapassTasks.predicateKey, predicateKey),
      ),
    );
}

// Counter-only path used by `profile_complete`: caller computes the
// final count + (optionally) state directly, no read-modify-write set
// manipulation. The transaction is still UPSERT with on-conflict
// update so two near-simultaneous nudges converge.
async function upsertProgress(
  app: FastifyInstance,
  userId: string,
  task: ZillapassTask,
  args: { nextCount: number; nextState: Record<string, unknown> | null },
): Promise<void> {
  const now = new Date();
  // See incrementByPredicate for why ${now} inside a sql template gets
  // bound as Date.toString() and breaks the cast — same workaround.
  const nowIso = now.toISOString();
  const period = periodStartKey(task.period, now);
  const reachedTarget = args.nextCount >= task.targetCount;
  // Insert if missing; otherwise update. completedAt is set to NOW()
  // the first time count reaches target — we never roll it back.
  await app.db
    .insert(zillapassUserProgress)
    .values({
      userId,
      taskId: task.id,
      periodStart: period,
      currentCount: Math.min(args.nextCount, task.targetCount),
      progressState: args.nextState ?? {},
      completedAt: reachedTarget ? now : null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        zillapassUserProgress.userId,
        zillapassUserProgress.taskId,
        zillapassUserProgress.periodStart,
      ],
      set: {
        currentCount: sql`GREATEST(${zillapassUserProgress.currentCount}, ${Math.min(
          args.nextCount,
          task.targetCount,
        )})`,
        progressState:
          args.nextState !== null
            ? args.nextState
            : zillapassUserProgress.progressState,
        completedAt: reachedTarget
          ? sql`COALESCE(${zillapassUserProgress.completedAt}, ${nowIso}::timestamptz)`
          : zillapassUserProgress.completedAt,
        updatedAt: now,
      },
    });
}

// Set-shaped path. The reducer reads the current `progress_state` row,
// computes the new set + count, and we write back inside the same
// transaction so two concurrent reducers don't lose an entry. SELECT
// FOR UPDATE serialises per (user, task, period) so the set ops are
// race-free without us holding a global lock.
async function upsertProgressWithSet(
  app: FastifyInstance,
  userId: string,
  task: ZillapassTask,
  reducer: (state: Record<string, unknown>) => {
    state: Record<string, unknown>;
    count: number;
  },
): Promise<void> {
  const now = new Date();
  const period = periodStartKey(task.period, now);

  await app.db.transaction(async (tx) => {
    // SELECT FOR UPDATE to serialise concurrent nudges on the same row.
    // Drizzle's typed query builder doesn't surface FOR UPDATE on
    // composite-PK selects cleanly, so we drop to raw SQL — the shape
    // is fixed.
    const rows = (await tx.execute(sql`
      SELECT current_count, progress_state, completed_at
      FROM zillapass_user_progress
      WHERE user_id = ${userId}
        AND task_id = ${task.id}
        AND period_start = ${period}
      FOR UPDATE
    `)) as unknown as Array<{
      current_count: number;
      progress_state: Record<string, unknown> | null;
      completed_at: Date | null;
    }>;

    const existing = rows[0];
    const startState = (existing?.progress_state ?? {}) as Record<
      string,
      unknown
    >;
    const reduced = reducer(startState);

    const nextCount = Math.min(reduced.count, task.targetCount);
    const reachedTarget = nextCount >= task.targetCount;
    const completedAt =
      existing?.completed_at ?? (reachedTarget ? now : null);

    if (existing) {
      await tx
        .update(zillapassUserProgress)
        .set({
          currentCount: nextCount,
          progressState: reduced.state,
          completedAt,
          updatedAt: now,
        })
        .where(
          and(
            eq(zillapassUserProgress.userId, userId),
            eq(zillapassUserProgress.taskId, task.id),
            eq(zillapassUserProgress.periodStart, period),
          ),
        );
    } else {
      await tx.insert(zillapassUserProgress).values({
        userId,
        taskId: task.id,
        periodStart: period,
        currentCount: nextCount,
        progressState: reduced.state,
        completedAt,
        updatedAt: now,
      });
    }
  });
}
