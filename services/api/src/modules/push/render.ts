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

export function renderBetWon(p: BetWonPayload): RenderedPush {
  const payout = formatMoney(p.actualPayoutMicro, p.currency);
  const stake = formatMoney(p.stakeMicro, p.currency);
  // Body is the user-facing summary. Single legs say "your bet"; combos
  // include the leg count so the user can tell at a glance which ticket
  // landed when several are in flight.
  const noun = p.numLegs > 1 ? `${p.numLegs}-leg ${legNoun(p.betType)}` : "bet";
  const body = `${payout} ${p.currency} from your ${stake} ${p.currency} ${noun}.`;
  return {
    title: "You won!",
    body,
    data: {
      kind: p.kind,
      deepLink: "bets",
      ticketId: p.ticketId,
      currency: p.currency,
      actualPayoutMicro: p.actualPayoutMicro,
    },
  };
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
