import { serverApi } from "@/lib/server-fetch";
import type { ZillapassTaskDto } from "@oddzilla/types";
import { ZillapassTasksEditor } from "./tasks-editor";

interface TasksResponse {
  tasks: ZillapassTaskDto[];
}

export default async function AdminZillapassPage() {
  const res = await serverApi<TasksResponse>("/admin/zillapass/tasks");
  const tasks = res?.tasks ?? [];

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">ZillaPass</h1>
      <p className="mt-2 text-sm text-[var(--color-fg-muted)]">
        Quest catalog. Each task is a per-user progress goal with a
        target count and a period reset. Predicate hooks that actually
        increment progress land in a follow-up; for now the rows render
        in the storefront top-bar chip and the /zillapass page, but
        every bettor's current count stays at 0.
      </p>

      <ul className="mt-3 space-y-1 text-xs text-[var(--color-fg-muted)]">
        <li>
          <strong className="text-[var(--color-fg)]">slug</strong> — stable
          id; admin can rename the title freely. Cannot be edited after
          create.
        </li>
        <li>
          <strong className="text-[var(--color-fg)]">predicateKey</strong> —
          identifier the (future) progress writer reads. Open-ended
          string; future task kinds add new keys without a migration.
        </li>
        <li>
          <strong className="text-[var(--color-fg)]">period</strong> —
          daily / weekly / season. Progress resets on the period
          boundary; completed_at on a row freezes the win.
        </li>
        <li>
          <strong className="text-[var(--color-fg)]">rewardKind</strong> +
          <strong className="text-[var(--color-fg)]"> rewardPayload</strong>
          {" "}— decorative until the unlock pipeline lands. Suggested
          kinds: <code>feature_unlock</code>, <code>xp</code>,{" "}
          <code>oz</code>.
        </li>
      </ul>

      <ZillapassTasksEditor initial={tasks} />
    </div>
  );
}
