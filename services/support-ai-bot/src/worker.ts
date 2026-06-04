// Main loop. Two concurrent loops:
//   - heartbeat: tells the server the assistant is online (drives the admin
//     "Assistant online" dot). When this PC is off the key expires and the
//     admin shows offline; threads simply wait for a human.
//   - poll: fetch open, AI-handled threads with an unanswered bettor message,
//     run the local model, and either reply or escalate to a human.
//
// Posting a reply clears unread_admin server-side, so the same message is
// never answered twice. A human "Take over" flips ai_handling=false and the
// thread drops out of /pending; the bot won't touch it again until "Resume AI".

import type {
  SupportBotPendingResponse,
  SupportBotPendingThread,
} from "@oddzilla/types";
import { loadConfig } from "./config.js";
import { logger } from "./logger.js";
import { BotApi, BotApiError } from "./api-client.js";
import { LmStudio } from "./lmstudio.js";
import { buildMessages } from "./prompt.js";
import {
  DEFAULT_HOLDING_MESSAGE,
  RG_HOLDING_MESSAGE,
  isResponsibleGamblingConcern,
  parseDecision,
  replyLooksUnsafe,
} from "./guardrails.js";

const cfg = loadConfig();
const api = new BotApi(cfg);
const lm = new LmStudio(cfg);

let stopped = false;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function latestUserMessage(thread: SupportBotPendingThread): string {
  for (let i = thread.messages.length - 1; i >= 0; i -= 1) {
    const m = thread.messages[i];
    if (m && m.sender === "user") return m.body;
  }
  return "";
}

async function handleThread(thread: SupportBotPendingThread): Promise<void> {
  const userText = latestUserMessage(thread);

  // 1) Responsible-gambling backstop — fires regardless of the model.
  if (userText && isResponsibleGamblingConcern(userText)) {
    await api.escalate(thread.threadId, "responsible_gambling", RG_HOLDING_MESSAGE);
    logger.warn({
      event: "escalate",
      threadId: thread.threadId,
      reason: "responsible_gambling",
    });
    return;
  }

  // 2) Resolve the model (auto-discovers the loaded one if not pinned).
  const model = await lm.discoverModel();
  if (!model) {
    logger.error(
      { event: "no_model", threadId: thread.threadId },
      "no LM Studio model loaded; leaving thread for a human",
    );
    return;
  }

  // 3) Ask the model.
  let raw: string;
  try {
    raw = await lm.chat(model, buildMessages(thread));
  } catch (err) {
    // Leave the thread pending — the next tick retries once LM Studio responds.
    logger.error({
      event: "lm_error",
      threadId: thread.threadId,
      err: (err as Error).message,
    });
    return;
  }

  const decision = parseDecision(raw);
  if (!decision) {
    logger.warn({ event: "unparseable", threadId: thread.threadId });
    await api.escalate(
      thread.threadId,
      "unparseable_model_output",
      DEFAULT_HOLDING_MESSAGE,
    );
    return;
  }

  if (decision.action === "escalate") {
    await api.escalate(
      thread.threadId,
      decision.reason ?? "model_escalate",
      decision.message.trim() || DEFAULT_HOLDING_MESSAGE,
    );
    logger.info({
      event: "escalate",
      threadId: thread.threadId,
      reason: decision.reason ?? "model_escalate",
    });
    return;
  }

  // 4) Reply path — deterministic output guardrails before sending.
  const text = decision.message.trim().slice(0, cfg.maxReplyChars);
  if (!text || replyLooksUnsafe(text)) {
    await api.escalate(
      thread.threadId,
      "unsafe_or_empty_reply",
      DEFAULT_HOLDING_MESSAGE,
    );
    logger.warn({ event: "blocked_reply", threadId: thread.threadId });
    return;
  }
  await api.reply(thread.threadId, text);
  logger.info({ event: "reply", threadId: thread.threadId, chars: text.length });
}

async function pollOnce(): Promise<void> {
  let pending: SupportBotPendingResponse | null = null;
  try {
    pending = await api.pending(cfg.pendingBatch);
  } catch (err) {
    if (err instanceof BotApiError && err.status === 503) {
      logger.warn(
        { event: "bot_disabled" },
        "server reports bot disabled — is SUPPORT_AI_BOT_TOKEN set on the server?",
      );
    } else if (err instanceof BotApiError && err.status === 404) {
      logger.error(
        { event: "bad_token" },
        "server returned 404 — SUPPORT_AI_BOT_TOKEN likely mismatched",
      );
    } else {
      logger.error({ event: "pending_error", err: (err as Error).message });
    }
    return;
  }
  if (!pending) return;

  for (const thread of pending.threads) {
    if (stopped) break;
    try {
      await handleThread(thread);
    } catch (err) {
      if (
        err instanceof BotApiError &&
        (err.code === "ai_paused" || err.code === "thread_closed")
      ) {
        // Raced with a human taking over / closing the thread — fine, skip.
        logger.info({
          event: "skip",
          threadId: thread.threadId,
          code: err.code,
        });
      } else {
        logger.error({
          event: "handle_error",
          threadId: thread.threadId,
          err: (err as Error).message,
        });
      }
    }
  }
}

async function heartbeatLoop(): Promise<void> {
  while (!stopped) {
    try {
      await api.heartbeat();
    } catch (err) {
      logger.warn({ event: "heartbeat_error", err: (err as Error).message });
    }
    await sleep(cfg.heartbeatIntervalMs);
  }
}

async function pollLoop(): Promise<void> {
  while (!stopped) {
    await pollOnce();
    await sleep(cfg.pollIntervalMs);
  }
}

export async function run(): Promise<void> {
  logger.info(
    {
      event: "start",
      apiBase: cfg.apiBase,
      lmStudio: cfg.lmStudioBaseUrl,
      model: cfg.lmStudioModel ?? "(auto-detect)",
    },
    "support-ai-bot starting",
  );

  const model = await lm.discoverModel();
  if (model) {
    logger.info({ event: "model", model }, "LM Studio model detected");
  } else {
    logger.warn(
      { event: "no_model" },
      "no model loaded in LM Studio yet — load one to start replying (the bot keeps heartbeating and retries each tick)",
    );
  }

  const stop = (): void => {
    stopped = true;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  await Promise.all([heartbeatLoop(), pollLoop()]);
  logger.info({ event: "stopped" }, "support-ai-bot stopped");
}
