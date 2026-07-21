"use client";

import { useEffect, useRef, useState } from "react";
import { fromMicro } from "@oddzilla/types/money";
import type { CashoutQuote, TicketSummary } from "@oddzilla/types";
import { clientApi, ApiFetchError } from "@/lib/api-client";
import { useWallets } from "@/lib/wallets";
import { useTranslations } from "@/lib/i18n";

// 5s cadence balances offer freshness against backend load. With 1000+
// concurrent open tickets that's 200 quotes/s — comfortable for one
// api container hitting Postgres on the same box.
const POLL_MS = 5000;

// Server reason codes that have a translated message under
// `cashoutPanel.reasons.*`; anything else falls back to the generic
// "not available" copy.
const KNOWN_REASONS = new Set([
  "not_open",
  "feature_disabled",
  "leg_inactive",
  "leg_no_probability",
  "leg_lost",
  "below_minimum",
  "below_change_threshold",
]);

interface Props {
  ticket: TicketSummary;
  onCashedOut: (
    ticketId: string,
    payoutMicro: string,
    cashedOutAt: string,
  ) => void;
}

export function CashoutPanel({ ticket, onCashedOut }: Props) {
  const t = useTranslations("cashoutPanel");
  const { refresh: refreshWallets } = useWallets();
  const [quote, setQuote] = useState<CashoutQuote | null>(null);
  const [accepting, setAccepting] = useState(false);
  const [acceptingDeadlineMs, setAcceptingDeadlineMs] = useState<number | null>(
    null,
  );
  const [, setTick] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const cancelRef = useRef(false);

  // Tick frequently while the acceptance countdown is running so the
  // button label stays close to wall-clock. remainingSec is computed
  // from Date.now() inline below — this state just forces a re-render.
  useEffect(() => {
    if (acceptingDeadlineMs === null) return;
    const t = setInterval(() => setTick((n) => n + 1), 200);
    return () => clearInterval(t);
  }, [acceptingDeadlineMs]);

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
          setError(t("fetchError"));
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
        {t("loading")}
      </div>
    );
  }

  if (!quote.available) {
    const message =
      quote.reason && KNOWN_REASONS.has(quote.reason)
        ? t(`reasons.${quote.reason}`)
        : t("unavailable");
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
    const delaySec = quote.acceptanceDelaySeconds ?? 0;
    if (delaySec > 0) {
      setAcceptingDeadlineMs(Date.now() + delaySec * 1000);
    }
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
      // Credit landed — pull the new balance so the top-bar pill +
      // any other wallet consumers reflect the cashout payout.
      void refreshWallets();
    } catch (e) {
      if (e instanceof ApiFetchError) {
        if (
          e.body.error === "quote_expired" ||
          e.body.error === "quote_amount_mismatch" ||
          e.body.error === "offer_drifted"
        ) {
          setError(t("offerChanged"));
          setQuote(null);
        } else {
          setError(e.body.message);
        }
      } else {
        setError(t("completeError"));
      }
      setConfirming(false);
    } finally {
      setAccepting(false);
      setAcceptingDeadlineMs(null);
    }
  }

  const remainingSec =
    acceptingDeadlineMs !== null
      ? Math.max(0, Math.ceil((acceptingDeadlineMs - Date.now()) / 1000))
      : 0;

  return (
    <div className="mt-3 rounded-md border border-[var(--color-accent)] bg-[var(--color-surface-2)] p-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
            {t("offerLabel")}
            {quote.fullPayback ? ` · ${t("fullStake")}` : null}
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
              {t("cashOutCta")}
            </button>
          ) : (
            <div className="flex gap-1">
              <button
                type="button"
                onClick={() => setConfirming(false)}
                disabled={accepting}
                className="btn btn-ghost text-xs"
              >
                {t("cancel")}
              </button>
              <button
                type="button"
                onClick={accept}
                disabled={accepting}
                className="btn btn-primary text-xs"
              >
                {accepting
                  ? remainingSec > 0
                    ? t("confirmingSeconds", { seconds: remainingSec })
                    : t("confirming")
                  : t("confirmCta", { amount: offer, currency: ticket.currency })}
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
