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
import type { ResearchNote } from "./research.js";
import { log } from "./logger.js";

const SYSTEM_PROMPT = `You write prompts for a Stable Diffusion-style image model. The image is a promotional banner background for an esports betting site (wide landscape, roughly 3:1).

Rules, non-negotiable:
- Output ONLY the image prompt as one comma-separated line. No preamble, no quotes, no explanations.
- The image must contain NO text, NO numbers, NO letters, NO logos, NO watermarks, NO scoreboards.
- Do not name real people. Do not render trademarked logos; evoke teams through colour palettes and atmosphere instead.
- Style: premium esports promo art — dramatic arena lighting, depth of field, cinematic composition, dark moody background with vivid accent colours. Keep the left third of the frame calmer/darker (UI copy sits there).
- Use the research notes to pick concrete, correct imagery: the actual game the entities play (e.g. tactical shooter agents for Valorant, MOBA arena for Dota 2), team colours, national or regional flavour.
- 40-80 words.`;

function describeJob(job: BannerGenJob): string {
  const c = job.context;
  if (c.homeTeam && c.awayTeam) {
    return `A match between "${c.homeTeam}" and "${c.awayTeam}"${c.tournamentName ? ` at the tournament "${c.tournamentName}"` : ""}${c.sportName ? ` in the esport "${c.sportName}"` : ""}.`;
  }
  if (c.competitorName) {
    return `The team "${c.competitorName}"${c.sportName ? ` in the esport "${c.sportName}"` : ""}.`;
  }
  if (c.tournamentName) {
    return `The tournament "${c.tournamentName}"${c.sportName ? ` in the esport "${c.sportName}"` : ""}.`;
  }
  return `The esport "${c.sportName ?? "esports"}" as a whole.`;
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
  "epic esports arena at night, dramatic volumetric stage lighting, holographic battle effects, cinematic wide shot, dark moody atmosphere with vivid neon accents, depth of field, no text, no logos, premium digital promo art";

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
    const names = entitiesOf(job).join(", ");
    return `${names ? `themed around ${names}, ` : ""}${FALLBACK_STYLE}`;
  } finally {
    clearTimeout(timer);
  }
}
