"use client";

import { useState, useTransition, type FormEvent } from "react";
import { clientApi, ApiFetchError } from "@/lib/api-client";
import {
  DEFAULT_PAYTABLE_LINES,
  FIXED_LINES,
  LINE_KEYS,
  SLOT_SYMBOLS,
  expectedReturnBp,
  formatMultiplier,
  type LineKey,
  type PaytableLines,
  type SlotSymbol,
} from "@oddzilla/types/slotzilla";
import {
  unwrapList,
  unwrapObject,
  type SlotzillaFitRequest,
  type SlotzillaFitResponse,
  type SlotzillaPaytableDto,
} from "./slotzilla-admin-types";
import {
  bpToPercent,
  cleanLines,
  formatBp,
  multiplierToX100,
  normaliseLineFrequencies,
  percentToBp,
} from "./format";
import {
  Chip,
  ErrorBanner,
  Field,
  LoadFailed,
  NoticeBanner,
  Section,
  cellInputStyle,
  dangerSmallButtonStyle,
  ghostButtonStyle,
  hintStyle,
  inputStyle,
  monoMuted,
  primaryButtonStyle,
  rowStyle,
  smallButtonStyle,
  tableStyle,
  tdStyle,
  thStyle,
} from "./ui";

// The paytable editor. A paytable is twelve multipliers — six symbols ×
// (any two / all three) — stored in hundredths. The grid edits them as
// decimals through `formatMultiplier` / `multiplierToX100`, so "0.5" is
// 50 and "35" is 3500 without a float in between.
//
// "Fit to target" asks the api to scale the SAVED base paytable so it
// returns the target against the corpus (the NONE lines held fixed, per
// FIXED_LINES); the answer is previewed beside the draft and applied into
// it on request. Nothing is written until Save. Activation is its own
// confirmed action because the active table prices the next spin on
// every live game.

const SYMBOL_LABEL: Record<SlotSymbol, string> = {
  P3: "3 points",
  P2: "2 points",
  FT: "Free throw",
  MISS: "Missed shot",
  FOUL: "Foul",
  NONE: "Nothing",
};

const NEW_ID = "__new__";

type Cells = Record<LineKey, string>;

interface Draft {
  name: string;
  cells: Cells;
}

function cellsFromLines(lines: PaytableLines | null | undefined): Cells {
  const clean = cleanLines(lines, LINE_KEYS);
  const out = {} as Cells;
  for (const k of LINE_KEYS) {
    const v = clean[k];
    out[k] = typeof v === "number" ? formatMultiplier(v) : "";
  }
  return out;
}

function toDraft(pt: SlotzillaPaytableDto | null): Draft {
  if (!pt) return { name: "", cells: cellsFromLines(DEFAULT_PAYTABLE_LINES) };
  return { name: pt.name ?? "", cells: cellsFromLines(pt.lines) };
}

function sameDraft(a: Draft, b: Draft): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Draft cells → lines; an empty cell is an absent line (pays nothing). */
function parseCells(cells: Cells): { lines: PaytableLines } | { errors: Partial<Record<LineKey, string>> } {
  const lines: PaytableLines = {};
  const errors: Partial<Record<LineKey, string>> = {};
  for (const k of LINE_KEYS) {
    const raw = cells[k];
    if (raw.trim() === "") continue;
    const v = multiplierToX100(raw);
    if (v === null) errors[k] = "Use a number with at most two decimals.";
    else lines[k] = v;
  }
  return Object.keys(errors).length > 0 ? { errors } : { lines };
}

const idOf = (pt: SlotzillaPaytableDto): string => String(pt.id);

