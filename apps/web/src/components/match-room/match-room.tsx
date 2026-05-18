"use client";

// MatchRoom — full-height chat panel for a live match.
//
// Implements Notion epics 1-6 (notion.so/Live-match-chat) over the
// oddzilla1 stack:
//
//   - useLiveChatRoom for state (REST snapshot + WS frames + actions)
//   - useWsConnected drives the "Reconnecting…" banner (Epic 6)
//   - Reveal-on-vote (Epic 4) — crowdPicks is null until the caller
//     submits a pick; both server (snapshot) and client (frame) gate it
//   - Reactions render as named chips, not emoji glyphs, per CLAUDE.md
//     invariant 8
//
// Style notes: Tailwind utilities only. Themed against the site's
// design tokens (`var(--color-*)` from apps/web/src/app/globals.css),
// so the chat blends into both light and dark themes instead of
// staying dark-slate while the rest of the app is editorial cream.

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  LiveChatBetPin,
  LiveChatCrowdPicks,
  LiveChatMatchSnapshot,
  LiveChatMessage,
  PickOutcome,
  ReactionKind,
} from "@oddzilla/types/live-chat";
import { REACTION_KINDS } from "@oddzilla/types/live-chat";
import { useLiveChatRoom, type ReactionBurst } from "@/lib/use-live-chat-room";
import { useWsConnected } from "@/lib/use-live-odds";

const MESSAGE_LIMIT = 160;
const CHAR_COUNTER_THRESHOLD = 140;

const REACTION_LABEL: Record<ReactionKind, string> = {
  goal: "GOAL",
  miss: "MISS",
  redcard: "RC",
  fire: "FIRE",
  cry: "CRY",
  hundred: "100",
};

export interface MatchRoomProps {
  matchId: string;
  // Pre-loaded from /auth/me on the server side. The room degrades to
  // read-only when null (anonymous viewer). Authenticated callers see
  // the input enabled; if they lack a nickname the API returns
  // nickname_required and the input surfaces it inline — no extra
  // round-trip on mount just to render an enabled/disabled state.
  viewer: { id: string } | null;
}

export function MatchRoom({ matchId, viewer }: MatchRoomProps) {
  const room = useLiveChatRoom(matchId);
  const connected = useWsConnected();
  const authed = viewer != null;

  if (room.load.kind === "loading") {
    return (
      <div className="rounded-[10px] border border-[var(--color-border)] bg-[var(--color-surface)] p-6 text-sm text-[var(--color-fg-muted)]">
        Loading match room…
      </div>
    );
  }
  if (room.load.kind === "error") {
    return (
      <div className="rounded-[10px] border border-[var(--color-negative)]/40 bg-[var(--color-negative)]/10 p-6 text-sm text-[var(--color-negative)]">
        Couldn&rsquo;t load match room: {room.load.message}
      </div>
    );
  }

  return (
    <div className="flex h-[600px] flex-col overflow-hidden rounded-[10px] border border-[var(--color-border)] bg-[var(--color-surface)] text-sm text-[var(--color-fg)]">
      <MatchHeaderBar match={room.match} viewerCount={room.viewerCount} />
      <BetPinCard betPin={room.betPin} match={room.match} />
      <CrowdPicksRow
        myPick={room.myPick}
        crowdPicks={room.crowdPicks}
        canVote={authed}
        onPick={room.submitPick}
      />
      <MessageList messages={room.messages} bursts={room.bursts} />
      {!connected && <ReconnectBanner />}
      <ReactionBar
        disabled={!authed || !connected}
        onReact={room.reactWith}
      />
      <MessageInputBar
        disabled={!authed || !connected}
        onSend={room.sendMessage}
      />
    </div>
  );
}

// ─── Header ──────────────────────────────────────────────────────────────

