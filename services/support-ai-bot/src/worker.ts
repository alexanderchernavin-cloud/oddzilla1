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
import { LmStudio, type ChatMessage } from "./lmstudio.js";
import { buildMessages } from "./prompt.js";
import { DEFAULT_HOLDING_MESSAGE } from "./guardrails.js";
import { TOOLS, executeTool } from "./tools.js";

const cfg = loadConfig();
const api = new BotApi(cfg);
const lm = new LmStudio(cfg);

let stopped = false;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const MAX_TOOL_ROUNDS = 2;
const ESCALATE_PREFIX = "ESCALATE:";

async function handleThread(thread: SupportBotPendingThread): Promise<void> {
  const model = await lm.discoverModel();
  if (!model) {
    logger.error(
      { event: "no_model", threadId: thread.threadId },
      "no LM Studio model loaded; leaving thread for a human",
    );
    return;
  }

  // The model answers from ACCOUNT_FACTS + the in-context schedule, and may
  // call read-only tools (find_matches / match_markets) to fetch anything it
  // doesn't already have. Loop: run with tools; if it requests a tool, execute
  // it and feed the result back; otherwise its text is the reply. On the final
  // round we drop tools to force a written answer. There are no mutating tools,
  // so the assistant can look anything up but can never change anything.
  const messages: ChatMessage[] = buildMessages(thread);
  let finalContent = "";

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
    const allowTools = round < MAX_TOOL_ROUNDS;
    let completion;
    try {
      completion = await lm.complete(
        model,
        messages,
        allowTools ? TOOLS : undefined,
      );
    } catch (err) {
      logger.error({
        event: "lm_error",
        threadId: thread.threadId,
        err: (err as Error).message,
      });
      return;
    }

    if (allowTools && completion.toolCalls.length > 0) {
      messages.push({
        role: "assistant",
        content: completion.content,
        tool_calls: completion.toolCalls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: c.arguments },
        })),
      });
      for (const call of completion.toolCalls) {
        const result = await executeTool(cfg, call.name, call.arguments);
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: result,
        });
        logger.info({
          event: "tool",
          threadId: thread.threadId,
          tool: call.name,
          args: call.arguments.slice(0, 120),
        });
      }
      continue;
    }

    finalContent = completion.content.trim();
    break;
  }

  if (!finalContent) {
    await api.escalate(thread.threadId, "empty_reply", DEFAULT_HOLDING_MESSAGE);
    logger.warn({ event: "empty_reply", threadId: thread.threadId });
    return;
  }
  if (finalContent.startsWith(ESCALATE_PREFIX)) {
    const note =
      finalContent.slice(ESCALATE_PREFIX.length).trim() ||
      DEFAULT_HOLDING_MESSAGE;
    await api.escalate(thread.threadId, "model_escalate", note);
    logger.info({ event: "escalate", threadId: thread.threadId });
    return;
  }
  const text = finalContent.slice(0, cfg.maxReplyChars);
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

  logger.info({
    event: "poll",
    count: pending.threads.length,
    ids: pending.threads.map((t) => t.threadId.slice(0, 8)),
  });

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
