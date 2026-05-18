"use client";

// Big-Win-only CTA. Replaces "Copy this bet" on settled big-win
// cards: the underlying match is already over, so the user can't
// place the same legs literally. Apply Same Play opens the modal,
// which finds upcoming matches that fit the same play structure.
//
// Auth gate: anonymous viewers see the CTA (per PRD §"Auth gating")
// but tapping it bounces them to /login instead of opening the modal
// — avoids a loading-flash before the inevitable 401 redirect from
// the candidates fetch. Authed viewers get the modal directly.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useSessionUserId } from "@/lib/session-user";
import { ApplySamePlayModal } from "./apply-same-play-modal";

export function ApplySamePlayButton({ ticketId }: { ticketId: string }) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const userId = useSessionUserId();

  function onClick() {
    if (userId === null) {
      router.push("/login");
      return;
    }
    setOpen(true);
  }

  return (
    <div className="text-right">
      <button
        type="button"
        onClick={onClick}
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
