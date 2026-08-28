// Post-render compositing: REAL team crests and REAL team names laid
// onto the diffusion plate.
//
// Why this exists. The prompt forbids text and logos, and that rule is
// not squeamishness — a diffusion model at banner scale renders a crest
// as a smeared blob and a team name as mangled pseudo-letters, and
// those two artefacts are the clearest "this was generated" tell there
// is. But the teams ARE the subject of the banner, so the answer is not
// to leave them out: it is to draw them properly, afterwards, from the
// assets we already hold. Crests come from `competitors.logo_url`
// (Oddin CDN or our own byte-serve route); names are set in a real
// font. Both stay vector-crisp because nothing diffuses them.
//
// Scope discipline: this runs for match / market / outcome rules only.
// Sport and tournament banners are used by the storefront as a scrimmed
// BACKDROP with its own copy laid over them, so baking copy into those
// plates would collide with the card chrome and duplicate it.
//
// Everything here is fail-soft. A logo that 404s is skipped, a font
// that will not rasterise drops the text layer, sharp missing entirely
// (an operator who pulled new code without re-running `pnpm install`)
// falls back to the bare plate. A plainer banner beats a failed job.

import type { BannerGenJob } from "@oddzilla/types";
// Type-only: the runtime handle comes from the dynamic import below, so
// a missing install degrades instead of crashing the worker at boot.
import type * as SharpNS from "sharp";
import type { WorkerConfig } from "./config.js";
import { log } from "./logger.js";

/** Hard cap on a fetched crest — ours are a few KB, CDN ones tens. */
const MAX_LOGO_BYTES = 3 * 1024 * 1024;
const LOGO_TIMEOUT_MS = 15_000;

type SharpModule = typeof SharpNS.default;

let sharpPromise: Promise<SharpModule | null> | null = null;

/**
 * Load sharp once, tolerating its absence. Dynamic on purpose: the GPU
 * box is updated by unpacking a git bundle, so new code can land there
 * before `pnpm install` runs. A hard top-level import would turn that
 * into a worker that will not boot at all.
 */
async function loadSharp(): Promise<SharpModule | null> {
  sharpPromise ??= import("sharp")
    .then((m) => (m.default ?? m) as SharpModule)
    .catch((err) => {
      log.warn(
        { err },
        "sharp unavailable — shipping bare plates; run pnpm install in services/zillaboost-banner-gen",
      );
      return null;
    });
  return sharpPromise;
}

function escapeXml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/** Hard stop, well past where the size-fitting below gives up. */
function clampName(name: string, max = 28): string {
  const t = name.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Shrink the type instead of truncating it. Esports names run long
 * ("Inner Circle Academy") and an ellipsis in the middle of a promo
 * banner reads as broken, where slightly smaller type does not. The
 * width estimate is the usual 0.6em-per-glyph approximation for a bold
 * sans — good enough to pick a size, and the hard clamp catches the
 * pathological cases.
 */
function fitFontSize(text: string, nominal: number, maxWidth: number): number {
  const est = text.length * nominal * 0.6;
  if (est <= maxWidth) return nominal;
  return Math.max(Math.round(nominal * 0.75), Math.floor(maxWidth / (text.length * 0.6)));
}

async function fetchLogo(url: string | null): Promise<Buffer | null> {
  if (!url) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOGO_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      log.warn({ url, status: res.status }, "crest fetch failed");
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > MAX_LOGO_BYTES) {
      log.warn({ url, bytes: buf.length }, "crest rejected on size");
      return null;
    }
    return buf;
  } catch (err) {
    log.warn({ err, url }, "crest fetch failed");
    return null;
  } finally {
    clearTimeout(timer);
  }
}

interface Geometry {
  w: number;
  h: number;
  haloRx: number;
  haloRy: number;
  crestCy: number;
  homeCx: number;
  awayCx: number;
  crestW: number;
  crestH: number;
  maxNameWidth: number;
  nameBaseline: number;
  nameSize: number;
  vsSize: number;
  bandTop: number;
}

