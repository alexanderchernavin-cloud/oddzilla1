// Image-prompt authoring on the local LLM (LM Studio, OpenAI-compatible
// /v1/chat/completions). The LLM turns "what is boosted" + the Wikipedia
// research into ONE diffusion prompt.
//
// House rules baked into the system prompt:
//  - NO text, numbers, logos, or watermarks in the image. Diffusion text
//    is garbage, and the storefront overlays its own ZillaBoost chip,
//    boost pct, and entity names — the graphic is pure atmosphere.
//  - Landscape esports-promo composition with the visual weight kept
//    left-of-center safe (the wide banners put copy on the left over a
//    scrim).
//  - Draw on the researched real-world facts (team colours, national
//    identity, the game the tournament is played in) without rendering
//    trademarked logos.

import type { BannerGenJob } from "@oddzilla/types";
import type { WorkerConfig } from "./config.js";
import { gameVocab } from "./game-vocab.js";
import type { ResearchNote } from "./research.js";
import { log } from "./logger.js";

const SYSTEM_PROMPT = `You write prompts for a Stable Diffusion-style image model. The image is a promotional banner background for an esports betting site (wide landscape, roughly 3:1).

Rules, non-negotiable:
- Output ONLY the image prompt as one comma-separated line. No preamble, no quotes, no explanations.
- The image must contain NO text, NO numbers, NO letters, NO logos, NO watermarks, NO scoreboards.
- Do not name real people. Do not render trademarked logos or team crests.
- START from the GAME WORLD clause given to you and keep its subject matter. It is ground truth about what this game looks like. Never substitute a different genre — a MOBA must not contain soldiers with guns, a shooter must not contain wizards.
- If two teams are given, compose a VERSUS image: the two sides mirrored or converging, one team's colour dominating the left, the other's the right, clashing in the middle. Use the exact hex colours supplied as the two accent colours.
- If one team or a tournament is given, use its supplied colour as the dominant accent.
- Use the research notes for concrete regional or national flavour (a Ukrainian roster, a Brazilian roster, a Chinese league) expressed as colour, crowd, and setting — never as flags with text.
- Style: premium esports promo art — dramatic arena lighting, depth of field, cinematic composition, dark moody background with vivid accent colours. Keep the left third of the frame calmer/darker (UI copy sits there).
- Be specific and physical. Name what is happening in the frame. Do NOT write vague filler like "esports arena, neon lights, cinematic" and stop — that produces stock art indistinguishable between titles.
- 40-80 words.`;

