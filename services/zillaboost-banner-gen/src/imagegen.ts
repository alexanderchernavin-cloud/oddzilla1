// Local image generation over the ComfyUI HTTP API — what the operator's
// model PC actually runs (ComfyUI 0.34, port 8188, discovered 2026-08-28;
// the earlier A1111 `/sdapi` client assumed wrong). Everything
// backend-shaped stays in this one file so a different stack remains a
// single-file swap.
//
// Flow: POST /prompt with a minimal txt2img workflow graph → poll
// /history/{prompt_id} until the SaveImage node reports an output →
// GET /view to fetch the PNG bytes.
//
// Checkpoint resolution: IMAGE_MODEL env when set, else discovered from
// /object_info/CheckpointLoaderSimple with a preference for an SD3-family
// checkpoint — SD3.5 honours a real negative prompt (where the no-text /
// no-logo terms live), while FLUX runs cfg=1 and ignores negatives, and
// is notorious for ADDING text to anything that looks like a poster.
// When a FLUX checkpoint is picked anyway, cfg drops to 1.0 unless the
// operator pinned IMAGE_CFG_SCALE explicitly.

import { randomBytes } from "node:crypto";
import type { WorkerConfig } from "./config.js";
import { log } from "./logger.js";

const NEGATIVE_BASE =
  "text, letters, numbers, words, typography, watermark, logo, signature, " +
  "caption, subtitles, ui, scoreboard, blurry, lowres, jpeg artifacts, " +
  "deformed hands, extra fingers, disfigured face";

/**
 * Cheap reachability probe — used by the worker to decide whether to
 * claim jobs at all. A dead backend means "don't claim, retry in an
 * hour", NOT a job failure.
 */