/**
 * Layout derived from the delivered size, but SIZED AGAINST THE DISPLAY
 * SIZE — which is the whole trick here.
 *
 * The plate is 1536x512 and the storefront paints it into a ~411x137
 * strip (measured on a 1512px desktop, 2026-08-28), so everything in
 * the overlay shrinks by roughly 3.7x on the way to the screen. The
 * first cut of this file used type at 5% of the plate height, which is
 * a perfectly reasonable 25px in the file and an illegible 6.7px in the
 * card. Everything below is chosen so it survives that reduction:
 * ~34px crests, ~13px names. It looks oversized when you open the PNG,
 * and correct where anybody actually sees it.
 *
 * The tournament line the first cut also drew is gone: it landed at
 * 4.3px, and the card prints the same tournament name in crisp UI type
 * a few pixels below the image anyway.
 */
function geometry(w: number, h: number): Geometry {
  return {
    w,
    h,
    // Sides sit at the quarter points, which leaves each name ~40% of
    // the width to breathe in and a clear gutter for the VS mark.
    homeCx: Math.round(w * 0.255),
    awayCx: Math.round(w * 0.745),
    crestW: Math.round(w * 0.13),
    crestH: Math.round(h * 0.25),
    crestCy: Math.round(h * 0.6),
    haloRx: Math.round(w * 0.105),
    haloRy: Math.round(h * 0.235),
    maxNameWidth: Math.round(w * 0.4),
    nameBaseline: Math.round(h * 0.9),
    nameSize: Math.round(h * 0.095),
    vsSize: Math.round(h * 0.085),
    bandTop: Math.round(h * 0.34),
  };
}

/**
 * Scrim + a soft halo under each crest.
 *
 * The halo, not a rounded-rect tile: a tile turns every crest into an
 * app icon and fights whatever the plate is doing behind it, where a
 * radial darkening buys the same contrast for a light logo on a bright
 * plate and stays invisible as a shape.
 */
function backdropSvg(g: Geometry, drawHalos: boolean): string {
  const halo = (cx: number) =>
    `<ellipse cx="${cx}" cy="${g.crestCy}" rx="${g.haloRx}" ry="${g.haloRy}" fill="url(#halo)"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${g.w}" height="${g.h}">
  <defs>
    <linearGradient id="band" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="rgba(0,0,0,0)"/>
      <stop offset="0.55" stop-color="rgba(0,0,0,0.55)"/>
      <stop offset="1" stop-color="rgba(0,0,0,0.82)"/>
    </linearGradient>
    <radialGradient id="halo">
      <stop offset="0" stop-color="rgba(0,0,0,0.46)"/>
      <stop offset="0.45" stop-color="rgba(0,0,0,0.26)"/>
      <stop offset="1" stop-color="rgba(0,0,0,0)"/>
    </radialGradient>
  </defs>
  <rect x="0" y="${g.bandTop}" width="${g.w}" height="${g.h - g.bandTop}" fill="url(#band)"/>
  ${drawHalos ? halo(g.homeCx) + halo(g.awayCx) : ""}
</svg>`;
}

