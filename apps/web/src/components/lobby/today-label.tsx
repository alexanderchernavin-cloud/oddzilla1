"use client";

import { useEffect, useState } from "react";

// Renders "Today · {Weekday}, {Mon} {D}" in the *browser's* local
// timezone. Doing this server-side would emit UTC (the prod box runs
// in UTC) — users east of UTC would see yesterday's date during the
// evening hours. Initial SSR markup intentionally omits the date so
// hydration doesn't flicker; the label fills in on mount.
export function TodayLabel() {
  const [label, setLabel] = useState<string | null>(null);
  useEffect(() => {
    setLabel(
      new Date().toLocaleDateString(undefined, {
        weekday: "long",
        month: "short",
        day: "numeric",
      }),
    );
  }, []);
  return (
    <div
      className="mono"
      style={{
        fontSize: 11,
        letterSpacing: "0.14em",
        textTransform: "uppercase",
        color: "var(--fg-dim)",
      }}
    >
      Today{label ? ` · ${label}` : ""}
    </div>
  );
}
