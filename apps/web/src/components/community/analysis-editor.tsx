"use client";

// Pre-match analysis composer. Always opened in the context of a
// specific match; the match itself isn't editable. The author picks
// one of their accepted tickets on this match (server-pre-filtered),
// writes a perex (≤100) and body (100–5000), and submits.
//
// Inline validation mirrors the server gates exactly so submit only
// lights up when the client-side state would also pass. The server
// remains the source of truth on every gate — this is for ergonomics,
// not security.

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type {
  AnalysisSummary,
  CreateAnalysisRequest,
  EligibleTicketSummary,
  EligibleTicketsResponse,
} from "@oddzilla/types";
import { fromMicro } from "@oddzilla/types/money";
import { clientApi, ApiFetchError } from "@/lib/api-client";
import { useTranslations } from "@/lib/i18n";

type Translator = ReturnType<typeof useTranslations>;

interface Props {
  matchId: string;
  matchTitle: string;
  onClose: () => void;
}

const PEREX_MAX = 100;
const BODY_MIN = 100;
const BODY_MAX = 5000;

export function AnalysisEditor({ matchId, matchTitle, onClose }: Props) {
  const [tickets, setTickets] = useState<EligibleTicketSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [ticketId, setTicketId] = useState<string | null>(null);
  const [perex, setPerex] = useState("");
  const [body, setBody] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const router = useRouter();
  const t = useTranslations("analyses");
  const tCommon = useTranslations("common");

  // Lock background scroll while open.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // Esc closes — same pattern as the Apply Same Play modal.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Fetch the author's eligible tickets for this match. Server
  // already filters to accepted, all-on-this-match, min-odds 1.30,
  // and excludes any ticket already attached to a published
  // analysis — so an empty list means "the user has nothing to
  // attach", not a bug.
  useEffect(() => {
    let cancelled = false;
    clientApi<EligibleTicketsResponse>(
      `/community/me/analysis-eligible-tickets?match=${encodeURIComponent(matchId)}`,
    )
      .then((resp) => {
        if (cancelled) return;
        setTickets(resp.tickets);
        if (resp.tickets[0]) setTicketId(resp.tickets[0].ticketId);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiFetchError && err.status === 401) {
          router.push("/login");
          return;
        }
        setLoadError(t("editor.loadError"));
      });
    return () => {
      cancelled = true;
    };
  }, [matchId, router, t]);

  const perexLen = perex.length;
  const bodyLen = body.length;
  const perexValid = perexLen >= 1 && perexLen <= PEREX_MAX;
  const bodyValid = bodyLen >= BODY_MIN && bodyLen <= BODY_MAX;
  const ticketValid = ticketId !== null;
  const formValid = perexValid && bodyValid && ticketValid && !submitting;

  const helperColor = useMemo(
    () => (n: number, min: number, max: number) => {
      if (n < min) return "text-[var(--color-fg-subtle)]";
      if (n > max) return "text-[var(--color-negative)]";
      return "text-[var(--color-positive)]";
    },
    [],
  );

  async function onSubmit() {
    if (!ticketId || !formValid) return;
    setSubmitting(true);
    setSubmitError(null);
    const req: CreateAnalysisRequest = {
      matchId,
      ticketId,
      perex: perex.trim(),
      body: body.trim(),
    };
    try {
      await clientApi<AnalysisSummary>("/community/analyses", {
        method: "POST",
        body: JSON.stringify(req),
      });
      onClose();
      router.refresh();
    } catch (err) {
      const code =
        err instanceof ApiFetchError ? err.body.error : "unknown_error";
      setSubmitError(serverErrorCopy(code, t));
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-label={t("editor.title")}
      onClick={onClose}
    >
      <div
        className="card max-h-[95vh] w-full max-w-2xl overflow-y-auto p-5 sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold tracking-tight">{t("editor.title")}</h2>
            <p className="mt-1 text-xs text-[var(--color-fg-muted)]">{matchTitle}</p>
          </div>
          <button type="button" className="btn btn-ghost text-xs" onClick={onClose} aria-label={tCommon("close")}>
            {tCommon("close")}
          </button>
        </header>

        {tickets === null && !loadError ? (
          <p className="py-6 text-center text-sm text-[var(--color-fg-muted)]">{t("editor.loadingTickets")}</p>
        ) : loadError ? (
          <p className="py-6 text-center text-sm text-[var(--color-negative)]">{loadError}</p>
        ) : tickets && tickets.length === 0 ? (
          <NoEligibleTickets />
        ) : (
          <div className="space-y-4">
            <Field label={t("editor.attachBet")} hint={t("editor.minOddsHint")}>
              <ul className="space-y-1.5">
                {tickets!.map((ticket) => (
                  <li key={ticket.ticketId}>
                    <label className="flex cursor-pointer items-center gap-3 rounded-[8px] border border-[var(--color-border-strong)] px-3 py-2 text-sm hover:border-[var(--color-accent)]/60">
                      <input
                        type="radio"
                        name="ticket"
                        checked={ticketId === ticket.ticketId}
                        onChange={() => setTicketId(ticket.ticketId)}
                        className="accent-[var(--color-accent)]"
                      />
                      <span className="flex-1 font-mono text-xs">
                        {t("legs", { count: ticket.legCount })} · @{ticket.totalOdds} ·{" "}
                        {fromMicro(BigInt(ticket.stakeMicro))} {ticket.currency}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </Field>

            <Field
              label={t("editor.headline")}
              hint={`${perexLen}/${PEREX_MAX}`}
              hintTone={helperColor(perexLen, 1, PEREX_MAX)}
            >
              <input
                type="text"
                maxLength={PEREX_MAX + 5}
                value={perex}
                onChange={(e) => setPerex(e.target.value)}
                placeholder={t("editor.headlinePlaceholder")}
                className="w-full rounded-[8px] border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-3 py-2 text-sm"
              />
            </Field>

            <Field
              label={t("editor.reasoning")}
              hint={`${bodyLen}/${BODY_MAX}${bodyLen < BODY_MIN ? ` ${t("editor.needMore", { count: BODY_MIN - bodyLen })}` : ""}`}
              hintTone={helperColor(bodyLen, BODY_MIN, BODY_MAX)}
            >
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={10}
                placeholder={t("editor.reasoningPlaceholder")}
                className="w-full rounded-[8px] border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-3 py-2 text-sm leading-relaxed"
              />
            </Field>

            {submitError ? (
              <p className="text-xs text-[var(--color-negative)]">{submitError}</p>
            ) : null}

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="btn btn-ghost text-xs"
                disabled={submitting}
              >
                {tCommon("cancel")}
              </button>
              <button
                type="button"
                onClick={onSubmit}
                disabled={!formValid}
                className={
                  "rounded-full border px-4 py-1.5 text-[11px] uppercase tracking-[0.15em] transition " +
                  (formValid
                    ? "border-[var(--color-accent)] bg-[var(--color-accent)]/10 text-[var(--color-accent)] hover:bg-[var(--color-accent)]/20"
                    : "cursor-not-allowed border-[var(--color-border-strong)] text-[var(--color-fg-subtle)]")
                }
              >
                {submitting ? t("editor.publishing") : t("editor.publish")}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  hintTone,
  children,
}: {
  label: string;
  hint?: string;
  hintTone?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between text-xs uppercase tracking-[0.15em]">
        <span className="text-[var(--color-fg-subtle)]">{label}</span>
        {hint ? (
          <span className={hintTone ?? "text-[var(--color-fg-subtle)]"}>{hint}</span>
        ) : null}
      </div>
      {children}
    </div>
  );
}

function NoEligibleTickets() {
  const t = useTranslations("analyses");
  return (
    <div className="py-10 text-center text-sm text-[var(--color-fg-muted)]">
      <p>{t("editor.noTicketsTitle")}</p>
      <p className="mt-1 text-xs">{t("editor.noTicketsHint")}</p>
    </div>
  );
}

function serverErrorCopy(code: string, t: Translator): string {
  const map: Record<string, string> = {
    match_not_eligible: t("editor.errors.matchNotEligible"),
    ticket_not_owned: t("editor.errors.ticketNotOwned"),
    ticket_match_mismatch: t("editor.errors.ticketMatchMismatch"),
    ticket_not_eligible: t("editor.errors.ticketNotEligible"),
    analysis_exists: t("editor.errors.analysisExists"),
    perex_invalid: t("editor.errors.perexInvalid"),
    body_invalid: t("editor.errors.bodyInvalid"),
    rate_limit_monthly: t("editor.errors.rateLimitMonthly"),
  };
  return map[code] ?? t("editor.errors.fallback");
}