function MatchHeaderBar({
  match,
  viewerCount,
}: {
  match: LiveChatMatchSnapshot | null;
  viewerCount: number;
}) {
  const score = match
    ? `${match.score.home}-${match.score.away}`
    : "0-0";
  const status =
    match?.status === "live"
      ? "LIVE"
      : match?.status === "fulltime"
        ? "FT"
        : match?.status === "halftime"
          ? "HT"
          : match?.status === "suspended"
            ? "SUSP"
            : "—";
  const isLive = match?.status === "live";
  return (
    <div className="flex items-center justify-between border-b border-[var(--color-hairline)] bg-[var(--color-surface-2)] px-4 py-3">
      <div className="flex items-center gap-3">
        <span
          className={
            isLive
              ? "inline-flex h-2 w-2 rounded-full bg-[var(--color-live)]"
              : "inline-flex h-2 w-2 rounded-full bg-[var(--color-fg-dim)]"
          }
        />
        <span className="font-semibold tracking-wide">{status}</span>
        <span className="font-mono text-base text-[var(--color-fg)]">{score}</span>
        {match?.clock ? (
          <span className="font-mono text-xs text-[var(--color-fg-muted)]">{match.clock}</span>
        ) : null}
      </div>
      <ViewerPill count={viewerCount} />
    </div>
  );
}

function ViewerPill({ count }: { count: number }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-border)] px-2.5 py-1 text-xs text-[var(--color-fg-muted)]">
      <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-fg-dim)]" />
      {count.toLocaleString()} watching
    </span>
  );
}

// ─── BetPin ──────────────────────────────────────────────────────────────

// Derived UI status for a live (still-pending) bet. Maps the bet's
// pickedSide (server-derived from market+outcome shape) against the
// running score. Returns null for terminal statuses, for unknown
// market shapes (pickedSide=null), or before the match has started.
// Exported for unit testing.
export function deriveLiveStatus(
  betPin: LiveChatBetPin | null,
  match: LiveChatMatchSnapshot | null,
): "winning" | "at_risk" | "level" | null {
  if (!betPin || !match) return null;
  // Terminal lifecycle states already carry their colour via
  // betPin.status — no live derivation.
  if (betPin.status !== "pending") return null;
  // Unknown market geometry (totals, BTTS, etc.) — show raw label
  // only.
  if (!betPin.pickedSide) return null;
  const { home, away } = match.score;
  if (betPin.pickedSide === "home") {
    if (home > away) return "winning";
    if (home < away) return "at_risk";
    return "level";
  }
  if (betPin.pickedSide === "away") {
    if (away > home) return "winning";
    if (away < home) return "at_risk";
    return "level";
  }
  // draw
  return home === away ? "winning" : "at_risk";
}

