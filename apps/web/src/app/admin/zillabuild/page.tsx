import { serverApi } from "@/lib/server-fetch";
import {
  ZillabuildConfigEditor,
  type ZillabuildConfigDto,
} from "./zillabuild-config-editor";

export const dynamic = "force-dynamic";

export default async function AdminZillabuildPage() {
  const config = await serverApi<ZillabuildConfigDto>("/admin/zillabuild-config");

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">ZillaBuild</h1>
      <p className="mt-2 text-sm text-[var(--color-fg-muted)]">
        Pre-built BetBuilder combos surfaced as cards on the prematch match
        page. For each match where BetBuilder is available, the engine
        assembles a few random single-map combos (2–4 legs each), persists
        the composition, and re-quotes Oddin for fresh odds on every page
        open. Use the controls below to decide which markets to consider,
        how many cards to show per map, and the minimum combined odds a card
        must clear to be worth showing.
      </p>
      <p className="mt-2 text-xs text-[var(--color-fg-muted)]">
        Turning the feature off hides the section immediately. Other edits
        take effect within one cache window (per-match), and apply as cards
        regenerate.
      </p>
      {config ? (
        <ZillabuildConfigEditor initial={config} />
      ) : (
        <p className="mt-6 text-sm text-[var(--color-fg-muted)]">
          Couldn&apos;t load the current config. Reload the page or check the
          API service status.
        </p>
      )}
    </div>
  );
}
