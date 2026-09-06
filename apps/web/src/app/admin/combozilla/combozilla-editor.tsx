"use client";

import {
  useCallback,
  useEffect,
  useState,
  useTransition,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from "react";
import { clientApi, ApiFetchError } from "@/lib/api-client";
import {
  COMBOZILLA_ALL_RISK_TIERS,
  type ComboZillaConfigDto,
  type ComboZillaPreviewDto,
  type ComboZillaRuleDto,
  type ComboZillaRuleMode,
  type ComboZillaRuleScope,
} from "@oddzilla/types/combozilla";

// Backoffice editor for the lobby's ComboZilla carousel (migration
// 20260906T015446_combozilla_config). Three parts:
//
//   1. The singleton config — master switch, eligible risk tiers,
//      untiered tournaments, sports allowed to hold several cards.
//   2. Scope rules — allow / block on a sport, category or tournament,
//      most specific wins. Added through a cascading picker that reuses
//      the /admin/tournaments option endpoints.
//   3. A preview of what the CURRENT saved policy admits, grouped sport →
//      tournament with match counts, so the effect of a change is visible
//      here before anyone opens the lobby.
//
// Rules and the preview are reloaded from the api after every mutation
// rather than patched locally: the preview depends on every rule and the
// config at once, and one GET is cheaper to reason about than a merge.

export interface AdminComboZillaResponse {
  config: ComboZillaConfigDto;
  rules: ComboZillaRuleDto[];
  preview: ComboZillaPreviewDto;
}

interface SportOption {
  id: number;
  slug: string;
  name: string;
  tournamentCount: number;
}

interface CategoryOption {
  id: number;
  name: string;
  tournamentCount: number;
}

interface TournamentOption {
  id: number;
  name: string;
  categoryName: string;
  riskTier: number | null;
}

interface Draft {
  enabled: boolean;
  tiers: number[];
  allowUntiered: boolean;
  multiCardSportSlugs: string[];
}

function toDraft(cfg: ComboZillaConfigDto): Draft {
  return {
    enabled: cfg.enabled,
    tiers: [...cfg.eligibleRiskTiers].sort((a, b) => a - b),
    allowUntiered: cfg.allowUntiered,
    multiCardSportSlugs: [...cfg.multiCardSportSlugs],
  };
}

function sameDraft(a: Draft, b: Draft): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

const SCOPE_LABEL: Record<ComboZillaRuleScope, string> = {
  sport: "Sport",
  category: "Category",
  tournament: "Tournament",
};

export function ComboZillaEditor({ initial }: { initial: AdminComboZillaResponse }) {
  const [config, setConfig] = useState<ComboZillaConfigDto>(initial.config);
  const [rules, setRules] = useState<ComboZillaRuleDto[]>(initial.rules);
  const [preview, setPreview] = useState<ComboZillaPreviewDto>(initial.preview);
  const [draft, setDraft] = useState<Draft>(() => toDraft(initial.config));
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Every active sport, for the multi-card picker and the rule adder.
  const [sportOptions, setSportOptions] = useState<SportOption[]>([]);
  useEffect(() => {
    let cancelled = false;
    clientApi<{ sports: SportOption[] }>("/admin/tournaments/sports")
      .then((r) => {
        if (!cancelled) setSportOptions(r.sports);
      })
      .catch(() => {
        // The pickers degrade to free text entry of a slug; the page
        // still works without the list.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const reload = useCallback(async () => {
    const fresh = await clientApi<AdminComboZillaResponse>("/admin/combozilla-config");
    setConfig(fresh.config);
    setRules(fresh.rules);
    setPreview(fresh.preview);
    return fresh;
  }, []);

  const dirty = !sameDraft(draft, toDraft(config));

  const toggleTier = (tier: number) =>
    setDraft((p) => ({
      ...p,
      tiers: p.tiers.includes(tier)
        ? p.tiers.filter((t) => t !== tier)
        : [...p.tiers, tier].sort((a, b) => a - b),
    }));

  const addMultiCard = (slug: string) => {
    if (!slug) return;
    setDraft((p) =>
      p.multiCardSportSlugs.includes(slug)
        ? p
        : { ...p, multiCardSportSlugs: [...p.multiCardSportSlugs, slug] },
    );
  };

  const removeMultiCard = (slug: string) =>
    setDraft((p) => ({
      ...p,
      multiCardSportSlugs: p.multiCardSportSlugs.filter((s) => s !== slug),
    }));

  const onSaveConfig = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      try {
        await clientApi<ComboZillaConfigDto>("/admin/combozilla-config", {
          method: "PUT",
          body: JSON.stringify({
            enabled: draft.enabled,
            eligibleRiskTiers: draft.tiers,
            allowUntiered: draft.allowUntiered,
            multiCardSportSlugs: draft.multiCardSportSlugs,
          }),
        });
        const fresh = await reload();
        setDraft(toDraft(fresh.config));
      } catch (err) {
        setError(err instanceof ApiFetchError ? err.message : "Save failed. Please try again.");
      }
    });
  };

  const upsertRule = (scope: ComboZillaRuleScope, refId: number, mode: ComboZillaRuleMode) => {
    setError(null);
    startTransition(async () => {
      try {
        await clientApi<ComboZillaRuleDto>(
          `/admin/combozilla-config/rules/${scope}/${refId}`,
          { method: "PUT", body: JSON.stringify({ mode }) },
        );
        await reload();
      } catch (err) {
        setError(err instanceof ApiFetchError ? err.message : "Could not save the rule.");
      }
    });
  };

  const removeRule = (rule: ComboZillaRuleDto) => {
    setError(null);
    startTransition(async () => {
      try {
        await clientApi<{ ok: true }>(
          `/admin/combozilla-config/rules/${rule.scope}/${rule.refId}`,
          { method: "DELETE" },
        );
        await reload();
      } catch (err) {
        setError(err instanceof ApiFetchError ? err.message : "Could not remove the rule.");
      }
    });
  };

  const sportBySlug = new Map(sportOptions.map((s) => [s.slug, s] as const));

  return (
    <div style={{ marginTop: 24, display: "flex", flexDirection: "column", gap: 20, maxWidth: 860 }}>
      <form onSubmit={onSaveConfig} style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        <Section title="Master switch">
          <label style={{ display: "inline-flex", alignItems: "center", gap: 10, fontSize: 14 }}>
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(e) => setDraft((p) => ({ ...p, enabled: e.target.checked }))}
            />
            <span>
              <strong>Enabled.</strong> When off, the carousel disappears from the lobby
              on its next render.
            </span>
          </label>
        </Section>

        <Section title="Eligible risk tiers">
          <p style={hintStyle}>
            A match qualifies by default when its tournament carries one of these
            tiers. Lower is bigger: T1 is a world final, T10 a qualifier or a
            simulation. ZillaAGI never assigns T1 (its standing +1 margin), so most
            of the traditional line sits at T4 to T6 — widen the band or add a rule
            below to bring it in.
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {COMBOZILLA_ALL_RISK_TIERS.map((tier) => {
              const on = draft.tiers.includes(tier);
              return (
                <button
                  key={tier}
                  type="button"
                  onClick={() => toggleTier(tier)}
                  aria-pressed={on}
                  className="mono"
                  style={{
                    ...chipButtonStyle,
                    background: on ? "var(--accent, #16a34a)" : "var(--color-bg, var(--bg))",
                    color: on ? "var(--accent-fg, #fff)" : "var(--color-fg, var(--fg))",
                    borderColor: on ? "transparent" : "var(--color-border, var(--border))",
                  }}
                >
                  T{tier}
                </button>
              );
            })}
          </div>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 10, fontSize: 13.5, marginTop: 4 }}>
            <input
              type="checkbox"
              checked={draft.allowUntiered}
              onChange={(e) => setDraft((p) => ({ ...p, allowUntiered: e.target.checked }))}
            />
            <span>
              Include tournaments with <strong>no tier yet</strong>. Off by default:
              RiskZilla prices an untiered tournament at the strictest tier, and
              ZillaAGI usually tiers a new one within half an hour.
            </span>
          </label>
        </Section>

        <Section title="Sports allowed more than one card">
          <p style={hintStyle}>
            The carousel holds four cards. Every sport NOT listed here is capped at
            one card per render, so the densest pool cannot fill the whole strip.
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 6 }}>
            {draft.multiCardSportSlugs.length === 0 ? (
              <span style={{ fontSize: 12.5, color: "var(--color-fg-subtle, var(--fg-dim))" }}>
                Every sport is capped at one card.
              </span>
            ) : (
              draft.multiCardSportSlugs.map((slug) => (
                <Chip key={slug} onRemove={() => removeMultiCard(slug)}>
                  {sportBySlug.get(slug)?.name ?? slug}
                </Chip>
              ))
            )}
          </div>
          <SportSelect
            options={sportOptions.filter((s) => !draft.multiCardSportSlugs.includes(s.slug))}
            placeholder="Add a sport…"
            onPick={(s) => addMultiCard(s.slug)}
          />
        </Section>

        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button
            type="submit"
            disabled={!dirty || pending}
            style={{
              ...buttonStyle,
              background: dirty ? "var(--accent, #16a34a)" : "var(--color-bg-subtle, var(--surface-2))",
              color: dirty ? "var(--accent-fg, #fff)" : "var(--color-fg-muted, var(--fg-muted))",
              cursor: dirty && !pending ? "pointer" : "default",
              opacity: pending ? 0.7 : 1,
            }}
          >
            {pending ? "Saving…" : "Save"}
          </button>
          <button
            type="button"
            onClick={() => setDraft(toDraft(config))}
            disabled={!dirty || pending}
            style={{
              ...buttonStyle,
              background: "transparent",
              border: "1px solid var(--color-border, var(--border))",
              color: "var(--color-fg, var(--fg))",
              cursor: dirty && !pending ? "pointer" : "default",
              opacity: dirty ? 1 : 0.5,
            }}
          >
            Discard changes
          </button>
          <span style={{ fontSize: 11, color: "var(--color-fg-muted, var(--fg-muted))" }}>
            Last saved: {new Date(config.updatedAt).toLocaleString()}
          </span>
        </div>
      </form>

      <Section title="Allow / block rules">
        <p style={hintStyle}>
          A rule overrides the tier default for everything under it. <strong>Allow</strong>{" "}
          puts the scope in whatever its tier; <strong>block</strong> keeps it out. The
          most specific rule wins, so you can block Football and still allow one league.
        </p>
        <RuleAdder
          sportOptions={sportOptions}
          existing={rules}
          disabled={pending}
          onAdd={upsertRule}
        />
        {rules.length === 0 ? (
          <p style={{ ...hintStyle, marginTop: 8 }}>No rules yet — the tier band decides on its own.</p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, marginTop: 8 }}>
            <thead>
              <tr>
                <th style={thStyle}>Scope</th>
                <th style={thStyle}>Name</th>
                <th style={thStyle}>Under</th>
                <th style={thStyle}>Tier</th>
                <th style={thStyle}>Mode</th>
                <th style={thStyle} />
              </tr>
            </thead>
            <tbody>
              {rules.map((rule) => (
                <tr key={`${rule.scope}:${rule.refId}`} style={{ borderTop: "1px solid var(--color-border, var(--border))" }}>
                  <td style={tdStyle}>
                    <span className="mono" style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--color-fg-muted, var(--fg-muted))" }}>
                      {SCOPE_LABEL[rule.scope]}
                    </span>
                  </td>
                  <td style={{ ...tdStyle, fontWeight: 600 }}>{rule.name}</td>
                  <td style={{ ...tdStyle, color: "var(--color-fg-muted, var(--fg-muted))" }}>
                    {rule.scope === "sport"
                      ? "—"
                      : [rule.sport.name, rule.category?.name].filter(Boolean).join(" › ")}
                  </td>
                  <td style={tdStyle}>
                    {rule.scope === "tournament" ? <TierBadge tier={rule.riskTier} /> : "—"}
                  </td>
                  <td style={tdStyle}>
                    <ModeToggle
                      mode={rule.mode}
                      disabled={pending}
                      onChange={(mode) => upsertRule(rule.scope, rule.refId, mode)}
                    />
                  </td>
                  <td style={{ ...tdStyle, textAlign: "right" }}>
                    <button
                      type="button"
                      onClick={() => removeRule(rule)}
                      disabled={pending}
                      style={{ ...smallButtonStyle }}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <Section title={`What qualifies right now — ${preview.totalMatches} prematch ${preview.totalMatches === 1 ? "match" : "matches"}`}>
        <p style={hintStyle}>
          Every prematch match with a bettable market the SAVED policy admits,
          grouped by sport and tournament. The carousel draws up to 40 per sport
          from this, flagship tournaments first. Unsaved edits above are not
          reflected until you save.
        </p>
        {!config.enabled ? (
          <p style={hintStyle}>ComboZilla is switched off.</p>
        ) : preview.sports.length === 0 ? (
          <p style={hintStyle}>
            Nothing qualifies. Widen the tier band or add an allow rule.
          </p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {preview.sports.map((s) => (
              <details key={s.id} style={{ border: "1px solid var(--color-border, var(--border))", borderRadius: 8, padding: "6px 10px", background: "var(--color-bg, var(--bg))" }}>
                <summary style={{ cursor: "pointer", fontSize: 13.5, display: "flex", gap: 10, alignItems: "center" }}>
                  <span style={{ fontWeight: 600 }}>{s.name}</span>
                  <span className="mono" style={{ fontSize: 12, color: "var(--color-fg-muted, var(--fg-muted))" }}>
                    {s.matchCount} {s.matchCount === 1 ? "match" : "matches"} · {s.tournaments.length}{" "}
                    {s.tournaments.length === 1 ? "tournament" : "tournaments"}
                    {config.multiCardSportSlugs.includes(s.slug) ? " · multi-card" : ""}
                  </span>
                </summary>
                <ul style={{ listStyle: "none", margin: "8px 0 2px", padding: 0, display: "flex", flexDirection: "column", gap: 4 }}>
                  {s.tournaments.map((t) => (
                    <li key={t.id} style={{ display: "flex", gap: 10, alignItems: "center", fontSize: 12.5 }}>
                      <TierBadge tier={t.riskTier} />
                      <span>{t.name}</span>
                      {t.categoryName ? (
                        <span style={{ color: "var(--color-fg-muted, var(--fg-muted))" }}>{t.categoryName}</span>
                      ) : null}
                      <span style={{ flex: 1 }} />
                      <span className="mono" style={{ color: "var(--color-fg-muted, var(--fg-muted))" }}>{t.matchCount}</span>
                    </li>
                  ))}
                </ul>
              </details>
            ))}
          </div>
        )}
      </Section>

      {error && (
        <div
          role="alert"
          style={{
            fontSize: 12.5,
            color: "var(--negative, #dc2626)",
            background: "color-mix(in oklab, var(--negative, #dc2626) 8%, transparent)",
            padding: "8px 12px",
            borderRadius: 8,
          }}
        >
          {error}
        </div>
      )}
    </div>
  );
}

