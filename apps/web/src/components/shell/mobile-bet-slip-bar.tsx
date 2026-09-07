"use client";

// Mobile-only sticky bar pinned to the viewport bottom. Shows the current
// slip at a glance (leg count + combined odds) and opens the full rail as
// a bottom sheet on tap. Hidden when the slip is empty or when the rail
// is already open — CSS controls viewport visibility.

import { useMemo } from "react";
import { useBetSlip } from "@/lib/bet-slip";
import { useMobileDrawers } from "./mobile-drawer-context";
import { I } from "@/components/ui/icons";
import { useTranslations } from "@/lib/i18n";

export function MobileBetSlipBar() {
  const slip = useBetSlip();
  const { railOpen, toggleRail } = useMobileDrawers();
  const count = slip.selections.length;
  const t = useTranslations("betSlip");
  const tCommon = useTranslations("common");

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
      aria-label={`${t("title")} (${t("legs", { count })})`}
    >
      {/* 26px, down from 32: the bar is 46px tall now (was 56), and a
          32px disc inside it left almost no breathing room. */}
      <span
        style={{
          width: 26,
          height: 26,
          borderRadius: 999,
          background: "var(--bg)",
          color: "var(--fg)",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        <I.Ticket size={13} />
      </span>
      <span
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-start",
          lineHeight: 1.05,
          minWidth: 0,
        }}
      >
        <span
          style={{
            fontSize: 12.5,
            fontWeight: 600,
            letterSpacing: "-0.005em",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            maxWidth: "100%",
          }}
        >
          {isCombo ? `${t("combo")} · ${t("legs", { count })}` : t("legs", { count })}
        </span>
        {/* Two lines inside a 46px bar: the leading trims to 1.05 and
            the odds line loses its top margin, which is what makes the
            slimmer bar fit without clipping a descender. The label
            truncates rather than pushing "Open" off the bar — the bar
            is narrower now that it stops clear of the chat button, and
            a long localised "Combo · N legs" is the string that would
            otherwise overflow it. */}
        <span
          className="mono tnum"
          style={{ fontSize: 10.5, opacity: 0.75 }}
        >
          @ {combinedOdds.toFixed(2)}
        </span>
      </span>
      <span style={{ flex: 1, minWidth: 4 }} />
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 5,
          fontSize: 12,
          fontWeight: 600,
          flexShrink: 0,
          whiteSpace: "nowrap",
        }}
      >
        {tCommon("open")}
        <I.Chev size={12} style={{ transform: "rotate(-90deg)" }} />
      </span>
    </button>
  );
}
