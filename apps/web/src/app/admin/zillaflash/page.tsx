import { serverApi } from "@/lib/server-fetch";
import {
  ZillaflashConfigEditor,
  type ZillaflashConfigDto,
} from "./zillaflash-config-editor";

export const dynamic = "force-dynamic";

export default async function AdminZillaflashPage() {
  const config = await serverApi<ZillaflashConfigDto>(
    "/admin/zillaflash-config",
  );

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">ZillaFlash</h1>
      <p className="mt-2 text-sm text-[var(--color-fg-muted)]">
        Boosted-odds promo rotation. The engine keeps two prematch and two
        live offers warm at all times; this page controls how long each
        offer is visible before it rotates to a fresh fixture. Shorter
        windows make the boost feel more urgent at the cost of more
        churn through the candidate pool.
      </p>
      <p className="mt-2 text-xs text-[var(--color-fg-muted)]">
        Edits propagate to the next rotation tick (within ~5 seconds) —
        no api restart needed.
      </p>
      {config ? (
        <ZillaflashConfigEditor initial={config} />
      ) : (
        <p className="mt-6 text-sm text-[var(--color-fg-muted)]">
          Couldn&apos;t load the current config. Reload the page or check the
          API service status.
        </p>
      )}
    </div>
  );
}
