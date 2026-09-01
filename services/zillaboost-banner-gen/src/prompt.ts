// Image-prompt authoring on the local LLM (LM Studio, OpenAI-compatible
// /v1/chat/completions). The LLM turns "what is boosted" + the Wikipedia
// research into ONE diffusion prompt.
//
// Register: PROSE, not tag soup. The backend is FLUX (T5 text encoder),
// which reads sentences and largely ignores comma-separated tag lists —
// the old "cinematic, dramatic arena lighting, depth of field, vivid
// accent colours" shape is SD1.5-era phrasing and it is exactly what
// produced airbrushed slop that looked identical for all 32 titles.
//
// Three things now carry the quality:
//
//  1. A banned-vocabulary list. Every word that summons the generic
//     AI-promo look is forbidden in the system prompt AND stripped from
//     the completion afterwards (scrubSlop), because a small local model
//     agrees not to use them and then uses them anyway.
//  2. The title's real art direction from game-vocab, appended
//     deterministically so the LLM cannot dilute it.
//  3. Team identity expressed PHYSICALLY — the colour is on the kit and
//     the light, not named as an "accent colour".
//
// Still no text and no logos in the render: diffusion at banner scale
// produces mangled pseudo-letters and smeared pseudo-crests, which is
// the single clearest AI tell. The REAL crests and REAL team names are
// composited onto the finished plate in compose.ts, in vector-crisp
// form, which is the only way to get them right.

import type { BannerGenJob } from "@oddzilla/types";
import type { WorkerConfig } from "./config.js";
import { gameVocab } from "./game-vocab.js";
import type { ResearchNote } from "./research.js";
import { log } from "./logger.js";

/**
 * Filler that makes an image look machine-made. Forbidden in the system
 * prompt and stripped from the completion. Ordered longest-first so a
 * multi-word phrase is removed before its constituent words.
 */
const SLOP_TERMS = [
  "trending on artstation",
  "award-winning",
  "award winning",
  "highly detailed",
  "hyper-detailed",
  "hyper detailed",
  "ultra-detailed",
  "ultra detailed",
  "extremely detailed",
  "intricate details",
  "intricately detailed",
  "volumetric lighting",
  "volumetric light",
  "god rays",
  "lens flare",
  "depth of field",
  "shallow depth",
  "bokeh",
  "cinematic lighting",
  "cinematic composition",
  "cinematic",
  "dramatic lighting",
  "dramatic",
  "epic",
  "moody",
  "atmospheric",
  "breathtaking",
  "stunning",
  "striking",
  "majestic",
  "masterpiece",
  "hyperrealistic",
  "hyper-realistic",
  "photo-realistic 8k",
  "8k",
  "4k",
  "uhd",
  "high resolution",
  "vivid accent colours",
  "vivid accent colors",
  "accent colours",
  "accent colors",
  "neon glow",
  "neon lights",
  "neon",
  "glowing energy",
  "premium",
  "promo art",
  "promotional art",
  "esports promo",
  "digital art",
  "concept art",
  "artstation",
  "unreal engine 5",
  "octane render",
  "vibrant colours",
  "vibrant colors",
];

const SYSTEM_PROMPT = `You write prompts for the FLUX image model. The output is the artwork for a promotional banner on an esports betting site: one wide image, roughly 3 times as wide as it is tall.

HOW TO WRITE
- Write 3 to 5 plain English sentences describing ONE specific moment, as if describing a screenshot to someone who cannot see it. Full sentences, not comma-separated tags.
- Say who is in the frame, what they are physically doing, where they are, and what the light is doing. Be concrete. "A rifleman braces against a stone doorway as dust drifts through the sunlight behind him" is good. "Intense esports action" is useless.
- Output ONLY the description. No preamble, no quotes, no headings, no lists.

WHAT THE IMAGE MUST BE
- Start from the GAME WORLD given to you. It is ground truth about what this title looks like. Never substitute a different genre: a MOBA has no soldiers with rifles, a tactical shooter has no wizards.
- Keep it grounded and believable. Real anatomy, real materials, real light. Nothing floating, nothing melting, no impossible glow.
- Two teams means the two sides face each other across the frame — one side entering from the left, the other from the right. Put each team's colour ON that side physically: their gear, their kit trim, the light falling on them. Never describe colour as an abstract "accent".
- Use the research notes only for real, visible detail (a roster's country, a venue, a climate). Never as a flag, never as writing.

BANNED — do not use these words at all: ${SLOP_TERMS.slice(0, 34).join(", ")}. They produce generic machine-made pictures. Describe the actual light instead of calling it dramatic.

BANNED SUBJECTS
- No text, letters, numbers, scoreboards, banners with writing, or watermarks. Clothing, walls and equipment are unmarked.
- No logos, crests or team badges. They are added to the finished image afterwards as real artwork.
- No real named people.`;

