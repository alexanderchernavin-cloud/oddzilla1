"use client";

import { useState, useTransition, type ChangeEvent, type CSSProperties, type FormEvent } from "react";
import { clientApi, ApiFetchError } from "@/lib/api-client";
import {
  unwrapObject,
  type SlotzillaConfigDto,
  type SlotzillaConfigUpdate,
} from "./slotzilla-admin-types";
import {
  bpToPercent,
  microToUnits,
  parseIntField,
  percentToBp,
  unitsToMicro,
} from "./format";
import {
  ErrorBanner,
  Field,
  LoadFailed,
  Section,
  ghostButtonStyle,
  hintStyle,
  inputStyle,
  primaryButtonStyle,
} from "./ui";

// Every column of slotzilla_config, edited as TEXT and parsed on save:
// money in whole units ("2.5" → 2500000 micro), percentages as percent
// ("97" → 9700 bp), seconds and counts as integers. Text drafts mean the
// dirty check is a string compare and a half-typed "1." never becomes NaN
// in a controlled input.

const ALL_CURRENCIES = ["USDC", "OZ"] as const;

const RTP_MIN_BP = 5000;
const RTP_MAX_BP = 9900;

interface Draft {
  enabled: boolean;
  currencies: string[];
  rtpPercent: string;
  leadSeconds: string;
  clockPastSeconds: string;
  graceSeconds: string;
  feedDarkVoidSeconds: string;
  minStake: string;
  maxStake: string;
  maxPayout: string;
  matchLiabilityCap: string;
  returnAlarmMarginPercent: string;
  returnAlarmMinSpins: string;
  autoplayEnabled: boolean;
}

type FieldErrors = Partial<Record<keyof Draft, string>>;

/** The keys edited through a text input. */
type TextKey = { [K in keyof Draft]: Draft[K] extends string ? K : never }[keyof Draft];

const intText = (v: number | null | undefined): string =>
  typeof v === "number" && Number.isFinite(v) ? String(v) : "";

function toDraft(c: SlotzillaConfigDto): Draft {
  return {
    enabled: Boolean(c.enabled),
    currencies: (c.currencies ?? []).filter((x): x is string => typeof x === "string"),
    rtpPercent: bpToPercent(c.rtpTargetBp),
    leadSeconds: intText(c.leadSeconds),
    clockPastSeconds: intText(c.clockPastSeconds),
    graceSeconds: intText(c.graceSeconds),
    feedDarkVoidSeconds: intText(c.feedDarkVoidSeconds),
    minStake: microToUnits(c.minStakeMicro),
    maxStake: microToUnits(c.maxStakeMicro),
    maxPayout: microToUnits(c.maxPayoutMicro),
    matchLiabilityCap: microToUnits(c.matchLiabilityCapMicro),
    returnAlarmMarginPercent: bpToPercent(c.returnAlarmMarginBp),
    returnAlarmMinSpins: intText(c.returnAlarmMinSpins),
    autoplayEnabled: Boolean(c.autoplayEnabled),
  };
}

function sameDraft(a: Draft, b: Draft): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function parseDraft(d: Draft): { body: SlotzillaConfigUpdate } | { errors: FieldErrors } {
  const errors: FieldErrors = {};

  const rtp = percentToBp(d.rtpPercent);
  if (rtp === null) errors.rtpPercent = "Enter a percentage, e.g. 97 or 96.5.";
  else if (rtp < RTP_MIN_BP || rtp > RTP_MAX_BP) errors.rtpPercent = "Between 50% and 99%.";

  const secondsFields = ["leadSeconds", "clockPastSeconds", "graceSeconds", "feedDarkVoidSeconds"] as const;
  const seconds: Partial<Record<(typeof secondsFields)[number], number>> = {};
  for (const k of secondsFields) {
    const v = parseIntField(d[k]);
    if (v === null) errors[k] = "Whole seconds, 0 or more.";
    else seconds[k] = v;
  }

  const moneyFields = ["minStake", "maxStake", "maxPayout", "matchLiabilityCap"] as const;
  const money: Partial<Record<(typeof moneyFields)[number], string>> = {};
  for (const k of moneyFields) {
    const v = unitsToMicro(d[k]);
    if (v === null) errors[k] = "A non-negative amount with at most 6 decimals.";
    else money[k] = v;
  }
  if (money.minStake && money.maxStake && BigInt(money.minStake) > BigInt(money.maxStake)) {
    errors.maxStake = "Max stake must be at least the min stake.";
  }

  const margin = percentToBp(d.returnAlarmMarginPercent);
  if (margin === null) errors.returnAlarmMarginPercent = "A percentage, e.g. 5.";
  const minSpins = parseIntField(d.returnAlarmMinSpins);
  if (minSpins === null) errors.returnAlarmMinSpins = "A whole number of spins.";

  if (Object.keys(errors).length > 0) return { errors };

  return {
    body: {
      enabled: d.enabled,
      currencies: d.currencies,
      rtpTargetBp: rtp as number,
      leadSeconds: seconds.leadSeconds as number,
      clockPastSeconds: seconds.clockPastSeconds as number,
      graceSeconds: seconds.graceSeconds as number,
      feedDarkVoidSeconds: seconds.feedDarkVoidSeconds as number,
      minStakeMicro: money.minStake as string,
      maxStakeMicro: money.maxStake as string,
      maxPayoutMicro: money.maxPayout as string,
      matchLiabilityCapMicro: money.matchLiabilityCap as string,
      returnAlarmMarginBp: margin as number,
      returnAlarmMinSpins: minSpins as number,
      autoplayEnabled: d.autoplayEnabled,
    },
  };
}

