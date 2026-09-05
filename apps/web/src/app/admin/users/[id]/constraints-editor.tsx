"use client";

// Inline editors for the levers that actually change what a bettor may
// place: risk factor (users.risk_score), per-ticket stake limit
// (users.global_limit_micro), bet delay (users.bet_delay_seconds) and
// account status. Each row saves on its own so an operator can cut one
// limit without touching the others. Risk factor goes through the
// RiskZilla endpoint (its own audit action); the rest through
// PATCH /admin/users/:id.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toMicro, fromMicro } from "@oddzilla/types/money";
import {
  RISK_FACTOR_MIN,
  RISK_FACTOR_MAX,
  RISK_FACTOR_STEP,
  riskFactorToPercent,
} from "@oddzilla/types/bettor-labels";
import { clientApi, ApiFetchError } from "@/lib/api-client";

type Status = "active" | "blocked" | "pending_kyc";
const STATUS_OPTIONS: Status[] = ["active", "blocked", "pending_kyc"];
const RISK_PRESETS = [0.1, 0.5, 1, 2, 5, 10];

interface Props {
  userId: string;
  riskScore: string;
  globalLimitMicro: string;
  betDelaySeconds: number;
  status: Status;
}

const inputClass =
  "h-9 rounded-[8px] border border-[var(--color-border-strong)] bg-[var(--color-bg-card)] px-3 font-mono text-sm";
const buttonClass =
  "h-9 rounded-[8px] border px-3 text-xs uppercase tracking-[0.15em] disabled:opacity-50";

function clampFactor(n: number): number {
  const stepped = Math.round(n / RISK_FACTOR_STEP) * RISK_FACTOR_STEP;
  return Math.min(RISK_FACTOR_MAX, Math.max(RISK_FACTOR_MIN, Number(stepped.toFixed(1))));
}

export function ConstraintsEditor(props: Props) {
  return (
    <div className="divide-y divide-[var(--color-border)]">
      <RiskFactorRow userId={props.userId} initial={props.riskScore} />
      <StakeLimitRow userId={props.userId} initial={props.globalLimitMicro} />
      <BetDelayRow userId={props.userId} initial={props.betDelaySeconds} />
      <StatusRow userId={props.userId} initial={props.status} />
    </div>
  );
}

function useSave() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function run(fn: () => Promise<void>) {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      try {
        await fn();
        setSaved(true);
        setTimeout(() => setSaved(false), 1500);
        router.refresh();
      } catch (err) {
        setError(err instanceof ApiFetchError ? err.body.message : "Save failed");
      }
    });
  }
  return { pending, error, saved, run };
}

function Row({
  label,
  hint,
  children,
  error,
}: {
  label: string;
  hint: string;
  children: React.ReactNode;
  error: string | null;
}) {
  return (
    <div className="grid gap-3 py-4 first:pt-0 last:pb-0 md:grid-cols-[180px_1fr]">
      <div>
        <p className="text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">{label}</p>
        <p className="mt-1 text-xs text-[var(--color-fg-muted)]">{hint}</p>
      </div>
      <div className="flex flex-col gap-2">
        {children}
        {error ? (
          <p role="alert" className="text-xs text-[var(--color-negative)]">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function SaveButton({
  dirty,
  pending,
  saved,
  onClick,
}: {
  dirty: boolean;
  pending: boolean;
  saved: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!dirty || pending}
      className={
        buttonClass +
        (dirty
          ? " border-[var(--color-accent)] text-[var(--color-accent)] hover:bg-[color-mix(in_oklab,var(--color-accent)_10%,transparent)]"
          : " border-[var(--color-border)] text-[var(--color-fg-subtle)]")
      }
    >
      {saved ? "Saved" : pending ? "Saving..." : "Save"}
    </button>
  );
}

function RiskFactorRow({ userId, initial }: { userId: string; initial: string }) {
  const initialNum = Number(initial);
  const [draft, setDraft] = useState<number>(clampFactor(initialNum));
  const { pending, error, saved, run } = useSave();
  const dirty = Math.abs(draft - initialNum) > 1e-9;
  const pct = riskFactorToPercent(draft);
  const tone =
    draft < 1 ? "var(--color-negative)" : draft > 1 ? "var(--color-positive)" : "var(--color-fg)";

  function save() {
    run(async () => {
      await clientApi(`/admin/riskzilla/bettors/${userId}/risk-score`, {
        method: "PATCH",
        body: JSON.stringify({ riskScore: draft.toFixed(3) }),
      });
    });
  }

  return (
    <Row
      label="Risk factor"
      hint="Multiplier on the bettor's allowed exposure. 1.0 = 100% of the standard allowance, every 0.1 is 10%. Range 0.1 to 10."
      error={error}
    >
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          aria-label="Decrease risk factor"
          onClick={() => setDraft((d) => clampFactor(d - RISK_FACTOR_STEP))}
          disabled={pending || draft <= RISK_FACTOR_MIN}
          className={buttonClass + " border-[var(--color-border-strong)] w-9 px-0 font-mono text-base"}
        >
          -
        </button>
        <input
          type="number"
          inputMode="decimal"
          min={RISK_FACTOR_MIN}
          max={RISK_FACTOR_MAX}
          step={RISK_FACTOR_STEP}
          value={draft.toFixed(1)}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (Number.isFinite(n)) setDraft(clampFactor(n));
          }}
          className={inputClass + " w-24 text-right"}
        />
        <button
          type="button"
          aria-label="Increase risk factor"
          onClick={() => setDraft((d) => clampFactor(d + RISK_FACTOR_STEP))}
          disabled={pending || draft >= RISK_FACTOR_MAX}
          className={buttonClass + " border-[var(--color-border-strong)] w-9 px-0 font-mono text-base"}
        >
          +
        </button>
        <span className="font-mono text-lg" style={{ color: tone, fontVariantNumeric: "tabular-nums" }}>
          {pct.toFixed(pct % 1 === 0 ? 0 : 1)}%
        </span>
        <SaveButton dirty={dirty} pending={pending} saved={saved} onClick={save} />
      </div>
      <div className="flex flex-wrap gap-1.5">
        {RISK_PRESETS.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => setDraft(p)}
            disabled={pending}
            className={
              "rounded-full border px-2.5 py-0.5 font-mono text-[11px] " +
              (Math.abs(draft - p) < 1e-9
                ? "border-[var(--color-fg)] text-[var(--color-fg)]"
                : "border-[var(--color-border)] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]")
            }
          >
            {p.toFixed(1)} · {riskFactorToPercent(p)}%
          </button>
        ))}
        {Math.abs(initialNum - clampFactor(initialNum)) > 1e-9 ? (
          <span className="self-center text-[11px] text-[var(--color-fg-muted)]">
            stored {initialNum.toFixed(3)} (legacy precision)
          </span>
        ) : null}
      </div>
    </Row>
  );
}

