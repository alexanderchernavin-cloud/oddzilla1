// The default bettor-facing note posted when the assistant hands a thread off
// to a human (an explicit "talk to a human" request, or an empty model reply).
//
// Per the operator's directive the assistant has exactly two rules — it cannot
// change anything, and it only covers Oddzilla / sportsbook topics — and both
// are enforced in the system prompt. There is intentionally NO content
// tripwire or forced escalation here: the bot answers on-topic questions
// (including account-specific ones) rather than handing them to a human.

export const DEFAULT_HOLDING_MESSAGE =
  "Thanks — let me bring in a teammate to help you with this.";
