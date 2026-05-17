"use client";

// ZillaPass progress chip + popover for the storefront top section.
// Renders only for signed-in users; anonymous viewers see nothing
// (the parent row collapses to just the search bar).
//
// Lives in the shell-search row beside the TopBarSearch input at
// every viewport. On mobile (≤719 px) the row's flex layout shrinks
// the search to ~40 % and gives the chip the remaining ~60 % so the
// progress is visible without scrolling or extra taps.
//
// State + polling lives in `lib/zillapass.tsx` via ZillapassProvider.
// The chip subscribes to that context; the tracker hooks push fresh
// state into the context after every nudge so the bar flips without
// waiting for the 30 s background poll.

import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { I } from "@/components/ui/icons";
import { useSessionUserId } from "@/lib/session-user";
import { useZillapass } from "@/lib/zillapass";
import type { ZillapassActiveTaskDto, ZillapassMeResponse } from "@oddzilla/types";

export function ZillapassIndicator() {
  const userId = useSessionUserId();
  const { data } = useZillapass();
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onPointer(e: PointerEvent) {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!userId) return null;

  // Render-time fallbacks so the chip doesn't pop in awkwardly while
  // the first fetch resolves. Once data lands the chip swaps to live
  // values without a layout shift (same width via min-width on the
  // count strip).
  const total = data?.totalActiveTasks ?? 0;
  const completed = data?.completedTasks ?? 0;
  const pct = total === 0 ? 0 : Math.min(1, completed / total);

  // Hide when the user has nothing to do on their current stage. This
  // happens to power users who completed every seeded set — they sit
  // at current_set_number past the max active set_number, so /zillapass/me
  // returns zero tasks. Re-renders when an admin seeds new tasks for
  // their stage. We only hide AFTER the first fetch lands (data !==
  // null) so the chip doesn't disappear during the initial paint
  // before we know the count.
  if (data !== null && total === 0) return null;

  return (
    <div
      ref={wrapperRef}
      style={{ position: "relative", flexShrink: 0 }}
      className="oz-zillapass-chip"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="ZillaPass progress"
        className="oz-zillapass-chip-button"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 10,
          height: 36,
          padding: "0 12px",
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: 999,
          cursor: "pointer",
          color: "var(--fg)",
          fontFamily: "inherit",
          fontSize: 12,
          fontWeight: 600,
          minWidth: 132,
          width: "100%",
        }}
      >
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            color: "var(--fg-muted)",
          }}
        >
          <I.Sparkles size={14} />
          {/* Label swaps with viewport: short "Tasks" on mobile (≤719
              px) so it fits in the chip's ~60 % share of the shell-
              search row; full "ZillaPass tasks" everywhere wider. */}
          <span
            className="mono oz-zillapass-chip-label-wide"
            style={{ letterSpacing: "0.02em" }}
          >
            ZillaPass Tasks
          </span>
          <span
            className="mono oz-zillapass-chip-label-mobile"
            style={{ letterSpacing: "0.02em" }}
          >
            Tasks
          </span>
        </span>
        <span
          className="mono"
          style={{
            color: "var(--fg)",
            fontVariantNumeric: "tabular-nums",
            minWidth: 30,
            textAlign: "right",
          }}
        >
          {completed}/{total}
        </span>
        <ProgressBar pct={pct} width={42} />
      </button>

      {open ? (
        <Popover
          data={data}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </div>
  );
}

function ProgressBar({ pct, width }: { pct: number; width: number }) {
  return (
    <span
      aria-hidden
      style={{
        position: "relative",
        display: "inline-block",
        width,
        height: 6,
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

function Popover({
  data,
  onClose,
}: {
  data: ZillapassMeResponse | null;
  onClose: () => void;
}) {
  const tasks = data?.tasks ?? [];
  return (
    <div
      role="dialog"
      aria-label="ZillaPass tasks"
      style={{
        position: "absolute",
        top: 44,
        right: 0,
        width: 340,
        maxWidth: "calc(100vw - 32px)",
        padding: 12,
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 12,
        boxShadow: "0 10px 30px rgba(0,0,0,0.18)",
        zIndex: 60,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 10,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 13,
            fontWeight: 600,
            color: "var(--fg)",
          }}
        >
          <I.Sparkles size={14} />
          <span>ZillaPass</span>
        </div>
        <div
          className="mono"
          style={{
            fontSize: 11,
            color: "var(--fg-muted)",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {data ? `${data.completedTasks}/${data.totalActiveTasks}` : "—"}
        </div>
      </div>

      {tasks.length === 0 ? (
        <EmptyState />
      ) : (
        <ul
          style={{
            listStyle: "none",
            margin: 0,
            padding: 0,
            display: "flex",
            flexDirection: "column",
            gap: 8,
            maxHeight: 320,
            overflowY: "auto",
          }}
        >
          {tasks.map((task) => (
            <li key={task.id}>
              <TaskRow task={task} />
            </li>
          ))}
        </ul>
      )}

      <div
        style={{
          marginTop: 12,
          paddingTop: 10,
          borderTop: "1px solid var(--hairline)",
        }}
      >
        <Link
          href="/zillapass"
          onClick={onClose}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            width: "100%",
            padding: "8px 10px",
            background: "var(--fg)",
            color: "var(--bg)",
            borderRadius: 8,
            textDecoration: "none",
            fontSize: 12,
            fontWeight: 600,
          }}
        >
          Open ZillaPass
        </Link>
      </div>
    </div>
  );
}

function TaskRow({ task }: { task: ZillapassActiveTaskDto }) {
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
        gap: 4,
        padding: 8,
        borderRadius: 8,
        background: "var(--surface-2)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <span
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: done ? "var(--fg-muted)" : "var(--fg)",
            textDecoration: done ? "line-through" : "none",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {task.title}
        </span>
        <span
          className="mono"
          style={{
            fontSize: 11,
            color: "var(--fg-muted)",
            fontVariantNumeric: "tabular-nums",
            flexShrink: 0,
          }}
        >
          {task.currentCount}/{task.targetCount}
        </span>
      </div>
      <RowBar pct={pct} />
    </div>
  );
}

function RowBar({ pct }: { pct: number }) {
  return (
    <span
      aria-hidden
      style={{
        position: "relative",
        display: "block",
        width: "100%",
        height: 6,
        background: "var(--surface)",
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

function EmptyState() {
  return (
    <div
      style={{
        padding: "18px 8px",
        textAlign: "center",
        color: "var(--fg-muted)",
        fontSize: 12,
      }}
    >
      No active tasks. Check back later.
    </div>
  );
}
