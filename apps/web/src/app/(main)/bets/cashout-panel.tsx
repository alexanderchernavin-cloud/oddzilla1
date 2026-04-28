"use client";

import { useEffect, useRef, useState } from "react";
import { fromMicro } from "@oddzilla/types/money";
import type { CashoutQuote, TicketSummary } from "@oddzilla/types";
import { clientApi, ApiFetchError } from "@/lib/api-client";

const POLL_MS = 2000;

const REASON_COPY: Record<string, string> = {
  not_open: "Cashout is only available for open tickets.",
  feature_disabled: "Cashout is currently disabled for this ticket.",
  leg_inactive: "One leg is suspended. Cashout will return when odds resume.",
  leg_no_probability:
    "Live probability missing for one leg. Cashout will return shortly.",
  leg_lost: "One leg has lost — cashout no longer available.",
  below_minimum: "Current offer is below the minimum cashout amount.",
  below_change_threshold:
    "Probability hasn't moved enough yet — cashout will appear once it does.",
};

interface Props {
  ticket: TicketSummary;
  onCashedOut: (
    ticketId: string,
    payoutMicro: string,
    cashedOutAt: string,
  ) => void;
}

export function CashoutPanel({ ticket, onCashedOut }: Props) {
  const [quote, setQuote] = useState<CashoutQuote | null>(null);
  const [accepting, setAccepting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const cancelRef = useRef(false);

  useEffect(() => {
    cancelRef.current = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function tick() {
      if (cancelRef.current || ticket.status !== "accepted") return;
      try {
        const res = await clientApi<{ quote: CashoutQuote }>(
          `/tickets/${ticket.id}/cashout/quote`,
        );
        if (cancelRef.current) return;
        setQuote(res.quote);
        setError(null);
      } catch (e) {
        if (cancelRef.current) return;
        // Soft-fail: show last known quote, log error.
        if (e instanceof ApiFetchError) {
          setError(e.body.message);
        } else {
          setError("Could not fetch cashout offer.");
        }
      } finally {
        if (!cancelRef.current && ticket.status === "accepted") {
          timer = setTimeout(tick, POLL_MS);
        }
      }
    }

    void tick();
    return () => {
      cancelRef.current = true;
      if (timer) clearTimeout(timer);
    };
  }, [ticket.id, ticket.status]);

  if (ticket.status !== "accepted") return null;

  // Pre-confirm or quote-not-yet-loaded.
  if (!quote) {
    return (
      <div className="mt-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3 text-xs text-[var(--color-fg-muted)]">
        Loading cashout offer…
      </div>
    );
  }

  if (!quote.available) {
    const message =
      (quote.reason && REASON_COPY[quote.reason]) ??
      "Cashout is not available right now.";
    return (
      <div className="mt-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3 text-xs text-[var(--color-fg-muted)]">
        {message}
      </div>
    );
  }

  const offer = quote.offerMicro
    ? fromMicro(BigInt(quote.offerMicro))
    : "0";

  async function accept() {
    if (!quote || !quote.quoteId || !quote.offerMicro) return;
    setAccepting(true);
    setError(null);
    try {
      const res = await clientApi<{
        ticketId: string;
        payoutMicro: string;
        cashedOutAt: string;
      }>(`/tickets/${ticket.id}/cashout`, {
        method: "POST",
        body: JSON.stringify({
          quoteId: quote.quoteId,
          expectedOfferMicro: quote.offerMicro,
        }),
      });
      onCashedOut(res.ticketId, res.payoutMicro, res.cashedOutAt);
    } catch (e) {
      if (e instanceof ApiFetchError) {
        if (e.body.error === "quote_expired" || e.body.error === "quote_amount_mismatch") {
          setError("Offer changed. Refreshing…");
          // Trigger refresh on the next tick.
          setQuote(null);
        } else {
          setError(e.body.message);
        }
      } else {
        setError("Could not complete cashout.");
      }
      setConfirming(false);
    } finally {
      setAccepting(false);
    }
  }

  return (
    <div className="mt-3 rounded-md border border-[var(--color-accent)] bg-[var(--color-surface-2)] p-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
            Cashout offer
            {quote.fullPayback ? " · full stake" : null}
          </div>
          <div className="mt-1 font-mono text-base">
            {offer} {ticket.currency}
          </div>
        </div>
        <div className="flex flex-col items-end gap-1">
          {!confirming ? (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              disabled={accepting}
              className="btn btn-primary text-xs"
            >
              Cash out
            </button>
          ) : (
            <div className="flex gap-1">
              <button
                type="button"
                onClick={() => setConfirming(false)}
                disabled={accepting}
                className="btn btn-ghost text-xs"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={accept}
                disabled={accepting}
                className="btn btn-primary text-xs"
              >
                {accepting ? "…" : `Confirm ${offer} ${ticket.currency}`}
              </button>
            </div>
          )}
          {error ? (
            <div className="text-[11px] text-[var(--color-negative)]">
              {error}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
