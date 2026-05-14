"use client";

// Client-only datetime formatter. The prod box runs in UTC, so any
// `toLocaleString` call rendered server-side resolves dates in UTC and
// users east of UTC saw "07:00" on the match-detail page while the
// list-card on the home page (already client-rendered) said "05:00".
// Same `Date` value, different timezone → same value rendered two
// different ways. Always render datetimes here so the formatting
// reads the browser's IANA timezone.
//
// Locale is picked from the i18n context so a user on RU sees the
// kicker in Russian; the SSR shell is empty for a beat and the label
// fills in on mount. We pre-render a deterministic skeleton matching
// the rendered width so the row doesn't reflow when hydration lands.

import { useEffect, useState } from "react";
import { useLocale } from "@/lib/i18n";

type Mode = "match-detail" | "row";

interface Props {
  iso: string | null;
  mode: Mode;
}

export function LocalDateTime({ iso, mode }: Props) {
  const locale = useLocale();
  const [label, setLabel] = useState<string | null>(null);

  useEffect(() => {
    if (!iso) {
      setLabel(null);
      return;
    }
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) {
      setLabel(null);
      return;
    }
    if (mode === "row") {
      const now = new Date();
      const sameDay =
        d.getFullYear() === now.getFullYear() &&
        d.getMonth() === now.getMonth() &&
        d.getDate() === now.getDate();
      const time = d.toLocaleTimeString(locale, {
        hour: "2-digit",
        minute: "2-digit",
      });
      if (sameDay) {
        setLabel(time);
      } else {
        const date = d.toLocaleDateString(locale, {
          month: "short",
          day: "numeric",
        });
        setLabel(`${date} · ${time}`);
      }
      return;
    }
    // match-detail: full date + time, always.
    setLabel(
      d.toLocaleString(locale, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }),
    );
  }, [iso, locale, mode]);

  // Render a non-breaking space rather than nothing so the surrounding
  // chip / pill keeps its baseline width.
  return <>{label ?? " "}</>;
}