export function SettingsTab({
  config,
  onConfigChange,
}: {
  config: SlotzillaConfigDto | null;
  onConfigChange: (fresh: SlotzillaConfigDto) => void;
}) {
  const [draft, setDraft] = useState<Draft | null>(() => (config ? toDraft(config) : null));
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const reload = async (): Promise<SlotzillaConfigDto | null> => {
    const raw = await clientApi<unknown>("/admin/slotzilla/config");
    const fresh = unwrapObject<SlotzillaConfigDto>(raw, "config");
    if (fresh) {
      onConfigChange(fresh);
      setDraft(toDraft(fresh));
    }
    return fresh;
  };

  const retry = () => {
    setError(null);
    startTransition(async () => {
      try {
        await reload();
      } catch (err) {
        setError(err instanceof ApiFetchError ? err.message : "Could not load the config.");
      }
    });
  };

  if (!config || !draft) {
    return (
      <>
        <LoadFailed what="the SlotZilla config" onRetry={retry} pending={pending} />
        {error ? <ErrorBanner>{error}</ErrorBanner> : null}
      </>
    );
  }

  const dirty = !sameDraft(draft, toDraft(config));
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((p) => (p ? { ...p, [k]: v } : p));
  const text = (k: TextKey) => ({
    value: draft[k],
    onChange: (e: ChangeEvent<HTMLInputElement>) => set(k, e.target.value),
    style: { ...inputStyle, maxWidth: 180, fontFamily: "var(--font-mono, ui-monospace, monospace)" },
    disabled: pending,
  });

  const onSave = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    const parsed = parseDraft(draft);
    if ("errors" in parsed) {
      setFieldErrors(parsed.errors);
      return;
    }
    setFieldErrors({});
    startTransition(async () => {
      try {
        await clientApi<unknown>("/admin/slotzilla/config", {
          method: "PUT",
          body: JSON.stringify(parsed.body),
        });
        await reload();
      } catch (err) {
        setError(err instanceof ApiFetchError ? err.message : "Save failed. Please try again.");
      }
    });
  };

  const toggleCurrency = (cur: string) =>
    set(
      "currencies",
      draft.currencies.includes(cur) ? draft.currencies.filter((c) => c !== cur) : [...draft.currencies, cur],
    );

  return (
    <form onSubmit={onSave} style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <Section title="Master switch">
        <label style={{ display: "inline-flex", alignItems: "center", gap: 10, fontSize: 14 }}>
          <input type="checkbox" checked={draft.enabled} onChange={(e) => set("enabled", e.target.checked)} disabled={pending} />
          <span>
            <strong>Enabled.</strong> Off idles the feed worker, hides the panel from every match
            page and refuses new spins; open spins still settle.
          </span>
        </label>
        <div style={{ display: "flex", gap: 18, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontSize: 12.5, fontWeight: 600 }}>Currencies</span>
          {ALL_CURRENCIES.map((cur) => (
            <label key={cur} style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 13 }}>
              <input
                type="checkbox"
                checked={draft.currencies.includes(cur)}
                onChange={() => toggleCurrency(cur)}
                disabled={pending}
              />
              <span className="mono">{cur}</span>
            </label>
          ))}
          {draft.currencies.length === 0 ? (
            <span style={{ ...hintStyle, color: "var(--negative, #dc2626)" }}>No currency — nobody can spin.</span>
          ) : null}
        </div>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 10, fontSize: 13.5 }}>
          <input
            type="checkbox"
            checked={draft.autoplayEnabled}
            onChange={(e) => set("autoplayEnabled", e.target.checked)}
            disabled={pending}
          />
          <span>
            <strong>Auto-play</strong> — the storefront may place the next spin as soon as the last one
            settles, with a visible stop and a session spend total.
          </span>
        </label>
      </Section>

      <Section title="Return and alarm">
        <p style={hintStyle}>
          The return target is what &ldquo;Fit to target&rdquo; on the Paytables tab aims for. The alarm
          marks a game on the Games tab once its realised return sits above target + margin over at
          least the minimum spin count — it is a signal to look, never an automatic pause.
        </p>
        <div style={gridStyle}>
          <Field label="Return target (%)" hint="50 to 99. Stored as basis points." error={fieldErrors.rtpPercent}>
            <input inputMode="decimal" {...text("rtpPercent")} />
          </Field>
          <Field label="Alarm margin (%)" hint="Above target before a game is flagged." error={fieldErrors.returnAlarmMarginPercent}>
            <input inputMode="decimal" {...text("returnAlarmMarginPercent")} />
          </Field>
          <Field label="Alarm min spins" hint="Fewer spins than this never alarm." error={fieldErrors.returnAlarmMinSpins}>
            <input inputMode="numeric" {...text("returnAlarmMinSpins")} />
          </Field>
        </div>
      </Section>

      <Section title="Timing (seconds of match clock unless stated)">
        <p style={hintStyle}>
          A spin opens at the first 5-second mark at least <strong>lead</strong> seconds past the clock
          reading we hold. A window is final once the clock is <strong>clock-past</strong> seconds beyond
          it and no event inside it has changed for <strong>grace</strong> seconds (wall time). A game with
          no successful feed fetch for <strong>feed-dark</strong> seconds (wall time) voids its open spins
          and pauses.
        </p>
        <div style={gridStyle}>
          <Field label="Lead" error={fieldErrors.leadSeconds}>
            <input inputMode="numeric" {...text("leadSeconds")} />
          </Field>
          <Field label="Clock past" error={fieldErrors.clockPastSeconds}>
            <input inputMode="numeric" {...text("clockPastSeconds")} />
          </Field>
          <Field label="Grace (wall)" error={fieldErrors.graceSeconds}>
            <input inputMode="numeric" {...text("graceSeconds")} />
          </Field>
          <Field label="Feed dark void (wall)" error={fieldErrors.feedDarkVoidSeconds}>
            <input inputMode="numeric" {...text("feedDarkVoidSeconds")} />
          </Field>
        </div>
      </Section>

      <Section title="Stakes and caps (whole currency units)">
        <p style={hintStyle}>
          Amounts are entered in units and stored in micro (× 1,000,000). The max payout caps one spin
          whatever the paytable says; the per-match cap bounds the sum of open exposure on one game.
        </p>
        <div style={gridStyle}>
          <Field label="Min stake" error={fieldErrors.minStake}>
            <input inputMode="decimal" {...text("minStake")} />
          </Field>
          <Field label="Max stake" error={fieldErrors.maxStake}>
            <input inputMode="decimal" {...text("maxStake")} />
          </Field>
          <Field label="Max payout per spin" error={fieldErrors.maxPayout}>
            <input inputMode="decimal" {...text("maxPayout")} />
          </Field>
          <Field label="Per-match liability cap" error={fieldErrors.matchLiabilityCap}>
            <input inputMode="decimal" {...text("matchLiabilityCap")} />
          </Field>
        </div>
      </Section>

      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <button type="submit" disabled={!dirty || pending} style={primaryButtonStyle(dirty, pending)}>
          {pending ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          onClick={() => {
            setDraft(toDraft(config));
            setFieldErrors({});
          }}
          disabled={!dirty || pending}
          style={ghostButtonStyle(dirty && !pending)}
        >
          Discard changes
        </button>
        <span style={{ fontSize: 11, color: "var(--color-fg-muted, var(--fg-muted))" }}>
          Last saved: {config.updatedAt ? new Date(config.updatedAt).toLocaleString() : "—"}
        </span>
      </div>

      {error ? <ErrorBanner>{error}</ErrorBanner> : null}
    </form>
  );
}

const gridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
  gap: 14,
};
