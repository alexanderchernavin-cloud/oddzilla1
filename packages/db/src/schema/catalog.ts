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
  customType,
} from "drizzle-orm/pg-core";

// Postgres BYTEA mapped to Buffer in/out. Drizzle's pg-core only ships
// text-shaped types; this matches the avatar_templates.image_data
// pattern so the same Buffer round-trip works on both tables without
// a bespoke serializer.
const bytea = customType<{ data: Buffer; default: false }>({
  dataType() {
    return "bytea";
  },
});
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
    // Optional per-sport branding. logo_url is plain text so admins
    // can paste any HTTPS URL or self-hosted relative path; brand_color
    // is reserved for future tinted accents. Both nullable — when
    // absent the storefront falls back to the bundled
    // public/sports/<slug>.svg, then to the FallbackGlyph.
    logoUrl: text("logo_url"),
    brandColor: text("brand_color"),
    // Admin-uploaded icon bytes. Mirrors avatar_templates.image_data:
    // the BYTEA + MIME pair is served by GET /sports/:slug/logo. When
    // a row carries bytes, the upload endpoint also writes a self-
    // referential logo_url so the storefront's existing <img src> path
    // works without code changes; clearing bytes also clears the URL.
    logoData: bytea("logo_data"),
    logoMime: text("logo_mime"),
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
    // Oddin risk_tier: sidebar lists tournaments higher-tier first.
    // Nullable until the backfill runs or auto-mapping populates it.
    riskTier: smallint(),
    // Optional per-tournament branding. Mirrors sports + competitors:
    // logo_url either external paste or auto-stamped /api/tournaments/
    // <id>/logo, brand_color "#RRGGBB" hex. Both nullable — when absent
    // the sidebar falls back to the sport's logo.
    logoUrl: text("logo_url"),
    brandColor: text("brand_color"),
    logoData: bytea("logo_data"),
    logoMime: text("logo_mime"),
    active: boolean().notNull().default(true),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("tournaments_category_idx").on(t.categoryId),
    index("tournaments_active_idx").on(t.active, t.startAt),
  ],
);

export const competitors = pgTable(
  "competitors",
  {
    id: serial().primaryKey(),
    sportId: integer()
      .notNull()
      .references(() => sports.id, { onDelete: "cascade" }),
    provider: text().notNull().default("oddin"),
    providerUrn: text(),
    slug: text().notNull(),
    name: text().notNull(),
    abbreviation: text(),
    // Optional team branding. logo_url is plain TEXT so admins can paste any
    // HTTPS URL (Liquipedia, team CDN, self-hosted /logos/*); brand_color is
    // a "#RRGGBB" hex string reserved for future tinted accents. Both are
    // nullable — when absent the storefront falls back to initials.
    logoUrl: text(),
    brandColor: text(),
    // Admin-uploaded icon bytes. Paired with logo_mime via a CHECK; the
    // upload endpoint also stamps logo_url to a /api/competitors/<id>/logo
    // URL so the existing logoUrl-based render path works without code
    // changes. Mirrors sports.logo_data / sports.logo_mime exactly.
    logoData: bytea("logo_data"),
    logoMime: text("logo_mime"),
    active: boolean().notNull().default(true),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("competitors_sport_slug").on(t.sportId, t.slug),
    index("competitors_sport_idx").on(t.sportId),
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
    homeCompetitorId: integer().references(() => competitors.id),
    awayCompetitorId: integer().references(() => competitors.id),
    scheduledAt: timestamp({ withTimezone: true }),
    status: matchStatusEnum().notNull().default("not_started"),
    oddinStatusCode: smallint(),
    bestOf: smallint(),
    // First not_started→live transition timestamp. Captured by
    // feed-ingester's UpdateMatchStatus and used by ZillaTips to anchor
    // "last prematch snapshot" queries across the historical sample.
    liveStartedAt: timestamp("live_started_at", { withTimezone: true }),
    liveScore: jsonb(),
    // Oddin's fixture endpoint exposes <tv_channels><tv_channel name=...
    // language=... stream_url=.../></tv_channels>. We store the parsed
    // array verbatim — the storefront recognises Twitch / YouTube
    // stream_url shapes and renders an embed. NULL = unknown (fixture
    // not fetched yet or missing block); [] = explicitly no channels.
    tvChannels: jsonb(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("matches_tournament_idx").on(t.tournamentId),
    index("matches_status_sched_idx").on(t.status, t.scheduledAt),
    index("matches_live_idx").on(t.status).where(sql`${t.status} = 'live'`),
    index("matches_home_competitor_idx").on(t.homeCompetitorId),
    index("matches_away_competitor_idx").on(t.awayCompetitorId),
    // ZillaTips lookback hot path — fetch "last 5 closed matches for team T,
    // ordered by recency". Partial-index pair lets Postgres index-scan
    // straight to the top-5 instead of sort-after-filter.
    index("matches_home_team_recency_idx")
      .on(t.homeCompetitorId, t.status, t.liveStartedAt.desc())
      .where(sql`${t.liveStartedAt} IS NOT NULL`),
    index("matches_away_team_recency_idx")
      .on(t.awayCompetitorId, t.status, t.liveStartedAt.desc())
      .where(sql`${t.liveStartedAt} IS NOT NULL`),
  ],
);

export type Sport = typeof sports.$inferSelect;
export type Category = typeof categories.$inferSelect;
export type Tournament = typeof tournaments.$inferSelect;
export type Competitor = typeof competitors.$inferSelect;
export type Match = typeof matches.$inferSelect;
