// Real-world entity research backing the image prompt. Keyless Wikipedia
// Action API (same approach as support-ai-bot's web_search tool): for each
// boosted entity — teams, tournament, sport — pull the top search hit's
// intro extract. The LLM then knows e.g. that "Team Falcons" is a Saudi
// esports organisation in green/white, or what a VCT stage looks like,
// before it writes the prompt. Failures degrade to an empty note — the
// prompt falls back to the entity names alone.

import type { WorkerConfig } from "./config.js";
import { log } from "./logger.js";

export interface ResearchNote {
  entity: string;
  summary: string;
}

async function wikiIntro(
  cfg: WorkerConfig,
  query: string,
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.requestTimeoutMs);
  try {
    const searchUrl =
      `${cfg.wikipediaApiBase}?action=query&list=search&format=json` +
      `&srlimit=1&srsearch=${encodeURIComponent(query)}`;
    const searchRes = await fetch(searchUrl, { signal: controller.signal });
    if (!searchRes.ok) return null;
    const search = (await searchRes.json()) as {
      query?: { search?: Array<{ title?: string }> };
    };
    const title = search.query?.search?.[0]?.title;
    if (!title) return null;

    const extractUrl =
      `${cfg.wikipediaApiBase}?action=query&prop=extracts&exintro=1` +
      `&explaintext=1&exchars=600&format=json&redirects=1` +
      `&titles=${encodeURIComponent(title)}`;
    const extractRes = await fetch(extractUrl, { signal: controller.signal });
    if (!extractRes.ok) return null;
    const extract = (await extractRes.json()) as {
      query?: { pages?: Record<string, { extract?: string }> };
    };
    const pages = extract.query?.pages ?? {};
    for (const page of Object.values(pages)) {
      if (page.extract && page.extract.trim().length > 0) {
        return page.extract.trim();
      }
    }
    return null;
  } catch (err) {
    log.warn({ err, query }, "wikipedia lookup failed");
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Research every named entity on the job. Sequential on purpose — this
 * runs once per job on an idle PC, and Wikipedia appreciates not being
 * hammered.
 */
export async function researchEntities(
  cfg: WorkerConfig,
  entities: readonly string[],
): Promise<ResearchNote[]> {
  const notes: ResearchNote[] = [];
  for (const entity of entities) {
    const summary = await wikiIntro(cfg, entity);
    if (summary) notes.push({ entity, summary });
  }
  return notes;
}