// ── Rule adder: scope → sport → (category) → (tournament) → mode ─────────

function RuleAdder({
  sportOptions,
  existing,
  disabled,
  onAdd,
}: {
  sportOptions: SportOption[];
  existing: ComboZillaRuleDto[];
  disabled: boolean;
  onAdd: (scope: ComboZillaRuleScope, refId: number, mode: ComboZillaRuleMode) => void;
}) {
  const [scope, setScope] = useState<ComboZillaRuleScope>("tournament");
  const [sportId, setSportId] = useState<number | null>(null);
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [tournamentId, setTournamentId] = useState<number | null>(null);
  const [mode, setMode] = useState<ComboZillaRuleMode>("allow");
  const [categories, setCategories] = useState<CategoryOption[]>([]);
  const [tournaments, setTournaments] = useState<TournamentOption[]>([]);
  const [tournamentQuery, setTournamentQuery] = useState("");

  // Categories follow the sport. Scoped to one sport on the api side
  // because football alone carries ~200 country buckets.
  useEffect(() => {
    setCategoryId(null);
    setTournamentId(null);
    setCategories([]);
    if (sportId == null || scope === "sport") return;
    let cancelled = false;
    clientApi<{ categories: CategoryOption[] }>(
      `/admin/tournaments/categories?sportId=${sportId}`,
    )
      .then((r) => {
        if (!cancelled) setCategories(r.categories);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [sportId, scope]);

  // Tournaments follow sport + optional category + a name filter. The
  // list endpoint pages at 200; the filter box is how a football operator
  // reaches league 250 of 291.
  useEffect(() => {
    setTournamentId(null);
    setTournaments([]);
    if (sportId == null || scope !== "tournament") return;
    let cancelled = false;
    const params = new URLSearchParams({
      sportId: String(sportId),
      limit: "200",
      sort: "name",
      active: "1",
    });
    if (categoryId != null) params.set("categoryId", String(categoryId));
    if (tournamentQuery.trim()) params.set("q", tournamentQuery.trim());
    const timer = setTimeout(() => {
      clientApi<{ tournaments: TournamentOption[] }>(`/admin/tournaments?${params}`)
        .then((r) => {
          if (!cancelled) setTournaments(r.tournaments);
        })
        .catch(() => undefined);
    }, 180);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [sportId, categoryId, scope, tournamentQuery]);

  const refId =
    scope === "sport" ? sportId : scope === "category" ? categoryId : tournamentId;
  const alreadyRuled =
    refId != null && existing.some((r) => r.scope === scope && r.refId === refId);
  const canAdd = refId != null && !disabled;

  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
      <select
        value={scope}
        onChange={(e) => setScope(e.target.value as ComboZillaRuleScope)}
        style={{ ...inputStyle, maxWidth: 140 }}
        aria-label="Rule scope"
      >
        <option value="sport">Sport</option>
        <option value="category">Category</option>
        <option value="tournament">Tournament</option>
      </select>
      <select
        value={sportId ?? ""}
        onChange={(e) => setSportId(e.target.value ? Number(e.target.value) : null)}
        style={{ ...inputStyle, maxWidth: 220 }}
        aria-label="Sport"
      >
        <option value="">Sport…</option>
        {sportOptions.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
      {scope !== "sport" && (
        <select
          value={categoryId ?? ""}
          onChange={(e) => setCategoryId(e.target.value ? Number(e.target.value) : null)}
          disabled={sportId == null}
          style={{ ...inputStyle, maxWidth: 240 }}
          aria-label="Category"
        >
          <option value="">{scope === "tournament" ? "Any category" : "Category…"}</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} ({c.tournamentCount})
            </option>
          ))}
        </select>
      )}
      {scope === "tournament" && (
        <>
          <input
            type="search"
            value={tournamentQuery}
            onChange={(e) => setTournamentQuery(e.target.value)}
            placeholder="Filter tournaments…"
            disabled={sportId == null}
            style={{ ...inputStyle, maxWidth: 200, fontFamily: "inherit" }}
            aria-label="Filter tournaments"
          />
          <select
            value={tournamentId ?? ""}
            onChange={(e) => setTournamentId(e.target.value ? Number(e.target.value) : null)}
            disabled={sportId == null}
            style={{ ...inputStyle, maxWidth: 320 }}
            aria-label="Tournament"
          >
            <option value="">
              {sportId == null
                ? "Tournament…"
                : tournaments.length === 0
                  ? "No tournaments match"
                  : `Tournament… (${tournaments.length})`}
            </option>
            {tournaments.map((t) => (
              <option key={t.id} value={t.id}>
                {t.riskTier != null ? `T${t.riskTier} · ` : "T? · "}
                {t.name}
              </option>
            ))}
          </select>
        </>
      )}
      <ModeToggle mode={mode} disabled={disabled} onChange={setMode} />
      <button
        type="button"
        disabled={!canAdd}
        onClick={() => {
          if (refId != null) onAdd(scope, refId, mode);
        }}
        style={{
          ...buttonStyle,
          background: canAdd ? "var(--accent, #16a34a)" : "var(--color-bg-subtle, var(--surface-2))",
          color: canAdd ? "var(--accent-fg, #fff)" : "var(--color-fg-muted, var(--fg-muted))",
          cursor: canAdd ? "pointer" : "default",
        }}
      >
        {alreadyRuled ? "Update rule" : "Add rule"}
      </button>
    </div>
  );
}

