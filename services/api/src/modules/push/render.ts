// Render an outbox payload into the title/body/data shape FCM expects.
//
// We send BOTH a `notification` block AND a `data` block so:
//   - Backgrounded Android shows a system-tray notification automatically
//     from the `notification` block (FCM behaviour).
//   - Foregrounded Android receives the `data` block, lets the
//     FcmService decide how to surface it (already wired in
//     apps/mobile-android/.../fcm/FcmService.kt.example).
//
// The Android FcmService reads `data.deepLink` to pick a route — keep
// the value space stable here: `bets` opens the bets list, `match/<id>`
// the match page, etc. We surface only the safe minimum on the wire —
// no PII, no auth-sensitive fields.

import { fromMicroMoney } from "@oddzilla/types";
import type { SelectionLabel } from "./labels.js";

export interface BetWonPayload {
  kind: "bet_won";
  ticketId: string;
  betType: string;
  currency: string;
  stakeMicro: string;
  actualPayoutMicro: string;
  potentialPayoutMicro: string;
  numLegs: number;
}

export interface RenderedPush {
  title: string;
  body: string;
  data: Record<string, string>;
}

// Push body shape, by leg count:
//   single (1 leg):  "<home> vs <away> — <outcome>"
//   multi  (≥2):     "<N>-leg <type> · <home> vs <away> (+N-1 more)"
//   no-labels:       "<stake> → <payout> <currency>" fallback (e.g. the
//                    description tables had no row, or the SQL probe
//                    silently failed — the user still gets the win
//                    signal in the title).
export function renderBetWon(
  p: BetWonPayload,
  labels: SelectionLabel[],
): RenderedPush {
  const payout = formatMoney(p.actualPayoutMicro, p.currency);
  const stake = formatMoney(p.stakeMicro, p.currency);
  const title = `You won ${payout} ${p.currency}!`;
  const data: Record<string, string> = {
    kind: p.kind,
    deepLink: "bets",
    ticketId: p.ticketId,
    currency: p.currency,
    actualPayoutMicro: p.actualPayoutMicro,
  };

  let body: string;
  if (p.numLegs <= 1 && labels.length >= 1) {
    const l = labels[0]!;
    body = `${l.homeTeam} vs ${l.awayTeam} — ${l.outcomeName}`;
    data.matchLabel = `${l.homeTeam} vs ${l.awayTeam}`;
    data.outcomeLabel = l.outcomeName;
  } else if (p.numLegs > 1 && labels.length >= 1) {
    const first = labels[0]!;
    const remaining = Math.max(0, p.numLegs - 1);
    body =
      remaining > 0
        ? `${p.numLegs}-leg ${legNoun(p.betType)} · ${first.homeTeam} vs ${first.awayTeam} (+${remaining} more)`
        : `${p.numLegs}-leg ${legNoun(p.betType)} · ${first.homeTeam} vs ${first.awayTeam}`;
    data.matchLabel = `${first.homeTeam} vs ${first.awayTeam}`;
    data.outcomeLabel = first.outcomeName;
  } else {
    // Label lookup empty — preserve the previous fallback shape so the
    // bettor still gets a money + bet-type summary.
    const noun = p.numLegs > 1 ? `${p.numLegs}-leg ${legNoun(p.betType)}` : "bet";
    body = `${payout} ${p.currency} from your ${stake} ${p.currency} ${noun}.`;
  }

  return { title, body, data };
}

function legNoun(betType: string): string {
  switch (betType) {
    case "combo":
      return "combo";
    case "tiple":
      return "Tiple";
    case "tippot":
      return "Tippot";
    case "betbuilder":
      return "Bet Builder";
    default:
      return "bet";
  }
}

function formatMoney(microString: string, _currency: string): string {
  // Wallet rows store micro as BIGINT; the Go writer hands us the decimal
  // string form for precision (JSON numbers lose at 2^53). Parse to bigint
  // and round to 2 decimals — same convention the storefront uses for
  // every odds / payout / balance figure.
  let asBig: bigint;
  try {
    asBig = BigInt(microString);
  } catch {
    return microString;
  }
  return fromMicroMoney(asBig, { decimals: 2 });
}
