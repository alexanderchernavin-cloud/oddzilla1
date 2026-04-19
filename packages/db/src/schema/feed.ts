import { sql } from "drizzle-orm";
import {
  pgTable,
  bigserial,
  bigint,
  smallint,
  text,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { matches } from "./catalog.js";

export const feedMessages = pgTable(
  "feed_messages",
  {
    id: bigserial({ mode: "bigint" }).primaryKey(),
    matchId: bigint({ mode: "bigint" }).references(() => matches.id, {
      onDelete: "cascade",
    }),
    eventUrn: text(),
    kind: text().notNull(),
    routingKey: text(),
    product: smallint(),
    payloadXml: text().notNull(),
    receivedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("feed_messages_match_ts_idx").on(t.matchId, sql`${t.receivedAt} DESC`),
    index("feed_messages_received_idx").on(t.receivedAt),
    index("feed_messages_event_urn_idx").on(t.eventUrn, sql`${t.receivedAt} DESC`),
  ],
);

export type FeedMessage = typeof feedMessages.$inferSelect;
