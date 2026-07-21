"use client";

import { useEffect } from "react";
import Link from "next/link";
import { I } from "@/components/ui/icons";
import { useTranslations } from "@/lib/i18n";
import { useZillapass } from "@/lib/zillapass";
import { useZillapassTaskText } from "@/lib/zillapass-i18n";
import type {
  ZillapassActiveTaskDto,
  ZillapassMeResponse,
} from "@oddzilla/types";

// Defence-in-depth: the admin POST/PATCH validator already enforces a
// leading slash on cta_href, but seeded rows + future migrations bypass
// that validator. Treat anything that isn't a same-origin path as
// untrusted and skip the CTA — never render an off-domain anchor from
// a database value.
function isSafeCtaHref(href: string | null | undefined): href is string {
  return typeof href === "string" && /^\/[^\s]*$/.test(href);
}

export function ZillapassPageView({
  initial,
}: {
  initial: ZillapassMeResponse | null;
}) {
  // Consume the shared context so the page updates in lockstep with
  // the chip whenever a tracker fires. The SSR-provided `initial`
  // seeds the first paint until the provider's own fetch lands.
  const t = useTranslations("zillapass");
  const { data: ctxData, setData } = useZillapass();
  // Only seed once on mount; subsequent context updates win. Intentional
  // empty deps. The repo's ESLint config doesn't load react-hooks rules,
  // so no exhaustive-deps suppression is needed (and a stale disable
  // comment referencing the unknown rule fails `pnpm lint`).
  useEffect(() => {
    if (initial && ctxData === null) setData(initial);
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
        <KpiCard label={t("level")} value={state.level} />
        <KpiCard label={t("xp")} value={state.xp} mono />
        <KpiCard label={t("streakDays")} value={state.activeStreakDays} />
        <KpiCard
          label={t("tasksLabel")}
          value={`${completed}/${total}`}
          mono
        />
      </section>

      <section>
        <SectionHeader title={t("activeTasks")} />
        {tasks.length === 0 ? (
          <EmptyState
            title={t("noTasksTitle")}
            body={t("noTasksBody")}
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
        <SectionHeader title={t("pastTasks")} />
        <EmptyState
          title={t("historyTitle")}
          body={t("historyBody")}
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
  const t = useTranslations("zillapass");
  const taskText = useZillapassTaskText();
  const { title, description, ctaLabel } = taskText(task);
  const pct =
    task.targetCount === 0
      ? 0
      : Math.min(1, task.currentCount / task.targetCount);
  const done = task.completedAt !== null;
  const ctaHref = isSafeCtaHref(task.ctaHref) ? task.ctaHref : null;

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
            {title}
          </div>
          {description ? (
            <div
              style={{
                marginTop: 2,
                fontSize: 12,
                color: "var(--fg-muted)",
              }}
            >
              {description}
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

      {/* Period chip dropped post-migration 0073 — every task is
          non-resetting now, so "daily" / "weekly" / "season" no longer
          carries useful UX signal. Reward label still surfaces when an
          admin sets one. */}
      {task.rewardKind ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            gap: 8,
            marginTop: 2,
          }}
        >
          <span
            style={{
              fontSize: 11,
              color: "var(--fg-muted)",
            }}
          >
            {t("reward", { kind: task.rewardKind })}
          </span>
        </div>
      ) : null}

      {ctaHref ? (
        <Link
          href={ctaHref}
          style={{
            marginTop: 6,
            alignSelf: "flex-start",
            padding: "8px 12px",
            fontSize: 12,
            fontWeight: 600,
            color: done ? "var(--fg-muted)" : "var(--fg)",
            background: "var(--surface-2)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            textDecoration: "none",
            opacity: done ? 0.7 : 1,
          }}
        >
          {ctaLabel ?? t("openCta")}
          <span aria-hidden style={{ marginLeft: 6 }}>
            →
          </span>
        </Link>
      ) : null}
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
