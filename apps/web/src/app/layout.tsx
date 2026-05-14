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
  // Pins the absolute base URL Next.js uses when resolving the
  // auto-emitted icon / opengraph-image / twitter:image tags. Without
  // it Next falls back to http://localhost:3000, so the production
  // HTML ships <meta og:image content="http://localhost:3000/..."> —
  // breaks every link preview (Twitter / Facebook / Slack / Discord)
  // and leaks a dev-port hint into prod.
  metadataBase: new URL("https://oddzilla.cc"),
  title: "Oddzilla — Esports sportsbook",
  description:
    "Premium, quiet esports sportsbook. CS2, Dota 2, League of Legends, Valorant.",
  // Next.js auto-resolves icon.png, apple-icon.png and
  // opengraph-image.png placed in this directory and emits the right
  // <link>/<meta> tags. The block below adds the surrounding OG +
  // Twitter copy so social previews carry the brand image with proper
  // titles instead of the bare URL.
  openGraph: {
    title: "Oddzilla — Esports sportsbook",
    description:
      "Premium, quiet esports sportsbook. CS2, Dota 2, League of Legends, Valorant.",
    siteName: "Oddzilla",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Oddzilla — Esports sportsbook",
    description:
      "Premium, quiet esports sportsbook. CS2, Dota 2, League of Legends, Valorant.",
  },
};

export const viewport: Viewport = {
  // Light bg — matches CSS `:root` default in globals.css. The
  // browser chrome stays light unless the user explicitly toggled
  // to dark; we don't bother with prefers-color-scheme here because
  // the in-app toggle is the source of truth.
  themeColor: "#f4f2ec",
  width: "device-width",
  initialScale: 1,
};

// Runs before body paints — sets `data-theme` on <html> from
// `oz:theme` in localStorage so users who picked dark don't see a
// light flash on every navigation. We deliberately do NOT declare
// `data-theme` on the JSX <html> element below: if we did, React
// would reconcile the attribute back to its server-rendered value
// during hydration and the script's choice would be lost. With no
// JSX attribute, hydration leaves the DOM alone, and CSS's :root
// rules supply the light default until the script runs. Storage key
// must match `apps/web/src/components/shell/theme-toggle.tsx`.
const themeBootScript = `(function(){try{var t=localStorage.getItem("oz:theme");if(t==="light"||t==="dark"){document.documentElement.setAttribute("data-theme",t);}}catch(e){}})();`;

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // The CSP-emitting middleware mints a per-request nonce and pushes it
  // into the request headers. Without applying it to the inline boot
  // script the browser would refuse to execute (CSP nonce-mode forbids
  // 'unsafe-inline'), and users would briefly see a light flash on a
  // dark-themed page before hydration patched up.
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
