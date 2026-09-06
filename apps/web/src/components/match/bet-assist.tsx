"use client";

// Bet Assist control — the per-market statistical case, from Sportradar.
//
// Shape follows Sportradar's own demo: the market row carries a quiet
// "BET ASSIST" label plus a small chart mark at its right edge, and
// either half opens the panel. What differs is WHERE the panel goes.
// Sportradar's `betAssist.button` widget draws its own popover, but we
// embed through their hosted standalone page (the licensing story in
// sportradar-lmt.tsx), and a popover drawn inside an iframe is clipped
// to that iframe's box. So the control is ours, native, and the overlay
// is ours too — it frames `betAssist.standalone`, which is just the
// panel with no popover machinery.
//
// The overlay is a portal onto document.body: a market card sits inside
// several stacking contexts (the card, the markets column, the page
// grid), and any of them would otherwise clip or mis-layer a fixed
// panel.
//
// Rendering is gated upstream by `resolveBetAssistMarket`
// (@oddzilla/types/bet-assist) — no mapping, no control. A market key
// the widget does not know for the sport renders an EMPTY panel rather
// than an error, which is exactly what that gate exists to prevent.

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { I } from "@/components/ui/icons";
import { useTranslations } from "@/lib/i18n";
import { useDocumentTheme, type DocumentTheme } from "@/lib/use-theme";
import {
  SPORTRADAR_FRAME_BACKGROUND,
  sportradarThemeHashParts,
} from "@/components/widgets/sportradar-theme";

const HOST = "https://widgets.sir.sportradar.com";

interface Props {
  /** Sportradar match id from a CONFIRMED mapping row. */
  srMatchId: number;
  /** Sportradar's market key, already validated for this sport. */
  market: string;
  /** Our own market name, for the overlay header and the aria label. */
  marketLabel: string;
  client?: string;
  language?: string;
}

// Frame height per Sportradar market key, in CSS px. The hosted page
// cannot report its size across origins, and the widget draws a
// DIFFERENT set of blocks per market shape: a 1X2 gets win probability +
// form split + last five games, a total gets a combined average + two
// goals bars, a double chance or a half-time result gets one two-bar
// block. Measured on production 2026-09-05 with a ruler overlaid on the
// stretched frame at the panel's 460px width (Inter Miami vs Atlanta
// United, Saint-Etienne vs Montpellier): 3Way ~225, totalOverUnder ~340,
// doubleChance ~95, 1stHalfWin ~95. The one-size 560 before this left
// 300px of blank white under a 1X2 and 460px under a double chance.
// Half-market analogues take their full-match sibling's shape; anything
// unmeasured takes the tallest measured shape, because a frame too
// short clips content while one too tall only costs blank space.
const FRAME_HEIGHT_BY_MARKET: Readonly<Record<string, number>> = {
  "3Way": 240,
  totalOverUnder: 350,
  doubleChance: 110,
  doubleChance1stHalf: 110,
  doubleChance2ndHalf: 110,
  "1stHalfWin": 110,
  "2ndHalfWin": 110,
};
const DEFAULT_FRAME_HEIGHT = 350;

export function frameHeightFor(market: string): number {
  return FRAME_HEIGHT_BY_MARKET[market] ?? DEFAULT_FRAME_HEIGHT;
}

export function buildBetAssistStandaloneUrl({
  srMatchId,
  market,
  client = "betradar",
  language = "en",
  theme,
}: Pick<Props, "srMatchId" | "market" | "client" | "language"> & {
  theme?: DocumentTheme;
}): string {
  const hash = [
    `matchId=${srMatchId}`,
    `market=${market}`,
    ...sportradarThemeHashParts(theme),
  ].join("&");
  return `${HOST}/${encodeURIComponent(client)}/${encodeURIComponent(language)}/standalone/betAssist.standalone#${hash}`;
}

export function BetAssistControl({
  srMatchId,
  market,
  marketLabel,
  client,
  language,
}: Props) {
  const t = useTranslations("matchWidgets");
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);

  return (
    <>
      <button
        type="button"
        data-oz-track="bet-assist-open"
        onClick={(e) => {
          // Market headers are inside clickable cards on some layouts;
          // opening the panel must not also toggle the card.
          e.stopPropagation();
          setOpen(true);
        }}
        aria-label={t("betAssist.openAria", { market: marketLabel })}
        title={t("betAssist.title")}
        className="mono"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 5,
          padding: "2px 7px",
          borderRadius: 6,
          border: "1px solid var(--border)",
          background: "transparent",
          color: "var(--fg-muted)",
          fontSize: 9.5,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          lineHeight: 1.6,
          cursor: "pointer",
        }}
      >
        {t("betAssist.label")}
        <BarsMark />
      </button>
      {open ? (
        <BetAssistOverlay
          srMatchId={srMatchId}
          market={market}
          marketLabel={marketLabel}
          client={client}
          language={language}
          onClose={close}
        />
      ) : null}
    </>
  );
}

// Sportradar's own mark for the control is a three-bar chart; drawn here
// rather than pulled from the shared icon set because it exists only in
// this one context and should track their button, not our iconography.
function BarsMark() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
      style={{ flexShrink: 0 }}
    >
      <path d="M5 20V12" />
      <path d="M12 20V5" />
      <path d="M19 20v-5" />
    </svg>
  );
}

function BetAssistOverlay({
  srMatchId,
  market,
  marketLabel,
  client,
  language,
  onClose,
}: Props & { onClose: () => void }) {
  const t = useTranslations("matchWidgets");
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  // Dark mode rides the hash (sportradar-theme.ts); the `key` on the
  // iframe remounts it if the theme flips while the panel is open.
  const theme = useDocumentTheme();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    // The panel is tall on a phone; freezing the page behind it stops the
    // scroll chaining that otherwise moves the markets list underneath.
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  if (!mounted) return null;

  const src = buildBetAssistStandaloneUrl({
    srMatchId,
    market,
    client,
    language,
    theme,
  });

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("betAssist.dialogAria", { market: marketLabel })}
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
        background: "rgba(0,0,0,0.55)",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(460px, 100%)",
          maxHeight: "min(720px, 92vh)",
          display: "flex",
          flexDirection: "column",
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: 14,
          overflow: "hidden",
          boxShadow: "0 24px 60px rgba(0,0,0,0.35)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "12px 14px",
            borderBottom: "1px solid var(--hairline)",
          }}
        >
          <div style={{ minWidth: 0, display: "flex", flexDirection: "column" }}>
            <span
              className="mono"
              style={{
                fontSize: 10,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                color: "var(--fg-dim)",
              }}
            >
              {t("betAssist.title")}
            </span>
            <span
              style={{
                fontSize: 13.5,
                fontWeight: 500,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {marketLabel}
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("betAssist.close")}
            style={{
              marginLeft: "auto",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 28,
              height: 28,
              borderRadius: 8,
              border: "1px solid var(--border)",
              background: "transparent",
              color: "var(--fg-muted)",
              cursor: "pointer",
            }}
          >
            <I.Close size={14} />
          </button>
        </div>
        {/* Fixed because the hosted page cannot report its size across
            origins; per market shape because the widget draws a
            different set of blocks for each — see FRAME_HEIGHT_BY_MARKET. */}
        <iframe
          key={theme}
          src={src}
          title={`${t("betAssist.title")} — ${marketLabel}`}
          style={{
            width: "100%",
            height: frameHeightFor(market),
            maxHeight: "100%",
            border: 0,
            display: "block",
            background: SPORTRADAR_FRAME_BACKGROUND,
          }}
        />
      </div>
    </div>,
    document.body,
  );
}
