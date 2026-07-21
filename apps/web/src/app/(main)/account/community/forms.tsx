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
import { useTranslations } from "@/lib/i18n";

const NICKNAME_RE = /^[A-Za-z0-9_]{3,20}$/;

type T = ReturnType<typeof useTranslations>;

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
      <ProfileForm
        initialNickname={initial.nickname ?? ""}
        initialBio={initial.bio ?? ""}
      />
      {/* Visibility lives inside PreferencesForms now (Share to
          Community is the same toggle backed by users.tickets_public).
          The dedicated VisibilityForm has been retired so the three
          privacy toggles are colocated per the Notifications & Privacy
          PRD. */}
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
  const t = useTranslations("accountCommunity");
  const tProfile = useTranslations("publicProfile");
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
          : t("avatarSaveFailed"),
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
            {tProfile("avatar")}
          </h2>
          <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
            {t("avatarExplainer")}
          </p>
        </div>
        {equippedId ? (
          <button
            type="button"
            className="btn btn-ghost text-xs"
            onClick={() => equip(null)}
            disabled={busyId !== null}
          >
            {busyId === "__clear__" ? "…" : t("clear")}
          </button>
        ) : null}
      </header>

      {error ? (
        <p className="mt-3 text-sm text-[var(--color-negative)]">{error}</p>
      ) : null}

      {templates.length === 0 ? (
        <p className="mt-4 text-sm text-[var(--color-fg-muted)]">
          {t("noAvatars")}
        </p>
      ) : (
        <ul
          role="radiogroup"
          aria-label={tProfile("avatar")}
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
  const t = useTranslations("accountCommunity");
  const tProfile = useTranslations("publicProfile");
  const tCommon = useTranslations("common");
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
        text: t("nicknameInvalid"),
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
      setMessage({ kind: "ok", text: t("saved") });
      router.refresh();
    } catch (err) {
      setMessage({ kind: "err", text: explainError(err, t) });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="card space-y-4 p-6">
      <h2 className="text-sm uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
        {tProfile("title")}
      </h2>

      <label className="block">
        <span className="text-xs text-[var(--color-fg-subtle)]">
          {tProfile("nickname")}
        </span>
        <input
          type="text"
          maxLength={20}
          value={nickname}
          onChange={(e) => setNickname(e.target.value)}
          placeholder={t("nicknamePlaceholder")}
          className="mt-1 w-full rounded-[10px] border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-2 outline-none focus:border-[var(--color-accent)]"
        />
      </label>

      <label className="block">
        <span className="text-xs text-[var(--color-fg-subtle)]">
          {tProfile("bio")}
        </span>
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
        {submitting ? tCommon("saving") : t("saveProfile")}
      </button>
    </form>
  );
}


function explainError(err: unknown, t: T): string {
  if (err instanceof ApiFetchError) {
    if (err.body.error === "nickname_taken") {
      return t("nicknameTaken");
    }
    if (err.body.error === "validation_error" || err.body.error === "nickname_invalid") {
      return t("nicknameInvalid");
    }
    return err.body.message;
  }
  return t("saveFailed");
}
