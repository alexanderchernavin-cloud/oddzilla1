import { TopBar } from "@/components/shell/top-bar";
import { Sidebar } from "@/components/shell/sidebar";
import { BetSlipRail } from "@/components/shell/bet-slip-rail";
import { MobileBetSlipBar } from "@/components/shell/mobile-bet-slip-bar";
import { MobileDrawersProvider } from "@/components/shell/mobile-drawer-context";
import { MobileShellOverlay } from "@/components/shell/mobile-shell-overlay";
import { ShellContainer } from "@/components/shell/shell-container";
import { SidePanels } from "@/components/shell/side-panels";
import { TopBarSearch } from "@/components/shell/top-bar-search";
import { ZillapassIndicator } from "@/components/shell/zillapass-indicator";
import { EmailVerificationBanner } from "@/components/shell/email-verification-banner";
import { SupportWidget } from "@/components/support/support-widget";
import { CookieBanner } from "@/components/shell/cookie-banner";
import { ShellFooter } from "@/components/shell/shell-footer";
import { MatchPageProvider } from "@/lib/match-page-context";
import { SidePanelProvider } from "@/lib/side-panel";
import { CombiBoostConfigProvider } from "@/lib/combi-boost-config";
import { SportLogosProvider } from "@/lib/sport-logos";
import { NotificationProvider } from "@/lib/notifications";
import { SessionUserProvider } from "@/lib/session-user";
import { WsSessionSync } from "@/lib/ws-session-sync";
import { WalletProvider } from "@/lib/wallets";
import { ZillapassProvider } from "@/lib/zillapass";
import { cookies } from "next/headers";
import { getSessionUser } from "@/lib/auth";
import { ListLayoutProvider } from "@/lib/list-layout";
// From the PLAIN module, not lib/list-layout.tsx: that file is "use
// client", and a function imported from it into this server component
// arrives as a client-reference proxy that throws when called — on the
// request, not at build. See lib/list-layout-cookie.ts.
import { LIST_LAYOUT_COOKIE, parseListLayoutCookie } from "@/lib/list-layout-cookie";
import { serverApi } from "@/lib/server-fetch";
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
    /** Operator pin position for the rail (migration 0103); null = unpinned. */
    displayOrder?: number | null;
  }>;
}

export default async function MainLayout({ children }: { children: React.ReactNode }) {
  // /wallet used to be in this fan-out and ran on every page render.
  // The 2026-05-11 load test traced its 5000-VU storefront crash to
  // the per-render fan-out fired by this layout (see docs/LOADTEST.md);
  // we moved the wallet fetch into a client-side WalletProvider so
  // anonymous renders don't fire the request at all and authed renders
  // return to the pool faster. The wallet pill on the top bar shows a
  // brief skeleton before the first client fetch resolves.
  const [user, sportsRes, liveCountsRes, boostRes, cookieStore] = await Promise.all([
    getSessionUser(),
    serverApi<SportsResponse>("/catalog/sports"),
    serverApi<Record<string, number>>("/catalog/live-counts"),
    serverApi<CombiBoostConfigLive>("/catalog/combi-boost-config"),
    cookies(),
  ]);
  // The match list's Default / Pro preference, so SSR renders the layout
  // the bettor chose instead of flipping to it after hydration. Read
  // here rather than in each list page: every list is under this layout,
  // and this render already reads the request's cookies for the session.
  const initialListLayout = parseListLayoutCookie(
    cookieStore.get(LIST_LAYOUT_COOKIE)?.value,
  );

  const sports = sportsRes?.sports ?? [];
  const liveCounts = liveCountsRes ?? {};
  const combiBoostConfig: CombiBoostConfigLive =
    boostRes ?? COMBI_BOOST_DEFAULT_CONFIG;

  return (
    <MobileDrawersProvider>
      <SessionUserProvider userId={user?.id ?? null}>
      <WsSessionSync />
      <MatchPageProvider>
      <SidePanelProvider>
      <CombiBoostConfigProvider config={combiBoostConfig}>
      <SportLogosProvider
        entries={sports.map((s) => ({ slug: s.slug, logoUrl: s.logoUrl ?? null }))}
      >
      <NotificationProvider enabled={Boolean(user)}>
      <WalletProvider signedIn={Boolean(user)}>
      <ZillapassProvider>
      <ShellContainer>
        <TopBar
          signedIn={Boolean(user)}
          user={user ?? undefined}
        />
        <Sidebar
          sports={sports}
          liveCounts={liveCounts}
          signedIn={Boolean(user)}
          isAdmin={user?.role === "admin"}
          userSportOrder={user?.sportOrder ?? null}
          userHiddenSports={user?.hiddenSports ?? null}
        />
        {/*
          The main cell spans 1fr so the shell fills any viewport, but the
          inner content is capped + centered so ultra-wide screens get
          balanced whitespace on both sides. Pages apply their own padding
          and narrower caps where they need them.
        */}
        <main className="oz-main">
          <div className="oz-main-inner">
            <div className="oz-shell-search">
              <div className="oz-shell-search-row">
                <TopBarSearch />
                <ZillapassIndicator />
              </div>
            </div>
            {user && !user.emailVerifiedAt && (
              <EmailVerificationBanner email={user.email} />
            )}
            <ListLayoutProvider initial={initialListLayout}>{children}</ListLayoutProvider>
            {/* Absorbs the leftover height on pages shorter than the
                viewport so the footer stays at the bottom of the page
                instead of floating up under the content. Collapses to
                zero on tall pages — see `.oz-main-spacer` in
                globals.css. */}
            <div className="oz-main-spacer" aria-hidden />
            <ShellFooter />
          </div>
        </main>
        <BetSlipRail />
        <MobileShellOverlay />
        <MobileBetSlipBar />
        <SupportWidget />
        <CookieBanner />
      </ShellContainer>
      {/* Two iframes pinned to the empty bands flanking the centered
          shell on wide viewports. Hidden via CSS below 2000px (synced
          with the 1/2-column toggle) so they never overlap the shell
          on a normal laptop / 1080p monitor. */}
      <SidePanels />
      </ZillapassProvider>
      </WalletProvider>
      </NotificationProvider>
      </SportLogosProvider>
      </CombiBoostConfigProvider>
      </SidePanelProvider>
      </MatchPageProvider>
      </SessionUserProvider>
    </MobileDrawersProvider>
  );
}
