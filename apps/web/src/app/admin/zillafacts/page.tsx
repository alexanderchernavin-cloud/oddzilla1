import { serverApi } from "@/lib/server-fetch";
import {
  InsightWidgetEditor,
  type InsightConfigDto,
} from "../insight-widgets/insight-widget-editor";

export const dynamic = "force-dynamic";

export default async function AdminZillaFactsPage() {
  const config = await serverApi<InsightConfigDto>("/admin/insight-widgets/zillafacts");

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">ZillaFacts</h1>
      <p className="mt-2 text-sm text-[var(--color-fg-muted)]">
        The streak and in-match pattern cards on the match page — &quot;this team
        has gone over this line in seven straight maps&quot;, and, once a map is
        under way, conditional patterns over the round history.
      </p>
      <p className="mt-2 text-xs text-[var(--color-fg-muted)]">
        Switching a scope off stops the work as well as the render — the
        historical scan is skipped, not just hidden. Changes take effect on
        the next request; the response cache does not delay them.
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