export function PaytablesTab({
  initial,
  rtpTargetBp,
}: {
  initial: unknown;
  rtpTargetBp: number | null;
}) {
  const [paytables, setPaytables] = useState<SlotzillaPaytableDto[] | null>(() =>
    initial === null ? null : unwrapList<SlotzillaPaytableDto>(initial, "paytables"),
  );
  const [selectedId, setSelectedId] = useState<string>(() => {
    const list = initial === null ? [] : unwrapList<SlotzillaPaytableDto>(initial, "paytables");
    const active = list.find((p) => p.active) ?? list[0];
    return active ? idOf(active) : NEW_ID;
  });
  const [draft, setDraft] = useState<Draft>(() => {
    const list = initial === null ? [] : unwrapList<SlotzillaPaytableDto>(initial, "paytables");
    return toDraft(list.find((p) => p.active) ?? list[0] ?? null);
  });
  const [cellErrors, setCellErrors] = useState<Partial<Record<LineKey, string>>>({});
  const [targetPercent, setTargetPercent] = useState<string>(() => bpToPercent(rtpTargetBp));
  const [fit, setFit] = useState<SlotzillaFitResponse | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const selected = paytables?.find((p) => idOf(p) === selectedId) ?? null;
  const isNew = selectedId === NEW_ID;
  const dirty = !sameDraft(draft, toDraft(isNew ? null : selected));

  const reload = async (): Promise<SlotzillaPaytableDto[]> => {
    const raw = await clientApi<unknown>("/admin/slotzilla/paytables");
    const list = unwrapList<SlotzillaPaytableDto>(raw, "paytables");
    setPaytables(list);
    return list;
  };

  const fail = (err: unknown, fallback: string) =>
    setError(err instanceof ApiFetchError ? err.message : fallback);

  const select = (id: string) => {
    if (dirty && !window.confirm("Discard the unsaved edits on this paytable?")) return;
    setSelectedId(id);
    setDraft(toDraft(id === NEW_ID ? null : (paytables?.find((p) => idOf(p) === id) ?? null)));
    setCellErrors({});
    setFit(null);
    setNotice(null);
    setError(null);
  };

  const retry = () => {
    setError(null);
    startTransition(async () => {
      try {
        const list = await reload();
        const active = list.find((p) => p.active) ?? list[0];
        if (active) {
          setSelectedId(idOf(active));
          setDraft(toDraft(active));
        }
      } catch (err) {
        fail(err, "Could not load the paytables.");
      }
    });
  };

  const onSave = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    const name = draft.name.trim();
    if (!name) {
      setError("Give the paytable a name.");
      return;
    }
    const parsed = parseCells(draft.cells);
    if ("errors" in parsed) {
      setCellErrors(parsed.errors);
      return;
    }
    setCellErrors({});
    startTransition(async () => {
      try {
        const body = JSON.stringify({ name, lines: parsed.lines });
        let savedId: string | null = null;
        if (isNew) {
          const raw = await clientApi<unknown>("/admin/slotzilla/paytables", { method: "POST", body });
          const created = unwrapObject<SlotzillaPaytableDto>(raw, "paytable");
          savedId = created?.id !== undefined ? String(created.id) : null;
        } else {
          await clientApi<unknown>(`/admin/slotzilla/paytables/${encodeURIComponent(selectedId)}`, {
            method: "PUT",
            body,
          });
          savedId = selectedId;
        }
        const list = await reload();
        const hit =
          (savedId ? list.find((p) => idOf(p) === savedId) : undefined) ??
          list.find((p) => p.name === name) ??
          null;
        if (hit) {
          setSelectedId(idOf(hit));
          setDraft(toDraft(hit));
        }
        setNotice(isNew ? "Paytable created. Activate it to put it in play." : "Paytable saved.");
      } catch (err) {
        fail(err, "Save failed. Please try again.");
      }
    });
  };

  const onActivate = (pt: SlotzillaPaytableDto) => {
    if (
      !window.confirm(
        `Activate "${pt.name}"? Every spin placed from now on prices from it; open spins keep the table they were placed on.`,
      )
    ) {
      return;
    }
    setError(null);
    setNotice(null);
    startTransition(async () => {
      try {
        await clientApi<unknown>(`/admin/slotzilla/paytables/${encodeURIComponent(idOf(pt))}/activate`, {
          method: "POST",
        });
        await reload();
        setNotice(`"${pt.name}" is now the active paytable.`);
      } catch (err) {
        fail(err, "Could not activate the paytable.");
      }
    });
  };

  const onFit = () => {
    setError(null);
    const targetBp = percentToBp(targetPercent);
    if (targetBp === null || targetBp < 5000 || targetBp > 9900) {
      setError("Fit target must be a percentage between 50 and 99.");
      return;
    }
    const body: SlotzillaFitRequest = { targetBp };
    if (!isNew) body.baseId = selectedId;
    startTransition(async () => {
      try {
        const raw = await clientApi<unknown>("/admin/slotzilla/paytables/fit", {
          method: "POST",
          body: JSON.stringify(body),
        });
        const res = unwrapObject<SlotzillaFitResponse>(raw, "fit");
        if (!res || !res.lines) throw new Error("empty fit response");
        setFit(res);
      } catch (err) {
        fail(err, "The fit failed. Is there a corpus? See the Corpus tab.");
      }
    });
  };

  const applyFit = () => {
    if (!fit) return;
    setDraft((p) => ({ ...p, cells: cellsFromLines(fit.lines) }));
    setCellErrors({});
    setNotice("Fitted multipliers copied into the draft. Save to keep them.");
  };

  if (paytables === null) {
    return (
      <>
        <LoadFailed what="the paytables" onRetry={retry} pending={pending} />
        {error ? <ErrorBanner>{error}</ErrorBanner> : null}
      </>
    );
  }

  // The draft's own expected return, on the corpus the last fit measured —
  // so an operator hand-tuning a cell sees the consequence before saving.
  const draftParsed = parseCells(draft.cells);
  const corpusFreq = fit ? normaliseLineFrequencies(fit.corpus?.byLine, fit.corpus?.rounds, LINE_KEYS) : null;
  const draftReturnBp =
    corpusFreq && "lines" in draftParsed ? expectedReturnBp(draftParsed.lines, corpusFreq) : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <Section
        title="Paytables"
        aside={
          <button type="button" onClick={() => select(NEW_ID)} disabled={pending} style={smallButtonStyle}>
            New paytable
          </button>
        }
      >
        {paytables.length === 0 ? (
          <p style={hintStyle}>No paytables yet. A fresh database seeds one; otherwise create one below.</p>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>Name</th>
                <th style={thStyle}>State</th>
                <th style={thStyle}>Fitted return</th>
                <th style={thStyle}>Corpus</th>
                <th style={thStyle}>Updated</th>
                <th style={thStyle} />
              </tr>
            </thead>
            <tbody>
              {paytables.map((pt) => {
                const id = idOf(pt);
                const on = id === selectedId;
                return (
                  <tr
                    key={id}
                    onClick={() => select(id)}
                    style={{
                      ...rowStyle,
                      cursor: "pointer",
                      background: on ? "color-mix(in oklab, var(--accent, #16a34a) 8%, transparent)" : undefined,
                    }}
                  >
                    <td style={{ ...tdStyle, fontWeight: 600 }}>{pt.name}</td>
                    <td style={tdStyle}>{pt.active ? <Chip tone="accent">active</Chip> : <Chip tone="muted">draft</Chip>}</td>
                    <td style={{ ...tdStyle }} className="mono">
                      {formatBp(pt.fittedRtpBp)}
                    </td>
                    <td style={{ ...tdStyle, ...monoMuted, maxWidth: 320 }}>{pt.corpusNote ?? "—"}</td>
                    <td style={{ ...tdStyle, ...monoMuted }}>
                      {pt.updatedAt ? new Date(pt.updatedAt).toLocaleString() : "—"}
                    </td>
                    <td style={{ ...tdStyle, textAlign: "right" }}>
                      {!pt.active ? (
                        <button
                          type="button"
                          disabled={pending}
                          onClick={(e) => {
                            e.stopPropagation();
                            onActivate(pt);
                          }}
                          style={smallButtonStyle}
                        >
                          Activate
                        </button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Section>

      <form onSubmit={onSave} style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        <Section
          title={isNew ? "New paytable" : `Edit — ${selected?.name ?? selectedId}`}
          aside={selected?.active ? <Chip tone="accent">active</Chip> : null}
        >
          <p style={hintStyle}>
            Multipliers of the stake. Two reels on a symbol pay the <strong>Any 2</strong> line, all three
            the <strong>All 3</strong> line; three different symbols pay nothing. An empty cell is a line
            that pays nothing. The NONE rows are held fixed by the fitter (half back / money back on
            empty reels).
          </p>
          <Field label="Name">
            <input
              value={draft.name}
              onChange={(e) => setDraft((p) => ({ ...p, name: e.target.value }))}
              disabled={pending}
              style={{ ...inputStyle, maxWidth: 320 }}
              placeholder="e.g. Corpus fit 2026-09"
            />
          </Field>
          <table style={{ ...tableStyle, maxWidth: 640 }}>
            <thead>
              <tr>
                <th style={thStyle}>Symbol</th>
                <th style={thStyle}>Any 2</th>
                <th style={thStyle}>All 3</th>
                {fit ? <th style={thStyle}>Fitted any 2</th> : null}
                {fit ? <th style={thStyle}>Fitted all 3</th> : null}
              </tr>
            </thead>
            <tbody>
              {SLOT_SYMBOLS.map((sym) => (
                <tr key={sym} style={rowStyle}>
                  <td style={tdStyle}>
                    <span className="mono" style={{ fontWeight: 700 }}>
                      {sym}
                    </span>{" "}
                    <span style={monoMuted}>{SYMBOL_LABEL[sym]}</span>
                    {FIXED_LINES.includes(`any2:${sym}`) ? (
                      <>
                        {" "}
                        <Chip tone="muted" title="Held fixed by the fitter">
                          fixed
                        </Chip>
                      </>
                    ) : null}
                  </td>
                  {(["any2", "all3"] as const).map((kind) => {
                    const key = `${kind}:${sym}` as LineKey;
                    return (
                      <td key={key} style={tdStyle}>
                        <input
                          inputMode="decimal"
                          aria-label={`${SYMBOL_LABEL[sym]} ${kind === "any2" ? "any two" : "all three"} multiplier`}
                          value={draft.cells[key]}
                          onChange={(e) =>
                            setDraft((p) => ({ ...p, cells: { ...p.cells, [key]: e.target.value } }))
                          }
                          disabled={pending}
                          style={{
                            ...cellInputStyle,
                            borderColor: cellErrors[key] ? "var(--negative, #dc2626)" : undefined,
                          }}
                          title={cellErrors[key]}
                        />
                      </td>
                    );
                  })}
                  {fit
                    ? (["any2", "all3"] as const).map((kind) => {
                        const key = `${kind}:${sym}` as LineKey;
                        const v = fit.lines?.[key];
                        return (
                          <td key={`fit-${key}`} style={{ ...tdStyle, textAlign: "right" }} className="mono">
                            {typeof v === "number" ? formatMultiplier(v) : "—"}
                          </td>
                        );
                      })
                    : null}
                </tr>
              ))}
            </tbody>
          </table>
          {Object.keys(cellErrors).length > 0 ? (
            <ErrorBanner>Some cells are not valid multipliers — use a number with at most two decimals.</ErrorBanner>
          ) : null}

          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", gap: 12, marginTop: 6 }}>
            <Field label="Fit target (%)" hint="Defaults to the return target on Settings.">
              <input
                inputMode="decimal"
                value={targetPercent}
                onChange={(e) => setTargetPercent(e.target.value)}
                disabled={pending}
                style={{ ...inputStyle, maxWidth: 120, fontFamily: "var(--font-mono, ui-monospace, monospace)" }}
              />
            </Field>
            <button type="button" onClick={onFit} disabled={pending} style={ghostButtonStyle(!pending)}>
              {pending ? "Working…" : "Fit to target"}
            </button>
            {fit ? (
              <button type="button" onClick={applyFit} disabled={pending} style={ghostButtonStyle(!pending)}>
                Apply fitted
              </button>
            ) : null}
            <span style={{ ...hintStyle, alignSelf: "center" }}>
              Fits from the {isNew ? "active" : "saved"} paytable&apos;s play rows, not from unsaved edits.
            </span>
          </div>

          {fit ? (
            <NoticeBanner>
              <span className="mono">
                Fitted return {formatBp(fit.fittedBp)} at factor {Number.isFinite(fit.factor) ? fit.factor.toFixed(4) : "—"} on{" "}
                {fit.corpus?.matches ?? "?"} matches / {fit.corpus?.rounds ?? "?"} rounds.
                {draftReturnBp !== null ? ` The draft as it stands returns ${formatBp(draftReturnBp)} on the same corpus.` : ""}
              </span>
              {fit.factor === 0 ? (
                <span style={{ display: "block", marginTop: 4, color: "var(--negative, #dc2626)" }}>
                  Factor 0: the fixed NONE lines alone exceed the target on this corpus. The target is
                  unreachable — do not ship this fit.
                </span>
              ) : null}
            </NoticeBanner>
          ) : null}
        </Section>

        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button type="submit" disabled={!dirty || pending} style={primaryButtonStyle(dirty, pending)}>
            {pending ? "Saving…" : isNew ? "Create" : "Save"}
          </button>
          <button
            type="button"
            onClick={() => {
              setDraft(toDraft(isNew ? null : selected));
              setCellErrors({});
            }}
            disabled={!dirty || pending}
            style={ghostButtonStyle(dirty && !pending)}
          >
            Discard changes
          </button>
          {selected && !selected.active ? (
            <button
              type="button"
              onClick={() => onActivate(selected)}
              disabled={pending || dirty}
              title={dirty ? "Save first" : undefined}
              style={{ ...dangerSmallButtonStyle, height: 36, padding: "0 16px", fontSize: 13, fontWeight: 600 }}
            >
              Activate this paytable
            </button>
          ) : null}
        </div>
      </form>

      {notice ? <NoticeBanner>{notice}</NoticeBanner> : null}
      {error ? <ErrorBanner>{error}</ErrorBanner> : null}
    </div>
  );
}