function StakeLimitRow({ userId, initial }: { userId: string; initial: string }) {
  const initialMicro = BigInt(initial);
  const [draft, setDraft] = useState(initialMicro === 0n ? "" : fromMicro(initialMicro));
  const { pending, error, saved, run } = useSave();

  let draftMicro: bigint | null = null;
  try {
    draftMicro = draft.trim() === "" ? 0n : (toMicro(draft.trim()) as bigint);
  } catch {
    draftMicro = null;
  }
  const dirty = draftMicro !== null && draftMicro !== initialMicro;

  function save() {
    if (draftMicro === null || draftMicro < 0n) return;
    const micro = draftMicro;
    run(async () => {
      await clientApi(`/admin/users/${userId}`, {
        method: "PATCH",
        body: JSON.stringify({ globalLimitMicro: micro.toString() }),
      });
    });
  }

  return (
    <Row
      label="Stake limit"
      hint="Maximum USDC per ticket for this bettor. Blank or 0 means no personal cap, only the RiskZilla tier limits apply."
      error={error ?? (draftMicro === null ? "invalid amount" : null)}
    >
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          inputMode="decimal"
          placeholder="no limit"
          className={inputClass + " w-40"}
        />
        <span className="text-xs text-[var(--color-fg-muted)]">USDC / ticket</span>
        {initialMicro !== 0n ? (
          <button
            type="button"
            onClick={() => setDraft("")}
            disabled={pending}
            className={buttonClass + " border-[var(--color-border-strong)] text-[var(--color-fg-muted)]"}
          >
            Clear
          </button>
        ) : null}
        <SaveButton dirty={dirty} pending={pending} saved={saved} onClick={save} />
      </div>
    </Row>
  );
}

function BetDelayRow({ userId, initial }: { userId: string; initial: number }) {
  const [draft, setDraft] = useState(String(initial));
  const { pending, error, saved, run } = useSave();
  const n = Number(draft);
  const valid = Number.isInteger(n) && n >= 0 && n <= 300;
  const dirty = valid && n !== initial;

  function save() {
    if (!valid) return;
    run(async () => {
      await clientApi(`/admin/users/${userId}`, {
        method: "PATCH",
        body: JSON.stringify({ betDelaySeconds: n }),
      });
    });
  }

  return (
    <Row
      label="Bet delay"
      hint="Extra seconds a live placement waits before acceptance, on top of the sport / tournament cascade. 0 disables, max 300."
      error={error ?? (!valid ? "0 to 300 seconds" : null)}
    >
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          inputMode="numeric"
          className={inputClass + " w-24 text-right"}
        />
        <span className="text-xs text-[var(--color-fg-muted)]">seconds</span>
        {[0, 5, 10, 30].map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => setDraft(String(p))}
            disabled={pending}
            className="rounded-full border border-[var(--color-border)] px-2.5 py-0.5 font-mono text-[11px] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
          >
            {p}s
          </button>
        ))}
        <SaveButton dirty={dirty} pending={pending} saved={saved} onClick={save} />
      </div>
    </Row>
  );
}

function StatusRow({ userId, initial }: { userId: string; initial: Status }) {
  const [draft, setDraft] = useState<Status>(initial);
  const { pending, error, saved, run } = useSave();
  const dirty = draft !== initial;

  function save() {
    run(async () => {
      await clientApi(`/admin/users/${userId}`, {
        method: "PATCH",
        body: JSON.stringify({ status: draft }),
      });
    });
  }

  return (
    <Row
      label="Account status"
      hint="Blocked freezes placement, deposits and withdrawals and revokes live sessions at once."
      error={error}
    >
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={draft}
          onChange={(e) => setDraft(e.target.value as Status)}
          className={inputClass + " font-sans"}
        >
          {STATUS_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <SaveButton dirty={dirty} pending={pending} saved={saved} onClick={save} />
      </div>
    </Row>
  );
}