// ── Small pieces ─────────────────────────────────────────────────────────

function SportSelect({
  options,
  placeholder,
  onPick,
}: {
  options: SportOption[];
  placeholder: string;
  onPick: (s: SportOption) => void;
}) {
  return (
    <select
      value=""
      onChange={(e) => {
        const hit = options.find((s) => s.slug === e.target.value);
        if (hit) onPick(hit);
      }}
      style={{ ...inputStyle, maxWidth: 260 }}
      aria-label={placeholder}
    >
      <option value="">{placeholder}</option>
      {options.map((s) => (
        <option key={s.id} value={s.slug}>
          {s.name}
        </option>
      ))}
    </select>
  );
}

function ModeToggle({
  mode,
  disabled,
  onChange,
}: {
  mode: ComboZillaRuleMode;
  disabled: boolean;
  onChange: (mode: ComboZillaRuleMode) => void;
}) {
  return (
    <div role="radiogroup" aria-label="Rule mode" style={{ display: "inline-flex", gap: 0, border: "1px solid var(--color-border, var(--border))", borderRadius: 8, overflow: "hidden" }}>
      {(["allow", "block"] as const).map((m) => {
        const on = mode === m;
        const tint = m === "allow" ? "var(--accent, #16a34a)" : "var(--negative, #dc2626)";
        return (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={disabled}
            onClick={() => onChange(m)}
            style={{
              height: 30,
              padding: "0 12px",
              border: 0,
              fontFamily: "inherit",
              fontSize: 12.5,
              fontWeight: 600,
              textTransform: "capitalize",
              cursor: disabled ? "default" : "pointer",
              background: on ? tint : "transparent",
              color: on ? "#fff" : "var(--color-fg-muted, var(--fg-muted))",
            }}
          >
            {m}
          </button>
        );
      })}
    </div>
  );
}

