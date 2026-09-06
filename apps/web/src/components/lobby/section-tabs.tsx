import Link from "next/link";
import { LiveDot } from "@/components/ui/primitives";
import { I } from "@/components/ui/icons";

export type SectionTabKind = "live" | "prematch";

interface SectionTabsProps {
  liveLabel: string;
  prematchLabel: string;
  // Which section the surrounding page is showing. `null` is the lobby,
  // which renders BOTH sections at once — so neither tab is selected
  // there and the strip keeps its original flat look.
  selected?: SectionTabKind | null;
  // Sport slug carried through from the page's chip filter, so moving
  // between Live and Pre-match keeps the filter the bettor set. Omitted
  // on the lobby, which has no sport filter.
  sport?: string | null;
}

// Live / Pre-match strip shown at the top of the match list on the
// lobby, /live and /upcoming.
//
// BOTH tabs always render. /live and /upcoming used to print only their
// own heading, so selecting one hid the other and the sections became
// dead ends — the only way back was the browser's back button. The
// selected tab is marked (full-strength label + underline +
// aria-current) instead of being the only one on screen.
//
// No counts. The strip used to print one per tab, and the number was the
// LENGTH OF THE PAGE'S FETCH — `/catalog/matches?…&limit=60` rendered as
// "Pre-match 60" over a line carrying thousands of prematch fixtures, and
// "Live 120" beside a sidebar badge that said 126. A count that is really
// a page size is worse than none (removed 2026-09-06). The sidebar's Live
// badge remains the one true live total.
export function SectionTabs({
  liveLabel,
  prematchLabel,
  selected = null,
  sport = null,
}: SectionTabsProps) {
  const suffix = sport ? `?sport=${encodeURIComponent(sport)}` : "";
  return (
    <div className="oz-lobby-tabs" data-selectable={selected ? "true" : "false"}>
      <SectionTab
        kind="live"
        href={`/live${suffix}`}
        label={liveLabel}
        selected={selected === "live"}
        headingLevel={selected ? (selected === "live" ? 1 : 0) : 2}
      />
      <SectionTab
        kind="prematch"
        href={`/upcoming${suffix}`}
        label={prematchLabel}
        selected={selected === "prematch"}
        headingLevel={selected ? (selected === "prematch" ? 1 : 0) : 2}
      />
    </div>
  );
}

// One tab: icon + section title. `kind` drives the icon (red pulsing dot
// for live, neutral clock outline for prematch); hover, focus and
// selected styling live in globals.css under `.oz-lobby-tab-link`.
//
// `headingLevel` 0 renders a plain span — the unselected tab on a page
// that already has an h1, where a second heading would be noise for a
// screen reader walking the outline.
function SectionTab({
  kind,
  href,
  label,
  selected,
  headingLevel,
}: {
  kind: SectionTabKind;
  href: string;
  label: string;
  selected: boolean;
  headingLevel: 0 | 1 | 2;
}) {
  const Label =
    headingLevel === 1 ? "h1" : headingLevel === 2 ? "h2" : "span";
  return (
    <Link
      href={href}
      className="oz-lobby-tab-link"
      data-kind={kind}
      data-selected={selected ? "true" : "false"}
      aria-current={selected ? "page" : undefined}
    >
      <span className="oz-lobby-tab-link-icon" aria-hidden>
        {kind === "live" ? <LiveDot size={9} /> : <I.Clock size={18} />}
      </span>
      <Label className="oz-lobby-tab-link-label">{label}</Label>
    </Link>
  );
}
