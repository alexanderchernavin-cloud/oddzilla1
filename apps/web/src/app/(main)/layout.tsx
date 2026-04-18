import { TopBar } from "@/components/shell/top-bar";
import { Sidebar } from "@/components/shell/sidebar";
import { BetSlipRail } from "@/components/shell/bet-slip-rail";
import { getSessionUser } from "@/lib/auth";
import { serverApi } from "@/lib/server-fetch";
import { fromMicro } from "@oddzilla/types/money";

interface SportsResponse {
  sports: Array<{ id: number; slug: string; name: string; kind: string; active: boolean }>;
}

interface WalletResponse {
  currency: string;
  balanceMicro: string;
  lockedMicro: string;
  availableMicro: string;
}

export default async function MainLayout({ children }: { children: React.ReactNode }) {
  const [user, sportsRes, liveCountsRes, walletRes] = await Promise.all([
    getSessionUser(),
    serverApi<SportsResponse>("/catalog/sports"),
    serverApi<Record<string, number>>("/catalog/live-counts"),
    serverApi<WalletResponse>("/wallet"),
  ]);

  const sports = sportsRes?.sports ?? [];
  const liveCounts = liveCountsRes ?? {};
  const balanceUsd = walletRes ? fromMicro(BigInt(walletRes.availableMicro)) : undefined;

  return (
    <div
      className="oz-shell"
      style={{
        display: "grid",
        gridTemplateColumns: "240px 1fr 340px",
        gridTemplateRows: "60px 1fr",
        gridTemplateAreas: `"top top top" "side main rail"`,
        minHeight: "100vh",
        background: "var(--bg)",
        color: "var(--fg)",
      }}
    >
      <TopBar
        signedIn={Boolean(user)}
        user={user ?? undefined}
        balanceUsd={balanceUsd}
      />
      <Sidebar
        sports={sports}
        liveCounts={liveCounts}
        signedIn={Boolean(user)}
        isAdmin={user?.role === "admin"}
      />
      <main style={{ gridArea: "main", overflow: "auto", minWidth: 0 }}>{children}</main>
      <BetSlipRail />
    </div>
  );
}
