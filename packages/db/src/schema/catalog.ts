import { sql } from "drizzle-orm";
import {
  pgTable,
  serial,
  bigserial,
  integer,
  smallint,
  text,
  boolean,
  timestamp,
  jsonb,
  unique,
  index,
} from "drizzle-orm/pg-core";
import { sportKindEnum, matchStatusEnum } from "../enums.js";

export const sports = pgTable(
  "sports",
  {
    id: serial().primaryKey(),
    provider: text().notNull().default("oddin"),
    providerUrn: text().notNull(),
    slug: text().notNull().unique(),
    name: text().notNull(),
    kind: sportKindEnum().notNull().default("esport"),
    active: boolean().notNull().default(true),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("sports_provider_urn").on(t.provider, t.providerUrn)],
);

export const categories = pgTable(
  "categories",
  {
    id: serial().primaryKey(),
    sportId: integer()
      .notNull()
      .references(() => sports.id, { onDelete: "cascade" }),
    providerUrn: text(),
    slug: text().notNull(),
    name: text().notNull(),
    isDummy: boolean().notNull().default(false),
    active: boolean().notNull().default(true),
  },
  (t) => [
    unique("categories_sport_slug").on(t.sportId, t.slug),
    unique("categories_sport_urn").on(t.sportId, t.providerUrn),
    index("categories_sport_idx").on(t.sportId),
  ],
);

export const tournaments = pgTable(
  "tournaments",
  {
    id: serial().primaryKey(),
    categoryId: integer()
      .notNull()
      .references(() => categories.id, { onDelete: "cascade" }),
    providerUrn: text().notNull().unique(),
    slug: text().notNull(),
    name: text().notNull(),
    startAt: timestamp({ withTimezone: true }),
    endAt: timestamp({ withTimezone: true }),
    active: boolean().notNull().default(true),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("tournaments_category_idx").on(t.categoryId),
    index("tournaments_active_idx").on(t.active, t.startAt),
  ],
);

export const matches = pgTable(
  "matches",
  {
    id: bigserial({ mode: "bigint" }).primaryKey(),
    tournamentId: integer()
      .notNull()
      .references(() => tournaments.id),
    providerUrn: text().notNull().unique(),
    homeTeam: text().notNull(),
    awayTeam: text().notNull(),
    homeTeamUrn: text(),
    awayTeamUrn: text(),
    scheduledAt: timestamp({ withTimezone: true }),
    status: matchStatusEnum().notNull().default("not_started"),
    oddinStatusCode: smallint(),
    bestOf: smallint(),
    liveScore: jsonb(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("matches_tournament_idx").on(t.tournamentId),
    index("matches_status_sched_idx").on(t.status, t.scheduledAt),
    index("matches_live_idx").on(t.status).where(sql`${t.status} = 'live'`),
  ],
);

export type Sport = typeof sports.$inferSelect;
export type Category = typeof categories.$inferSelect;
export type Tournament = typeof tournaments.$inferSelect;
export type Match = typeof matches.$inferSelect;
