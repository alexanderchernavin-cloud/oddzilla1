"use client";

// Mobile-only sticky bar pinned to the viewport bottom. Shows the current
// slip at a glance (leg count + combined odds) and opens the full rail as
// a bottom sheet on tap. Hidden when the slip is empty or when the rail
// is already open — CSS controls viewport visibility.

import { useMemo } from "react";
import { useBetSlip } from "@/lib/bet-slip";
import { useMobileDrawers } from "./mobile-drawer-context";
import { I } from "@/components/ui/icons";

export function MobileBetSlipBar() {
  const slip = useBetSlip();
  const { railOpen, toggleRail } = useMobileDrawers();
  const count = slip.selections.length;

  const combinedOdds = useMemo(() => {
    if (count === 0) return 0;
    return slip.selections.reduce((acc, s) => acc * Number(s.odds || 0), 1);
  }, [slip.selections, count]);

  // Nothing to show: either no picks, or the full sheet is already open.
  if (count === 0 || railOpen) return null;

  const isCombo = count >= 2;

  return (
    <button
      type="button"
      onClick={toggleRail}
      className="oz-mobile-betbar"
      aria-label={`Open bet slip (${count} selection${count === 1 ? "" : "s"})`}
    >
      <span
        style={{
          width: 32,
          height: 32,
          borderRadius: 999,
          background: "var(--bg)",
          color: "var(--fg)",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        <I.Ticket size={14} />
      </span>
      <span
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-start",
          lineHeight: 1.1,
          minWidth: 0,
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 600, letterSpacing: "-0.005em" }}>
          {isCombo ? `Combo · ${count} legs` : `${count} selection`}
        </span>
        <span
          className="mono tnum"
          style={{ fontSize: 11, opacity: 0.75, marginTop: 2 }}
        >
          @ {combinedOdds.toFixed(2)}
        </span>
      </span>
      <span style={{ flex: 1 }} />
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          fontSize: 12.5,
          fontWeight: 600,
        }}
      >
        Review
        <I.Chev size={12} style={{ transform: "rotate(-90deg)" }} />
      </span>
    </button>
  );
}
