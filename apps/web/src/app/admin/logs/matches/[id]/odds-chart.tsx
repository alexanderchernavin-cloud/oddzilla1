"use client";

// Pure-SVG line chart for one market with a hover snapshot tooltip.
// Plots `published ?? raw` per series against time. Axes are auto-scaled
// from the data. Hovering anywhere over the plot picks the nearest
// timestamp across all series and shows every selection's odds at that
// instant — same shape an admin would see if they could replay a single
// odds_change frame.

import { useMemo, useRef, useState } from "react";

interface Point {
  tsMs: number;
  raw: string | null;
  published: string | null;
}
interface Series {
  outcomeId: string;
  name: string;
  points: Point[];
}

const PALETTE = [
  "#f5c77e",
  "#7ec8e3",
  "#c28fe0",
  "#85e0a3",
  "#f4a261",
  "#e76f51",
  "#9dd9d2",
  "#eab3ff",
];

const WIDTH = 640;
const HEIGHT = 180;
const PAD_L = 40;
const PAD_R = 8;
const PAD_T = 10;
const PAD_B = 22;

function oddsOf(p: Point): number | null {
  const v = p.published ?? p.raw;
  if (v == null) return null;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

// Find the largest tsMs in `sortedTimes` that's <= target. Sorted asc.
function binarySearchLE(sortedTimes: number[], target: number): number {
  if (sortedTimes.length === 0) return -1;
  let lo = 0;
  let hi = sortedTimes.length - 1;
  if (target < sortedTimes[0]!) return 0;
  if (target >= sortedTimes[hi]!) return hi;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (sortedTimes[mid]! <= target) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export function OddsChart({ series }: { series: Series[] }) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hoverTs, setHoverTs] = useState<number | null>(null);

  // Pre-compute everything that doesn't depend on hover state.
  const layout = useMemo(() => {
    const allPoints: Array<{ ts: number; v: number }> = [];
    for (const s of series) {
      for (const p of s.points) {
        const v = oddsOf(p);
        if (v != null) allPoints.push({ ts: p.tsMs, v });
      }
    }
    if (allPoints.length === 0) return null;

    const minTs = Math.min(...allPoints.map((p) => p.ts));
    const maxTs = Math.max(...allPoints.map((p) => p.ts));
    const tsSpan = Math.max(1, maxTs - minTs);

    const rawMin = Math.min(...allPoints.map((p) => p.v));
    const rawMax = Math.max(...allPoints.map((p) => p.v));
    const pad = Math.max(0.05, (rawMax - rawMin) * 0.1);
    const yMin = Math.max(1, rawMin - pad);
    const yMax = rawMax + pad;
    const ySpan = Math.max(0.0001, yMax - yMin);

    const plotW = WIDTH - PAD_L - PAD_R;
    const plotH = HEIGHT - PAD_T - PAD_B;
    const xOf = (ts: number) => PAD_L + ((ts - minTs) / tsSpan) * plotW;
    const yOf = (v: number) => PAD_T + (1 - (v - yMin) / ySpan) * plotH;

    const gridYs = [0, 0.25, 0.5, 0.75, 1].map((f) => ({
      y: PAD_T + (1 - f) * plotH,
      label: (yMin + f * ySpan).toFixed(2),
    }));

    // Per-series projected pixel points + sorted ts list for tooltip lookup.
    const seriesPx = series.map((s) => {
      const pts: Array<{ x: number; y: number }> = [];
      const tsList: number[] = [];
      const valByTs = new Map<number, number>();
      for (const p of s.points) {
        const v = oddsOf(p);
        if (v == null) continue;
        pts.push({ x: xOf(p.tsMs), y: yOf(v) });
        tsList.push(p.tsMs);
        valByTs.set(p.tsMs, v);
      }
      return { outcomeId: s.outcomeId, name: s.name, pts, tsList, valByTs };
    });

    // Union of every timestamp across series, sorted ascending — used to
    // snap the cursor to the nearest real point.
    const unionTs = Array.from(
      new Set(seriesPx.flatMap((sp) => sp.tsList)),
    ).sort((a, b) => a - b);

    return {
      minTs,
      maxTs,
      plotW,
      plotH,
      xOf,
      gridYs,
      seriesPx,
      unionTs,
    };
  }, [series]);

  if (!layout) {
    return (
      <div className="rounded-[10px] border border-[var(--color-border)] bg-[var(--color-bg)] p-4 text-xs text-[var(--color-fg-subtle)]">
        No odds history in the last 24h. The Odds history button shows the
        full 7-day window.
      </div>
    );
  }

  const handleMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const xPx = ((e.clientX - rect.left) / rect.width) * WIDTH;
    if (xPx < PAD_L || xPx > WIDTH - PAD_R) {
      setHoverTs(null);
      return;
    }
    const frac = (xPx - PAD_L) / layout.plotW;
    const target = layout.minTs + frac * (layout.maxTs - layout.minTs);
    const idx = binarySearchLE(layout.unionTs, target);
    if (idx < 0) {
      setHoverTs(null);
      return;
    }
    // Snap to nearest of [idx, idx+1].
    const left = layout.unionTs[idx]!;
    const right = layout.unionTs[idx + 1] ?? left;
    const snapped = Math.abs(target - left) <= Math.abs(target - right) ? left : right;
    setHoverTs(snapped);
  };

  // Resolve each series' value at hoverTs (carry-forward semantics).
  const snapshot = hoverTs == null
    ? null
    : layout.seriesPx.map((sp) => {
        const idx = binarySearchLE(sp.tsList, hoverTs);
        if (idx < 0) return { outcomeId: sp.outcomeId, name: sp.name, value: null };
        const ts = sp.tsList[idx]!;
        const value = sp.valByTs.get(ts) ?? null;
        return { outcomeId: sp.outcomeId, name: sp.name, value, ts };
      });

  const hoverX = hoverTs == null ? null : layout.xOf(hoverTs);

  return (
    <div className="relative rounded-[10px] border border-[var(--color-border)] bg-[var(--color-bg)]">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        xmlns="http://www.w3.org/2000/svg"
        role="img"
        aria-label="Odds history chart"
        style={{ display: "block", width: "100%", height: "auto" }}
        onMouseMove={handleMove}
        onMouseLeave={() => setHoverTs(null)}
      >
        {layout.gridYs.map((g, i) => (
          <g key={i}>
            <line
              x1={PAD_L}
              x2={WIDTH - PAD_R}
              y1={g.y}
              y2={g.y}
              stroke="var(--color-border)"
              strokeWidth={1}
              strokeDasharray={
                i === 0 || i === layout.gridYs.length - 1 ? undefined : "2,3"
              }
            />
            <text
              x={PAD_L - 6}
              y={g.y + 3}
              textAnchor="end"
              fontSize="9"
              fontFamily="var(--font-mono, monospace)"
              fill="var(--color-fg-subtle)"
            >
              {g.label}
            </text>
          </g>
        ))}
        <text
          x={PAD_L}
          y={HEIGHT - 6}
          fontSize="9"
          fontFamily="var(--font-mono, monospace)"
          fill="var(--color-fg-subtle)"
        >
          {new Date(layout.minTs).toLocaleString()}
        </text>
        <text
          x={WIDTH - PAD_R}
          y={HEIGHT - 6}
          textAnchor="end"
          fontSize="9"
          fontFamily="var(--font-mono, monospace)"
          fill="var(--color-fg-subtle)"
        >
          {new Date(layout.maxTs).toLocaleString()}
        </text>

        {layout.seriesPx.map((sp, si) => {
          if (sp.pts.length === 0) return null;
          const color = PALETTE[si % PALETTE.length];
          const pointsAttr = sp.pts
            .map((pt) => `${pt.x.toFixed(1)},${pt.y.toFixed(1)}`)
            .join(" ");
          const only = sp.pts[0]!;
          return (
            <g key={sp.outcomeId}>
              <polyline
                fill="none"
                stroke={color}
                strokeWidth={1.5}
                strokeLinejoin="round"
                strokeLinecap="round"
                points={pointsAttr}
              />
              {sp.pts.length === 1 ? (
                <circle cx={only.x} cy={only.y} r={2.5} fill={color} />
              ) : null}
            </g>
          );
        })}

        {hoverX != null && hoverTs != null ? (
          <g pointerEvents="none">
            <line
              x1={hoverX}
              x2={hoverX}
              y1={PAD_T}
              y2={HEIGHT - PAD_B}
              stroke="var(--color-fg-subtle)"
              strokeWidth={1}
              strokeDasharray="2,3"
            />
            {layout.seriesPx.map((sp, si) => {
              const idx = binarySearchLE(sp.tsList, hoverTs);
              if (idx < 0) return null;
              const ts = sp.tsList[idx]!;
              const pt = sp.pts[idx]!;
              const fresh = ts === hoverTs;
              return (
                <circle
                  key={sp.outcomeId}
                  cx={pt.x}
                  cy={pt.y}
                  r={fresh ? 3.5 : 2.5}
                  fill={PALETTE[si % PALETTE.length]}
                  stroke="var(--color-bg)"
                  strokeWidth={1}
                />
              );
            })}
          </g>
        ) : null}
      </svg>

      {hoverTs != null && snapshot ? (
        <div
          className="pointer-events-none absolute z-10 rounded-[8px] border border-[var(--color-border-strong)] bg-[var(--color-bg-card)] px-2.5 py-1.5 text-xs shadow-lg"
          style={{
            left: `min(calc(100% - 220px), ${(hoverX! / WIDTH) * 100}%)`,
            top: 8,
          }}
        >
          <div className="mb-1 font-mono text-[10px] text-[var(--color-fg-subtle)]">
            {new Date(hoverTs).toLocaleString()}
          </div>
          <ul className="space-y-0.5">
            {snapshot.map((s, si) => (
              <li
                key={s.outcomeId}
                className="flex items-center justify-between gap-3"
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <span
                    className="inline-block h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: PALETTE[si % PALETTE.length] }}
                  />
                  <span className="truncate text-[var(--color-fg-muted)]">
                    {s.name}
                  </span>
                </span>
                <span className="font-mono text-[var(--color-fg)]">
                  {s.value == null ? "—" : s.value.toFixed(2)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-[var(--color-border)] px-3 py-2 text-xs">
        {layout.seriesPx.map((sp, si) => (
          <span key={sp.outcomeId} className="flex items-center gap-1.5">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: PALETTE[si % PALETTE.length] }}
            />
            <span className="text-[var(--color-fg-muted)]">{sp.name}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
