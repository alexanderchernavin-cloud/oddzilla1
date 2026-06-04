<!--
  Oddzilla support assistant — knowledge base.

  EDIT THIS FILE to add or correct specifics the assistant should know.
  It is injected into the assistant's prompt on every reply, so changes take
  effect on the next message (no restart needed). Keep it accurate and
  reasonably short. Plain prose/markdown is fine.
-->

# Oddzilla

Oddzilla is a B2C esports sportsbook. Bettors place bets on esports matches
(CS2, Dota 2, LoL, Valorant, and more).

## Currencies
- **USDC** — the real-money currency. On-chain as ERC20 (USDC on Ethereum) only.
- **OZ** — a demo / play currency. Every new account gets a 1000 OZ bonus to try
  the bet flow. OZ is not real money, has no blockchain, and cannot be withdrawn.

## Deposits (USDC only)
- Send USDC on the Ethereum (ERC20) network to the receive address shown on the
  deposit screen.
- One shared address is used, so after sending the bettor pastes their
  transaction hash so the deposit can be attributed to their account.
- Status moves: pending → confirming → credited.
- Only USDC is supported. A different token (e.g. USDT) or the wrong network is
  not auto-credited and needs the team to review.

## Withdrawals (USDC only)
- Requested from the wallet screen to a USDC ERC20 address.
- Status moves: requested → approved → submitted → confirmed. They are reviewed
  and sent by the team, so they are not instant.

## Betting
- Bet types: single, combo (multi-leg), tiple, tippot, and BetBuilder.
- **tippot** pays out per tier based on how many legs win, so a tippot can pay a
  partial amount even when not every leg wins. A combo pays only if every leg wins.
- The bet slip has a USDC / OZ currency toggle.
- Live bets can have a short acceptance delay; a bettor can opt in to "accept
  odds changes" so a live bet is re-priced at current odds instead of rejected.
- A bet leg's result is one of: won, lost, void, half_won, half_lost.

## Cash-out
- Some accepted tickets can be cashed out early for a live-updating amount.

## Account
- Login is email + password. The bettor site and the admin site keep separate
  sessions.
- New accounts get a verification email; clicking the link verifies the email.
  The site is usable before verifying.

## ZillaPass
- A quest / tasks feature for engagement and progression.
