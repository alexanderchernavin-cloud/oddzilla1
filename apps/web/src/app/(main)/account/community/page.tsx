import Link from "next/link";
import { redirect } from "next/navigation";
import type {
  CommunityMe,
  AvatarTemplateListResponse,
  PreferencesResponse,
} from "@oddzilla/types";
import { getSessionUser } from "@/lib/auth";
import { serverApi } from "@/lib/server-fetch";
import { CommunitySettingsForms } from "./forms";
import { PreferencesForms } from "./preferences-forms";

export const dynamic = "force-dynamic";

// Defaults shown when the API returns null (auth blip, fresh user
// with no row yet). They mirror the BE column defaults exactly — see
// notifications.ts DEFAULT_PREFS.
const DEFAULT_PREFS: PreferencesResponse = {
  notifications: {
    picksCopied: true,
    newFollowers: true,
    competitionUpdates: false,
    competitionUpdatesManuallySet: false,
    communityHighlights: true,
    achievementsRewards: true,
    betSettlements: true,
  },
  privacy: {
    sharePublicly: true,
    showWinLossRecord: true,
    allowProfileDiscovery: true,
  },
};

export default async function CommunitySettingsPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const [me, avatars, prefs] = await Promise.all([
    serverApi<CommunityMe>("/community/me"),
    serverApi<AvatarTemplateListResponse>("/community/avatars"),
    serverApi<PreferencesResponse>("/community/me/preferences"),
  ]);
  // Logged-in user but the community endpoint failed. Render with safe
  // defaults so the page is still usable; the form will surface the
  // real error on save.
  const initial: CommunityMe = me ?? {
    ticketsPublic: true,
    nickname: null,
    bio: null,
    avatarTemplateId: null,
    avatarUrl: null,
  };
  const templates = avatars?.templates ?? [];
  const initialPrefs: PreferencesResponse = prefs ?? DEFAULT_PREFS;

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Community</h1>
      <p className="mt-2 text-sm text-[var(--color-fg-muted)]">
        Pick a public handle, write a short bio, choose your avatar, and
        decide whether your settled tickets show up in the community feed.
      </p>

      {initial.nickname ? (
        <div className="mt-4 flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-[10px] border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-4 py-3 text-sm">
          <span className="text-[var(--color-fg-subtle)]">
            Your public profile:
          </span>
          <Link
            href={`/u/${encodeURIComponent(initial.nickname)}`}
            className="font-medium text-[var(--color-accent)] hover:underline"
          >
            /u/{initial.nickname}
          </Link>
        </div>
      ) : null}

      <CommunitySettingsForms initial={initial} templates={templates} />
      <div className="mt-8">
        <PreferencesForms initial={initialPrefs} />
      </div>
    </div>
  );
}