/** "#RRGGBB" → normalised, or null when the value is not a hex colour. */
function normalizeHex(hex: string | null): string | null {
  if (!hex) return null;
  const clean = hex.trim();
  if (!/^#?[0-9a-fA-F]{6}$/.test(clean)) return null;
  return clean.startsWith("#") ? clean : `#${clean}`;
}

/**
 * Where the composited overlay lands, told to the model as a
 * composition instruction. Match/market plates get a matchup band laid
 * over the bottom third (compose.ts); sport and tournament plates are
 * used as a backdrop with the storefront's own copy scrimmed over the
 * left. Either way the model should leave that area simple — which
 * happens to be better composition regardless.
 */
function framingClause(scope: BannerGenJob["scope"]): string {
  if (scope === "match" || scope === "market" || scope === "outcome") {
    return "Composition: wide banner crop, the action across the middle of the frame, the bottom third kept simple and uncluttered (ground, floor, low haze).";
  }
  return "Composition: wide banner crop, the action in the middle and right of the frame, the left third kept simple and darker.";
}

const TECHNICAL_TAIL =
  "Wide 3:1 banner crop. Every surface unmarked: no text, no letters, no numbers, no logos, no badges, no watermark anywhere in the frame.";

function describeJob(job: BannerGenJob): string {
  const c = job.context;
  const vocab = gameVocab(c.sportSlug);
  const lines: string[] = [`GAME: ${vocab.label}.`, `GAME WORLD: ${vocab.scene}.`];

  if (c.homeTeam && c.awayTeam) {
    const home = normalizeHex(c.homeBrandColor);
    const away = normalizeHex(c.awayBrandColor);
    lines.push(
      `BOOSTED: the match "${c.homeTeam}" against "${c.awayTeam}"${c.tournamentName ? ` at ${c.tournamentName}` : ""}. Two sides facing each other across the frame.`,
    );
    if (home || away) {
      lines.push(
        `SIDE COLOURS (put them on gear and light, never as abstract accents): left side ${home ?? "any strong colour that contrasts with the right"}, right side ${away ?? "any strong colour that contrasts with the left"}.`,
      );
    } else {
      lines.push(
        "SIDE COLOURS: none supplied — give the two sides clearly different gear colours.",
      );
    }
  } else if (c.competitorName) {
    const col = normalizeHex(c.competitorBrandColor);
    lines.push(`BOOSTED: the team "${c.competitorName}".`);
    if (col) lines.push(`TEAM COLOUR (on gear and light): ${col}.`);
  } else if (c.tournamentName) {
    const col = normalizeHex(c.tournamentBrandColor);
    lines.push(
      `BOOSTED: the tournament "${c.tournamentName}" — show the scale of the event itself, the stage and the crowd, no specific teams.`,
    );
    if (col) lines.push(`EVENT COLOUR (in the stage light and staging): ${col}.`);
  } else {
    lines.push(
      `BOOSTED: the game "${c.sportName ?? "esports"}" as a whole — one signature moment from it, no specific teams.`,
    );
  }
  return lines.join("\n");
}

/** Entities worth researching, most specific first. */
export function entitiesOf(job: BannerGenJob): string[] {
  const c = job.context;
  const out: string[] = [];
  if (c.homeTeam) out.push(`${c.homeTeam} esports`);
  if (c.awayTeam) out.push(`${c.awayTeam} esports`);
  if (c.competitorName) out.push(`${c.competitorName} esports`);
  if (c.tournamentName) out.push(c.tournamentName);
  if (c.sportName) out.push(c.sportName);
  return out.slice(0, 4);
}

/** Auth header for the LLM endpoint. Empty for a local LM Studio, which
 *  needs none; required by a hosted OpenAI-compatible gateway. */
function llmHeaders(cfg: WorkerConfig): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (cfg.lmStudioApiKey) h.authorization = `Bearer ${cfg.lmStudioApiKey}`;
  return h;
}

