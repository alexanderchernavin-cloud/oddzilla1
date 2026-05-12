import {
  pgTable,
  bigserial,
  bigint,
  uuid,
  text,
  timestamp,
  jsonb,
  primaryKey,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { liveChatMessageKindEnum } from "../enums.js";
import { matches } from "./catalog.js";
import { users } from "./users.js";

// Append-only message log for live match rooms. The hot path
// reads/writes Redis (chat:msgs:{matchId} capped list); this table is
// the durable backing store for cache misses and admin moderation.
// Reactions are ephemeral (Redis pub/sub) and are NOT stored here.
// See migration 0045_live_chat.sql for the why.
export const liveChatMessages = pgTable(
  "live_chat_messages",
  {
    id: bigserial({ mode: "bigint" }).primaryKey(),
    matchId: bigint({ mode: "bigint" })
      .notNull()
      .references(() => matches.id, { onDelete: "cascade" }),
    kind: liveChatMessageKindEnum().notNull(),
    // Nullable for system messages. The DB CHECK enforces NOT NULL
    // when kind='user'; ON DELETE SET NULL preserves history when a
    // user is hard-deleted (moderation/legal).
    userId: uuid().references(() => users.id, { onDelete: "set null" }),
    text: text().notNull(),
    // Free-text rather than an enum so new system events (red card,
    // var, penalty) ship without a migration. Known values listed in
    // packages/types/src/live-chat.ts.
    systemKind: text(),
    // Snapshot of match state at emit time: { score, clock, status }.
    // NULL for user messages.
    payload: jsonb(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("live_chat_messages_match_created_idx").on(
      t.matchId,
      t.createdAt.desc(),
      t.id.desc(),
    ),
    index("live_chat_messages_user_idx")
      .on(t.userId)
      .where(sql`${t.userId} IS NOT NULL`),
    check(
      "live_chat_messages_text_length",
      sql`length(${t.text}) BETWEEN 1 AND 320`,
    ),
    check(
      "live_chat_messages_user_required",
      sql`${t.kind} <> 'user' OR ${t.userId} IS NOT NULL`,
    ),
    check(
      "live_chat_messages_system_kind_required",
      sql`${t.kind} <> 'system' OR ${t.systemKind} IS NOT NULL`,
    ),
  ],
);

// One pick per (match_id, user_id) — server-enforced double-vote
// prevention for the crowd-picks reveal-on-vote UX (Notion Epic 4).
// Aggregate counters are cached in Redis (chat:picks:{matchId} hash)
// to avoid scanning this table on every viewer join.
export const liveChatPicks = pgTable(
  "live_chat_picks",
  {
    matchId: bigint({ mode: "bigint" })
      .notNull()
      .references(() => matches.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // 'home' | 'draw' | 'away'. Free-text + CHECK rather than enum so
    // future no-draw sports (Valorant best-of) can extend without a
    // schema migration. API constrains the zod input.
    pick: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.matchId, t.userId] }),
    index("live_chat_picks_match_pick_idx").on(t.matchId, t.pick),
    check(
      "live_chat_picks_value",
      sql`${t.pick} IN ('home', 'draw', 'away')`,
    ),
  ],
);
