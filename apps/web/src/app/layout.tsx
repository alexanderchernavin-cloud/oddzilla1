import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { Instrument_Serif, Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { BetSlipProvider } from "@/lib/bet-slip";

const geist = Geist({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600"],
  variable: "--font-geist",
  display: "swap",
});

const geistMono = Geist_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-geist-mono",
  display: "swap",
});

const instrumentSerif = Instrument_Serif({
  subsets: ["latin"],
  weight: ["400"],
  style: ["normal", "italic"],
  variable: "--font-instrument-serif",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Oddzilla — Esports sportsbook",
  description:
    "Premium, quiet esports sportsbook. CS2, Dota 2, League of Legends, Valorant.",
};

export const viewport: Viewport = {
  themeColor: "#0b0b0c",
  width: "device-width",
  initialScale: 1,
};

// Runs before body paints — sets `data-theme` on <html> from
// `oz:theme` in localStorage so users who picked light don't see a
// dark flash on every navigation. We deliberately do NOT declare
// `data-theme` on the JSX <html> element below: if we did, React
// would reconcile the attribute back to its server-rendered value
// during hydration and the script's choice would be lost. With no
// JSX attribute, hydration leaves the DOM alone, and CSS's :root
// rules supply the dark default until the script runs. Storage key
// must match `apps/web/src/components/shell/theme-toggle.tsx`.
const themeBootScript = `(function(){try{var t=localStorage.getItem("oz:theme");if(t==="light"||t==="dark"){document.documentElement.setAttribute("data-theme",t);}}catch(e){}})();`;

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // The CSP-emitting middleware mints a per-request nonce and pushes it
  // into the request headers. Without applying it to the inline boot
  // script the browser would refuse to execute (CSP nonce-mode forbids
  // 'unsafe-inline'), and users would briefly see a dark flash on a
  // light-themed page before hydration patched up.
  const nonce = (await headers()).get("x-csp-nonce") ?? undefined;

  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geist.variable} ${geistMono.variable} ${instrumentSerif.variable}`}
    >
      <head>
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: themeBootScript }} />
      </head>
      <body>
        <BetSlipProvider>{children}</BetSlipProvider>
      </body>
    </html>
  );
}
