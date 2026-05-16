"use client";

// Notification Settings + Privacy & Sharing accordions on the
// /account/community page.
//
// Both panels back onto the same /community/me/preferences endpoint
// (PATCH accepts partial updates across both halves). Optimistic
// toggle: flip local state, fire the request, revert on error. The
// router.refresh() call on success keeps the SSR'd initial values
// fresh for re-mounts.
//
// The shape mirrors the existing VisibilityForm pattern from
// forms.tsx — same Tailwind primitives, same status-toast
// convention. Replaces VisibilityForm so the three privacy toggles
// (Share to Community / Show W/L / Allow Discovery) are colocated
// per the PRD.

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { PreferencesResponse } from "@oddzilla/types";
import { ApiFetchError, clientApi } from "@/lib/api-client";

interface PreferencesFormsProps {
  initial: PreferencesResponse;
}

export function PreferencesForms({ initial }: PreferencesFormsProps) {
  return (
    <div className="grid gap-6 md:grid-cols-2">
      <NotificationSettingsForm initial={initial} />
      <PrivacySharingForm initial={initial} />
    </div>
  );
}

// ─── Toggle row primitive ───────────────────────────────────────────────────

interface ToggleRowProps {
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}

// Plain checkbox styled as an iOS-style switch via the parent label's
// flex layout. Keeps the toggle accessible (real input, real label
// click target) without pulling in a primitives library.
function ToggleRow({
  label,
  description,
  checked,
  disabled,
  onChange,
}: ToggleRowProps) {
  return (
    <label className="flex items-start gap-3 py-2 cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 cursor-pointer accent-[var(--color-accent)]"
      />
      <span className="flex-1">
        <span className="block text-sm font-medium">{label}</span>
        <span className="block text-xs text-[var(--color-fg-subtle)] mt-0.5">
          {description}
        </span>
      </span>
    </label>
  );
}

// ─── Notification Settings ──────────────────────────────────────────────────

function NotificationSettingsForm({ initial }: { initial: PreferencesResponse }) {
  const router = useRouter();
  const [prefs, setPrefs] = useState(initial.notifications);
  const [message, setMessage] = useState<
    { kind: "ok" | "err"; text: string } | null
  >(null);

  async function patch(
    key: keyof typeof prefs,
    value: boolean,
  ): Promise<void> {
    // Optimistic flip. The form snapshots the previous value so we can
    // revert if the network call fails — recreating the previous
    // state from the fresh `prefs` here would be racy.
    const prior = prefs[key];
    setPrefs((p) => ({ ...p, [key]: value }));
    setMessage(null);
    try {
      const next = await clientApi<PreferencesResponse>(
        "/community/me/preferences",
        {
          method: "PATCH",
          body: JSON.stringify({ notifications: { [key]: value } }),
        },
      );
      setPrefs(next.notifications);
      router.refresh();
    } catch (err) {
      setPrefs((p) => ({ ...p, [key]: prior }));
      setMessage({ kind: "err", text: explain(err) });
    }
  }

  return (
    <section className="card space-y-1 p-6">
      <header className="flex items-center justify-between">
        <h2 className="text-sm uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
          Notification Settings
        </h2>
      </header>
      <ToggleRow
        label="Picks Copied"
        description="Someone copies or is inspired by your bet"
        checked={prefs.picksCopied}
        onChange={(v) => void patch("picksCopied", v)}
      />
      <ToggleRow
        label="New Followers"
        description="Someone starts following you"
        checked={prefs.newFollowers}
        onChange={(v) => void patch("newFollowers", v)}
      />
      <ToggleRow
        label="Competition Updates"
        description={
          prefs.competitionUpdatesManuallySet
            ? "Leaderboard changes and deadlines"
            : "Auto-enables on your first competition join"
        }
        checked={prefs.competitionUpdates}
        onChange={(v) => void patch("competitionUpdates", v)}
      />
      <ToggleRow
        label="Community Highlights"
        description="Likes on your analyses, weekly digests"
        checked={prefs.communityHighlights}
        onChange={(v) => void patch("communityHighlights", v)}
      />
      <ToggleRow
        label="Achievements & Rewards"
        description="Challenge completions, achievements, level ups"
        checked={prefs.achievementsRewards}
        onChange={(v) => void patch("achievementsRewards", v)}
      />
      <ToggleRow
        label="Bet Settlements"
        description="When your bet wins or you cash out"
        checked={prefs.betSettlements}
        onChange={(v) => void patch("betSettlements", v)}
      />
      {message ? (
        <p
          role="status"
          className={
            "text-sm pt-2 " +
            (message.kind === "ok"
              ? "text-[var(--color-positive)]"
              : "text-[var(--color-negative)]")
          }
        >
          {message.text}
        </p>
      ) : null}
    </section>
  );
}

// ─── Privacy & Sharing ──────────────────────────────────────────────────────

function PrivacySharingForm({ initial }: { initial: PreferencesResponse }) {
  const router = useRouter();
  const [priv, setPriv] = useState(initial.privacy);
  const [message, setMessage] = useState<
    { kind: "ok" | "err"; text: string } | null
  >(null);

  async function patch(
    key: keyof typeof priv,
    value: boolean,
  ): Promise<void> {
    const prior = priv[key];
    setPriv((p) => ({ ...p, [key]: value }));
    setMessage(null);
    try {
      const next = await clientApi<PreferencesResponse>(
        "/community/me/preferences",
        {
          method: "PATCH",
          body: JSON.stringify({ privacy: { [key]: value } }),
        },
      );
      setPriv(next.privacy);
      router.refresh();
    } catch (err) {
      setPriv((p) => ({ ...p, [key]: prior }));
      setMessage({ kind: "err", text: explain(err) });
    }
  }

  return (
    <section className="card space-y-1 p-6">
      <header className="flex items-center justify-between">
        <h2 className="text-sm uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
          Privacy &amp; Sharing
        </h2>
      </header>
      <ToggleRow
        label="Share to Community"
        description="Make your settled tickets visible in the community feed"
        checked={priv.sharePublicly}
        onChange={(v) => void patch("sharePublicly", v)}
      />
      <ToggleRow
        label="Show Win/Loss Record"
        description="Display W/L badges on your public profile"
        checked={priv.showWinLossRecord}
        onChange={(v) => void patch("showWinLossRecord", v)}
      />
      <ToggleRow
        label="Allow Profile Discovery"
        description="Let other users find you via search"
        checked={priv.allowProfileDiscovery}
        onChange={(v) => void patch("allowProfileDiscovery", v)}
      />
      {message ? (
        <p
          role="status"
          className={
            "text-sm pt-2 " +
            (message.kind === "ok"
              ? "text-[var(--color-positive)]"
              : "text-[var(--color-negative)]")
          }
        >
          {message.text}
        </p>
      ) : null}
    </section>
  );
}

// ─── Error helper ───────────────────────────────────────────────────────────

function explain(err: unknown): string {
  if (err instanceof ApiFetchError) {
    if (err.body.error === "preference_invalid") return "No changes to save.";
    return err.body.message || "Save failed.";
  }
  return "Network error. Try again.";
}
