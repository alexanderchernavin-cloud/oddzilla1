"use client";

import { useMemo, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toMicro } from "@oddzilla/types/money";
import { useBetSlip } from "@/lib/bet-slip";
import { clientApi, ApiFetchError } from "@/lib/api-client";
import { I } from "@/components/ui/icons";
import { Button } from "@/components/ui/primitives";
import { SportGlyph } from "@/components/ui/sport-glyph";
import type { SlipSelection } from "@oddzilla/types";

export function BetSlipRail() {
  const slip = useBetSlip();
  const selections = slip.selections;
  const router = useRouter();
  const [stakeInput, setStakeInput] = useState("10.00");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [placedTicketId, setPlacedTicketId] = useState<string | null>(null);

  // Combined odds = product of all selection odds (combo accumulator).
  // With a single selection, this degrades to that selection's odds —
  // the rail renders the same way for singles and combos.
  const combinedOdds = useMemo(() => {
    if (selections.length === 0) return 0;
    return selections.reduce((acc, s) => acc * Number(s.odds || 0), 1);
  }, [selections]);

  const potentialReturn = useMemo(() => {
    const stake = Number(stakeInput);
    if (!Number.isFinite(stake) || stake <= 0 || combinedOdds <= 0) return 0;
    return stake * combinedOdds;
  }, [stakeInput, combinedOdds]);

  const isCombo = selections.length >= 2;

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (selections.length === 0) return;
    setError(null);
    setPlacedTicketId(null);

    let stakeMicro: string;
    try {
      const micro = toMicro(stakeInput);
      if (micro <= 0n) {
        setError("Stake must be positive.");
        return;
      }
      stakeMicro = micro.toString();
    } catch {
      setError("Invalid stake.");
      return;
    }

    setSubmitting(true);
    try {
      const idempotencyKey = crypto.randomUUID();
      const res = await clientApi<{ ticket: { id: string; status: string } }>(
        "/bets",
        {
          method: "POST",
          body: JSON.stringify({
            stakeMicro,
            idempotencyKey,
            selections: selections.map((s) => ({
              marketId: s.marketId,
              outcomeId: s.outcomeId,
              odds: s.odds,
            })),
          }),
        },
      );
      setPlacedTicketId(res.ticket.id);
      slip.clear();
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiFetchError ? mapError(err) : "Placement failed.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <aside
      className="oz-rail"
      style={{
        gridArea: "rail",
        borderLeft: "1px solid var(--hairline)",
        background: "var(--bg)",
        display: "flex",
        flexDirection: "column",
        position: "sticky",
        top: 60,
        maxHeight: "calc(100vh - 60px)",
      }}
    >
      <div
        style={{
          padding: "18px 20px 14px",
          display: "flex",
          alignItems: "center",
          gap: 10,
          borderBottom: "1px solid var(--hairline)",
        }}
      >
        <I.Ticket size={16} />
        <span
          className="display"
          style={{ fontSize: 16, fontWeight: 500, letterSpacing: "-0.01em" }}
        >
          Bet slip
        </span>
        {selections.length > 0 && (
          <span
            className="mono"
            style={{
              fontSize: 10.5,
              padding: "2px 8px",
              background: isCombo ? "var(--fg)" : "var(--surface-2)",
              color: isCombo ? "var(--bg)" : "var(--fg-muted)",
              border: isCombo ? "1px solid var(--fg)" : "1px solid var(--border)",
              borderRadius: 999,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              fontWeight: 600,
            }}
          >
            {isCombo ? `Combo · ${selections.length}` : "Single"}
          </span>
        )}
        <div style={{ flex: 1 }} />
        {selections.length > 0 && (
          <button
            type="button"
            onClick={slip.clear}
            style={{
              background: 0,
              border: 0,
              color: "var(--fg-muted)",
              fontSize: 12,
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            Clear
          </button>
        )}
      </div>

      <div
        style={{
          flex: 1,
          overflow: "auto",
          padding: "12px 16px 8px",
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        {placedTicketId ? (
          <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 10 }}>
            <div
              style={{
                width: 36,
                height: 36,
                borderRadius: 999,
                background: "color-mix(in oklab, var(--positive) 15%, transparent)",
                color: "var(--positive)",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              ✓
            </div>
            <div
              className="display"
              style={{ fontSize: 16, fontWeight: 500, letterSpacing: "-0.01em" }}
            >
              Bet placed.
            </div>
            <div style={{ fontSize: 12, color: "var(--fg-muted)" }}>
              Ticket id{" "}
              <span className="mono">{placedTicketId.slice(0, 8)}…</span>
            </div>
            <Link
              href="/bets"
              style={{
                fontSize: 13,
                color: "var(--fg)",
                textDecoration: "underline",
                marginTop: 4,
              }}
            >
              View in bet history →
            </Link>
          </div>
        ) : selections.length === 0 ? (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 8,
              textAlign: "center",
              padding: "12px 20px 20px",
              color: "var(--fg-muted)",
            }}
          >
            <div
              style={{
                width: 44,
                height: 44,
                borderRadius: 999,
                background: "var(--surface-2)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "var(--fg-dim)",
              }}
            >
              <I.Ticket size={18} />
            </div>
            <div
              className="display"
              style={{ fontSize: 15, color: "var(--fg)", letterSpacing: "-0.01em" }}
            >
              Empty slip
            </div>
            <div
              style={{
                fontSize: 12,
                color: "var(--fg-muted)",
                maxWidth: 220,
                lineHeight: 1.5,
              }}
            >
              Tap any odds button to build your bet. Add a second match for a
              combo — multiple markets from the same match replace each other.
            </div>
          </div>
        ) : (
          <>
            {selections.map((s) => (
              <SelectionCard
                key={`${s.marketId}:${s.outcomeId}`}
                selection={s}
                onRemove={() => slip.remove(s.marketId, s.outcomeId)}
              />
            ))}
          </>
        )}
      </div>

      {selections.length > 0 && !placedTicketId && (
        <form
          onSubmit={onSubmit}
          style={{
            padding: "14px 20px 18px",
            borderTop: "1px solid var(--hairline)",
            display: "flex",
            flexDirection: "column",
            gap: 12,
          }}
        >
          {isCombo && (
            <div
              style={{
                display: "flex",
                alignItems: "baseline",
                justifyContent: "space-between",
                fontSize: 12,
                color: "var(--fg-muted)",
              }}
            >
              <span>Combo · {selections.length} legs</span>
              <span className="mono tnum" style={{ fontSize: 14, fontWeight: 600, color: "var(--fg)" }}>
                {combinedOdds.toFixed(2)}
              </span>
            </div>
          )}

          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "0 14px",
              height: 44,
              background: "var(--surface-2)",
              border: "1px solid var(--border)",
              borderRadius: 10,
            }}
          >
            <span style={{ fontSize: 12, color: "var(--fg-muted)" }}>Stake</span>
            <input
              value={stakeInput}
              onChange={(e) => setStakeInput(e.target.value.replace(/[^\d.]/g, ""))}
              className="mono tnum"
              inputMode="decimal"
              style={{
                flex: 1,
                border: 0,
                background: "transparent",
                outline: "none",
                fontFamily: "var(--font-mono)",
                fontSize: 15,
                fontWeight: 600,
                color: "var(--fg)",
                textAlign: "right",
              }}
            />
            <span className="mono" style={{ fontSize: 12, color: "var(--fg-muted)" }}>
              USDT
            </span>
          </div>

          <div style={{ display: "flex", gap: 6 }}>
            {[10, 25, 50, 100].map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setStakeInput(String(v))}
                style={{
                  flex: 1,
                  height: 28,
                  fontSize: 12,
                  background: "transparent",
                  border: "1px solid var(--border)",
                  borderRadius: 999,
                  cursor: "pointer",
                  color: "var(--fg-muted)",
                  fontFamily: "var(--font-mono)",
                  fontWeight: 500,
                }}
              >
                {v}
              </button>
            ))}
          </div>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "10px 0",
              borderTop: "1px dashed var(--border)",
              borderBottom: "1px dashed var(--border)",
            }}
          >
            <span style={{ fontSize: 12, color: "var(--fg-muted)" }}>Potential return</span>
            <span
              className="display tnum"
              style={{ fontSize: 22, fontWeight: 500, letterSpacing: "-0.02em" }}
            >
              {potentialReturn.toFixed(2)}
            </span>
          </div>

          {error && (
            <div
              role="alert"
              style={{ fontSize: 12, color: "var(--negative)", lineHeight: 1.45 }}
            >
              {error}
            </div>
          )}

          <Button
            variant="primary"
            size="lg"
            type="submit"
            disabled={submitting}
            style={{ width: "100%" }}
          >
            {submitting ? "Placing…" : isCombo ? "Place combo" : "Place bet"}
          </Button>

          <div style={{ fontSize: 11, color: "var(--fg-dim)", textAlign: "center" }}>
            Odds may update before acceptance.
          </div>
        </form>
      )}
    </aside>
  );
}

