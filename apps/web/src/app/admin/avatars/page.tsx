import { serverApi } from "@/lib/server-fetch";
import type { AvatarTemplateAdminListResponse } from "@oddzilla/types";
import { AvatarManager } from "./avatar-manager";

export const dynamic = "force-dynamic";

export default async function AdminAvatarsPage() {
  // Server-fetch the full list (active + hidden). The client manager
  // takes the initial set, then re-fetches via the same endpoint after
  // each mutation. Keeping the SSR fetch here means the page renders
  // populated even before client JS hydrates, which matters for the
  // admin grid where the operator typically lands and immediately
  // scans for a row.
  const data = await serverApi<AvatarTemplateAdminListResponse>(
    "/admin/avatars",
  );

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Avatars</h1>
      <p className="mt-2 text-sm text-[var(--color-fg-muted)]">
        Manage the avatar template library. Static seed rows live under{" "}
        <code>apps/web/public/avatars/</code> and can&apos;t have their image
        bytes replaced — to swap art on a seed, hide the row and upload a
        new one. Operator uploads store bytes in Postgres and serve via{" "}
        <code>/api/community/avatars/&lt;slug&gt;/image</code>.
      </p>
      <AvatarManager initialTemplates={data?.templates ?? []} />
    </div>
  );
}
