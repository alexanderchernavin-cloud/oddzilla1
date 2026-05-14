import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { Instrument_Serif, Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { BetSlipProvider } from "@/lib/bet-slip";
import { I18nProvider } from "@/lib/i18n";
import { getServerMessages } from "@/lib/i18n/server";

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

export async function generateMetadata(): Promise<Metadata> {
  // Locale-aware metadata so social previews and the browser tab pick
  // up the language the user picked. Falls back to English when the
  // cookie is unset (negotiator already does that — see
  // lib/i18n/server.ts).
  const { messages } = await getServerMessages();
  const c = messages.common;
  const title = `${c.appName} — ${c.appTagline}`;
  // Next.js auto-resolves icon.png, apple-icon.png and
  // opengraph-image.png placed in this directory and emits the right
  // <link>/<meta> tags. The block below adds the surrounding OG +
  // Twitter copy so social previews carry the brand image with proper
  // titles instead of the bare URL.
  return {
    title,
    description: c.appDescription,
    openGraph: {
      title,
      description: c.appDescription,
      siteName: c.appName,
      type: "website",
    },
    twitter: {
      card: "summary_large_image",
      title,
      description: c.appDescription,
    },
  };
}

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
  const { locale, messages } = await getServerMessages();

  return (
    <html
      lang={locale}
      suppressHydrationWarning
      className={`${geist.variable} ${geistMono.variable} ${instrumentSerif.variable}`}
    >
      <head>
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: themeBootScript }} />
      </head>
      <body>
        <I18nProvider locale={locale} messages={messages}>
          <BetSlipProvider>{children}</BetSlipProvider>
        </I18nProvider>
      </body>
    </html>
  );
}
