"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
// Runtime imports must use the subpath — Next.js webpack can't resolve
// the .js re-exports in the package root. Type imports from the root
// are fine because tsc erases them. See packages/types/package.json
// `exports` and the precedent in /community/page.tsx with `isCurrency`
// from @oddzilla/types/currencies.
import {
  COMPETITION_RULE_CATALOG,
  defaultRuleSet,
} from "@oddzilla/types/competitions-catalog";
import type {
  AdminMatchInput,
  CompetitionDetail,
  CompetitionRuleAssignment,
  CompetitionType,
} from "@oddzilla/types";

// Single-screen create form. Replaces the 4-step wizard from the
// Notion spec with a flat form for V1 simplicity; we can split into
// steps later if operators ask. The rule catalog still drives the
// rules section, just inline.

interface MatchDraft extends AdminMatchInput {
  // Local-only key for stable React keys before the row is saved.
  key: string;
}

const TYPE_OPTIONS: { value: CompetitionType; label: string }[] = [
  { value: "prediction", label: "Score predictor" },
  { value: "tipping", label: "1X2 tipping" },
  { value: "challenge", label: "Custom challenge" },
];

export function CompetitionCreateForm() {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [type, setType] = useState<CompetitionType>("prediction");
  const [league, setLeague] = useState("");
  const [launchAt, setLaunchAt] = useState(defaultDateTimeLocal(0));
  const [betCloseAt, setBetCloseAt] = useState(defaultDateTimeLocal(24));
  const [matchStartAt, setMatchStartAt] = useState(defaultDateTimeLocal(48));
  const [stopShowAt, setStopShowAt] = useState(defaultDateTimeLocal(7 * 24));
  const [featured, setFeatured] = useState(false);

  const [rules, setRules] = useState<CompetitionRuleAssignment[]>(defaultRuleSet());
  const [matches, setMatches] = useState<MatchDraft[]>([]);

  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ruleEnabled = (id: string) => rules.some((r) => r.ruleId === id);
  const toggleRule = (id: string) => {
    setRules((prev) => {
      const def = COMPETITION_RULE_CATALOG.find((r) => r.id === id);
      if (!def) return prev;
      if (def.locked) return prev; // can't toggle locked rules off
      const present = prev.some((r) => r.ruleId === id);
      if (present) return prev.filter((r) => r.ruleId !== id);
      return [...prev, { ruleId: id, value: def.defaultValue }];
    });
  };
  const setRuleValue = (id: string, value: string) => {
    setRules((prev) => prev.map((r) => (r.ruleId === id ? { ...r, value } : r)));
  };

  const addMatch = () => {
    setMatches((prev) => [
      ...prev,
      {
        key: crypto.randomUUID(),
        teamA: "",
        teamB: "",
        league: "",
        kickoffAt: matchStartAt,
      },
    ]);
  };
  const removeMatch = (key: string) => {
    setMatches((prev) => prev.filter((m) => m.key !== key));
  };
  const updateMatch = (key: string, patch: Partial<MatchDraft>) => {
    setMatches((prev) => prev.map((m) => (m.key === key ? { ...m, ...patch } : m)));
  };

  return (
    <form
      className="space-y-6"
      onSubmit={async (e) => {
        e.preventDefault();
        setPending(true);
        setError(null);
        try {
          if (matches.length === 0) {
            setError("Add at least one match before publishing.");
            return;
          }
          const payload = {
            title,
            description: description || undefined,
            type,
            league: league || undefined,
            launchAt: new Date(launchAt).toISOString(),
            betCloseAt: new Date(betCloseAt).toISOString(),
            matchStartAt: new Date(matchStartAt).toISOString(),
            stopShowAt: new Date(stopShowAt).toISOString(),
            featured,
            rules,
            matches: matches.map((m) => ({
              teamA: m.teamA,
              teamB: m.teamB,
              league: m.league,
              kickoffAt: new Date(m.kickoffAt).toISOString(),
            })),
          };
          const res = await fetch("/api/admin/competitions", {
            method: "POST",
            credentials: "include",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          });
          if (!res.ok) {
            const body = (await res.json().catch(() => ({}))) as {
              error?: string;
              message?: string;
            };
            setError(body.error ?? body.message ?? "Couldn't create competition");
            return;
          }
          const detail = (await res.json()) as CompetitionDetail;
          router.push(`/admin/competitions/${detail.id}`);
          router.refresh();
        } finally {
          setPending(false);
        }
      }}
    >
      <Section title="Basics">
        <Field label="Title">
          <input
            required
            maxLength={200}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="input"
          />
        </Field>
        <Field label="Description">
          <textarea
            rows={3}
            maxLength={2000}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="input"
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Type">
            <select
              value={type}
              onChange={(e) => setType(e.target.value as CompetitionType)}
              className="input"
            >
              {TYPE_OPTIONS.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="League (free text)">
            <input
              maxLength={100}
              value={league}
              onChange={(e) => setLeague(e.target.value)}
              className="input"
            />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-xs text-[var(--color-fg-muted)]">
          <input
            type="checkbox"
            checked={featured}
            onChange={(e) => setFeatured(e.target.checked)}
          />
          Feature on the home rotator
        </label>
      </Section>

      <Section title="Schedule">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Launch at">
            <input
              required
              type="datetime-local"
              value={launchAt}
              onChange={(e) => setLaunchAt(e.target.value)}
              className="input"
            />
          </Field>
          <Field label="Picks close">
            <input
              required
              type="datetime-local"
              value={betCloseAt}
              onChange={(e) => setBetCloseAt(e.target.value)}
              className="input"
            />
          </Field>
          <Field label="Match start">
            <input
              required
              type="datetime-local"
              value={matchStartAt}
              onChange={(e) => setMatchStartAt(e.target.value)}
              className="input"
            />
          </Field>
          <Field label="Stop showing">
            <input
              required
              type="datetime-local"
              value={stopShowAt}
              onChange={(e) => setStopShowAt(e.target.value)}
              className="input"
            />
          </Field>
        </div>
      </Section>

      <Section title="Rules">
        <ul className="space-y-2">
          {COMPETITION_RULE_CATALOG.filter(
            (def) => !def.applicableTo || def.applicableTo.includes(type),
          ).map((def) => {
            const enabled = ruleEnabled(def.id) || def.locked;
            const assignment = rules.find((r) => r.ruleId === def.id);
            return (
              <li
                key={def.id}
                className="rounded-[8px] border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] p-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    {/* Wrapping label associates the checkbox with its
                        rule name so screen readers + Playwright's
                        getByRole('checkbox', { name }) lookup find each
                        toggle by accessible name. */}
                    <label
                      htmlFor={`rule-${def.id}`}
                      className="flex items-center gap-2 cursor-pointer"
                    >
                      <input
                        id={`rule-${def.id}`}
                        type="checkbox"
                        disabled={def.locked}
                        checked={enabled}
                        onChange={() => toggleRule(def.id)}
                        aria-label={def.label}
                      />
                      <span className="text-sm font-medium text-[var(--color-fg)]">
                        {def.label}
                      </span>
                      {def.locked ? (
                        <span className="rounded-full border border-[var(--color-border-strong)] px-2 py-0.5 text-[10px] uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
                          Required
                        </span>
                      ) : null}
                      <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
                        {def.category}
                      </span>
                    </label>
                    <p className="ml-6 mt-1 text-xs text-[var(--color-fg-muted)]">
                      {def.description}
                    </p>
                  </div>
                  {def.configurable && enabled ? (
                    <input
                      value={assignment?.value ?? def.defaultValue ?? ""}
                      onChange={(e) => setRuleValue(def.id, e.target.value)}
                      placeholder={def.valueLabel}
                      className="input w-24 shrink-0"
                    />
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      </Section>

      <Section title="Matches">
        {matches.length === 0 ? (
          <p className="text-xs text-[var(--color-fg-muted)]">
            No matches yet. Add at least one before publishing.
          </p>
        ) : (
          <ul className="space-y-2">
            {matches.map((m) => (
              <li
                key={m.key}
                className="rounded-[8px] border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] p-3"
              >
                <div className="grid grid-cols-2 gap-2">
                  <Field label="Home team">
                    <input
                      required
                      maxLength={100}
                      value={m.teamA}
                      onChange={(e) => updateMatch(m.key, { teamA: e.target.value })}
                      className="input"
                    />
                  </Field>
                  <Field label="Away team">
                    <input
                      required
                      maxLength={100}
                      value={m.teamB}
                      onChange={(e) => updateMatch(m.key, { teamB: e.target.value })}
                      className="input"
                    />
                  </Field>
                  <Field label="League">
                    <input
                      maxLength={100}
                      value={m.league ?? ""}
                      onChange={(e) => updateMatch(m.key, { league: e.target.value })}
                      className="input"
                    />
                  </Field>
                  <Field label="Kickoff">
                    <input
                      required
                      type="datetime-local"
                      value={m.kickoffAt}
                      onChange={(e) =>
                        updateMatch(m.key, { kickoffAt: e.target.value })
                      }
                      className="input"
                    />
                  </Field>
                </div>
                <button
                  type="button"
                  onClick={() => removeMatch(m.key)}
                  className="mt-2 text-xs text-[var(--color-danger)] hover:underline"
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        <button
          type="button"
          onClick={addMatch}
          className="rounded-[8px] border border-[var(--color-border-strong)] px-3 py-1.5 text-xs font-semibold hover:bg-[var(--color-bg-elevated)]"
        >
          + Add match
        </button>
      </Section>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-[10px] bg-[var(--color-accent)] px-5 py-2 text-sm font-semibold text-[var(--color-on-accent)] hover:opacity-90 disabled:opacity-60"
        >
          {pending ? "Saving…" : "Save as draft"}
        </button>
        {error ? (
          <p className="text-xs text-[var(--color-danger)]">{error}</p>
        ) : null}
      </div>

      <style jsx>{`
        .input {
          width: 100%;
          height: 2.25rem;
          padding: 0 0.625rem;
          border: 1px solid var(--color-border-strong);
          border-radius: 6px;
          background: var(--color-bg-base);
          color: var(--color-fg);
          font-size: 0.875rem;
        }
        textarea.input {
          height: auto;
          padding: 0.5rem 0.625rem;
          line-height: 1.5;
        }
      `}</style>
    </form>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h2 className="text-xs font-semibold uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
        {title}
      </h2>
      <div className="mt-2 space-y-3">{children}</div>
    </section>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block text-[10px] uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
      {label}
      <div className="mt-1 normal-case tracking-normal">{children}</div>
    </label>
  );
}

function defaultDateTimeLocal(hoursFromNow: number): string {
  const d = new Date(Date.now() + hoursFromNow * 3_600_000);
  // datetime-local needs a "YYYY-MM-DDTHH:MM" string in the local
  // timezone. toISOString gives UTC; pad and slice instead.
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}
