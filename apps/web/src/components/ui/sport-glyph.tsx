import type { SVGProps } from "react";

export const SPORTS = [
  { id: "cs2", name: "Counter-Strike 2", short: "CS2" },
  { id: "lol", name: "League of Legends", short: "LoL" },
  { id: "dota2", name: "Dota 2", short: "Dota 2" },
  { id: "valorant", name: "Valorant", short: "Valorant" },
  { id: "rl", name: "Rocket League", short: "RL" },
  { id: "ow", name: "Overwatch", short: "OW" },
  { id: "sc", name: "StarCraft", short: "SC" },
] as const;

export function SportGlyph({ sport, size = 20 }: { sport: string; size?: number }) {
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
