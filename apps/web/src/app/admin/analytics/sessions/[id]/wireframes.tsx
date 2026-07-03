"use client";

// Schematic storefront wireframe drawn UNDER the mouse-trail replay so
// the trails have spatial anchors ("hovering the bet slip", "scrubbing
// the sidebar") without shipping real page content. Geometry mirrors
// the storefront shell (apps/web/src/app/globals.css):
//
//   desktop >= 1100px : 60px top bar, 240px sidebar, main, 300px rail
//   tablet 720-1099px : 60px top bar, 240px sidebar, main (no rail)
//   mobile  < 720px   : 90px top bar, single column, 56px bet-slip bar
//
// CRITICAL: .oz-shell is `max-width: 1440px; margin-inline: auto`, and
// the top bar is INSIDE the shell (grid area "top top top") — on wide
// monitors the whole thing (top bar included) is a centered 1440px
// band with page background either side. Every chrome + content
// coordinate is therefore offset by shellX = (vw - 1440) / 2.
//
// The viewport-FIXED chrome (top bar / sidebar / rail) is exactly the
// part of the real layout that viewport-relative trail coordinates
// line up with, so those regions are faithful; the main-column content
// is schematic (row counts and card sizes don't track real data).
// Everything is drawn in viewBox units = viewport px, so it stretches
// with the visitor's actual viewport.

import type { ReactNode } from "react";

const FILL = "var(--color-bg-card, #ffffff)";
const BLOCK = "var(--color-bg-subtle, #e8e4da)";
const STROKE = "var(--color-border, #d8d2c6)";

const SHELL_MAX_W = 1440;

type Chrome = {
  shellX: number;
  shellW: number;
  topH: number;
  sidebarW: number;
  railW: number;
  bottomBarH: number;
  mainX: number;
  mainW: number;
};

function chromeFor(vw: number, isAuth: boolean): Chrome {
  const shellW = Math.min(vw, SHELL_MAX_W);
  const shellX = Math.max(0, (vw - shellW) / 2);
  if (isAuth) {
    // (auth) layout: minimal header, centered card, no shell chrome.
    return { shellX: 0, shellW: vw, topH: 60, sidebarW: 0, railW: 0, bottomBarH: 0, mainX: 0, mainW: vw };
  }
  if (vw >= 1100) {
    return {
      shellX,
      shellW,
      topH: 60,
      sidebarW: 240,
      railW: 300,
      bottomBarH: 0,
      mainX: shellX + 240,
      mainW: shellW - 240 - 300,
    };
  }
  if (vw >= 720) {
    return { shellX, shellW, topH: 60, sidebarW: 240, railW: 0, bottomBarH: 0, mainX: shellX + 240, mainW: shellW - 240 };
  }
  return { shellX: 0, shellW: vw, topH: 90, sidebarW: 0, railW: 0, bottomBarH: 56, mainX: 0, mainW: vw };
}

function sectionOf(path: string): string {
  const segs = path.split("?")[0]!.split("#")[0]!.split("/").filter(Boolean);
  if (segs.length === 0) return "lobby";
  const first = segs[0]!.toLowerCase();
  if (first === "u") return "profile";
  return first;
}

const AUTH_SECTIONS = new Set(["login", "signup", "verify-email", "forgot-password", "reset-password"]);

// ── Reusable schematic pieces ─────────────────────────────────────────

function box(key: string, x: number, y: number, w: number, h: number, r = 8, fill = FILL): ReactNode {
  if (w <= 4 || h <= 4) return null;
  return <rect key={key} x={x} y={y} width={w} height={h} rx={r} fill={fill} stroke={STROKE} strokeWidth={1} />;
}

// A match-list row: team lines at the left, 2 odd buttons at the right.
function matchRow(key: string, x: number, y: number, w: number, h: number): ReactNode {
  const btnW = Math.min(72, w * 0.12);
  return (
    <g key={key}>
      {box(`${key}-card`, x, y, w, h, 10)}
      <rect x={x + 14} y={y + h * 0.24} width={w * 0.32} height={8} rx={4} fill={BLOCK} />
      <rect x={x + 14} y={y + h * 0.58} width={w * 0.24} height={8} rx={4} fill={BLOCK} />
      <rect x={x + w - btnW * 2 - 26} y={y + h * 0.22} width={btnW} height={h * 0.56} rx={8} fill={BLOCK} />
      <rect x={x + w - btnW - 14} y={y + h * 0.22} width={btnW} height={h * 0.56} rx={8} fill={BLOCK} />
    </g>
  );
}

function chipStrip(key: string, x: number, y: number, w: number): ReactNode {
  const chips: ReactNode[] = [];
  let cx = x;
  for (let i = 0; cx + 86 < x + w && i < 8; i += 1) {
    chips.push(<rect key={`${key}-${i}`} x={cx} y={y} width={78} height={28} rx={14} fill={BLOCK} />);
    cx += 90;
  }
  return <g key={key}>{chips}</g>;
}

function rowsDown(key: string, x: number, yStart: number, w: number, vh: number, rowH: number, gap: number): ReactNode {
  const rows: ReactNode[] = [];
  for (let y = yStart, i = 0; y + rowH < vh - 8 && i < 24; y += rowH + gap, i += 1) {
    rows.push(matchRow(`${key}-${i}`, x, y, w, rowH));
  }
  return <g key={key}>{rows}</g>;
}

