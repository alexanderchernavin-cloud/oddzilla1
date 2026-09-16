// Brand-token failover for the Disir widgets.
//
// The local URL fallback (disir-url.ts) covers api-disir being down. It
// cannot cover the BRAND TOKEN being refused, because that check runs on
// Oddin's widget host when the iframe loads, and a URL we build carries
// the same token a URL they issue would. So a second token is the only
// remedy, and this module decides which of the two the proxy uses.
//
// Measured 2026-09-16 (docs/ODDIN.md "Disir widgets"): BOTH widget hosts
// check the Referer's registrable domain against a per-token registry and
// refuse a missing Referer. Our token is registered for oddzilla.cc on the
// integration host only; a backup token is useful only once Oddin has
// registered our domain on it, on whichever host `DISIR_BACKUP_ENV` names.
//
// Two signals decide the slot:
//
// 1. A periodic PROBE of the widget host with the primary token — a GET of
//    a tournament widget page with `Referer: https://<FRONTEND_HOST>/`, a
//    fresh cache-buster and `Accept-Encoding: gzip`. The last two are
//    load-bearing, not cosmetic: CloudFront caches a 200 obtained with an
//    authorised referer and serves it to anyone for minutes, keyed on the
//    URL and the encoding, so a probe without them can report a token
//    healthy for as long as somebody else's success is cached. A 403 is
//    the host refusing the token for our domain; 401 from the REST is the
//    issuer refusing it. Anything else (5xx, timeout) says nothing about
//    the token — the host itself is unwell — and leaves the slot as it is.
// 2. A 401 from api-disir on the primary during an ordinary request,
//    which the route reports here so the switch does not wait for the
//    next probe.
//
// The decision is the pure `decideSlot`; the state lives in Redis
// (`disir:token:slot`) so every api process — there is one today — reads
// the same answer, and it self-heals: a probe that finds the primary
// healthy again moves the slot back.

import type { Redis } from "ioredis";
import { disirWidgetHost, encodeDisirId, randomCacheBuster, type DisirEnv } from "./disir-url.js";

export type TokenSlot = "primary" | "backup";

export interface TokenCredentials {
  slot: TokenSlot;
  brandToken: string;
  env: DisirEnv;
}

export type ProbeVerdict = "ok" | "refused" | "unknown";

export interface ProbeResult {
  verdict: ProbeVerdict;
  status: number | null;
  detail?: string;
}

// What the widget host is asked for: a tournament widget, because it
// needs no team ids, for a tournament that does not have to exist — the
// host answers the token/domain check before the page ever looks at the
// id, and a 200 here is the same 200 a real embed gets.
const PROBE_TOURNAMENT_URN = "od:tournament:1";
const PROBE_TIMEOUT_MS = 8000;
const PROBE_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

export function probeUrl(env: DisirEnv, brandToken: string): string {
  const qs = new URLSearchParams();
  qs.set("availableData", "tournament");
  qs.set("brandToken", brandToken);
  qs.set("darkMode", "true");
  qs.set("id", encodeDisirId("tournament", PROBE_TOURNAMENT_URN));
  qs.set("lang", "en");
  qs.set("layout", "default");
  qs.set("t", String(randomCacheBuster()));
  qs.set("theme", "dark");
  qs.sort();
  return `${disirWidgetHost(env)}/csgo/tournament?${qs.toString()}`;
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; signal: AbortSignal; redirect: "manual" },
) => Promise<{ status: number }>;

