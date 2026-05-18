"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { clientApi, ApiFetchError } from "@/lib/api-client";
import type { ZillapassPeriod, ZillapassTaskDto } from "@oddzilla/types";

const PERIODS: ZillapassPeriod[] = ["daily", "weekly", "season"];

export function ZillapassTasksEditor({
  initial,
}: {
  initial: ZillapassTaskDto[];
}) {
  const [tasks, setTasks] = useState(initial);
  return (
    <div className="mt-8 space-y-8">
      <CreateForm
        onCreated={(t) =>
          setTasks((prev) =>
            [...prev, t].sort(
              (a, b) => a.sortOrder - b.sortOrder || a.id - b.id,
            ),
          )
        }
      />

      <section>
        <h2 className="text-lg font-semibold tracking-tight">Tasks</h2>
        {tasks.length === 0 ? (
          <p className="mt-3 text-sm text-[var(--color-fg-muted)]">
            No tasks yet. Use the form above to create one.
          </p>
        ) : (
          <ul className="mt-4 space-y-3">
            {tasks.map((task) => (
              <li key={task.id}>
                <TaskRow
                  task={task}
                  onUpdated={(t) =>
                    setTasks((prev) =>
                      prev
                        .map((p) => (p.id === t.id ? t : p))
                        .sort(
                          (a, b) =>
                            a.sortOrder - b.sortOrder || a.id - b.id,
                        ),
                    )
                  }
                  onDeleted={(id) =>
                    setTasks((prev) => prev.filter((p) => p.id !== id))
                  }
                />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function CreateForm({
  onCreated,
}: {
  onCreated: (task: ZillapassTaskDto) => void;
}) {
  const [pending, startTransition] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [slug, setSlug] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [targetCount, setTargetCount] = useState("3");
  const [predicateKey, setPredicateKey] = useState("");
  const [period, setPeriod] = useState<ZillapassPeriod>("daily");
  const [setNumber, setSetNumber] = useState("1");
  const [rewardKind, setRewardKind] = useState("");
  const [rewardPayload, setRewardPayload] = useState("");
  const [sortOrder, setSortOrder] = useState("0");
  const [active, setActive] = useState(true);

  function submit() {
    setErr(null);
    const targetN = Number(targetCount);
    const sortN = Number(sortOrder);
    const setN = Number(setNumber);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
      setErr("Slug must be lower-kebab (e.g. place-5-bets).");
      return;
    }
    if (!title.trim()) {
      setErr("Title is required.");
      return;
    }
    if (!predicateKey.trim()) {
      setErr("Predicate key is required (e.g. bets_placed).");
      return;
    }
    if (!Number.isInteger(targetN) || targetN < 1) {
      setErr("Target count must be a positive integer.");
      return;
    }
    if (!Number.isInteger(setN) || setN < 1) {
      setErr("Set number must be a positive integer.");
      return;
    }
    let parsedPayload: unknown = null;
    if (rewardPayload.trim().length > 0) {
      try {
        parsedPayload = JSON.parse(rewardPayload);
      } catch {
        setErr("Reward payload must be valid JSON (or empty).");
        return;
      }
    }

    startTransition(async () => {
      try {
        const res = await clientApi<{ task: ZillapassTaskDto }>(
          "/admin/zillapass/tasks",
          {
            method: "POST",
            body: JSON.stringify({
              slug,
              title,
              description: description.trim() || null,
              targetCount: targetN,
              predicateKey,
              period,
              setNumber: setN,
              rewardKind: rewardKind.trim() || null,
              rewardPayload: parsedPayload,
              sortOrder: sortN || 0,
              active,
            }),
          },
        );
        onCreated(res.task);
        setSlug("");
        setTitle("");
        setDescription("");
        setTargetCount("3");
        setPredicateKey("");
        setRewardKind("");
        setRewardPayload("");
      } catch (e) {
        setErr(e instanceof ApiFetchError ? e.message : "Create failed");
      }
    });
  }

  return (
    <section className="rounded border border-[var(--color-border)] bg-[var(--color-bg-elev)] p-4">
      <h2 className="text-base font-semibold">New task</h2>
      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <TextField label="Slug" value={slug} onChange={setSlug} placeholder="place-5-bets" />
        <TextField label="Title" value={title} onChange={setTitle} placeholder="Place 5 bets" />
        <TextField
          label="Description"
          value={description}
          onChange={setDescription}
          placeholder="Optional — shown in the popover + page"
        />
        <NumberField
          label="Target count"
          value={targetCount}
          onChange={setTargetCount}
          min={1}
        />
        <TextField
          label="Predicate key"
          value={predicateKey}
          onChange={setPredicateKey}
          placeholder="bets_placed"
        />
        <SelectField
          label="Period"
          value={period}
          onChange={(v) => setPeriod(v as ZillapassPeriod)}
          options={PERIODS}
        />
        <NumberField
          label="Set number (stage)"
          value={setNumber}
          onChange={setSetNumber}
          min={1}
        />
        <TextField
          label="Reward kind"
          value={rewardKind}
          onChange={setRewardKind}
          placeholder="feature_unlock"
        />
        <TextField
          label='Reward payload (JSON)'
          value={rewardPayload}
          onChange={setRewardPayload}
          placeholder='{"feature":"cashout"}'
        />
        <NumberField
          label="Sort order"
          value={sortOrder}
          onChange={setSortOrder}
          min={0}
        />
        <label className="flex items-center gap-2 self-end text-sm">
          <input
            type="checkbox"
            checked={active}
            onChange={(e) => setActive(e.target.checked)}
          />
          Active
        </label>
      </div>
      {err ? (
        <p className="mt-3 text-sm text-[var(--color-negative,#c1342f)]">{err}</p>
      ) : null}
      <div className="mt-4">
        <button
          type="button"
          onClick={submit}
          disabled={pending}
          className="rounded bg-[var(--color-fg)] px-3 py-1.5 text-sm font-medium text-[var(--color-bg)] disabled:opacity-60"
        >
          {pending ? "Creating…" : "Create task"}
        </button>
      </div>
    </section>
  );
}

function TaskRow({
  task,
  onUpdated,
  onDeleted,
}: {
  task: ZillapassTaskDto;
  onUpdated: (t: ZillapassTaskDto) => void;
  onDeleted: (id: number) => void;
}) {
  const [pending, startTransition] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description ?? "");
  const [targetCount, setTargetCount] = useState(String(task.targetCount));
  const [predicateKey, setPredicateKey] = useState(task.predicateKey);
  const [period, setPeriod] = useState<ZillapassPeriod>(task.period);
  const [setNumber, setSetNumber] = useState(String(task.setNumber));
  const [rewardKind, setRewardKind] = useState(task.rewardKind ?? "");
  const [rewardPayload, setRewardPayload] = useState(
    task.rewardPayload === null || task.rewardPayload === undefined
      ? ""
      : JSON.stringify(task.rewardPayload),
  );
  const [sortOrder, setSortOrder] = useState(String(task.sortOrder));
  const [active, setActive] = useState(task.active);

  function save() {
    setErr(null);
    const targetN = Number(targetCount);
    const sortN = Number(sortOrder);
    const setN = Number(setNumber);
    if (!title.trim()) {
      setErr("Title is required.");
      return;
    }
    if (!predicateKey.trim()) {
      setErr("Predicate key is required.");
      return;
    }
    if (!Number.isInteger(targetN) || targetN < 1) {
      setErr("Target count must be a positive integer.");
      return;
    }
    if (!Number.isInteger(setN) || setN < 1) {
      setErr("Set number must be a positive integer.");
      return;
    }
    let parsedPayload: unknown = null;
    if (rewardPayload.trim().length > 0) {
      try {
        parsedPayload = JSON.parse(rewardPayload);
      } catch {
        setErr("Reward payload must be valid JSON (or empty).");
        return;
      }
    }

    startTransition(async () => {
      try {
        const res = await clientApi<{ task: ZillapassTaskDto }>(
          `/admin/zillapass/tasks/${task.id}`,
          {
            method: "PATCH",
            body: JSON.stringify({
              title,
              description: description.trim() || null,
              targetCount: targetN,
              predicateKey,
              period,
              setNumber: setN,
              rewardKind: rewardKind.trim() || null,
              rewardPayload: parsedPayload,
              sortOrder: sortN || 0,
              active,
            }),
          },
        );
        onUpdated(res.task);
      } catch (e) {
        setErr(e instanceof ApiFetchError ? e.message : "Save failed");
      }
    });
  }

  function remove() {
    if (!window.confirm(`Delete task "${task.title}"? This wipes all user progress on it.`)) {
      return;
    }
    setErr(null);
    startTransition(async () => {
      try {
        await clientApi(`/admin/zillapass/tasks/${task.id}`, {
          method: "DELETE",
        });
        onDeleted(task.id);
      } catch (e) {
        setErr(e instanceof ApiFetchError ? e.message : "Delete failed");
      }
    });
  }

  return (
    <div className="rounded border border-[var(--color-border)] bg-[var(--color-bg-elev)] p-4">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-base font-semibold">{task.title}</h3>
        <code className="text-xs text-[var(--color-fg-muted)]">
          #{task.id} · {task.slug}
        </code>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <TextField label="Title" value={title} onChange={setTitle} />
        <TextField
          label="Description"
          value={description}
          onChange={setDescription}
        />
        <NumberField
          label="Target count"
          value={targetCount}
          onChange={setTargetCount}
          min={1}
        />
        <TextField
          label="Predicate key"
          value={predicateKey}
          onChange={setPredicateKey}
        />
        <SelectField
          label="Period"
          value={period}
          onChange={(v) => setPeriod(v as ZillapassPeriod)}
          options={PERIODS}
        />
        <NumberField
          label="Set number (stage)"
          value={setNumber}
          onChange={setSetNumber}
          min={1}
        />
        <TextField
          label="Reward kind"
          value={rewardKind}
          onChange={setRewardKind}
        />
        <TextField
          label="Reward payload (JSON)"
          value={rewardPayload}
          onChange={setRewardPayload}
        />
        <NumberField
          label="Sort order"
          value={sortOrder}
          onChange={setSortOrder}
          min={0}
        />
        <label className="flex items-center gap-2 self-end text-sm">
          <input
            type="checkbox"
            checked={active}
            onChange={(e) => setActive(e.target.checked)}
          />
          Active
        </label>
      </div>
      {err ? (
        <p className="mt-3 text-sm text-[var(--color-negative,#c1342f)]">{err}</p>
      ) : null}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={save}
          disabled={pending}
          className="rounded bg-[var(--color-fg)] px-3 py-1.5 text-sm font-medium text-[var(--color-bg)] disabled:opacity-60"
        >
          {pending ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          onClick={remove}
          disabled={pending}
          className="rounded border border-[var(--color-border)] px-3 py-1.5 text-sm text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] disabled:opacity-60"
        >
          Delete
        </button>
        <span className="ml-auto text-xs text-[var(--color-fg-muted)]">
          updated {new Date(task.updatedAt).toLocaleString()}
        </span>
      </div>
    </div>
  );
}

function TextField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-xs uppercase tracking-[0.12em] text-[var(--color-fg-subtle,var(--color-fg-muted))]">
        {label}
      </span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm"
      />
    </label>
  );
}

function NumberField({
  label,
  value,
  onChange,
  min,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  min?: number;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-xs uppercase tracking-[0.12em] text-[var(--color-fg-subtle,var(--color-fg-muted))]">
        {label}
      </span>
      <input
        type="number"
        value={value}
        min={min}
        onChange={(e) => onChange(e.target.value)}
        className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm"
      />
    </label>
  );
}

function SelectField({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: readonly string[];
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-xs uppercase tracking-[0.12em] text-[var(--color-fg-subtle,var(--color-fg-muted))]">
        {label}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm"
      >
        {options.map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
    </label>
  );
}