function cardGrid(key: string, x: number, yStart: number, w: number, vh: number, cols: number, cardH: number): ReactNode {
  const gap = 14;
  const cardW = (w - gap * (cols - 1)) / cols;
  const cards: ReactNode[] = [];
  let i = 0;
  for (let y = yStart; y + cardH < vh - 8 && i < 12; y += cardH + gap) {
    for (let c = 0; c < cols; c += 1, i += 1) {
      cards.push(box(`${key}-${i}`, x + c * (cardW + gap), y, cardW, cardH, 12));
    }
  }
  return <g key={key}>{cards}</g>;
}

// ── Chrome (viewport-fixed, faithful) ─────────────────────────────────

function shellChrome(c: Chrome, vw: number, vh: number): ReactNode {
  const railX = c.shellX + c.shellW - c.railW;
  return (
    <g key="chrome">
      <rect x={c.shellX} y={0} width={c.shellW} height={c.topH} fill={FILL} stroke={STROKE} strokeWidth={1} />
      <rect x={c.shellX + 16} y={c.topH / 2 - 10} width={110} height={20} rx={6} fill={BLOCK} />
      <rect x={c.shellX + c.shellW - 190} y={c.topH / 2 - 12} width={80} height={24} rx={12} fill={BLOCK} />
      <rect x={c.shellX + c.shellW - 100} y={c.topH / 2 - 12} width={80} height={24} rx={12} fill={BLOCK} />
      {c.sidebarW > 0 && (
        <g>
          <rect x={c.shellX} y={c.topH} width={c.sidebarW} height={vh - c.topH} fill={FILL} stroke={STROKE} strokeWidth={1} />
          {Array.from({ length: Math.min(14, Math.floor((vh - c.topH - 24) / 38)) }, (_, i) => (
            <rect
              key={`side-${i}`}
              x={c.shellX + 14}
              y={c.topH + 18 + i * 38}
              width={c.sidebarW - 28}
              height={22}
              rx={6}
              fill={BLOCK}
            />
          ))}
        </g>
      )}
      {c.railW > 0 && (
        <g>
          <rect x={railX} y={c.topH} width={c.railW} height={vh - c.topH} fill={FILL} stroke={STROKE} strokeWidth={1} />
          <rect x={railX + 16} y={c.topH + 16} width={c.railW - 32} height={26} rx={8} fill={BLOCK} />
          {box("rail-slip", railX + 16, c.topH + 58, c.railW - 32, 130, 10)}
          <rect x={railX + 16} y={vh - 66} width={c.railW - 32} height={40} rx={10} fill={BLOCK} />
        </g>
      )}
      {c.bottomBarH > 0 && (
        <rect x={0} y={vh - c.bottomBarH} width={vw} height={c.bottomBarH} fill={FILL} stroke={STROKE} strokeWidth={1} />
      )}
    </g>
  );
}

// ── Per-section main-column content (schematic) ───────────────────────

function mainContent(section: string, c: Chrome, vh: number): ReactNode {
  const pad = 18;
  const x = c.mainX + pad;
  const w = c.mainW - pad * 2;
  const top = c.topH + pad;
  if (w <= 40) return null;

  switch (section) {
    case "match": {
      // Match header (scoreboard/stream area), tab strip, market rows.
      return (
        <g key="main">
          {box("hdr", x, top, w, 150, 12)}
          {chipStrip("tabs", x, top + 166, w)}
          {rowsDown("markets", x, top + 210, w, vh, 84, 12)}
        </g>
      );
    }
    case "zillapass":
      return (
        <g key="main">
          {box("zp-head", x, top, w, 90, 12)}
          {cardGrid("zp-cards", x, top + 106, w, vh, c.mainW > 640 ? 2 : 1, 120)}
        </g>
      );
    case "wallet":
    case "account":
      return (
        <g key="main">
          {box("head", x, top, w, 70, 12)}
          {cardGrid("cards", x, top + 86, w, vh, 1, 150)}
        </g>
      );
    case "bets":
      return <g key="main">{rowsDown("tickets", x, top + 44, w, vh, 96, 12)}{chipStrip("filters", x, top, w)}</g>;
    case "community":
    case "profile":
      return (
        <g key="main">
          {box("head", x, top, w, 110, 12)}
          {cardGrid("cards", x, top + 126, w, vh, c.mainW > 760 ? 2 : 1, 140)}
        </g>
      );
    case "lobby":
    case "sport":
    case "live":
    case "upcoming":
    default:
      return (
        <g key="main">
          {chipStrip("chips", x, top, w)}
          {rowsDown("matches", x, top + 44, w, vh, 72, 10)}
        </g>
      );
  }
}

function authContent(vw: number, vh: number): ReactNode {
  const cardW = Math.min(400, vw - 48);
  const cardH = Math.min(380, vh - 140);
  const x = (vw - cardW) / 2;
  const y = Math.max(80, (vh - cardH) / 2);
  return (
    <g key="auth">
      <rect x={vw / 2 - 60} y={24} width={120} height={22} rx={6} fill={BLOCK} />
      {box("card", x, y, cardW, cardH, 14)}
      <rect x={x + 28} y={y + 40} width={cardW - 56} height={34} rx={8} fill={BLOCK} />
      <rect x={x + 28} y={y + 92} width={cardW - 56} height={34} rx={8} fill={BLOCK} />
      <rect x={x + 28} y={y + 152} width={cardW - 56} height={40} rx={10} fill={BLOCK} />
    </g>
  );
}

export function WireframeBackdrop({ path, vw, vh }: { path: string; vw: number; vh: number }) {
  const section = sectionOf(path);
  const isAuth = AUTH_SECTIONS.has(section);
  const c = chromeFor(vw, isAuth);
  return (
    <g opacity={0.55} aria-hidden>
      {isAuth ? authContent(vw, vh) : mainContent(section, c, vh)}
      {!isAuth && shellChrome(c, vw, vh)}
    </g>
  );
}
