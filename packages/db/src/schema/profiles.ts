// Competitor + player profile cache. See migration 0008.
// Populated by feed-ingester on match creation; read by the API when
// rendering outcomes whose id is a bare `od:competitor:` or
// `od:player:` URN (team-specific / player-prop markets).

import { pgTable, text, timestamp, index } from "drizzle-orm/pg-core";

export const competitorProfiles = pgTable("competitor_profiles", {
  urn: text().primaryKey(),
  name: text().notNull(),
  abbreviation: text(),
  iconPath: text(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export const playerProfiles = pgTable(
  "player_profiles",
  {
    urn: text().primaryKey(),
    name: text().notNull(),
    fullName: text(),
    competitorUrn: text(),
    sportUrn: text(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("player_profiles_competitor_idx").on(t.competitorUrn)],
);

export type CompetitorProfile = typeof competitorProfiles.$inferSelect;
export type PlayerProfile = typeof playerProfiles.$inferSelect;
