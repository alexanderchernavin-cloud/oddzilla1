"use client";

import { useEffect, useState, useTransition } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import type {
  AvatarTemplateAdminSummary,
  AvatarTemplateAdminListResponse,
  AvatarTemplatePatchRequest,
  AvatarRarity,
  AvatarStatus,
} from "@oddzilla/types";
import { clientApi, ApiFetchError } from "@/lib/api-client";

// Admin avatar manager: grid + upload + per-row edit. The initial data
// comes from the server component; subsequent mutations refetch the
// list rather than mutating local state, so the grid stays a faithful
// reflection of the DB.

const RARITY_CHOICES: AvatarRarity[] = ["common", "rare", "epic", "legendary"];
const STATUS_CHOICES: AvatarStatus[] = ["active", "hidden"];
const CATEGORY_CHOICES = [
  "creature",
  "sport",
  "esports",
  "persona",
  "abstract",
  "event",
  "custom",
] as const;

// Slug regex MUST track the API's: lowercase alphanumerics + dashes/
// underscores, 3-64 chars, can't start/end with separator. Validation
// happens server-side too — this just gives instant feedback in the
// upload form.
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{1,62}[a-z0-9]$/;

interface UploadState {
  slug: string;
  name: string;
  category: string;
  rarity: AvatarRarity;
  file: File | null;
  status: "idle" | "uploading" | "error" | "success";
  errorMessage: string | null;
}

const INITIAL_UPLOAD: UploadState = {
  slug: "",
  name: "",
  category: "custom",
  rarity: "common",
  file: null,
  status: "idle",
  errorMessage: null,
};

export function AvatarManager({
  initialTemplates,
}: {
  initialTemplates: AvatarTemplateAdminSummary[];
}) {
  const router = useRouter();
  const [templates, setTemplates] = useState(initialTemplates);
  const [pending, startTransition] = useTransition();
  // Re-sync from props when the server component re-fetches (router.refresh).
  useEffect(() => {
    setTemplates(initialTemplates);
  }, [initialTemplates]);

  async function refetch() {
    const next = await clientApi<AvatarTemplateAdminListResponse>(
      "/admin/avatars",
    );
    setTemplates(next.templates);
    // Also bump the route cache so a subsequent server-rendered
    // navigation lands on fresh data.
    startTransition(() => router.refresh());
  }

  return (
    <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_320px]">
      <Grid templates={templates} onChange={refetch} />
      <UploadCard onUploaded={refetch} disabled={pending} />
    </div>
  );
}

function Grid({
  templates,
  onChange,
}: {
  templates: AvatarTemplateAdminSummary[];
  onChange: () => Promise<void>;
}) {
  if (templates.length === 0) {
    return (
      <div className="card p-10 text-center text-sm text-[var(--color-fg-muted)]">
        No avatar templates yet. Upload one on the right.
      </div>
    );
  }
  return (
    <ul className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
      {templates.map((t) => (
        <Card key={t.id} template={t} onChange={onChange} />
      ))}
    </ul>
  );
}

function Card({
  template,
  onChange,
}: {
  template: AvatarTemplateAdminSummary;
  onChange: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <li
      className={
        "card flex flex-col gap-3 p-3 " +
        (template.status === "hidden" ? "opacity-60" : "")
      }
    >
      <div className="relative aspect-square overflow-hidden rounded-md border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)]">
        {/* unoptimized for /api/community/avatars/* (BYTEA upload path)
            because Next.js's image optimizer can't introspect dynamic
            API responses. Static /avatars/*.png stays fully optimized. */}
        <Image
          src={template.imageUrl}
          alt={template.name}
          fill
          sizes="200px"
          unoptimized={template.imageUrl.startsWith("/api/")}
          className="object-cover"
        />
      </div>
      <div className="flex items-center justify-between gap-2 text-xs">
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{template.name}</div>
          <div className="truncate text-[var(--color-fg-subtle)]">
            <code>{template.slug}</code>
          </div>
        </div>
        <RarityPill rarity={template.rarity} />
      </div>
      <div className="flex items-center justify-between text-[10px] uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
        <span>{template.category}</span>
        <span>{template.source === "seed" ? "Seed" : "Upload"}</span>
        <span>{template.status === "active" ? "Active" : "Hidden"}</span>
      </div>
      {editing ? (
        <EditPanel
          template={template}
          onClose={() => setEditing(false)}
          onSaved={async () => {
            setEditing(false);
            await onChange();
          }}
        />
      ) : (
        <div className="flex gap-2 text-xs">
          <button
            type="button"
            className="btn btn-ghost flex-1"
            onClick={() => setEditing(true)}
          >
            Edit
          </button>
          <ToggleStatusButton template={template} onChanged={onChange} />
        </div>
      )}
    </li>
  );
}