/** "#RRGGBB" → a phrase the model can act on, or null. */
function colorNote(label: string, hex: string | null): string | null {
  if (!hex) return null;
  const clean = hex.trim();
  if (!/^#?[0-9a-fA-F]{6}$/.test(clean)) return null;
  return `${label} colour ${clean.startsWith("#") ? clean : `#${clean}`}`;
}

function describeJob(job: BannerGenJob): string {
  const c = job.context;
  const vocab = gameVocab(c.sportSlug);
  const lines: string[] = [`GAME: ${vocab.label}.`, `GAME WORLD: ${vocab.scene}.`];

  if (c.homeTeam && c.awayTeam) {
    const colors = [
      colorNote(`"${c.homeTeam}"`, c.homeBrandColor),
      colorNote(`"${c.awayTeam}"`, c.awayBrandColor),
    ].filter(Boolean);
    lines.push(
      `BOOSTED: the match "${c.homeTeam}" versus "${c.awayTeam}"${c.tournamentName ? ` at "${c.tournamentName}"` : ""}. Compose it as a versus image.`,
    );
    if (colors.length > 0) lines.push(`TEAM COLOURS: ${colors.join("; ")}.`);
    else {
      lines.push(
        "TEAM COLOURS: not supplied — pick two strongly contrasting accent colours for the two sides.",
      );
    }
  } else if (c.competitorName) {
    lines.push(`BOOSTED: the team "${c.competitorName}".`);
    const col = colorNote(`"${c.competitorName}"`, c.competitorBrandColor);
    if (col) lines.push(`TEAM COLOUR: ${col}.`);
  } else if (c.tournamentName) {
    lines.push(
      `BOOSTED: the tournament "${c.tournamentName}" — show its stage and crowd, championship scale.`,
    );
    const col = colorNote(`"${c.tournamentName}"`, c.tournamentBrandColor);
    if (col) lines.push(`TOURNAMENT COLOUR: ${col}.`);
  } else {
    lines.push(
      `BOOSTED: the whole game "${c.sportName ?? "esports"}" — a signature scene from it, no specific teams.`,
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

async function discoverModel(cfg: WorkerConfig): Promise<string> {
  const res = await fetch(`${cfg.lmStudioBaseUrl}/v1/models`);
  if (!res.ok) throw new Error(`lmstudio /v1/models HTTP ${res.status}`);
  const body = (await res.json()) as { data?: Array<{ id?: string }> };
  const id = body.data?.[0]?.id;
  if (!id) throw new Error("lmstudio has no model loaded");
  return id;
}

const FALLBACK_STYLE =
  "cinematic wide shot, dramatic volumetric stage lighting, dark moody atmosphere with vivid accent colours, depth of field, no text, no logos, premium digital promo art";

/**
 * Prompt used when the LLM is unreachable or returns nothing. Built
 * from the deterministic game vocabulary rather than generic arena
 * boilerplate, so a degraded run still produces a picture of the RIGHT
 * GAME — the previous version fell back to "epic esports arena" for
 * every title, which is exactly the stock look we're fixing.
 */
function fallbackPrompt(job: BannerGenJob): string {
  const c = job.context;
  const vocab = gameVocab(c.sportSlug);
  const accents = [
    c.homeBrandColor,
    c.awayBrandColor,
    c.competitorBrandColor,
    c.tournamentBrandColor,
  ]
    .filter((h): h is string => !!h && /^#?[0-9a-fA-F]{6}$/.test(h.trim()))
    .slice(0, 2);
  const versus =
    c.homeTeam && c.awayTeam
      ? "two opposing sides converging from left and right, mirrored versus composition, "
      : "";
  const palette =
    accents.length > 0
      ? `accent colours ${accents.join(" and ")}, `
      : "";
  return `${vocab.scene}, ${versus}${palette}${FALLBACK_STYLE}`;
}

/**
 * Author the diffusion prompt. LLM failure falls back to a serviceable
 * generic prompt seeded with the entity names — a plainer banner beats a
 * failed job.
 */
export async function authorPrompt(
  cfg: WorkerConfig,
  job: BannerGenJob,
  notes: readonly ResearchNote[],
): Promise<string> {
  const research =
    notes.length > 0
      ? notes.map((n) => `- ${n.entity}: ${n.summary}`).join("\n")
      : "(no research available — rely on the entity names)";
  const user = `Boosted entity:\n${describeJob(job)}\n\nResearch notes:\n${research}\n\nWrite the image prompt now.`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.requestTimeoutMs);
  try {
    const model = cfg.lmStudioModel ?? (await discoverModel(cfg));
    const res = await fetch(`${cfg.lmStudioBaseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        temperature: 0.7,
        max_tokens: 300,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: user },
        ],
      }),
    });
    if (!res.ok) throw new Error(`lmstudio chat HTTP ${res.status}`);
    const body = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = body.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error("lmstudio returned empty completion");
    // One line, and strip stray wrapping quotes some models add.
    return text.replaceAll(/\s+/g, " ").replace(/^["']|["']$/g, "").trim();
  } catch (err) {
    log.warn({ err, ruleId: job.ruleId }, "prompt LLM failed — using fallback");
    return fallbackPrompt(job);
  } finally {
    clearTimeout(timer);
  }
}