/** Team names and the VS mark — real type, over everything. */
function textSvg(g: Geometry, font: string, home: string, away: string): string {
  const family = `${escapeXml(font)}, Segoe UI, Arial, Helvetica, sans-serif`;
  const name = (cx: number, raw: string) => {
    const text = clampName(raw).toUpperCase();
    const size = fitFontSize(text, g.nameSize, g.maxNameWidth);
    return `<text x="${cx}" y="${g.nameBaseline}" text-anchor="middle" font-family="${family}" font-size="${size}" font-weight="700" letter-spacing="0.5" fill="#ffffff">${escapeXml(text)}</text>`;
  };
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${g.w}" height="${g.h}">
  ${name(g.homeCx, home)}
  ${name(g.awayCx, away)}
  <text x="${g.w / 2}" y="${g.crestCy + g.vsSize * 0.36}" text-anchor="middle" font-family="${family}" font-size="${g.vsSize}" font-weight="700" letter-spacing="1.5" fill="rgba(255,255,255,0.82)">VS</text>
</svg>`;
}

export interface ComposedImage {
  imageBase64: string;
  mime: "image/png" | "image/webp";
  /** Diagnostic trail echoed into renderMeta for the admin panel. */
  meta: {
    composed: boolean;
    outputWidth: number;
    outputHeight: number;
    outputFormat: string;
    crests: number;
  };
}

/**
 * Scale the plate to the delivered size, composite the matchup where it
 * applies, and encode. Called for every job — non-versus scopes just
 * take the resize + encode path.
 */
export async function composeBanner(
  cfg: WorkerConfig,
  job: BannerGenJob,
  plate: Buffer,
): Promise<ComposedImage> {
  const sharp = await loadSharp();
  const encodeRaw = (): ComposedImage => ({
    imageBase64: plate.toString("base64"),
    mime: "image/png",
    meta: {
      composed: false,
      outputWidth: cfg.imageWidth,
      outputHeight: cfg.imageHeight,
      outputFormat: "png",
      crests: 0,
    },
  });
  if (!sharp) return encodeRaw();

  try {
    const w = cfg.outputWidth;
    const h = Math.round((w * cfg.imageHeight) / cfg.imageWidth);
    const base = sharp(plate).resize(w, h, { fit: "cover", kernel: "lanczos3" });

    const c = job.context;
    const versusScope =
      job.scope === "match" || job.scope === "market" || job.scope === "outcome";
    const wantsOverlay =
      cfg.compose && versusScope && !!c.homeTeam && !!c.awayTeam;

    let crests = 0;
    if (wantsOverlay) {
      const g = geometry(w, h);
      const [homeRaw, awayRaw] = await Promise.all([
        fetchLogo(c.homeLogoUrl ?? null),
        fetchLogo(c.awayLogoUrl ?? null),
      ]);
      // Fit each crest inside its tile without cropping — esports marks
      // are all over the place aspect-wise, from square shields to long
      // wordmarks. `density` matters for the SVG ones: rasterising at
      // the default 72 dpi and then scaling up is how a crisp vector
      // crest ends up looking like another blurry AI artefact.
      const fitCrest = async (buf: Buffer | null): Promise<Buffer | null> => {
        if (!buf) return null;
        try {
          return await sharp(buf, { density: 384 })
            .resize(g.crestW, g.crestH, {
              fit: "inside",
              withoutEnlargement: false,
              background: { r: 0, g: 0, b: 0, alpha: 0 },
            })
            .png()
            .toBuffer();
        } catch (err) {
          log.warn({ err }, "crest decode failed — skipping it");
          return null;
        }
      };
      const [home, away] = await Promise.all([
        fitCrest(homeRaw),
        fitCrest(awayRaw),
      ]);
      crests = (home ? 1 : 0) + (away ? 1 : 0);

      const layers: Array<{ input: Buffer; top: number; left: number }> = [
        {
          input: Buffer.from(backdropSvg(g, crests > 0)),
          top: 0,
          left: 0,
        },
      ];
      const place = async (buf: Buffer | null, cx: number) => {
        if (!buf) return;
        const m = await sharp(buf).metadata();
        layers.push({
          input: buf,
          left: Math.round(cx - (m.width ?? g.crestW) / 2),
          top: Math.round(g.crestCy - (m.height ?? g.crestH) / 2),
        });
      };
      await place(home, g.homeCx);
      await place(away, g.awayCx);
      layers.push({
        input: Buffer.from(
          textSvg(g, cfg.composeFont, c.homeTeam!, c.awayTeam!),
        ),
        top: 0,
        left: 0,
      });
      base.composite(layers);
    }

    const out =
      cfg.outputFormat === "png"
        ? await base.png({ compressionLevel: 9 }).toBuffer()
        : await base.webp({ quality: cfg.outputQuality }).toBuffer();
    return {
      imageBase64: out.toString("base64"),
      mime: cfg.outputFormat === "png" ? "image/png" : "image/webp",
      meta: {
        composed: wantsOverlay,
        outputWidth: w,
        outputHeight: h,
        outputFormat: cfg.outputFormat,
        crests,
      },
    };
  } catch (err) {
    log.warn({ err, ruleId: job.ruleId }, "compositing failed — shipping bare plate");
    return encodeRaw();
  }
}
