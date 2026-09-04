"use client";

import { useState, type SVGProps } from "react";
import { useSportLogo } from "@/lib/sport-logos";

// Slugs with a brand SVG in /public/sports/<slug>.svg.
// Keep in sync with the files actually copied into apps/web/public/sports/.
const BRAND_LOGOS = new Set<string>([
  "cs2",
  "dota2",
  "lol",
  "valorant",
  "rocket-league",
  "overwatch",
  "starcraft",
  "starcraft-2",
  "fortnite",
  "pubg",
  "pubg-mobile",
  "rainbow-six",
  "call-of-duty",
  "halo",
  "deadlock",
  "marvel-rivals",
  "mobile-legends",
  "wild-rift",
  "world-of-tanks",
  "world-of-warcraft",
  "warcraft-3",
  "age-of-empires-2",
  "street-fighter",
  "tekken",
  "crossfire",
  "free-fire",
  "geoguessr",
  "chess-com",
  "escape-from-tarkov",
  "arena-of-valor",
  "kings-of-glory",
  "efootball",
  "ebasketball",
  "ecricket",
  "etouchdown",
  "efootball-bots",
  "ebasketball-bots",
  "ecricket-bots",
  "etouchdown-bots",
  "cs2-duels",
  "dota2-duels",
  // Traditional sports from the Fonbet feed (services/fonbet-ingester).
  // Most Fonbet sports carry a CDN icon in sports.logo_url (resolved
  // above); these nine have no Fonbet glyph so they ship bundled art.
  "american-football",
  "table-tennis",
  "mma",
  "basketball-3x3",
  "beach-volleyball",
  "beach-soccer",
  "specials",
  "aussie-rules",
  "gaelic-sports",
]);

// Legacy short ids used by the SPORTS list above map onto canonical slugs.
const SLUG_ALIAS: Record<string, string> = {
  rl: "rocket-league",
  ow: "overwatch",
  sc: "starcraft",
};

export function SportGlyph({ sport, size = 20 }: { sport: string; size?: number }) {
  const slug = (SLUG_ALIAS[sport] ?? sport).toLowerCase();
  // Resolution priority:
  //   1. Admin-uploaded / feed-supplied URL from /catalog/sports (context).
  //   2. Bundled brand SVG at /public/sports/<slug>.svg.
  //   3. Inline FallbackGlyph for slugs we don't have art for.
  // A remote URL that fails to load (CDN outage, path gone) drops to the
  // next tier instead of leaving a broken <img> — same contract as
  // TeamMark for team crests.
  const dbLogoUrl = useSportLogo(slug);
  const [remoteFailed, setRemoteFailed] = useState(false);
  if (dbLogoUrl && !remoteFailed) {
    return (
      <img
        src={dbLogoUrl}
        width={size}
        height={size}
        alt=""
        aria-hidden
        onError={() => setRemoteFailed(true)}
        style={{ display: "inline-block", flexShrink: 0, objectFit: "contain" }}
      />
    );
  }
  if (BRAND_LOGOS.has(slug)) {
    return (
      <img
        src={`/sports/${slug}.svg`}
        width={size}
        height={size}
        alt=""
        aria-hidden
        style={{ display: "inline-block", flexShrink: 0 }}
      />
    );
  }
  return <FallbackGlyph sport={sport} size={size} />;
}

function FallbackGlyph({ sport, size }: { sport: string; size: number }) {
  const common: SVGProps<SVGSVGElement> = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.6,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": true,
  };
  switch (sport) {
    case "cs2":
      return (
        <svg {...common}>
          <path d="M4 7h10l4 4-4 4H4z" />
          <circle cx="7" cy="11" r="1" fill="currentColor" />
          <path d="M18 11h2" />
        </svg>
      );
    case "lol":
      return (
        <svg {...common}>
          <path d="M12 3 4 8v8l8 5 8-5V8z" />
          <path d="M8 10v4l4 2 4-2v-4l-4-2z" />
        </svg>
      );
    case "dota2":
      return (
        <svg {...common}>
          <path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z" />
        </svg>
      );
    case "valorant":
      return (
        <svg {...common}>
          <path d="M3 4 11 20 M21 4 15 16 M10 16h6" />
        </svg>
      );
    case "rl":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8" />
          <path d="M4 12h16M12 4v16M6 6l12 12M18 6 6 18" />
        </svg>
      );
    case "ow":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 5v7l4 3" />
        </svg>
      );
    case "sc":
      return (
        <svg {...common}>
          <path d="M3 6c6 0 12 3 18 12M3 18c6-9 12-12 18-12" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8" />
        </svg>
      );
  }
}
