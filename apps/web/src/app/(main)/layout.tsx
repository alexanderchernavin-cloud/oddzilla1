import { TopBar } from "@/components/shell/top-bar";
import { Sidebar } from "@/components/shell/sidebar";
import { BetSlipRail } from "@/components/shell/bet-slip-rail";
import { MobileBetSlipBar } from "@/components/shell/mobile-bet-slip-bar";
import { MobileDrawersProvider } from "@/components/shell/mobile-drawer-context";
import { MobileShellOverlay } from "@/components/shell/mobile-shell-overlay";
import { ShellContainer } from "@/components/shell/shell-container";
import { MatchPageProvider } from "@/lib/match-page-context";
import { CombiBoostConfigProvider } from "@/lib/combi-boost-config";
import { SportLogosProvider } from "@/lib/sport-logos";
import { NotificationProvider } from "@/lib/notifications";
import { getSessionUser } from "@/lib/auth";
import { serverApi } from "@/lib/server-fetch";
import type { WalletListResponse } from "@oddzilla/types";
import {
  COMBI_BOOST_DEFAULT_CONFIG,
  type CombiBoostConfigLive,
} from "@oddzilla/types/combi-boost";

interface SportsResponse {
  sports: Array<{
    id: number;
    slug: string;
    name: string;
    kind: string;
    active: boolean;
    logoUrl?: string | null;
    brandColor?: string | null;
  }>;
}

export default async function MainLayout({ children }: { children: React.ReactNode }) {
  const [user, sportsRes, liveCountsRes, walletRes, boostRes] = await Promise.all([
    getSessionUser(),
    serverApi<SportsResponse>("/catalog/sports"),
    serverApi<Record<string, number>>("/catalog/live-counts"),
    serverApi<WalletListResponse>("/wallet"),
    serverApi<CombiBoostConfigLive>("/catalog/combi-boost-config"),
  ]);

  const sports = sportsRes?.sports ?? [];
  const liveCounts = liveCountsRes ?? {};
  const wallets = walletRes?.wallets ?? [];
  const combiBoostConfig: CombiBoostConfigLive =
    boostRes ?? COMBI_BOOST_DEFAULT_CONFIG;

  return (
    <MobileDrawersProvider>
      <MatchPageProvider>
      <CombiBoostConfigProvider config={combiBoostConfig}>
      <SportLogosProvider
        entries={sports.map((s) => ({ slug: s.slug, logoUrl: s.logoUrl ?? null }))}
      >
      <NotificationProvider enabled={Boolean(user)}>
      <ShellContainer>
        <TopBar
          signedIn={Boolean(user)}
          user={user ?? undefined}
          wallets={wallets}
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
      </NotificationProvider>
      </SportLogosProvider>
      </CombiBoostConfigProvider>
      </MatchPageProvider>
    </MobileDrawersProvider>
  );
}
