import { notFound } from "next/navigation";
import Link from "next/link";
import { serverApi } from "@/lib/server-fetch";
import {
  BettorOddsAdjustmentTree,
  type SportRow,
  type Override,
} from "./tree-client";

export const dynamic = "force-dynamic";

interface SportsResponse {
  global: Override | null;
  entries: SportRow[];
}

interface UserDetailLite {
  user: { id: string; email: string; role: string };
}

export default async function BettorOddsAdjustmentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  // The summary endpoint is enough for breadcrumb — the user detail
  // endpoint already exists and returns email + role. One round-trip
  // each in parallel so the page renders in a single render pass.
  const [detail, data] = await Promise.all([
    serverApi<UserDetailLite>(`/admin/users/${id}`),
    serverApi<SportsResponse>(`/admin/users/${id}/odds-adjustment/sports`),
  ]);
  if (!detail) notFound();
  if (!data) {
    return (
      <p style={{ color: "var(--color-fg-muted)" }}>
        Couldn&apos;t load odds-adjustment configuration.
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
          Odds adjustment
        </span>
      </nav>

      <h1 className="mt-2 text-2xl font-semibold tracking-tight">
        Odds adjustment
      </h1>
      <p
        style={{
          fontSize: 13,
          color: "var(--color-fg-muted)",
          marginTop: 8,
          marginBottom: 16,
          maxWidth: 720,
        }}
      >
        Per-bettor odds delta in basis points. Positive bumps the bettor&apos;s
        price up (less house margin); negative widens the house margin. Cascade
        per leg: <code>match</code> &rarr; <code>tournament</code> &rarr;{" "}
        <code>sport</code> &rarr; <code>global</code> (first override wins).
        The result is clamped at fair odds (1 / probability) so an over-generous
        bump can never publish a negative-margin price; the lower clamp is 1.01.
        Range: ±90.00% (±9000 bp).
      </p>
      <BettorOddsAdjustmentTree
        userId={id}
        global={data.global}
        sports={data.entries}
      />
    </div>
  );
}