function RarityPill({ rarity }: { rarity: AvatarRarity }) {
  // Color mapping leans on the existing accent / negative / positive
  // tokens rather than introducing new ones. Common = subtle, rare =
  // accent, epic = positive, legendary = a hand-tuned warm tone.
  const cls: Record<AvatarRarity, string> = {
    common:
      "border-[var(--color-border-strong)] text-[var(--color-fg-muted)]",
    rare: "border-[var(--color-accent)] text-[var(--color-accent)]",
    epic: "border-[var(--color-positive)] text-[var(--color-positive)]",
    legendary: "border-amber-500 text-amber-500",
  };
  return (
    <span
      className={
        "inline-block rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.15em] " +
        cls[rarity]
      }
    >
      {rarity}
    </span>
  );
}

function ToggleStatusButton({
  template,
  onChanged,
}: {
  template: AvatarTemplateAdminSummary;
  onChanged: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const isActive = template.status === "active";
  async function flip() {
    setBusy(true);
    try {
      if (isActive) {
        // Soft delete = hide. The DELETE endpoint returns 200 even on
        // a no-op (already hidden), so we can call it without checking.
        await clientApi(`/admin/avatars/${template.id}`, { method: "DELETE" });
      } else {
        // Re-activate via PATCH.
        const body: AvatarTemplatePatchRequest = { status: "active" };
        await clientApi(`/admin/avatars/${template.id}`, {
          method: "PATCH",
          body: JSON.stringify(body),
        });
      }
      await onChanged();
    } catch (err) {
      console.error("toggle avatar status", err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <button
      type="button"
      className="btn btn-ghost flex-1"
      onClick={flip}
      disabled={busy}
    >
      {busy ? "…" : isActive ? "Hide" : "Activate"}
    </button>
  );
}

function EditPanel({
  template,
  onClose,
  onSaved,
}: {
  template: AvatarTemplateAdminSummary;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [name, setName] = useState(template.name);
  const [category, setCategory] = useState(template.category);
  const [rarity, setRarity] = useState<AvatarRarity>(template.rarity);
  const [sortOrder, setSortOrder] = useState(template.sortOrder);
  const [status, setStatus] = useState<AvatarStatus>(template.status);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    // Build a minimal patch — only fields that actually changed. The
    // API rejects an empty patch with no_changes, so we'd 400 if
    // nothing differed; the early return below sidesteps that.
    const patch: AvatarTemplatePatchRequest = {};
    if (name !== template.name) patch.name = name;
    if (category !== template.category) patch.category = category;
    if (rarity !== template.rarity) patch.rarity = rarity;
    if (sortOrder !== template.sortOrder) patch.sortOrder = sortOrder;
    if (status !== template.status) patch.status = status;
    if (Object.keys(patch).length === 0) {
      setBusy(false);
      onClose();
      return;
    }
    try {
      await clientApi(`/admin/avatars/${template.id}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      await onSaved();
    } catch (err) {
      setError(
        err instanceof ApiFetchError
          ? err.body.message
          : "Couldn't save changes",
      );
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="flex flex-col gap-2 text-xs">
      <input
        className="input"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Name"
        maxLength={80}
        required
      />
      <select
        className="input"
        value={category}
        onChange={(e) => setCategory(e.target.value)}
      >
        {CATEGORY_CHOICES.includes(category as (typeof CATEGORY_CHOICES)[number])
          ? null
          : (
            <option value={category}>{category}</option>
          )}
        {CATEGORY_CHOICES.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
      <select
        className="input"
        value={rarity}
        onChange={(e) => setRarity(e.target.value as AvatarRarity)}
      >
        {RARITY_CHOICES.map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
      </select>
      <select
        className="input"
        value={status}
        onChange={(e) => setStatus(e.target.value as AvatarStatus)}
      >
        {STATUS_CHOICES.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
      <input
        className="input"
        type="number"
        value={sortOrder}
        onChange={(e) => setSortOrder(Number(e.target.value))}
        min={0}
        max={10000}
        placeholder="Sort order"
      />
      {error ? (
        <p className="text-[var(--color-negative)]">{error}</p>
      ) : null}
      <div className="flex gap-2">
        <button type="submit" className="btn flex-1" disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          className="btn btn-ghost flex-1"
          onClick={onClose}
          disabled={busy}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function UploadCard({
  onUploaded,
  disabled,
}: {
  onUploaded: () => Promise<void>;
  disabled: boolean;
}) {
  const [state, setState] = useState<UploadState>(INITIAL_UPLOAD);
  const slugInvalid = state.slug.length > 0 && !SLUG_RE.test(state.slug);

  function reset() {
    setState(INITIAL_UPLOAD);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!state.file) {
      setState((s) => ({
        ...s,
        status: "error",
        errorMessage: "Pick a PNG, JPEG, or WebP file (≤5 MB).",
      }));
      return;
    }
    if (!SLUG_RE.test(state.slug)) {
      setState((s) => ({
        ...s,
        status: "error",
        errorMessage:
          "Slug must be 3–64 lowercase chars, alphanumerics with - or _ in the middle.",
      }));
      return;
    }
    setState((s) => ({ ...s, status: "uploading", errorMessage: null }));
    const fd = new FormData();
    fd.append("slug", state.slug);
    fd.append("name", state.name);
    fd.append("category", state.category);
    fd.append("rarity", state.rarity);
    fd.append("file", state.file);
    try {
      // Raw fetch here — clientApi force-sets content-type: application/
      // json for any request with a body, which would corrupt the
      // multipart boundary. Same-origin so credentials: 'include' picks
      // up the admin session cookie.
      const res = await fetch("/api/admin/avatars", {
        method: "POST",
        body: fd,
        credentials: "include",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { message?: string }
          | null;
        throw new Error(body?.message ?? `Upload failed (${res.status})`);
      }
      reset();
      await onUploaded();
    } catch (err) {
      setState((s) => ({
        ...s,
        status: "error",
        errorMessage:
          err instanceof Error ? err.message : "Upload failed",
      }));
    }
  }

  return (
    <form
      onSubmit={submit}
      className="card flex flex-col gap-3 p-4 text-sm"
      aria-busy={state.status === "uploading" || disabled}
    >
      <h2 className="text-sm font-semibold uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
        Upload avatar
      </h2>
      <label className="flex flex-col gap-1 text-xs">
        <span className="text-[var(--color-fg-muted)]">File (PNG/JPEG/WebP, ≤5 MB)</span>
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp"
          onChange={(e) =>
            setState((s) => ({ ...s, file: e.target.files?.[0] ?? null }))
          }
          required
        />
      </label>
      <label className="flex flex-col gap-1 text-xs">
        <span className="text-[var(--color-fg-muted)]">Slug (URL-safe id)</span>
        <input
          className="input"
          value={state.slug}
          onChange={(e) => setState((s) => ({ ...s, slug: e.target.value.toLowerCase() }))}
          placeholder="kaiju-13"
          required
        />
        {slugInvalid ? (
          <span className="text-[var(--color-negative)]">
            3–64 lowercase chars, separator only in the middle.
          </span>
        ) : null}
      </label>
      <label className="flex flex-col gap-1 text-xs">
        <span className="text-[var(--color-fg-muted)]">Display name</span>
        <input
          className="input"
          value={state.name}
          onChange={(e) => setState((s) => ({ ...s, name: e.target.value }))}
          placeholder="Apex Reptile"
          maxLength={80}
          required
        />
      </label>
      <label className="flex flex-col gap-1 text-xs">
        <span className="text-[var(--color-fg-muted)]">Category</span>
        <select
          className="input"
          value={state.category}
          onChange={(e) =>
            setState((s) => ({ ...s, category: e.target.value }))
          }
        >
          {CATEGORY_CHOICES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs">
        <span className="text-[var(--color-fg-muted)]">Rarity</span>
        <select
          className="input"
          value={state.rarity}
          onChange={(e) =>
            setState((s) => ({ ...s, rarity: e.target.value as AvatarRarity }))
          }
        >
          {RARITY_CHOICES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </label>
      {state.status === "error" && state.errorMessage ? (
        <p className="text-xs text-[var(--color-negative)]">
          {state.errorMessage}
        </p>
      ) : null}
      <button
        type="submit"
        className="btn"
        disabled={state.status === "uploading" || disabled}
      >
        {state.status === "uploading" ? "Uploading…" : "Upload"}
      </button>
    </form>
  );
}
