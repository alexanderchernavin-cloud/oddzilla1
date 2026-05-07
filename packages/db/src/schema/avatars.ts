import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  customType,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./users.js";

// Drizzle ships `customType` for opaque column types. Postgres BYTEA is
// the natural fit for admin-uploaded avatar bytes — we store small
// images (capped at 5 MB at the API boundary), serve them via a single
// Fastify handler, and skip the volume-sharing ceremony that would
// otherwise be required to coordinate api + web containers on a
// shared filesystem. Reads come back as Node Buffer through
// postgres-js, which Fastify can stream directly. See migration
// 0036_avatar_templates.sql for the storage rationale and the
// CHECK constraint that enforces "exactly one source" (image_path
// XOR image_data) on every row.
const bytea = customType<{ data: Buffer; default: false }>({
  dataType() {
    return "bytea";
  },
});

export const avatarTemplates = pgTable(
  "avatar_templates",
  {
    id: uuid().primaryKey().defaultRandom(),
    slug: text().notNull().unique(),
    name: text().notNull(),
    // Free-text grouping (creature, sport, esports, persona, abstract,
    // event, …). Kept loose so a future pack lands without a
    // schema-altering migration.
    category: text().notNull(),
    // common | rare | epic | legendary. CHECK in the migration enforces
    // the set; this stays free-text in TS so a future 'mythic' tier
    // doesn't require a type-system rename.
    rarity: text().notNull().default("common"),
    // active | hidden. 'hidden' rows stay equipped on existing users
    // but drop out of the picker.
    status: text().notNull().default("active"),
    sortOrder: integer().notNull().default(0),
    // Static assets ship under apps/web/public/avatars/ and reference
    // themselves here as e.g. '/avatars/kaiju-01.png'. Mutually
    // exclusive with imageData per the table CHECK.
    imagePath: text(),
    imageData: bytea(),
    imageMime: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    // Admin who uploaded; NULL for static seed rows.
    createdBy: uuid().references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [
    // Picker query: status='active' ORDER BY sort_order, name.
    // Partial index (active only) keeps it small even if the hidden
    // pile grows.
    index("avatar_templates_active_order_idx")
      .on(t.status, t.sortOrder, t.name)
      .where(sql`${t.status} = 'active'`),
    // The `avatar_templates_one_source` CHECK from the migration lives
    // in raw SQL because Drizzle doesn't yet support multi-column
    // CHECKs that reference NULL semantics cleanly. The check below
    // duplicates the rarity domain so introspection tools see it.
    check(
      "avatar_templates_status_chk",
      sql`${t.status} IN ('active', 'hidden')`,
    ),
    check(
      "avatar_templates_rarity_chk",
      sql`${t.rarity} IN ('common', 'rare', 'epic', 'legendary')`,
    ),
  ],
);

export type AvatarTemplate = typeof avatarTemplates.$inferSelect;
export type NewAvatarTemplate = typeof avatarTemplates.$inferInsert;
