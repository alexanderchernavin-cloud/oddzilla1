// Deterministic safety layer that does NOT trust the model:
//   - a responsible-gambling / distress tripwire that forces escalation
//     (a backstop independent of what the model decides),
//   - a post-filter on the model's proposed reply that escalates instead of
//     sending if the text promises money actions or claims to have done one,
//   - tolerant parsing of the model's JSON decision.

export interface BotDecision {
  action: "reply" | "escalate";
  message: string;
  reason?: string;
}

// Backstop keyword tripwire. English-leaning + a few common terms; the system
// prompt also instructs the model to escalate on distress, so this is a
// belt-and-braces layer, not the only line of defence.
const RG_PATTERNS: RegExp[] = [
  /suicide|kill myself|end my life|harm myself/i,
  /self[-\s]?exclu/i,
  /gambling problem|problem gambling|gambling addict|addicted to gambl/i,
  /can'?t stop (gambling|betting|playing)/i,
  /losing control|out of control/i,
  /lost (all|everything|my savings|my rent)/i,
  /\bset (a )?(deposit )?limit/i,
  /take a break/i,
];

export function isResponsibleGamblingConcern(text: string): boolean {
  return RG_PATTERNS.some((re) => re.test(text));
}

export const RG_HOLDING_MESSAGE =
  "Thank you for reaching out, and for trusting us with this. I want to make " +
  "sure you get proper help, so I'm bringing in a member of our team to follow " +
  "up with you here. In the meantime, you can take a break or set deposit " +
  "limits from your account settings at any time, and please reach out to a " +
  "local support service if you need to talk to someone right away.";

export const DEFAULT_HOLDING_MESSAGE =
  "Thanks for your patience — let me bring in a teammate to help you with this.";

// Phrases that should never appear in an autonomous reply: a money promise or
// a claim that an account action was taken. If matched, escalate to a human
// instead of sending.
const RISKY_REPLY_PATTERNS: RegExp[] = [
  /\bguarantee(d|s)?\b/i,
  /\brefund(ed|ing|s)?\b/i,
  /\bcharge[-\s]?back/i,
  /\bi('|’)?(ve| have)\s+(added|credited|sent|paid|processed|refunded|approved)/i,
  /\bi('|’)?ll\s+(add|credit|send|pay|process|refund|approve)/i,
  /\bi (can|will) (add|credit|send|pay|process|refund|approve)/i,
  /\b(we|i) (have|'ve)?\s*(credited|added|sent|paid)\b/i,
  /(credited|added|sent|deposited|paid) (it )?to your (balance|wallet|account)/i,
];

export function replyLooksUnsafe(text: string): boolean {
  return RISKY_REPLY_PATTERNS.some((re) => re.test(text));
}

function extractJsonObject(raw: string): unknown {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // Model wrapped the object in prose / code fences — grab the outermost {}.
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  return null;
}

export function parseDecision(raw: string): BotDecision | null {
  const obj = extractJsonObject(raw);
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  const action =
    o.action === "escalate" ? "escalate" : o.action === "reply" ? "reply" : null;
  if (!action) return null;
  const message = typeof o.message === "string" ? o.message : "";
  const reason = typeof o.reason === "string" ? o.reason : undefined;
  return { action, message, reason };
}
