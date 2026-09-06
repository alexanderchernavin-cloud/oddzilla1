import { serverApi } from "@/lib/server-fetch";
import {
  ComboZillaEditor,
  type AdminComboZillaResponse,
} from "./combozilla-editor";

export const dynamic = "force-dynamic";

export default async function AdminComboZillaPage() {
  const data = await serverApi<AdminComboZillaResponse>("/admin/combozilla-config");

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">ComboZilla</h1>
      <p className="mt-2 text-sm text-[var(--color-fg-muted)]">
        The lobby&apos;s prebuilt 3-fold carousel: four cards (Safe /
        Challenging / Risky / Ultimate) assembled from the prematch offer.
        This page decides WHICH matches may feed it. By default a match
        qualifies when its tournament carries one of the eligible risk
        tiers; a rule on a sport, category or tournament overrides that in
        either direction, most specific first (tournament beats category
        beats sport). The odds bands, the same-sport requirement and the
        per-leg Combi Boost floor are fixed in the builder.
      </p>
      <p className="mt-2 text-xs text-[var(--color-fg-muted)]">
        Edits reach the lobby on its next render. Signed-out renders share a
        3-second cache, which every save here clears.
      </p>
      {data ? (
        <ComboZillaEditor initial={data} />
      ) : (
        <p className="mt-6 text-sm text-[var(--color-fg-muted)]">
          Couldn&apos;t load the current config. Reload the page or check the
          API service status.
        </p>
      )}
    </div>
  );
}
