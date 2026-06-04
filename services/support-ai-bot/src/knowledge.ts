// Curated product FAQ injected into the system prompt as grounding so the
// assistant answers from facts rather than guessing. Keep it accurate and
// short; update it when product behaviour changes. Anything not covered here
// (or anything account-specific the supplied facts don't answer) should be
// escalated to a human.

export const KNOWLEDGE = `Oddzilla is a B2C esports sportsbook. Bettors place bets on esports
matches (CS2, Dota 2, LoL, Valorant, and more).

CURRENCIES
- USDC: the real-money currency. On-chain as ERC20 (USDC on Ethereum) only.
- OZ: a demo/play currency. Every new account gets a 1000 OZ bonus to try the
  bet flow. OZ is not real money, has no blockchain, and cannot be withdrawn.

DEPOSITS (USDC only)
- Send USDC on the Ethereum (ERC20) network to the receive address shown in
  the wallet/deposit screen.
- Because one shared address is used, after sending the bettor pastes their
  transaction hash so we can attribute the deposit to their account.
- Status moves pending -> confirming -> credited as the network confirms.
- Only USDC is supported. Sending a different token (e.g. USDT) or using the
  wrong network will NOT be auto-credited and needs a human to review.

WITHDRAWALS (USDC only)
- Requested from the wallet screen to a USDC ERC20 address.
- Status moves requested -> approved -> submitted -> confirmed. Withdrawals are
  reviewed and sent by the team, so they are not instant.

BETTING
- Bet types: single, combo (multi), plus tiple, tippot, and BetBuilder.
- The bet slip has a USDC/OZ currency toggle.
- Live bets can have a short acceptance delay; a bettor can opt in to "accept
  odds changes" so a live bet is re-priced at current odds instead of rejected.

CASH-OUT
- Some accepted tickets can be cashed out early for a live-updating amount.

ACCOUNT
- Login is email + password. The bettor site and the admin site keep separate
  sessions.
- New accounts get a verification email; clicking the link verifies the email.
  The site is usable before verifying.

ZILLAPASS
- A quest/tasks feature for engagement and progression.`;
