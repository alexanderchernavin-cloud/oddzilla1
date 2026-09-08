// Abuse moderation for the support assistant.
//
// Operator directive (2026-09-08): a bettor who abuses Support gets one
// fixed reply instead of a model turn.
//
// Deterministic and model-free ON PURPOSE. Two reasons: the reply is a
// fixed string the operator chose, so there is nothing to generate; and a
// safety-trained model asked to produce it would comply inconsistently,
// which would make the feature fire at random. It also means the reply
// still works when no model is loaded.
//
// THE HARD PART IS NOT THE WORD LIST, IT IS WHO THE WORDS ARE AIMED AT.
// "Abuses Support" is not "used a swear word". Two messages that share a
// vocabulary need opposite handling:
//
//   "fuck you, you useless bot"        -> abuse of support
//   "what the fuck happened to my bet" -> an ordinary frustrated question
//   "i've lost all my fucking money"   -> possibly a person in trouble
//
// A sportsbook sees the second and third constantly, and the third is the
// one this must never fire on: the system prompt commits the assistant to
// answering gambling-addiction and loss-of-control messages with real
// help and a helpline, and swearing while distressed is normal. Insulting
// that person would be the system doing the opposite of its job at the
// only moment it really matters. So DISTRESS_MARKERS is checked first and
// vetoes everything below it.
//
// What is left fires on TARGETING, not on vocabulary:
//   - DIRECTED_PHRASES  — phrases that are already aimed at the reader
//                         ("fuck you", "иди нахуй"); these fire alone.
//   - PROFANITY near SECOND_PERSON — a swear within PROXIMITY_WINDOW
//                         tokens of "you" / "ты" / "вы". The window is the
//                         whole reason this is usable: "fuck" and "you"
//                         both appear in "what the fuck happened to my
//                         bet, can you check" and are nine tokens apart.
//
// Deliberately NOT firing: a bare shout of profanity with no target
// ("БЛЯТЬ!!!"), which is frustration rather than abuse of a person. A
// false positive here insults a customer who did nothing wrong, so the
// rule stays conservative in that direction.

/** The operator-chosen reply. Posted verbatim; nothing generates it. */
export const ABUSE_REPLY = "Fuck you, suka blyad'";

export type ModerationVerdict = "abusive" | "clean";

/** How many tokens may sit between a swear and a second-person word for
 * the swear to count as aimed at the reader. 3 covers "you fucking idiot"
 * and "you are a fucking clown" while leaving a swear elsewhere in a long
 * sentence alone. */
const PROXIMITY_WINDOW = 3;

// Checked FIRST and vetoes everything. Anything here means the message may
// be from someone in trouble, and the assistant's own prompt promises them
// a supportive answer. Substring-matched against the normalised text, so
// entries must be lowercase and free of punctuation.
const DISTRESS_MARKERS = [
  // en
  "addict",
  "gambling problem",
  "problem gambling",
  "self exclude",
  "self exclusion",
  "selfexclude",
  "cant stop",
  "cannot stop",
  "out of control",
  "losing control",
  "lost control",
  "lost everything",
  "lost it all",
  "rent money",
  "in debt",
  "suicid",
  "kill myself",
  "end my life",
  "want to die",
  "hurt myself",
  "depress",
  "help me stop",
  "take a break",
  "cooling off",
  "deposit limit",
  "loss limit",
  // ru (transliterated inputs are handled by the en entries above)
  "зависим",
  "лудоман",
  "не могу остановиться",
  "проблема с азартн",
  "самоисключен",
  "потерял все",
  "потеряла все",
  "последние деньги",
  "покончить с собой",
  "суицид",
  "убить себя",
  "не хочу жить",
  "долг",
  "помогите бросить",
];

// Aimed at the reader by construction, so these fire on their own.
const DIRECTED_PHRASES = [
  // en
  "fuck you",
  "fuck u",
  "fuck off",
  "fuck yourself",
  "screw you",
  "piss off",
  "shut up",
  "shut the fuck up",
  "eat shit",
  "go to hell",
  "get fucked",
  "kill yourself",
  // ru
  "иди на хуй",
  "иди нахуй",
  "иди в жопу",
  "пошел ты",
  "пошёл ты",
  "пошли вы",
  "пошел на хуй",
  "пошёл нахуй",
  "отъебись",
  "отвали",
  "заткнись",
  "пошел ты на хуй",
  "нахуй иди",
];

