"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type {
  CommunityMe,
  AvatarTemplateSummary,
  EquipAvatarRequest,
} from "@oddzilla/types";
import { clientApi, ApiFetchError } from "@/lib/api-client";
import { Avatar } from "@/components/community/avatar";

const NICKNAME_RE = /^[A-Za-z0-9_]{3,20}$/;

export function CommunitySettingsForms({
  initial,
  templates,
}: {
  initial: CommunityMe;
  templates: AvatarTemplateSummary[];
}) {
  return (
    <div className="mt-8 space-y-6">
      <AvatarPicker initial={initial} templates={templates} />
      <div className="grid gap-6 md:grid-cols-2">
        <ProfileForm
          initialNickname={initial.nickname ?? ""}
          initialBio={initial.bio ?? ""}
        />
        <VisibilityForm initial={initial.ticketsPublic} />
      </div>
    </div>
  );
}

// Avatar picker — server hands the active templates list down at SSR
// time. Selecting a row PUTs to /community/me/avatar; clearing the
// selection PUTs templateId=null and the user falls back to the
// monogram. Optimistic UI: the click immediately moves the gold ring,
// the network roundtrip resolves in the background. router.refresh()
// re-queries the server component so the topbar / feed update too.
function AvatarPicker({
  initial,
  templates,
}: {
  initial: CommunityMe;
  templates: AvatarTemplateSummary[];
}) {
  const router = useRouter();
  const [equippedId, setEquippedId] = useState<string | null>(
    initial.avatarTemplateId,
  );
  const [equippedUrl, setEquippedUrl] = useState<string | null>(
    initial.avatarUrl,
  );
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function equip(templateId: string | null) {
    setBusyId(templateId ?? "__clear__");
    setError(null);
    // Optimistic — flip the ring before the network resolves so the
    // tap feels instant. Roll back on failure.
    const prevId = equippedId;
    const prevUrl = equippedUrl;
    setEquippedId(templateId);
    const nextUrl = templateId
      ? templates.find((t) => t.id === templateId)?.imageUrl ?? null
      : null;
    setEquippedUrl(nextUrl);
    try {
      const body: EquipAvatarRequest = { templateId };
      const updated = await clientApi<CommunityMe>("/community/me/avatar", {
        method: "PUT",
        body: JSON.stringify(body),
      });
      // Trust the server on resolution — guards against a race where
      // the URL changes mid-equip (admin renames bytes-mode slug, etc.)
      setEquippedId(updated.avatarTemplateId);
      setEquippedUrl(updated.avatarUrl);
      router.refresh();
    } catch (err) {
      setEquippedId(prevId);
      setEquippedUrl(prevUrl);
      setError(
        err instanceof ApiFetchError
          ? err.body.message
          : "Couldn't save avatar.",
      );
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="card p-6">
      <header className="flex flex-wrap items-center gap-4">
        <Avatar
          imageUrl={equippedUrl}
          name={initial.nickname ?? "?"}
          size={64}
        />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
            Avatar
          </h2>
          <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
            Pick from the operator&apos;s avatar library. Tap your current
            avatar to clear it and fall back to a monogram.
          </p>
        </div>
        {equippedId ? (
          <button
            type="button"
            className="btn btn-ghost text-xs"
            onClick={() => equip(null)}
            disabled={busyId !== null}
          >
            {busyId === "__clear__" ? "…" : "Clear"}
          </button>
        ) : null}
      </header>

      {error ? (
        <p className="mt-3 text-sm text-[var(--color-negative)]">{error}</p>
      ) : null}

      {templates.length === 0 ? (
        <p className="mt-4 text-sm text-[var(--color-fg-muted)]">
          The operator hasn&apos;t enabled any avatars yet.
        </p>
      ) : (
        <ul
          role="radiogroup"
          aria-label="Avatar"
          className="mt-4 grid grid-cols-4 gap-3 sm:grid-cols-6 md:grid-cols-8"
        >
          {templates.map((t) => {
            const active = equippedId === t.id;
            return (
              <li key={t.id}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={active}
                  aria-label={t.name}
                  onClick={() => equip(t.id)}
                  disabled={busyId !== null}
                  className={
                    "block rounded-full transition focus:outline-none " +
                    (active
                      ? "ring-2 ring-[var(--color-accent)] ring-offset-2 ring-offset-[var(--color-bg)]"
                      : "ring-0 hover:ring-1 hover:ring-[var(--color-border-strong)]")
                  }
                >
                  <Avatar imageUrl={t.imageUrl} name={t.name} size={56} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function ProfileForm({
  initialNickname,
  initialBio,
}: {
  initialNickname: string;
  initialBio: string;
}) {
  const router = useRouter();
  const [nickname, setNickname] = useState(initialNickname);
  const [bio, setBio] = useState(initialBio);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<
    { kind: "ok" | "err"; text: string } | null
  >(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSubmitting(true);
    setMessage(null);

    const trimmedNick = nickname.trim();
    if (trimmedNick && !NICKNAME_RE.test(trimmedNick)) {
      setMessage({
        kind: "err",
        text: "Nickname must be 3–20 letters, numbers, or underscores.",
      });
      setSubmitting(false);
      return;
    }

    try {
      await clientApi("/community/me/profile", {
        method: "PATCH",
        body: JSON.stringify({
          nickname: trimmedNick || null,
          bio: bio.trim() || null,
        }),
      });
      setMessage({ kind: "ok", text: "Saved." });
      router.refresh();
    } catch (err) {
      setMessage({ kind: "err", text: explainError(err) });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="card space-y-4 p-6">
      <h2 className="text-sm uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
        Public profile
      </h2>

      <label className="block">
        <span className="text-xs text-[var(--color-fg-subtle)]">Nickname</span>
        <input
          type="text"
          maxLength={20}
          value={nickname}
          onChange={(e) => setNickname(e.target.value)}
          placeholder="e.g. midlaner_42"
          className="mt-1 w-full rounded-[10px] border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-2 outline-none focus:border-[var(--color-accent)]"
        />
      </label>

      <label className="block">
        <span className="text-xs text-[var(--color-fg-subtle)]">Bio</span>
        <textarea
          maxLength={280}
          rows={3}
          value={bio}
          onChange={(e) => setBio(e.target.value)}
          className="mt-1 w-full rounded-[10px] border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-2 outline-none focus:border-[var(--color-accent)]"
        />
        <span className="mt-1 block text-right text-xs text-[var(--color-fg-subtle)]">
          {bio.length}/280
        </span>
      </label>

      {message ? (
        <p
          role="status"
          className={
            "text-sm " +
            (message.kind === "ok"
              ? "text-[var(--color-positive)]"
              : "text-[var(--color-negative)]")
          }
        >
          {message.text}
        </p>
      ) : null}

      <button type="submit" disabled={submitting} className="btn btn-primary">
        {submitting ? "Saving…" : "Save profile"}
      </button>
    </form>
  );
}

function VisibilityForm({ initial }: { initial: boolean }) {
  const router = useRouter();
  const [ticketsPublic, setTicketsPublic] = useState(initial);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<
    { kind: "ok" | "err"; text: string } | null
  >(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSubmitting(true);
    setMessage(null);
    try {
      await clientApi("/community/me/visibility", {
        method: "PATCH",
        body: JSON.stringify({ ticketsPublic }),
      });
      setMessage({ kind: "ok", text: "Saved." });
      router.refresh();
    } catch (err) {
      setMessage({ kind: "err", text: explainError(err) });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="card space-y-4 p-6">
      <h2 className="text-sm uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
        Visibility
      </h2>

      <label className="flex items-start gap-3">
        <input
          type="checkbox"
          checked={ticketsPublic}
          onChange={(e) => setTicketsPublic(e.target.checked)}
          className="mt-0.5 h-4 w-4"
        />
        <span className="text-sm">
          Show my settled tickets in the community feed and on my public
          profile.
        </span>
      </label>

      {message ? (
        <p
          role="status"
          className={
            "text-sm " +
            (message.kind === "ok"
              ? "text-[var(--color-positive)]"
              : "text-[var(--color-negative)]")
          }
        >
          {message.text}
        </p>
      ) : null}

      <button type="submit" disabled={submitting} className="btn btn-ghost">
        {submitting ? "Saving…" : "Save visibility"}
      </button>
    </form>
  );
}

function explainError(err: unknown): string {
  if (err instanceof ApiFetchError) {
    if (err.body.error === "nickname_taken") {
      return "That nickname is taken.";
    }
    if (err.body.error === "validation_error" || err.body.error === "nickname_invalid") {
      return "Nickname must be 3–20 letters, numbers, or underscores.";
    }
    return err.body.message;
  }
  return "Save failed.";
}
