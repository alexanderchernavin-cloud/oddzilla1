// Main loop.
//
//   poll /pending → for each claimed job:
//     research entities (Wikipedia) → author prompt (LM Studio) →
//     render (local image server) → upload → done
//
// Availability semantics, matching the operator's requirements exactly:
//  - Production PC-off case: the server queue is pull-based, so an OFF
//    PC simply doesn't poll. On boot this worker drains everything that
//    accumulated. Nothing to do here.
//  - LOCAL image backend down (PC on, model server not running): do NOT
//    claim jobs — probe first, and when the probe fails sleep
//    backendRetryMs (default 1 hour) before probing again. Jobs stay
//    queued server-side and no attempts are burned.
//  - API unreachable (network blip): log, sleep one normal poll
//    interval, try again — the hourly backoff is reserved for the image
//    backend, a flaky WAN shouldn't slow the queue down by an hour.
//  - A real generation error reports /fail: the server backs that job
//    off an hour and flips it to 'failed' after MAX_ATTEMPTS.

import type { BannerGenJob } from "@oddzilla/types";
import { WorkerApi, ApiError } from "./api-client.js";
import type { WorkerConfig } from "./config.js";
import { backendUp, generateImage } from "./imagegen.js";
import { authorPrompt, entitiesOf } from "./prompt.js";
import { researchEntities } from "./research.js";
import { healthState } from "./health.js";
import { log } from "./logger.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function processJob(
  cfg: WorkerConfig,
  api: WorkerApi,
  job: BannerGenJob,
): Promise<void> {
  const started = Date.now();
  log.info(
    { ruleId: job.ruleId, scope: job.scope, context: job.context },
    "job start",
  );
  try {
    const notes = await researchEntities(cfg, entitiesOf(job));
    const prompt = await authorPrompt(cfg, job, notes);
    log.info({ ruleId: job.ruleId, prompt }, "prompt authored");
    const { imageBase64, mime } = await generateImage(cfg, prompt);
    await api.complete(job.ruleId, imageBase64, mime);
    log.info(
      { ruleId: job.ruleId, ms: Date.now() - started },
      "job complete — image uploaded",
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ ruleId: job.ruleId, err }, "job failed");
    try {
      await api.fail(job.ruleId, message);
    } catch (reportErr) {
      // Even the failure report failed (API blip mid-job). The claim
      // lease expires server-side and the job re-offers itself — safe
      // to just drop it here.
      log.warn({ ruleId: job.ruleId, err: reportErr }, "could not report failure");
    }
  }
}

export async function runWorker(cfg: WorkerConfig): Promise<never> {
  const api = new WorkerApi(cfg);
  log.info(
    {
      apiBase: cfg.apiBase,
      imageApiBase: cfg.imageApiBase,
      lmStudioBaseUrl: cfg.lmStudioBaseUrl,
    },
    "zillaboost-banner-gen worker starting",
  );

  healthState.mode = "running";
  for (;;) {
    // Image backend gate FIRST — never claim what we can't render.
    const up = await backendUp(cfg);
    healthState.backendUp = up;
    if (!up) {
      log.warn(
        { retryInMs: cfg.backendRetryMs, imageApiBase: cfg.imageApiBase },
        "image backend unreachable — queued jobs wait server-side; retrying hourly",
      );
      await sleep(cfg.backendRetryMs);
      continue;
    }

    try {
      healthState.lastPollAt = new Date().toISOString();
      const { jobs } = await api.pending(3);
      if (jobs.length > 0) {
        log.info({ count: jobs.length }, "claimed jobs");
        // Sequential: one GPU, and the claim lease (15 min each) is
        // sized for one render at a time.
        for (const job of jobs) {
          await processJob(cfg, api, job);
        }
        // Immediately poll again — drain the backlog without waiting
        // out the poll interval between batches.
        continue;
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 503) {
        // banner_gen_disabled — token not configured server-side yet.
        log.warn("server reports banner_gen_disabled — set BANNER_GEN_TOKEN in the api env");
      } else {
        log.warn({ err }, "api poll failed — retrying next interval");
      }
    }
    await sleep(cfg.pollIntervalMs);
  }
}
