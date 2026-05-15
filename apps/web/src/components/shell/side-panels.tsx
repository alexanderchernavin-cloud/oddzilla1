"use client";

// SidePanels — renders two fixed-position iframes in the empty bands
// flanking the centered `.oz-shell` on ultra-wide viewports. Each panel
// shows a separate match in the shell-less `/embed/match/[id]` route so
// a bettor can keep two extra matches "open" alongside whatever the
// main column is showing.
//
// Visibility is gated in CSS via `.oz-side-panel { display: none }` +
// a `@media (min-width: 2200px)` block that turns them on; this
// component is mounted on every page under the (main) shell but only
// paints anything when the viewport is wide enough for the panels to
// fit without overlapping the shell.
//
// The iframe sits at the SAME origin so cookies (auth + theme) flow
// through. State sync with the parent bet slip is intentionally NOT
// wired in v1 — each iframe owns its own slip rail; clicking an
// outcome inside the panel uses that frame's rail to place the bet.

import { I } from "@/components/ui/icons";
import { useSidePanels, type PanelSide } from "@/lib/side-panel";

export function SidePanels() {
  const { left, right, close } = useSidePanels();
  return (
    <>
      <SidePanel side="left" matchId={left} onClose={() => close("left")} />
      <SidePanel side="right" matchId={right} onClose={() => close("right")} />
    </>
  );
}

function SidePanel({
  side,
  matchId,
  onClose,
}: {
  side: PanelSide;
  matchId: string | null;
  onClose: () => void;
}) {
  const empty = matchId == null;
  return (
    <aside
      className="oz-side-panel"
      data-side={side}
      data-open={empty ? "false" : "true"}
      aria-hidden={empty}
    >
      {empty ? null : (
        <>
          <div className="oz-side-panel-header">
            <span className="mono" style={{ fontSize: 10.5, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--fg-dim)" }}>
              {side === "left" ? "Left panel" : "Right panel"}
            </span>
            <button
              type="button"
              className="oz-side-panel-close"
              onClick={onClose}
              aria-label="Close panel"
              title="Close panel"
            >
              <I.Close size={14} />
            </button>
          </div>
          <iframe
            className="oz-side-panel-frame"
            src={`/embed/match/${matchId}`}
            title={`Match ${matchId}`}
            // Same-origin: no sandbox attribute so cookies + storage
            // work normally. The embed route emits its own minimal
            // chrome; we only host the close button + container.
          />
        </>
      )}
    </aside>
  );
}