// Asks the widget host whether it would serve a widget to our storefront
// with this token. `refererOrigin` is the storefront origin the host has
// (or has not) registered for the token.
export async function probeWidgetHost(
  env: DisirEnv,
  brandToken: string,
  refererOrigin: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<ProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetchImpl(probeUrl(env, brandToken), {
      method: "GET",
      headers: {
        "user-agent": PROBE_USER_AGENT,
        accept: "text/html,application/xhtml+xml,*/*;q=0.8",
        "accept-encoding": "gzip, deflate, br",
        referer: `${refererOrigin.replace(/\/$/, "")}/`,
        "sec-fetch-dest": "iframe",
        "sec-fetch-mode": "navigate",
        "sec-fetch-site": "cross-site",
      },
      signal: controller.signal,
      redirect: "manual",
    });
    if (res.status === 200) return { verdict: "ok", status: 200 };
    if (res.status === 403 || res.status === 401) {
      return { verdict: "refused", status: res.status };
    }
    return { verdict: "unknown", status: res.status };
  } catch (err) {
    return {
      verdict: "unknown",
      status: null,
      detail: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

// The whole policy, kept pure so it is testable without a network:
// - no backup configured → primary, whatever the probes say (there is
//   nothing else to use, and a refused primary is at least visible);
// - primary healthy → primary, even if we were on the backup: the backup
//   is a bridge, not a new home;
// - primary refused and backup healthy → backup;
// - primary refused and backup ALSO refused or unknown → stay where we
//   are. Moving to a backup we have not seen work would trade a known
//   failure for an unknown one;
// - primary unknown (host unwell) → stay where we are.
export function decideSlot(
  current: TokenSlot,
  hasBackup: boolean,
  primary: ProbeVerdict,
  backup: ProbeVerdict | null,
): TokenSlot {
  if (!hasBackup) return "primary";
  if (primary === "ok") return "primary";
  if (primary === "refused" && backup === "ok") return "backup";
  return current;
}

// ── Redis-held slot state ──────────────────────────────────────────────

const SLOT_KEY = "disir:token:slot";
// Long enough to outlive a probe interval by a wide margin; a lost key
// simply reads as primary, which is the safe default.
const SLOT_TTL_SECONDS = 24 * 3600;

export interface SlotState {
  slot: TokenSlot;
  since: number;
  reason: string;
}

export async function readSlot(redis: Redis): Promise<SlotState> {
  const raw = await redis.get(SLOT_KEY).catch(() => null);
  if (raw) {
    try {
      const v = JSON.parse(raw) as Partial<SlotState>;
      if ((v.slot === "primary" || v.slot === "backup") && typeof v.since === "number") {
        return { slot: v.slot, since: v.since, reason: typeof v.reason === "string" ? v.reason : "" };
      }
    } catch {
      // corrupt → primary
    }
  }
  return { slot: "primary", since: 0, reason: "default" };
}

export async function writeSlot(redis: Redis, state: SlotState): Promise<void> {
  await redis.set(SLOT_KEY, JSON.stringify(state), "EX", SLOT_TTL_SECONDS).catch(() => null);
}

export interface TokenConfig {
  primary: { brandToken: string; env: DisirEnv };
  backup: { brandToken: string; env: DisirEnv } | null;
}

export function credentialsFor(cfg: TokenConfig, slot: TokenSlot): TokenCredentials {
  if (slot === "backup" && cfg.backup) {
    return { slot: "backup", brandToken: cfg.backup.brandToken, env: cfg.backup.env };
  }
  return { slot: "primary", brandToken: cfg.primary.brandToken, env: cfg.primary.env };
}

// One probe round: reads the current slot, probes what needs probing,
// writes the decision back. Returns the new state and the verdicts so the
// caller can log a transition. `probe` is injectable for tests.
export async function runProbeRound(
  redis: Redis,
  cfg: TokenConfig,
  refererOrigin: string,
  probe: (env: DisirEnv, token: string, referer: string) => Promise<ProbeResult> = probeWidgetHost,
): Promise<{ before: SlotState; after: SlotState; primary: ProbeResult; backup: ProbeResult | null }> {
  const before = await readSlot(redis);
  const primary = await probe(cfg.primary.env, cfg.primary.brandToken, refererOrigin);
  let backup: ProbeResult | null = null;
  // The backup is only worth a request when the primary is refused; a
  // healthy primary decides on its own.
  if (cfg.backup && primary.verdict === "refused") {
    backup = await probe(cfg.backup.env, cfg.backup.brandToken, refererOrigin);
  }
  const slot = decideSlot(before.slot, cfg.backup !== null, primary.verdict, backup?.verdict ?? null);
  const after: SlotState =
    slot === before.slot
      ? before
      : {
          slot,
          since: Date.now(),
          reason:
            slot === "backup"
              ? `primary refused (${primary.status ?? "n/a"}), backup ok`
              : `primary ok (${primary.status ?? "n/a"})`,
        };
  if (after !== before) await writeSlot(redis, after);
  return { before, after, primary, backup };
}
