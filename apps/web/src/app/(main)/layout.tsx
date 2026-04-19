import { TopBar } from "@/components/shell/top-bar";
import { Sidebar } from "@/components/shell/sidebar";
import { BetSlipRail } from "@/components/shell/bet-slip-rail";
import { MobileBetSlipBar } from "@/components/shell/mobile-bet-slip-bar";
import { MobileDrawersProvider } from "@/components/shell/mobile-drawer-context";
import { MobileShellOverlay } from "@/components/shell/mobile-shell-overlay";
import { ShellContainer } from "@/components/shell/shell-container";
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
    <MobileDrawersProvider>
      <ShellContainer>
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
        {/*
          The main cell spans 1fr so the shell fills any viewport, but the
          inner content is capped + centered so ultra-wide screens get
          balanced whitespace on both sides. Pages apply their own padding
          and narrower caps where they need them.
        */}
        <main className="oz-main">
          <div className="oz-main-inner">{children}</div>
        </main>
        <BetSlipRail />
        <MobileShellOverlay />
        <MobileBetSlipBar />
      </ShellContainer>
    </MobileDrawersProvider>
  );
}