function SelectionCard({
  selection,
  onRemove,
}: {
  selection: SlipSelection;
  onRemove: () => void;
}) {
  return (
    <div
      style={{
        padding: "12px 14px",
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 10,
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <SportGlyph sport={selection.sportSlug} size={12} />
        <span
          className="mono"
          style={{
            fontSize: 10,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "var(--fg-dim)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {selection.marketLabel}
        </span>
        <div style={{ flex: 1 }} />
        <button
          type="button"
          onClick={onRemove}
          style={{
            background: 0,
            border: 0,
            color: "var(--fg-dim)",
            cursor: "pointer",
            padding: 2,
          }}
          aria-label="Remove selection"
        >
          <I.Close size={12} />
        </button>
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 10,
        }}
      >
        <div
          style={{
            fontSize: 13.5,
            fontWeight: 500,
            letterSpacing: "-0.005em",
            minWidth: 0,
            flex: 1,
          }}
        >
          {selection.outcomeLabel}
        </div>
        <div className="mono tnum" style={{ fontSize: 14, fontWeight: 600, flexShrink: 0 }}>
          {Number(selection.odds).toFixed(2)}
        </div>
      </div>
      <div style={{ fontSize: 11, color: "var(--fg-muted)" }}>
        {selection.homeTeam} vs {selection.awayTeam}
      </div>
    </div>
  );
}

function mapError(err: ApiFetchError): string {
  switch (err.body.error) {
    case "insufficient_balance":
      return "Not enough balance for this stake.";
    case "exceeds_global_limit":
      return "Stake exceeds your global limit.";
    case "odds_drift_exceeded":
      return "The odds moved since you clicked. Try again.";
    case "market_not_active":
    case "outcome_not_active":
    case "outcome_no_price":
      return "This market is suspended. Try again in a moment.";
    case "match_not_open":
      return "This match is no longer open for betting.";
    case "account_not_active":
      return "Your account can't place bets right now.";
    case "idempotency_key_collision":
      return "Please retry — collision on submission id.";
    case "combo_same_match":
      return "Combos can't include two markets from the same match.";
    default:
      return err.body.message || "Placement failed.";
  }
}
