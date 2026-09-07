import { serverApi } from "@/lib/server-fetch";
import {
  InsightWidgetEditor,
  type InsightConfigDto,
} from "../insight-widgets/insight-widget-editor";

export const dynamic = "force-dynamic";

export default async function AdminZillaTipsPage() {
  const config = await serverApi<InsightConfigDto>("/admin/insight-widgets/zillatips");

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">ZillaTips</h1>
      <p className="mt-2 text-sm text-[var(--color-fg-muted)]">
        The per-market historical hint on the match page: for each outcome,
        how a flat stake on the same market would have gone over the team&apos;s
        last five matches with the same market signature. Only tips clearing
        the ROI floor are shown, and the badge tier rises with the number.
      </p>
      <p className="mt-2 text-xs text-[var(--color-fg-muted)]">
        Switching a scope off stops the work as well as the render — the
        per-match historical scan is skipped, not just hidden. Changes take
        effect on the next request; the 5-minute response cache does not
        delay them.
      </p>
      {config ? (
        <InsightWidgetEditor initial={config} />
      ) : (
        <p className="mt-6 text-sm text-[var(--color-fg-muted)]">
          Couldn&apos;t load the current config. Reload the page or check the
          API service status.
        </p>
      )}
    </div>
  );
}
