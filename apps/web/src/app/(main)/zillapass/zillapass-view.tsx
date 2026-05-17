"use client";

import { useEffect } from "react";
import { I } from "@/components/ui/icons";
import { useZillapass } from "@/lib/zillapass";
import type {
  ZillapassActiveTaskDto,
  ZillapassMeResponse,
} from "@oddzilla/types";

export function ZillapassPageView({
  initial,
}: {
  initial: ZillapassMeResponse | null;
}) {
  // Consume the shared context so the page updates in lockstep with
  // the chip whenever a tracker fires. The SSR-provided `initial`
  // seeds the first paint until the provider's own fetch lands.
  const { data: ctxData, setData } = useZillapass();
  useEffect(() => {
    if (initial && ctxData === null) setData(initial);
    // Only seed once on mount; subsequent context updates win.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const data = ctxData ?? initial;

  const state = data?.state ?? {
    level: 1,
    xp: 0,
    activeStreakDays: 0,
    lastActiveDate: null,
  };
  const tasks = data?.tasks ?? [];
  const total = data?.totalActiveTasks ?? 0;
  const completed = data?.completedTasks ?? 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
        }}
      >
        <I.Sparkles size={22} />
        <h1
          style={{
            margin: 0,
            fontSize: 28,
            fontWeight: 600,
            letterSpacing: "-0.01em",
          }}
        >
          ZillaPass
        </h1>
      </header>

      <section
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
          gap: 12,
        }}
      >
        <KpiCard label="Level" value={state.level} />
        <KpiCard label="XP" value={state.xp} mono />
        <KpiCard label="Streak (days)" value={state.activeStreakDays} />
        <KpiCard
          label="Tasks today"
          value={`${completed}/${total}`}
          mono
        />
      </section>

      <section>
        <SectionHeader title="Active tasks" />
        {tasks.length === 0 ? (
          <EmptyState
            title="No active tasks"
            body="An admin hasn't published any tasks yet. Once they're live, your progress will show here."
          />
        ) : (
          <ul
            style={{
              listStyle: "none",
              margin: 0,
              padding: 0,
              display: "flex",
              flexDirection: "column",
              gap: 10,
            }}
          >
            {tasks.map((task) => (
              <li key={task.id}>
                <FullTaskCard task={task} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <SectionHeader title="Past tasks" />
        <EmptyState
          title="History coming soon"
          body="Completed and expired tasks will land here once the predicate hooks ship."
        />
      </section>
    </div>
  );
}

function KpiCard({
  label,
  value,
  mono,
}: {
  label: string;
  value: number | string;
  mono?: boolean;
}) {
  return (
    <div
      style={{
        padding: 16,
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 12,
      }}
    >
      <div
        className="mono"
        style={{
          fontSize: 10,
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          color: "var(--fg-muted)",
        }}
      >
        {label}
      </div>
      <div
        className={mono ? "mono" : undefined}
        style={{
          marginTop: 6,
          fontSize: 24,
          fontWeight: 600,
          color: "var(--fg)",
          fontVariantNumeric: mono ? "tabular-nums" : undefined,
        }}
      >
        {value}
      </div>
    </div>
  );
}

function SectionHeader({ title }: { title: string }) {
  return (
    <h2
      className="mono"
      style={{
        margin: "0 0 12px",
        fontSize: 11,
        letterSpacing: "0.16em",
        textTransform: "uppercase",
        color: "var(--fg-muted)",
      }}
    >
      {title}
    </h2>
  );
}

function FullTaskCard({ task }: { task: ZillapassActiveTaskDto }) {
  const pct =
    task.targetCount === 0
      ? 0
      : Math.min(1, task.currentCount / task.targetCount);
  const done = task.completedAt !== null;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        padding: 16,
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 12,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: done ? "var(--fg-muted)" : "var(--fg)",
              textDecoration: done ? "line-through" : "none",
            }}
          >
            {task.title}
          </div>
          {task.description ? (
            <div
              style={{
                marginTop: 2,
                fontSize: 12,
                color: "var(--fg-muted)",
              }}
            >
              {task.description}
            </div>
          ) : null}
        </div>
        <div
          className="mono"
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: "var(--fg)",
            fontVariantNumeric: "tabular-nums",
            flexShrink: 0,
          }}
        >
          {task.currentCount}/{task.targetCount}
        </div>
      </div>

      <FullBar pct={pct} />

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          marginTop: 2,
        }}
      >
        <span
          className="mono"
          style={{
            fontSize: 10,
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            color: "var(--fg-muted)",
          }}
        >
          {task.period}
        </span>
        {task.rewardKind ? (
          <span
            style={{
              fontSize: 11,
              color: "var(--fg-muted)",
            }}
          >
            Reward: {task.rewardKind}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function FullBar({ pct }: { pct: number }) {
  return (
    <span
      aria-hidden
      style={{
        position: "relative",
        display: "block",
        width: "100%",
        height: 8,
        background: "var(--surface-2)",
        borderRadius: 999,
        overflow: "hidden",
      }}
    >
      <span
        style={{
          position: "absolute",
          inset: 0,
          width: `${Math.round(pct * 100)}%`,
          background: "var(--accent, var(--fg))",
          borderRadius: 999,
          transition: "width 200ms var(--ease, ease)",
        }}
      />
    </span>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div
      style={{
        padding: 28,
        background: "var(--surface)",
        border: "1px dashed var(--border)",
        borderRadius: 12,
        textAlign: "center",
      }}
    >
      <div style={{ fontSize: 14, fontWeight: 600, color: "var(--fg)" }}>
        {title}
      </div>
      <div
        style={{ marginTop: 6, fontSize: 12, color: "var(--fg-muted)" }}
      >
        {body}
      </div>
    </div>
  );
}
