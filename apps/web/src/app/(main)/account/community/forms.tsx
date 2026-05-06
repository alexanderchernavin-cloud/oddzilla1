"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { CommunityMe } from "@oddzilla/types";
import { clientApi, ApiFetchError } from "@/lib/api-client";

const NICKNAME_RE = /^[A-Za-z0-9_]{3,20}$/;

export function CommunitySettingsForms({ initial }: { initial: CommunityMe }) {
  return (
    <div className="mt-8 grid gap-6 md:grid-cols-2">
      <ProfileForm
        initialNickname={initial.nickname ?? ""}
        initialBio={initial.bio ?? ""}
      />
      <VisibilityForm initial={initial.ticketsPublic} />
    </div>
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
