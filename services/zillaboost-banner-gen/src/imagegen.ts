// Local image generation over the AUTOMATIC1111/Forge-compatible
// `/sdapi/v1/txt2img` JSON API (SD WebUI, Forge, and SD.Next all expose
// it; launch the server with the `--api` flag). Everything backend-shaped
// lives in this one file so a different local stack (e.g. ComfyUI) is a
// single-file swap.

import type { WorkerConfig } from "./config.js";

const NEGATIVE_BASE =
  "text, letters, numbers, words, watermark, logo, signature, caption, " +
  "subtitles, ui, scoreboard, blurry, lowres, jpeg artifacts, deformed hands, " +
  "extra fingers, disfigured face";

/**
 * Cheap reachability probe — used by the worker to decide whether to
 * claim jobs at all. A dead backend means "don't claim, retry in an
 * hour", NOT a job failure.
 */
export async function backendUp(cfg: WorkerConfig): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    // sd-webui serves /sdapi/v1/sd-models cheaply; any 2xx will do.
    const res = await fetch(`${cfg.imageApiBase}/sdapi/v1/sd-models`, {
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Render one banner. Returns PNG bytes as base64 (A1111 output shape). */
export async function generateImage(
  cfg: WorkerConfig,
  prompt: string,
): Promise<{ imageBase64: string; mime: "image/png" }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.imageTimeoutMs);
  try {
    const res = await fetch(`${cfg.imageApiBase}/sdapi/v1/txt2img`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        prompt,
        negative_prompt: cfg.imageNegativeExtra
          ? `${NEGATIVE_BASE}, ${cfg.imageNegativeExtra}`
          : NEGATIVE_BASE,
        width: cfg.imageWidth,
        height: cfg.imageHeight,
        steps: cfg.imageSteps,
        cfg_scale: cfg.imageCfgScale,
        sampler_name: cfg.imageSampler,
        batch_size: 1,
        n_iter: 1,
        ...(cfg.imageModel
          ? { override_settings: { sd_model_checkpoint: cfg.imageModel } }
          : null),
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`txt2img HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    const body = (await res.json()) as { images?: string[] };
    const image = body.images?.[0];
    if (!image) throw new Error("txt2img returned no images");
    // A1111 sometimes prefixes a data-URI; the api wants bare base64.
    const base64 = image.includes(",") ? image.split(",", 2)[1]! : image;
    return { imageBase64: base64, mime: "image/png" };
  } finally {
    clearTimeout(timer);
  }
}
