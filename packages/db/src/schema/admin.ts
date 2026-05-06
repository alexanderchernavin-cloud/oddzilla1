import { sql } from "drizzle-orm";
import {
  pgTable,
  bigserial,
  bigint,
  uuid,
  text,
  jsonb,
  timestamp,
  inet,
  unique,
  index,
  customType,
} from "drizzle-orm/pg-core";
import { mappingStatusEnum, chainNetworkEnum } from "../enums.js";
import { users } from "./users.js";

// Mirrors the bytea customType in sessions.ts. Kept local to each schema
// file to avoid cross-file circular imports inside `packages/db`.
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export const mappingReviewQueue = pgTable(
  "mapping_review_queue",
  {
    id: bigserial({ mode: "bigint" }).primaryKey(),
    entityType: text().notNull(),
    provider: text().notNull().default("oddin"),
    providerUrn: text().notNull(),
    rawPayload: jsonb().notNull(),
    createdEntityId: text(),
    status: mappingStatusEnum().notNull().default("pending"),
    reviewedBy: uuid().references(() => users.id),
    reviewedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("mapping_review_unique").on(t.provider, t.providerUrn, t.entityType),
    index("mapping_review_pending_idx")
      .on(t.status, t.createdAt)
      .where(sql`${t.status} = 'pending'`),
  ],
);

export const adminAuditLog = pgTable(
  "admin_audit_log",
  {
    id: bigserial({ mode: "bigint" }).primaryKey(),
    actorUserId: uuid().references(() => users.id),
    action: text().notNull(),
    targetType: text(),
    targetId: text(),
    beforeJson: jsonb(),
    afterJson: jsonb(),
    ipInet: inet(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    // Hash chain (migration 0026). Both columns are populated by the
    // `admin_audit_log_chain()` BEFORE INSERT trigger; never write them
    // from app code. Verifier: SELECT * FROM admin_audit_chain_check().
    prevHash: bytea("prev_hash"),
    rowHash: bytea("row_hash"),
  },
  (t) => [
    index("admin_audit_actor_idx").on(t.actorUserId, sql`${t.createdAt} DESC`),
    index("admin_audit_target_idx").on(t.targetType, t.targetId),
  ],
);

export const amqpState = pgTable("amqp_state", {
  key: text().primaryKey(),
  afterTs: bigint({ mode: "bigint" }).notNull().default(0n),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

// wallet-watcher persists its per-chain block cursor here.
export const chainScannerState = pgTable("chain_scanner_state", {
  chain: chainNetworkEnum().primaryKey(),
  lastBlockNumber: bigint({ mode: "bigint" }).notNull().default(0n),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export type MappingReviewEntry = typeof mappingReviewQueue.$inferSelect;
export type AdminAuditEntry = typeof adminAuditLog.$inferSelect;
export type AmqpState = typeof amqpState.$inferSelect;
export type ChainScannerState = typeof chainScannerState.$inferSelect;
