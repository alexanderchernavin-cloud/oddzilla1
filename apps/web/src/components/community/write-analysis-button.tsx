"use client";

// Lazy boundary between the server-rendered Analyses section and
// the client-side editor. Splitting the button into its own
// component lets the section stay async/server while still owning
// the CTA copy and visibility logic.

import { useState } from "react";
import { AnalysisEditor } from "./analysis-editor";

export function WriteAnalysisButton({
  matchId,
  matchTitle,
}: {
  matchId: string;
  matchTitle: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-full border border-[var(--color-accent)] px-3 py-1 text-[11px] uppercase tracking-[0.15em] text-[var(--color-accent)] transition hover:bg-[var(--color-accent)]/10"
      >
        Write analysis
      </button>
      {open ? (
        <AnalysisEditor
          matchId={matchId}
          matchTitle={matchTitle}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}
