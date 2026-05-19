import { notFound } from "next/navigation";
import Link from "next/link";
import { serverApi } from "@/lib/server-fetch";
import {
  PromoVisibilityTree,
  type SportRow,
  type Override,
} from "./tree-client";

export const dynamic = "force-dynamic";

interface SportsResponse {
  globalZillaflash: Override | null;
  globalCombiBoost: Override | null;
  entries: SportRow[];
}

interface UserDetailLite {
  user: { id: string; email: string; role: string };
}

export default async function PromoVisibilityPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [detail, data] = await Promise.all([
    serverApi<UserDetailLite>(`/admin/users/${id}`),
    serverApi<SportsResponse>(`/admin/users/${id}/promo-visibility/sports`),
  ]);
  if (!detail) notFound();
  if (!data) {
    return (
      <p style={{ color: "var(--color-fg-muted)" }}>
        Couldn&apos;t load promo-visibility configuration.
      </p>
    );
  }
  const backHref = `/admin/users/${id}`;
  return (
    <div>
      <nav className="text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
        <Link href="/admin/users" className="hover:text-[var(--color-fg)]">
          Bettors
        </Link>{" "}
        /{" "}
        <Link href={backHref} className="hover:text-[var(--color-fg)]">
          {detail.user.email}
        </Link>{" "}
        /{" "}
        <span className="normal-case tracking-normal text-[var(--color-fg)]">
          Promo visibility
        </span>
      </nav>

      <h1 className="mt-2 text-2xl font-semibold tracking-tight">
        Promo visibility
      </h1>
      <p
        style={{
          fontSize: 13,
          color: "var(--color-fg-muted)",
          marginTop: 8,
          marginBottom: 16,
          maxWidth: 760,
        }}
      >
        Per-bettor visibility for ZillaFlash (boosted-odds flash cards) and
        CombiBoost (combo-bet multiplier). Default is shown — toggling a row
        OFF hides the promo for this bettor at that scope (and everything
        below, unless a child row overrides). Cascade: <code>match</code>{" "}
        &rarr; <code>tournament</code> &rarr; <code>sport</code> &rarr;{" "}
        <code>global</code> (first explicit row wins). Placement re-checks
        on the server — even a stale client can&apos;t claim a hidden promo.
      </p>
      <PromoVisibilityTree
        userId={id}
        globalZillaflash={data.globalZillaflash}
        globalCombiBoost={data.globalCombiBoost}
        sports={data.entries}
      />
    </div>
  );
}
