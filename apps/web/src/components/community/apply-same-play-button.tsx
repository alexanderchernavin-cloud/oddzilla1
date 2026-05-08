"use client";

// Big-Win-only CTA. Replaces "Copy this bet" on settled big-win
// cards: the underlying match is already over, so the user can't
// place the same legs literally. Apply Same Play opens the modal,
// which finds upcoming matches that fit the same play structure.
//
// The modal owns the network request and ranking; this component
// just toggles its visibility and renders the gold-pill CTA from
// the PRD.

import { useState } from "react";
import { ApplySamePlayModal } from "./apply-same-play-modal";

export function ApplySamePlayButton({ ticketId }: { ticketId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="text-right">
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-full border border-[var(--color-accent)] px-3 py-1 text-[11px] uppercase tracking-[0.15em] text-[var(--color-accent)] transition hover:bg-[var(--color-accent)]/10"
      >
        Apply same play
      </button>
      {open ? (
        <ApplySamePlayModal
          ticketId={ticketId}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </div>
  );
}