function BetPinCard({
  betPin,
  match,
}: {
  betPin: LiveChatBetPin | null;
  match: LiveChatMatchSnapshot | null;
}) {
  if (!betPin) return null;
  const liveStatus = deriveLiveStatus(betPin, match);
  const dot =
    betPin.status === "won" || liveStatus === "winning"
      ? "bg-[var(--color-positive)]"
      : betPin.status === "lost" || liveStatus === "at_risk"
        ? "bg-[var(--color-negative)]"
        : "bg-[var(--color-fg-dim)]";
  const badge =
    betPin.status === "won"
      ? "Won"
      : betPin.status === "lost"
        ? "Lost"
        : betPin.status === "void"
          ? "Void"
          : betPin.status === "cashed_out"
            ? "Cashed out"
            : liveStatus === "winning"
              ? "Winning"
              : liveStatus === "at_risk"
                ? "At risk"
                : liveStatus === "level"
                  ? "Level"
                  : null;
  const badgeStyle =
    liveStatus === "winning" || betPin.status === "won"
      ? "bg-[var(--color-positive)]/15 text-[var(--color-positive)]"
      : liveStatus === "at_risk" || betPin.status === "lost"
        ? "bg-[var(--color-negative)]/15 text-[var(--color-negative)]"
        : "bg-[var(--color-bg-elevated)] text-[var(--color-fg-muted)] border border-[var(--color-border)]";
  const odds = (betPin.oddsX10000 / 10_000).toFixed(2);
  return (
    <div className="border-b border-[var(--color-hairline)] bg-[var(--color-bg-elevated)] px-4 py-2.5 text-xs">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-2 text-[var(--color-fg-muted)]">
          <span className={`h-2 w-2 rounded-full ${dot}`} />
          <span className="uppercase tracking-wide text-[var(--color-fg-dim)]">
            Your pick
          </span>
          <span className="font-medium text-[var(--color-fg)]">
            {betPin.outcomeLabel}
          </span>
          <span className="font-mono text-[var(--color-fg-muted)]">@ {odds}</span>
          {badge ? (
            <span
              className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${badgeStyle}`}
            >
              {badge}
            </span>
          ) : null}
        </span>
        <span className="font-mono text-[var(--color-fg)]">
          {formatMicroAmount(betPin.potentialWinMicro)} {betPin.currency}
        </span>
      </div>
    </div>
  );
}

// ─── Crowd picks ─────────────────────────────────────────────────────────

const PICK_LABEL: Record<PickOutcome, string> = {
  home: "Home",
  draw: "Draw",
  away: "Away",
};

function CrowdPicksRow({
  myPick,
  crowdPicks,
  canVote,
  onPick,
}: {
  myPick: PickOutcome | null;
  crowdPicks: LiveChatCrowdPicks | null;
  canVote: boolean;
  onPick: (
    pick: PickOutcome,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
}) {
  const [submitting, setSubmitting] = useState<PickOutcome | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const handleVote = async (pick: PickOutcome) => {
    if (!canVote || submitting) return;
    setErr(null);
    setSubmitting(pick);
    const res = await onPick(pick);
    setSubmitting(null);
    if (!res.ok) setErr(res.error);
  };

  // Pre-vote: blurred row with three buttons + prompt.
  if (!myPick || !crowdPicks) {
    return (
      <div className="border-b border-[var(--color-hairline)] bg-[var(--color-surface)] px-4 py-2.5">
        <div className="mb-1.5 text-xs text-[var(--color-fg-muted)]">
          {canVote
            ? "Pick the winner to see the room"
            : "Sign in to see who the room is backing"}
        </div>
        <div className="grid grid-cols-3 gap-2">
          {(["home", "draw", "away"] as PickOutcome[]).map((p) => (
            <button
              key={p}
              type="button"
              disabled={!canVote || submitting !== null}
              onClick={() => handleVote(p)}
              className="rounded border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-3 py-1.5 text-xs font-medium text-[var(--color-fg)] transition-colors hover:bg-[var(--color-surface-2)] disabled:opacity-50"
            >
              {submitting === p ? "…" : PICK_LABEL[p]}
            </button>
          ))}
        </div>
        {err ? <div className="mt-1.5 text-xs text-[var(--color-negative)]">{err}</div> : null}
      </div>
    );
  }

  // Post-vote: animated bars.
  const total = crowdPicks.totalVotes || 1;
  const pct = {
    home: Math.round((crowdPicks.home / total) * 100),
    draw: Math.round((crowdPicks.draw / total) * 100),
    away: Math.round((crowdPicks.away / total) * 100),
  };
  return (
    <div className="border-b border-[var(--color-hairline)] bg-[var(--color-surface)] px-4 py-2.5">
      <div className="mb-1.5 flex items-center justify-between text-xs text-[var(--color-fg-muted)]">
        <span>
          Crowd picks · {crowdPicks.totalVotes.toLocaleString()} votes
        </span>
        <span className="text-[var(--color-fg-dim)]">
          You picked {PICK_LABEL[myPick]}
        </span>
      </div>
      <div className="space-y-1">
        {(["home", "draw", "away"] as PickOutcome[]).map((p) => (
          <PickBar
            key={p}
            label={PICK_LABEL[p]}
            percent={pct[p]}
            highlighted={myPick === p}
          />
        ))}
      </div>
    </div>
  );
}

function PickBar({
  label,
  percent,
  highlighted,
}: {
  label: string;
  percent: number;
  highlighted: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <span
        className={`w-12 text-xs ${highlighted ? "font-medium text-[var(--color-fg)]" : "text-[var(--color-fg-muted)]"}`}
      >
        {label}
      </span>
      <div className="relative h-2 flex-1 overflow-hidden rounded bg-[var(--color-bg-elevated)]">
        <div
          className={`absolute inset-y-0 left-0 transition-[width] duration-500 ${highlighted ? "bg-[var(--color-accent)]" : "bg-[var(--color-fg-dim)]"}`}
          style={{ width: `${percent}%` }}
        />
      </div>
      <span className="w-9 text-right font-mono text-xs text-[var(--color-fg-muted)]">
        {percent}%
      </span>
    </div>
  );
}

// ─── Message feed ────────────────────────────────────────────────────────

function MessageList({
  messages,
  bursts,
}: {
  messages: LiveChatMessage[];
  bursts: ReactionBurst[];
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [pinnedToBottom, setPinnedToBottom] = useState(true);
  const [unread, setUnread] = useState(0);
  const lastSeenCountRef = useRef(messages.length);

  // Track scroll position — when the user pushes up by more than a
  // viewport's worth of text we stop auto-scrolling and start
  // counting unread messages.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const onScroll = () => {
      const atBottom =
        el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      setPinnedToBottom(atBottom);
      if (atBottom) {
        setUnread(0);
        lastSeenCountRef.current = messages.length;
      }
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [messages.length]);

  // Auto-scroll on new messages when pinned; otherwise count unread.
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    if (pinnedToBottom) {
      el.scrollTop = el.scrollHeight;
      lastSeenCountRef.current = messages.length;
    } else {
      setUnread(messages.length - lastSeenCountRef.current);
    }
  }, [messages, pinnedToBottom]);

  const jump = () => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    setPinnedToBottom(true);
    setUnread(0);
    lastSeenCountRef.current = messages.length;
  };

  return (
    <div className="relative flex-1 overflow-hidden">
      <div
        ref={scrollerRef}
        className="absolute inset-0 overflow-y-auto px-4 py-3"
      >
        {messages.length === 0 ? (
          <div className="text-xs text-[var(--color-fg-dim)]">
            No messages yet. Be the first to say something.
          </div>
        ) : (
          <ul className="space-y-2">
            {messages.map((m) => (
              <li key={m.id}>
                <MessageRow message={m} />
              </li>
            ))}
          </ul>
        )}
      </div>
      <BurstOverlay bursts={bursts} />
      {!pinnedToBottom && unread > 0 ? (
        <button
          type="button"
          onClick={jump}
          className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-[var(--color-accent)] bg-[var(--color-accent)] px-3 py-1 text-xs font-medium text-[var(--color-accent-fg)] shadow-[var(--shadow-md)]"
        >
          {unread} new {unread === 1 ? "message" : "messages"} ↓
        </button>
      ) : null}
    </div>
  );
}

function MessageRow({ message }: { message: LiveChatMessage }) {
  if (message.kind === "system") {
    return (
      <div className="flex items-center gap-2 rounded border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-3 py-1.5 text-xs">
        <span className="rounded bg-[var(--color-surface-2)] px-1.5 py-0.5 font-medium uppercase tracking-wide text-[var(--color-fg-muted)]">
          {message.systemKind.replace("_", " ")}
        </span>
        <span className="text-[var(--color-fg)]">{message.text}</span>
      </div>
    );
  }
  return (
    <div className="flex items-start gap-2">
      <span className="mt-0.5 inline-flex h-7 w-7 flex-none items-center justify-center rounded-full border border-[var(--color-border)] bg-[var(--color-bg-elevated)] text-[10px] font-semibold text-[var(--color-fg)]">
        {message.avatarInitials}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-xs text-[var(--color-fg-muted)]">{message.nickname}</div>
        <div className="break-words text-sm text-[var(--color-fg)]">{message.text}</div>
      </div>
    </div>
  );
}

// ─── Reaction bursts ─────────────────────────────────────────────────────

function BurstOverlay({ bursts }: { bursts: ReactionBurst[] }) {
  // Cap visible bursts so a flood of reactions doesn't blanket the
  // message feed. Newest at the top of the stack.
  const visible = useMemo(() => bursts.slice(-5), [bursts]);
  if (visible.length === 0) return null;
  return (
    <div className="pointer-events-none absolute right-3 top-3 flex flex-col items-end gap-1">
      {visible.map((b) => (
        <span
          key={b.id}
          className="animate-pulse rounded-full border border-[var(--color-accent)] bg-[var(--color-bg-card)] px-2.5 py-1 text-[11px] font-medium text-[var(--color-fg)] shadow-[var(--shadow-md)]"
        >
          {b.nickname}: {REACTION_LABEL[b.reaction]}
        </span>
      ))}
    </div>
  );
}

// ─── Reaction bar ────────────────────────────────────────────────────────

function ReactionBar({
  disabled,
  onReact,
}: {
  disabled: boolean;
  onReact: (
    r: ReactionKind,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
}) {
  const [busy, setBusy] = useState<ReactionKind | null>(null);
  const handle = async (r: ReactionKind) => {
    if (disabled || busy) return;
    setBusy(r);
    await onReact(r);
    setBusy(null);
  };
  return (
    // Equal-width 6-column grid (was a flex row with horizontal padding
    // that overflowed the 340px rail and clipped the "100" chip on the
    // right). Each button now claims `1fr` of the row, so the labels
    // fit no matter how narrow the panel gets.
    <div className="grid grid-cols-6 gap-1 border-t border-[var(--color-hairline)] bg-[var(--color-surface)] px-3 py-2">
      {REACTION_KINDS.map((r) => (
        <button
          key={r}
          type="button"
          disabled={disabled || busy !== null}
          onClick={() => handle(r)}
          title={r}
          className="min-w-0 truncate rounded border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-1 py-1 text-[10px] font-semibold uppercase tracking-tight text-[var(--color-fg-muted)] transition-colors hover:bg-[var(--color-surface-2)] hover:text-[var(--color-fg)] disabled:opacity-40"
        >
          {REACTION_LABEL[r]}
        </button>
      ))}
    </div>
  );
}

// ─── Message input ───────────────────────────────────────────────────────

function MessageInputBar({
  disabled,
  onSend,
}: {
  disabled: boolean;
  onSend: (
    text: string,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const trimmed = text.trim();
  const tooLong = text.length > MESSAGE_LIMIT;
  const showCounter = text.length >= CHAR_COUNTER_THRESHOLD;
  const remaining = MESSAGE_LIMIT - text.length;
  const canSend =
    !disabled && !busy && trimmed.length > 0 && trimmed.length <= MESSAGE_LIMIT;

  const submit = async () => {
    if (!canSend) return;
    setErr(null);
    setBusy(true);
    const res = await onSend(trimmed);
    setBusy(false);
    if (res.ok) setText("");
    else setErr(res.error);
  };

  return (
    <div className="border-t border-[var(--color-hairline)] bg-[var(--color-surface)] px-4 py-2.5">
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={text}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder={disabled ? "Reconnecting…" : "Say something"}
          maxLength={MESSAGE_LIMIT + 40}
          className={`min-w-0 flex-1 rounded border bg-[var(--color-bg-elevated)] px-3 py-1.5 text-sm text-[var(--color-fg)] placeholder:text-[var(--color-fg-dim)] focus:outline-none focus:ring-1 ${tooLong ? "border-[var(--color-negative)] focus:ring-[var(--color-negative)]" : "border-[var(--color-border)] focus:ring-[var(--color-accent)]"}`}
        />
        <button
          type="button"
          onClick={() => void submit()}
          disabled={!canSend}
          className="rounded bg-[var(--color-accent)] px-3 py-1.5 text-xs font-semibold text-[var(--color-accent-fg)] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? "…" : "Send"}
        </button>
      </div>
      <div className="mt-1 flex items-center justify-between text-[11px]">
        <span className={err ? "text-[var(--color-negative)]" : "text-[var(--color-fg-dim)]"}>
          {err ?? ""}
        </span>
        {showCounter ? (
          <span
            className={
              tooLong
                ? "font-mono text-[var(--color-negative)]"
                : "font-mono text-[var(--color-fg-muted)]"
            }
          >
            {remaining}
          </span>
        ) : null}
      </div>
    </div>
  );
}

// ─── Reconnect banner (Notion Epic 6) ────────────────────────────────────

function ReconnectBanner() {
  return (
    <div className="border-t border-[var(--color-hairline)] bg-[var(--color-bg-elevated)] px-4 py-1.5 text-center text-xs text-[var(--color-fg-muted)]">
      Reconnecting…
    </div>
  );
}

// ─── helpers ─────────────────────────────────────────────────────────────

function formatMicroAmount(micro: string): string {
  // bigint-as-decimal-string with 6 decimals → trimmed display value
  // (CLAUDE.md invariant 1). Skip BigInt for a cheap trim since we
  // only render two decimal places.
  const n = Number(micro);
  if (!Number.isFinite(n)) return "0.00";
  return (n / 1_000_000).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
