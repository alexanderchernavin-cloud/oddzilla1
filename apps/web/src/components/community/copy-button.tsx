"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { CommunityCopyResponse } from "@oddzilla/types";
import { useBetSlip } from "@/lib/bet-slip";
import { clientApi, ApiFetchError } from "@/lib/api-client";

// Copy-to-bet on a community feed card. Calls the backend's
// /community/copy endpoint, drops every still-available leg into the
// bet-slip via the existing add() API, and opens the slip rail. The
// slip's place flow handles the rest — POST /bets re-validates odds
// and market state, so a leg that's drifted out of `status=1` between
// click and submit will reject there with a clear error.

interface CopyButtonProps {
  ticketId: string;
}

type Status =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "added"; legs: number; dropped: number }
  | { kind: "no_legs" }
  | { kind: "error"; message: string };

export function CopyButton({ ticketId }: CopyButtonProps) {
  const router = useRouter();
  const slip = useBetSlip();
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [pending, startTransition] = useTransition();

  async function onCopy() {
    setStatus({ kind: "loading" });
    try {
      const resp = await clientApi<CommunityCopyResponse>(
        `/community/copy/${ticketId}`,
        { method: "POST" },
      );

      const available = resp.selections.filter((s) => s.available);
      const dropped = resp.selections.length - available.length;

      if (available.length === 0) {
        setStatus({ kind: "no_legs" });
        return;
      }

      // The slip's add() drops any same-match leg already in the slip
      // (one leg per match across slips). That's the right behaviour
      // here too — copying is conceptually "replace whatever I had on
      // these matches".
      for (const sel of available) {
        slip.add({
          matchId: sel.matchId,
          marketId: sel.marketId,
          outcomeId: sel.outcomeId,
          odds: sel.odds,
          // The /community/copy endpoint already filters to legs whose
          // markets are still active — assume bettable; the slip rail
          // will re-derive from WS ticks once the legs subscribe.
          active: true,
          homeTeam: sel.homeTeam,
          awayTeam: sel.awayTeam,
          marketLabel: sel.marketLabel,
          outcomeLabel: sel.outcomeLabel,
          sportSlug: sel.sportSlug,
        });
      }

      // Match the original ticket's bet type when it's safe — single
      // / combo. tiple/tippot need explicit user opt-in via the slip
      // mode tabs (probabilities are repriced from current odds), so
      // we don't auto-flip into those modes here.
      if (resp.betType === "single" || resp.betType === "combo") {
        slip.setMode(resp.betType);
      }
      slip.setOpen(true);

      setStatus({ kind: "added", legs: available.length, dropped });
      startTransition(() => router.refresh());
    } catch (err) {
      setStatus({
        kind: "error",
        message:
          err instanceof ApiFetchError
            ? err.body.message
            : "Couldn't copy this bet.",
      });
    }
  }

  return (
    <div className="text-right">
      <button
        type="button"
        onClick={onCopy}
        disabled={status.kind === "loading" || pending}
        className="btn btn-ghost text-xs"
      >
        {status.kind === "loading" ? "Copying…" : "Copy this bet"}
      </button>
      <StatusLine status={status} />
    </div>
  );
}

function StatusLine({ status }: { status: Status }) {
  if (status.kind === "added") {
    if (status.dropped > 0) {
      return (
        <p className="mt-1 text-[10px] text-[var(--color-fg-muted)]">
          Added {status.legs} leg{status.legs === 1 ? "" : "s"} ·{" "}
          {status.dropped} closed
        </p>
      );
    }
    return (
      <p className="mt-1 text-[10px] text-[var(--color-positive)]">
        Added to slip
      </p>
    );
  }
  if (status.kind === "no_legs") {
    return (
      <p className="mt-1 text-[10px] text-[var(--color-fg-muted)]">
        Markets closed
      </p>
    );
  }
  if (status.kind === "error") {
    return (
      <p className="mt-1 text-[10px] text-[var(--color-negative)]">
        {status.message}
      </p>
    );
  }
  return null;
}