export async function backendUp(cfg: WorkerConfig): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(`${cfg.imageApiBase}/system_stats`, {
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveCheckpoint(cfg: WorkerConfig): Promise<string> {
  if (cfg.imageModel) return cfg.imageModel;
  const res = await fetch(
    `${cfg.imageApiBase}/object_info/CheckpointLoaderSimple`,
  );
  if (!res.ok) throw new Error(`object_info HTTP ${res.status}`);
  const body = (await res.json()) as {
    CheckpointLoaderSimple?: {
      input?: { required?: { ckpt_name?: [string[], unknown] } };
    };
  };
  const names =
    body.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] ?? [];
  if (names.length === 0) throw new Error("comfyui has no checkpoints");
  return names.find((n) => /sd3/i.test(n)) ?? names[0]!;
}

/**
 * Minimal txt2img graph — the exact node shape of the FLUX workflow
 * verified end-to-end on the operator's box (RX 7900 XTX / ROCm),
 * parameterised. Latent node per family: the verified FLUX run used
 * EmptyLatentImage; SD3-family checkpoints take EmptySD3LatentImage.
 * (SD3.5-large-fp8 currently hipErrorLaunchFailure-crashes that GPU —
 * keep IMAGE_MODEL pinned to FLUX there.)
 */
function buildWorkflow(args: {
  checkpoint: string;
  latentClass: "EmptyLatentImage" | "EmptySD3LatentImage";
  prompt: string;
  negative: string;
  width: number;
  height: number;
  steps: number;
  cfgScale: number;
  sampler: string;
  seed: number;
}): Record<string, unknown> {
  return {
    "1": {
      class_type: "CheckpointLoaderSimple",
      inputs: { ckpt_name: args.checkpoint },
    },
    "2": {
      class_type: "CLIPTextEncode",
      inputs: { text: args.prompt, clip: ["1", 1] },
    },
    "3": {
      class_type: "CLIPTextEncode",
      inputs: { text: args.negative, clip: ["1", 1] },
    },
    "4": {
      class_type: args.latentClass,
      inputs: { width: args.width, height: args.height, batch_size: 1 },
    },
    "5": {
      class_type: "KSampler",
      inputs: {
        seed: args.seed,
        steps: args.steps,
        cfg: args.cfgScale,
        sampler_name: args.sampler,
        scheduler: "simple",
        denoise: 1,
        model: ["1", 0],
        positive: ["2", 0],
        negative: ["3", 0],
        latent_image: ["4", 0],
      },
    },
    "6": {
      class_type: "VAEDecode",
      inputs: { samples: ["5", 0], vae: ["1", 2] },
    },
    "7": {
      class_type: "SaveImage",
      inputs: { images: ["6", 0], filename_prefix: "zillaboost" },
    },
  };
}

interface HistoryImage {
  filename: string;
  subfolder: string;
  type: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Render params echoed back to the api for backoffice troubleshooting. */
export interface RenderMeta {
  checkpoint: string;
  latentClass: string;
  cfgScale: number;
  steps: number;
  sampler: string;
  width: number;
  height: number;
  seed: number;
  negative: string;
}

/** Render one banner. Returns PNG bytes as base64 + the params used. */
export async function generateImage(
  cfg: WorkerConfig,
  prompt: string,
): Promise<{ imageBase64: string; mime: "image/png"; meta: RenderMeta }> {
  const checkpoint = await resolveCheckpoint(cfg);
  const isFlux = /flux/i.test(checkpoint);
  // FLUX ignores the negative branch and needs cfg 1.0, and the
  // verified box workflow ran 20 steps; honour explicit operator
  // overrides, otherwise adapt per family.
  const cfgScale =
    process.env.IMAGE_CFG_SCALE?.trim()
      ? cfg.imageCfgScale
      : isFlux
        ? 1.0
        : cfg.imageCfgScale;
  const steps =
    process.env.IMAGE_STEPS?.trim() ? cfg.imageSteps : isFlux ? 20 : cfg.imageSteps;
  const seed = randomBytes(4).readUInt32BE(0);
  const latentClass = isFlux ? "EmptyLatentImage" : "EmptySD3LatentImage";
  const negative = cfg.imageNegativeExtra
    ? `${NEGATIVE_BASE}, ${cfg.imageNegativeExtra}`
    : NEGATIVE_BASE;
  const meta: RenderMeta = {
    checkpoint,
    latentClass,
    cfgScale,
    steps,
    sampler: cfg.imageSampler,
    width: cfg.imageWidth,
    height: cfg.imageHeight,
    seed,
    negative,
  };
  const workflow = buildWorkflow({
    checkpoint,
    latentClass,
    prompt,
    negative,
    width: cfg.imageWidth,
    height: cfg.imageHeight,
    steps,
    cfgScale,
    sampler: cfg.imageSampler,
    seed,
  });
  log.info({ checkpoint, cfgScale, seed }, "submitting comfyui workflow");

  const submit = await fetch(`${cfg.imageApiBase}/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      prompt: workflow,
      client_id: `zillaboost-${seed.toString(16)}`,
    }),
  });
  if (!submit.ok) {
    const text = await submit.text().catch(() => "");
    throw new Error(`comfyui /prompt HTTP ${submit.status}: ${text.slice(0, 300)}`);
  }
  const { prompt_id: promptId } = (await submit.json()) as {
    prompt_id?: string;
  };
  if (!promptId) throw new Error("comfyui /prompt returned no prompt_id");

  // Poll history until the SaveImage node reports its file.
  const deadline = Date.now() + cfg.imageTimeoutMs;
  let image: HistoryImage | null = null;
  while (Date.now() < deadline) {
    await sleep(2000);
    const res = await fetch(`${cfg.imageApiBase}/history/${promptId}`);
    if (!res.ok) continue;
    const body = (await res.json()) as Record<
      string,
      {
        status?: { status_str?: string; completed?: boolean };
        outputs?: Record<string, { images?: HistoryImage[] }>;
      }
    >;
    const entry = body[promptId];
    if (!entry) continue;
    if (entry.status?.status_str === "error") {
      throw new Error("comfyui reported a workflow error");
    }
    const out = entry.outputs?.["7"]?.images?.[0];
    if (out) {
      image = out;
      break;
    }
  }
  if (!image) throw new Error("comfyui render timed out");

  const view = await fetch(
    `${cfg.imageApiBase}/view?filename=${encodeURIComponent(image.filename)}` +
      `&subfolder=${encodeURIComponent(image.subfolder)}` +
      `&type=${encodeURIComponent(image.type)}`,
  );
  if (!view.ok) throw new Error(`comfyui /view HTTP ${view.status}`);
  const bytes = Buffer.from(await view.arrayBuffer());
  if (bytes.length === 0) throw new Error("comfyui returned an empty image");
  return { imageBase64: bytes.toString("base64"), mime: "image/png", meta };
}
