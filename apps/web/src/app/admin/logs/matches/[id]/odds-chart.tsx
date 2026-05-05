// Pure-SVG line chart for one market. Plots `published ?? raw` per series
// against time. Axes are auto-scaled from the data. Runs on the server as
// a regular React component — no client hydration needed.

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

export function OddsChart({ series }: { series: Series[] }) {
  const allPoints: Array<{ ts: number; v: number }> = [];
  for (const s of series) {
    for (const p of s.points) {
      const v = oddsOf(p);
      if (v != null) allPoints.push({ ts: p.tsMs, v });
    }
  }

  if (allPoints.length === 0) {
    return (
      <div className="rounded-[10px] border border-[var(--color-border)] bg-[var(--color-bg)] p-4 text-xs text-[var(--color-fg-subtle)]">
        No odds history in the last 24h. The Odds history button shows the
        full 7-day window.
      </div>
    );
  }

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

  // Y-axis gridlines at 25/50/75/100% of range
  const gridYs = [0, 0.25, 0.5, 0.75, 1].map((f) => ({
    y: PAD_T + (1 - f) * plotH,
    label: (yMin + f * ySpan).toFixed(2),
  }));

  return (
    <div className="rounded-[10px] border border-[var(--color-border)] bg-[var(--color-bg)]">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        xmlns="http://www.w3.org/2000/svg"
        role="img"
        aria-label="Odds history chart"
        style={{ display: "block", width: "100%", height: "auto" }}
      >
        {gridYs.map((g, i) => (
          <g key={i}>
            <line
              x1={PAD_L}
              x2={WIDTH - PAD_R}
              y1={g.y}
              y2={g.y}
              stroke="var(--color-border)"
              strokeWidth={1}
              strokeDasharray={i === 0 || i === gridYs.length - 1 ? undefined : "2,3"}
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
          {new Date(minTs).toLocaleString()}
        </text>
        <text
          x={WIDTH - PAD_R}
          y={HEIGHT - 6}
          textAnchor="end"
          fontSize="9"
          fontFamily="var(--font-mono, monospace)"
          fill="var(--color-fg-subtle)"
        >
          {new Date(maxTs).toLocaleString()}
        </text>

        {series.map((s, si) => {
          const color = PALETTE[si % PALETTE.length];
          const pts: Array<{ x: number; y: number }> = [];
          for (const p of s.points) {
            const v = oddsOf(p);
            if (v == null) continue;
            pts.push({ x: xOf(p.tsMs), y: yOf(v) });
          }
          if (pts.length === 0) return null;
          const pointsAttr = pts
            .map((pt) => `${pt.x.toFixed(1)},${pt.y.toFixed(1)}`)
            .join(" ");
          const only = pts[0]!;
          return (
            <g key={s.outcomeId}>
              <polyline
                fill="none"
                stroke={color}
                strokeWidth={1.5}
                strokeLinejoin="round"
                strokeLinecap="round"
                points={pointsAttr}
              />
              {pts.length === 1 ? (
                <circle cx={only.x} cy={only.y} r={2.5} fill={color} />
              ) : null}
            </g>
          );
        })}
      </svg>
      <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-[var(--color-border)] px-3 py-2 text-xs">
        {series.map((s, si) => (
          <span key={s.outcomeId} className="flex items-center gap-1.5">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: PALETTE[si % PALETTE.length] }}
            />
            <span className="text-[var(--color-fg-muted)]">{s.name}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
