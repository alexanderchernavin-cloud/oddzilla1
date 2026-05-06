import { notFound } from "next/navigation";
import type { CommunityProfile, Currency } from "@oddzilla/types";
import { isCurrency } from "@oddzilla/types";
import { serverApi } from "@/lib/server-fetch";
import { CurrencyTabs } from "@/components/community/currency-tabs";

export const dynamic = "force-dynamic";

export default async function PublicProfilePage({
  params,
  searchParams,
}: {
  params: Promise<{ nickname: string }>;
  searchParams: Promise<{ currency?: string }>;
}) {
  const { nickname } = await params;
  const { currency: rawCurrency } = await searchParams;
  const currency: Currency =
    rawCurrency && isCurrency(rawCurrency) ? rawCurrency : "USDT";

  const profile = await serverApi<CommunityProfile>(
    `/community/users/${encodeURIComponent(nickname)}/profile?currency=${currency}`,
  );
  if (!profile) notFound();

  const joined = new Date(profile.joinedAt).toLocaleDateString("en-US", {
    month: "short",
    year: "numeric",
  });

  return (
    <div>
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">
          {profile.nickname}
        </h1>
        <p className="text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
          Joined {joined}
        </p>
        {profile.bio ? (
          <p className="mt-2 max-w-prose text-sm">{profile.bio}</p>
        ) : null}
      </header>

      <div className="mt-6">
        <CurrencyTabs nickname={profile.nickname} active={currency} />
      </div>

      <section className="mt-6 grid gap-3 sm:grid-cols-4">
        <Stat label="Settled" value={String(profile.stats.settledTickets)} />
        <Stat label="Wins" value={String(profile.stats.wins)} />
        <Stat label="Win rate" value={`${profile.stats.winRatePct}%`} />
        <Stat
          label="ROI"
          value={`${profile.stats.roiPct >= 0 ? "+" : ""}${profile.stats.roiPct}%`}
        />
      </section>

      <section className="mt-8">
        <h2 className="text-sm uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
          Recent tickets
        </h2>
        <div className="card mt-3 p-6 text-sm text-[var(--color-fg-muted)]">
          Recent tickets land in Phase 10.2 once the community feed
          projection is live.
        </div>
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="card p-4">
      <dt className="text-xs uppercase tracking-[0.15em] text-[var(--color-fg-subtle)]">
        {label}
      </dt>
      <dd className="mt-1 text-lg font-semibold">{value}</dd>
    </div>
  );
}