function TierBadge({ tier }: { tier: number | null }) {
  return (
    <span
      className="mono"
      title={tier == null ? "No risk tier assigned" : `Risk tier ${tier}`}
      style={{
        display: "inline-block",
        minWidth: 28,
        textAlign: "center",
        fontSize: 11,
        padding: "1px 6px",
        borderRadius: 999,
        border: "1px solid var(--color-border, var(--border))",
        color: tier == null ? "var(--negative, #dc2626)" : "var(--color-fg-muted, var(--fg-muted))",
      }}
    >
      {tier == null ? "T?" : `T${tier}`}
    </span>
  );
}

function Chip({ children, onRemove }: { children: ReactNode; onRemove: () => void }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        height: 26,
        padding: "0 6px 0 10px",
        borderRadius: 999,
        border: "1px solid var(--color-border, var(--border))",
        background: "var(--color-bg, var(--bg))",
        fontSize: 12.5,
      }}
    >
      {children}
      <button
        type="button"
        aria-label="Remove"
        onClick={onRemove}
        style={{
          border: 0,
          background: "transparent",
          cursor: "pointer",
          color: "var(--color-fg-muted, var(--fg-muted))",
          fontSize: 14,
          lineHeight: 1,
          padding: "0 2px",
        }}
      >
        ×
      </button>
    </span>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 10,
        padding: "16px 18px",
        background: "var(--color-bg-subtle, var(--surface-2))",
        border: "1px solid var(--color-border, var(--border))",
        borderRadius: 10,
      }}
    >
      <h2
        className="mono"
        style={{
          fontSize: 11,
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          color: "var(--color-fg-subtle, var(--fg-dim))",
          margin: 0,
        }}
      >
        {title}
      </h2>
      {children}
    </section>
  );
}