async function discoverModel(cfg: WorkerConfig): Promise<string> {
  const res = await fetch(`${cfg.lmStudioBaseUrl}/v1/models`, {
    headers: llmHeaders(cfg),
  });
  if (!res.ok) throw new Error(`lmstudio /v1/models HTTP ${res.status}`);
  const body = (await res.json()) as { data?: Array<{ id?: string }> };
  const id = body.data?.[0]?.id;
  if (!id) throw new Error("lmstudio has no model loaded");
  return id;
}

/**
 * Strip the banned vocabulary the model used anyway, then repair the
 * punctuation the removal leaves behind. Cheap and deterministic — the
 * alternative is re-prompting, which on a small local model mostly
 * produces a different set of the same words.
 */
export function scrubSlop(text: string): string {
  let out = text;
  for (const term of SLOP_TERMS) {
    out = out.replaceAll(
      new RegExp(`\\b${term.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"),
      " ",
    );
  }
  return out
    .replaceAll(/\s+/g, " ")
    .replaceAll(/\s+([,.;:])/g, "$1")
    .replaceAll(/([,;:])\s*(?=[,.;:])/g, "")
    .replaceAll(/,\s*\./g, ".")
    .replaceAll(/\.\s*\./g, ".")
    .trim();
}

/**
 * Prompt used when the LLM is unreachable or its completion scrubs down
 * to nothing. Built from the deterministic game vocabulary — a degraded
 * run still produces a picture of the RIGHT GAME, in the right style.
 */
function fallbackPrompt(job: BannerGenJob): string {
  const c = job.context;
  const vocab = gameVocab(c.sportSlug);
  const home = normalizeHex(c.homeBrandColor);
  const away = normalizeHex(c.awayBrandColor);
  const sides =
    c.homeTeam && c.awayTeam
      ? ` Two opposing sides face each other across the frame, the left side in ${home ?? "dark red"} gear and the right side in ${away ?? "deep blue"} gear.`
      : "";
  return `${vocab.scene}.${sides}`;
}

/**
 * Author the diffusion prompt: LLM paragraph (scrubbed) + the title's
 * real art direction + the framing and no-marks tail, both appended
 * deterministically so no completion can drop them.
 */
export async function authorPrompt(
  cfg: WorkerConfig,
  job: BannerGenJob,
  notes: readonly ResearchNote[],
): Promise<string> {
  const vocab = gameVocab(job.context.sportSlug);
  const research =
    notes.length > 0
      ? notes.map((n) => `- ${n.entity}: ${n.summary}`).join("\n")
      : "(no research available — rely on the entity names)";
  const user = `Boosted entity:\n${describeJob(job)}\n\nResearch notes:\n${research}\n\nWrite the description now.`;

  let body = fallbackPrompt(job);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.requestTimeoutMs);
  try {
    const model = cfg.lmStudioModel ?? (await discoverModel(cfg));
    const res = await fetch(`${cfg.lmStudioBaseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: llmHeaders(cfg),
      signal: controller.signal,
      body: JSON.stringify({
        model,
        // Lower than the old 0.7: this is an instruction-following task
        // with a hard banned-word list, not a creative-writing one.
        temperature: 0.45,
        // Budget covers REASONING tokens as well as the prompt we want.
        // Reasoning models (GLM-5.3-flash on the hosted endpoint, for one)
        // spend this allowance on an internal `reasoning_content` field
        // first and only then emit `content` — at max_tokens 400 a long
        // research blob can burn the lot and return content: "" with
        // finish_reason "length", i.e. a silently empty prompt. Measured:
        // a short support answer cost 40 reasoning + 31 text tokens, so the
        // multiple matters more than the absolute. Harmless on a local
        // non-reasoning model, which simply stops when it is done.
        max_tokens: 1200,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: user },
        ],
      }),
    });
    if (!res.ok) throw new Error(`lmstudio chat HTTP ${res.status}`);
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const raw = json.choices?.[0]?.message?.content?.trim();
    if (!raw) throw new Error("lmstudio returned empty completion");
    const cleaned = scrubSlop(raw.replace(/^["']|["']$/g, ""));
    // A completion that scrubs down to nothing (all filler) is worse
    // than the deterministic scene — keep the fallback in that case.
    if (cleaned.length >= 60) body = cleaned;
    else log.warn({ ruleId: job.ruleId, raw }, "completion scrubbed empty — using scene fallback");
  } catch (err) {
    log.warn({ err, ruleId: job.ruleId }, "prompt LLM failed — using fallback");
  } finally {
    clearTimeout(timer);
  }

  return [body, `${vocab.style}.`, framingClause(job.scope), TECHNICAL_TAIL]
    .join(" ")
    .replaceAll(/\s+/g, " ")
    .trim();
}
