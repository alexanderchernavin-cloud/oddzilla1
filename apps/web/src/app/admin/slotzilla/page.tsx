import { serverApi } from "@/lib/server-fetch";
import { SlotzillaEditor, type SlotzillaAdminInitial } from "./slotzilla-editor";

export const dynamic = "force-dynamic";

export default async function AdminSlotzillaPage() {
  // Five independent reads; one failing must not blank the rest, so each
  // lands as null and its tab renders a retry.
  const [config, paytables, games, status, corpus] = await Promise.all([
    serverApi<unknown>("/admin/slotzilla/config"),
    serverApi<unknown>("/admin/slotzilla/paytables"),
    serverApi<unknown>("/admin/slotzilla/games"),
    serverApi<unknown>("/admin/slotzilla/status"),
    serverApi<unknown>("/admin/slotzilla/corpus/summary"),
  ]);

  const initial: SlotzillaAdminInitial = { config, paytables, games, status, corpus };

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">SlotZilla</h1>
      <p className="mt-2 text-sm text-[var(--color-fg-muted)]">
        The 15-second live-basketball slot. A spin covers three 5-second windows of
        match clock; each window shows the highest-value play-by-play event inside
        it, and two or three matching reels pay from the active paytable. This page
        holds the switch, the limits and the timing rules, the paytables and their
        calibration against the corpus of finished matches, and the games desk with
        pause, resume and void.
      </p>
      {config === null ? (
        <p className="mt-6 text-sm text-[var(--color-fg-muted)]">
          Couldn&apos;t load the SlotZilla config. The API may be down or the
          SlotZilla routes not deployed yet; each tab below offers a retry.
        </p>
      ) : null}
      <SlotzillaEditor initial={initial} />
    </div>
  );
}
