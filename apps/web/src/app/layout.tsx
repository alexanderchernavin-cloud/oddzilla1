import type { Metadata, Viewport } from "next";
import "./globals.css";
import { BetSlipProvider } from "@/lib/bet-slip";
import { BetSlip } from "@/components/bet-slip";

export const metadata: Metadata = {
  title: "Oddzilla",
  description: "Esports sportsbook. CS2, Dota 2, League of Legends, Valorant.",
};

export const viewport: Viewport = {
  themeColor: "#0a0a0a",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-dvh bg-[var(--color-bg)] text-[var(--color-fg)] antialiased">
        <BetSlipProvider>
          {children}
          <BetSlip />
        </BetSlipProvider>
      </body>
    </html>
  );
}