// Swear / insult stems. Matched as a token PREFIX so Russian inflection
// ("суки", "мудаком", "ебанутый") is covered without listing every form;
// English entries are whole words that inflect little.
const PROFANITY_STEMS = [
  // en
  "fuck",
  "fucking",
  "fucker",
  // How people actually shorten it. No English or Russian word starts
  // with either, so the prefix match is safe.
  "fuk",
  "fck",
  "shit",
  "shitty",
  "bullshit",
  "bastard",
  "asshole",
  "arsehole",
  "bitch",
  "cunt",
  "dickhead",
  "prick",
  "wanker",
  "moron",
  "idiot",
  "imbecile",
  "clown",
  "scumbag",
  "retard",
  "useless",
  "pathetic",
  // ru
  "хуй",
  "хуе",
  "хуё",
  "хует",
  "нахуй",
  "пизд",
  "ебан",
  "ёбан",
  "ебат",
  "ебуч",
  "заеб",
  "уеб",
  "бляд",
  "блят",
  "блядь",
  "сука",
  "суки",
  "суче",
  "мудак",
  "мудил",
  "чмо",
  "гандон",
  "гнида",
  "дебил",
  "долбоеб",
  "долбоёб",
  "придурок",
  "тварь",
  "ублюд",
];

// The reader. A swear near one of these is aimed at the assistant.
const SECOND_PERSON = new Set([
  // en
  "you",
  "your",
  "youre",
  "yours",
  "yourself",
  "u",
  "ur",
  // ru
  "ты",
  "вы",
  "тебя",
  "тебе",
  "тобой",
  "вас",
  "вам",
  "вами",
  "твой",
  "твоя",
  "твое",
  "твоё",
  "ваш",
  "ваша",
  "ваше",
]);

// Modest de-obfuscation: digits and symbols standing in for letters.
// Deliberately not an adversarial filter — asterisk-censoring ("f*ck") is
// left to fall apart into non-words, since someone bothering to self-
// censor is not the aggressive abuser this targets, and the cost of a
// miss is only that a rude bettor gets a normal helpful answer.
const LEET: Record<string, string> = {
  "0": "o",
  "1": "i",
  "3": "e",
  "4": "a",
  "5": "s",
  "7": "t",
  "@": "a",
  $: "s",
};

/** Lowercase, de-leet, drop everything that is not a letter or space, and
 * collapse runs of the same letter ("fuuuuck" -> "fuck"). Unicode-aware so
 * Cyrillic survives. */
export function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[013457@$]/g, (c) => LEET[c] ?? c)
    .replace(/[^\p{L}\s]/gu, " ")
    .replace(/(\p{L})\1{2,}/gu, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function hasStem(token: string): boolean {
  return PROFANITY_STEMS.some((stem) => token.startsWith(stem));
}

/**
 * Is this bettor message abuse directed at the assistant?
 *
 * Conservative by design — see the header. Returns "clean" for anything
 * carrying a distress marker, and for profanity that is not aimed at the
 * reader.
 */
export function classifyBettorMessage(text: string): ModerationVerdict {
  const norm = normalise(text);
  if (!norm) return "clean";

  // Distress wins over everything, unconditionally.
  if (DISTRESS_MARKERS.some((m) => norm.includes(m))) return "clean";

  if (DIRECTED_PHRASES.some((p) => norm.includes(p))) return "abusive";

  const tokens = norm.split(" ");
  for (let i = 0; i < tokens.length; i += 1) {
    if (!hasStem(tokens[i]!)) continue;
    const from = Math.max(0, i - PROXIMITY_WINDOW);
    const to = Math.min(tokens.length - 1, i + PROXIMITY_WINDOW);
    for (let j = from; j <= to; j += 1) {
      if (j !== i && SECOND_PERSON.has(tokens[j]!)) return "abusive";
    }
  }
  return "clean";
}