const hintStyle: CSSProperties = {
  fontSize: 12.5,
  color: "var(--color-fg-muted, var(--fg-muted))",
  margin: 0,
  lineHeight: 1.45,
};

const inputStyle: CSSProperties = {
  height: 36,
  padding: "0 10px",
  background: "var(--color-bg, var(--bg))",
  border: "1px solid var(--color-border, var(--border))",
  borderRadius: 8,
  color: "var(--color-fg, var(--fg))",
  fontFamily: "inherit",
  fontSize: 13.5,
};

const buttonStyle: CSSProperties = {
  height: 36,
  padding: "0 16px",
  borderRadius: 8,
  border: "1px solid transparent",
  fontFamily: "inherit",
  fontSize: 13,
  fontWeight: 600,
};

const smallButtonStyle: CSSProperties = {
  height: 28,
  padding: "0 10px",
  borderRadius: 6,
  border: "1px solid var(--color-border, var(--border))",
  background: "transparent",
  color: "var(--color-fg, var(--fg))",
  fontFamily: "inherit",
  fontSize: 12,
  cursor: "pointer",
};

const chipButtonStyle: CSSProperties = {
  height: 30,
  minWidth: 44,
  padding: "0 12px",
  borderRadius: 999,
  border: "1px solid",
  fontSize: 12.5,
  fontWeight: 600,
  cursor: "pointer",
};

const thStyle: CSSProperties = {
  textAlign: "left",
  fontSize: 11,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--color-fg-muted, var(--fg-muted))",
  padding: "4px 8px",
  fontWeight: 500,
};

const tdStyle: CSSProperties = {
  padding: "8px 8px",
  verticalAlign: "middle",
};
