import Link from "next/link";
import { redirect } from "next/navigation";
import type {
  CommunityMe,
  AvatarTemplateListResponse,
} from "@oddzilla/types";
import { getSessionUser } from "@/lib/auth";
import { serverApi } from "@/lib/server-fetch";
import { CommunitySettingsForms } from "./forms";

export const dynamic = "force-dynamic";

export default async function CommunitySettingsPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const [me, avatars] = await Promise.all([
    serverApi<CommunityMe>("/community/me"),
    serverApi<AvatarTemplateListResponse>("/community/avatars"),
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
    </div>
  );
}
