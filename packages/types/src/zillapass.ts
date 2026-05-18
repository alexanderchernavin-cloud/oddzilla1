// ZillaPass shared types.
//
// Tasks are admin-curated; per-user progress and state are read-only
// for the storefront in this initial cut. Once the predicate hooks
// land, the writer will mutate `currentCount` + `state.xp` etc. via
// internal calls; the storefront still only reads these shapes.

export type ZillapassPeriod = "daily" | "weekly" | "season";

export interface ZillapassTaskDto {
  id: number;
  slug: string;
  title: string;
  description: string | null;
  targetCount: number;
  predicateKey: string;
  period: ZillapassPeriod;
  // Stage (set) the task belongs to. Users see only tasks where
  // `setNumber` matches their `state.currentSetNumber`.
  setNumber: number;
  rewardKind: string | null;
  rewardPayload: unknown | null;
  active: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

// Single task in the user-facing /zillapass/me response. Mirrors the
// admin DTO but folds in the bettor's progress for the current period.
export interface ZillapassActiveTaskDto {
  id: number;
  slug: string;
  title: string;
  description: string | null;
  targetCount: number;
  currentCount: number;
  period: ZillapassPeriod;
  rewardKind: string | null;
  rewardPayload: unknown | null;
  sortOrder: number;
  completedAt: string | null;
}

export interface ZillapassUserStateDto {
  level: number;
  xp: number;
  activeStreakDays: number;
  lastActiveDate: string | null;
  // Stage (set) the user is currently on. They see only tasks where
  // `task.setNumber === currentSetNumber`. Advances one UTC day after
  // completing every task in the set.
  currentSetNumber: number;
  // UTC date (YYYY-MM-DD) the user completed `currentSetNumber`, or
  // null if not yet. Stamped by the writer; cleared on advancement.
  lastSetCompletedDate: string | null;
}

// Aggregate progress, computed server-side so the top-bar chip can
// render `completedTasks / totalActiveTasks` without summing client-
// side. Both counters scope to the user's current set's active tasks.
// A user past the max seeded set sees totalActiveTasks=0; the chip
// hides in that case.
export interface ZillapassMeResponse {
  totalActiveTasks: number;
  completedTasks: number;
  tasks: ZillapassActiveTaskDto[];
  state: ZillapassUserStateDto;
}
