import { redirect } from "next/navigation";
import type { CommunityMe } from "@oddzilla/types";
import { getSessionUser } from "@/lib/auth";
import { serverApi } from "@/lib/server-fetch";
import { CommunitySettingsForms } from "./forms";

export const dynamic = "force-dynamic";

export default async function CommunitySettingsPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const me = await serverApi<CommunityMe>("/community/me");
  // Logged-in user but the community endpoint failed. Render with safe
  // defaults so the page is still usable; the form will surface the
  // real error on save.
  const initial: CommunityMe = me ?? {
    ticketsPublic: true,
    nickname: null,
    bio: null,
  };

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Community</h1>
      <p className="mt-2 text-sm text-[var(--color-fg-muted)]">
        Pick a public handle, write a short bio, and choose whether your
        settled tickets show up in the community feed.
      </p>
      <CommunitySettingsForms initial={initial} />
    </div>
  );
}
