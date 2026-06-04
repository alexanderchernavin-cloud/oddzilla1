// Tolerant parsing of the model's JSON decision, plus a default holding note
// for the rare case the bettor explicitly asks for a human (or the model
// returns something unparseable).
//
// Per the operator's directive the assistant has exactly two rules — it cannot
// change anything, and it only covers Oddzilla / sportsbook topics — and both
// are enforced in the system prompt. There is intentionally NO content
// tripwire or forced escalation here: the bot answers on-topic questions
// (including account-specific ones) rather than handing them to a human.

export interface BotDecision {
  action: "reply" | "escalate";
  message: string;
  reason?: string;
}

export const DEFAULT_HOLDING_MESSAGE =
  "Thanks — let me bring in a teammate to help you with this.";

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
