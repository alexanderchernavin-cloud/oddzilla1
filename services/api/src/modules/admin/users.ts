// /admin/users endpoints. Admin-only.
//
// Allowed mutations: status (active/blocked/pending_kyc), role, per-user
// stake limit, per-user bet-delay seconds. Every mutation writes to
// admin_audit_log with before/after JSON. Password hashes, emails, and
// KYC raw documents are never returned or written here — email is read-
// only for admin list/filter purposes.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq, and, or, ilike, desc, sql, type SQL } from "drizzle-orm";
import {
  users,
  wallets,
  walletLedger,
  tickets,
  deposits,
  withdrawals,
  adminAuditLog,
} from "@oddzilla/db";
import { hashPassword } from "@oddzilla/auth";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../../lib/errors.js";

const listQuery = z.object({
  q: z.string().trim().max(128).optional(),
  status: z.enum(["active", "blocked", "pending_kyc"]).optional(),
  role: z.enum(["user", "admin", "support"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const createBody = z.object({
  email: z.string().email().max(320),
  password: z.string().min(8).max(256),
  displayName: z.string().min(1).max(64).optional(),
  countryCode: z
    .string()
    .length(2)
    .regex(/^[A-Za-z]{2}$/)
    .transform((s) => s.toUpperCase())
    .optional(),
  role: z.enum(["user", "admin", "support"]).default("user"),
  status: z.enum(["active", "blocked", "pending_kyc"]).default("active"),
  globalLimitMicro: z.string().regex(/^\d+$/).optional(),
  betDelaySeconds: z.number().int().min(0).max(300).optional(),
});

const patchBody = z.object({
  status: z.enum(["active", "blocked", "pending_kyc"]).optional(),
  role: z.enum(["user", "admin", "support"]).optional(),
  globalLimitMicro: z.string().regex(/^\d+$/).optional(),
  betDelaySeconds: z.number().int().min(0).max(300).optional(),
});

interface AdminUserRow {
  id: string;
  email: string;
  status: "active" | "blocked" | "pending_kyc";
  role: "user" | "admin" | "support";
  kycStatus: "none" | "pending" | "approved" | "rejected";
  displayName: string | null;
  countryCode: string | null;
  globalLimitMicro: string;
  betDelaySeconds: number;
  createdAt: string;
  lastLoginAt: string | null;
  balanceMicro: string;
  lockedMicro: string;
}

export default async function adminUsersRoutes(app: FastifyInstance) {
  app.get("/admin/users", async (request) => {
    request.requireRole("admin");
    const q = listQuery.parse(request.query);

    const filters: SQL[] = [];
    if (q.status) filters.push(eq(users.status, q.status));
    if (q.role) filters.push(eq(users.role, q.role));
    if (q.q) {
      const like = `%${q.q}%`;
      const orExpr = or(ilike(users.email, like), ilike(users.displayName, like));
      if (orExpr) filters.push(orExpr);
    }
    const whereClause = filters.length > 0 ? and(...filters) : sql`TRUE`;

    const rows = await app.db
      .select({
        id: users.id,
        email: users.email,
        status: users.status,
        role: users.role,
        kycStatus: users.kycStatus,
        displayName: users.displayName,
        countryCode: users.countryCode,
        globalLimitMicro: users.globalLimitMicro,
        betDelaySeconds: users.betDelaySeconds,
        createdAt: users.createdAt,
        lastLoginAt: users.lastLoginAt,
        balanceMicro: wallets.balanceMicro,
        lockedMicro: wallets.lockedMicro,
      })
      .from(users)
      .leftJoin(wallets, eq(wallets.userId, users.id))
      .where(whereClause)
      .orderBy(desc(users.createdAt))
      .limit(q.limit)
      .offset(q.offset);

    const payload: { users: AdminUserRow[]; limit: number; offset: number } = {
      users: rows.map((r) => ({
        id: r.id,
        email: r.email,
        status: r.status,
        role: r.role,
        kycStatus: r.kycStatus,
        displayName: r.displayName,
        countryCode: r.countryCode,
        globalLimitMicro: r.globalLimitMicro.toString(),
        betDelaySeconds: r.betDelaySeconds,
        createdAt: r.createdAt.toISOString(),
        lastLoginAt: r.lastLoginAt?.toISOString() ?? null,
        balanceMicro: (r.balanceMicro ?? 0n).toString(),
        lockedMicro: (r.lockedMicro ?? 0n).toString(),
      })),
      limit: q.limit,
      offset: q.offset,
    };
    return payload;
  });

  app.get("/admin/users/:id", async (request) => {
    request.requireRole("admin");
    const params = z.object({ id: z.string().uuid() }).parse(request.params);

    const [user] = await app.db
      .select({
        id: users.id,
        email: users.email,
        status: users.status,
        role: users.role,
        kycStatus: users.kycStatus,
        displayName: users.displayName,
        countryCode: users.countryCode,
        globalLimitMicro: users.globalLimitMicro,
        betDelaySeconds: users.betDelaySeconds,
        createdAt: users.createdAt,
        lastLoginAt: users.lastLoginAt,
        balanceMicro: wallets.balanceMicro,
        lockedMicro: wallets.lockedMicro,
      })
      .from(users)
      .leftJoin(wallets, eq(wallets.userId, users.id))
      .where(eq(users.id, params.id))
      .limit(1);
    if (!user) throw new NotFoundError("user_not_found", "user_not_found");

    const statsResult = (await app.db.execute(sql`
      SELECT
        COUNT(*)::int AS total_tickets,
        COUNT(*) FILTER (WHERE status IN ('accepted', 'pending_delay'))::int AS open_tickets,
        COUNT(*) FILTER (WHERE status = 'settled')::int AS settled_tickets,
        COALESCE(SUM(stake_micro), 0)::text AS total_stake_micro,
        COALESCE(SUM(actual_payout_micro) FILTER (WHERE status = 'settled'), 0)::text AS total_payout_micro
      FROM tickets
      WHERE user_id = ${params.id}
    `)) as unknown as Array<{
      total_tickets: number;
      open_tickets: number;
      settled_tickets: number;
      total_stake_micro: string;
      total_payout_micro: string;
    }>;
    const stats = statsResult[0];

    const recent = await app.db
      .select({
        id: tickets.id,
        status: tickets.status,
        stakeMicro: tickets.stakeMicro,
        potentialPayoutMicro: tickets.potentialPayoutMicro,
        actualPayoutMicro: tickets.actualPayoutMicro,
        placedAt: tickets.placedAt,
        settledAt: tickets.settledAt,
      })
      .from(tickets)
      .where(eq(tickets.userId, params.id))
      .orderBy(desc(tickets.placedAt))
      .limit(20);

    return {
      user: {
        id: user.id,
        email: user.email,
        status: user.status,
        role: user.role,
        kycStatus: user.kycStatus,
        displayName: user.displayName,
        countryCode: user.countryCode,
        globalLimitMicro: user.globalLimitMicro.toString(),
        betDelaySeconds: user.betDelaySeconds,
        createdAt: user.createdAt.toISOString(),
        lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
        balanceMicro: (user.balanceMicro ?? 0n).toString(),
        lockedMicro: (user.lockedMicro ?? 0n).toString(),
      },
      stats: {
        totalTickets: Number(stats?.total_tickets ?? 0),
        openTickets: Number(stats?.open_tickets ?? 0),
        settledTickets: Number(stats?.settled_tickets ?? 0),
        totalStakeMicro: stats?.total_stake_micro ?? "0",
        totalPayoutMicro: stats?.total_payout_micro ?? "0",
      },
      recentTickets: recent.map((t) => ({
        id: t.id,
        status: t.status,
        stakeMicro: t.stakeMicro.toString(),
        potentialPayoutMicro: t.potentialPayoutMicro.toString(),
        actualPayoutMicro: t.actualPayoutMicro?.toString() ?? null,
        placedAt: t.placedAt.toISOString(),
        settledAt: t.settledAt?.toISOString() ?? null,
      })),
    };
  });

  app.patch("/admin/users/:id", async (request) => {
    const admin = request.requireRole("admin");
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = patchBody.parse(request.body);

    if (
      body.status === undefined &&
      body.role === undefined &&
      body.globalLimitMicro === undefined &&
      body.betDelaySeconds === undefined
    ) {
      throw new BadRequestError("no_changes", "no_changes");
    }

    // Self-guard: admins cannot demote or block themselves.
    if (params.id === admin.id) {
      if (body.role !== undefined && body.role !== "admin") {
        throw new BadRequestError("cannot_demote_self", "cannot_demote_self");
      }
      if (body.status !== undefined && body.status !== "active") {
        throw new BadRequestError("cannot_block_self", "cannot_block_self");
      }
    }

    const [existing] = await app.db.select().from(users).where(eq(users.id, params.id)).limit(1);
    if (!existing) throw new NotFoundError("user_not_found", "user_not_found");

    const patch: Partial<typeof users.$inferInsert> = { updatedAt: new Date() };
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};

    if (body.status !== undefined && body.status !== existing.status) {
      patch.status = body.status;
      before.status = existing.status;
      after.status = body.status;
    }
    if (body.role !== undefined && body.role !== existing.role) {
      patch.role = body.role;
      before.role = existing.role;
      after.role = body.role;
    }
    if (body.globalLimitMicro !== undefined) {
      const n = BigInt(body.globalLimitMicro);
      if (n !== existing.globalLimitMicro) {
        patch.globalLimitMicro = n;
        before.globalLimitMicro = existing.globalLimitMicro.toString();
        after.globalLimitMicro = n.toString();
      }
    }
    if (
      body.betDelaySeconds !== undefined &&
      body.betDelaySeconds !== existing.betDelaySeconds
    ) {
      patch.betDelaySeconds = body.betDelaySeconds;
      before.betDelaySeconds = existing.betDelaySeconds;
      after.betDelaySeconds = body.betDelaySeconds;
    }

    if (Object.keys(after).length === 0) {
      throw new BadRequestError("no_changes", "no_changes");
    }

    await app.db.transaction(async (tx) => {
      await tx.update(users).set(patch).where(eq(users.id, params.id));
      await tx.insert(adminAuditLog).values({
        actorUserId: admin.id,
        action: "user.update",
        targetType: "user",
        targetId: params.id,
        beforeJson: before,
        afterJson: after,
        ipInet: request.ip ?? null,
      });
    });

    return { ok: true, changed: Object.keys(after) };
  });

  app.post("/admin/users", async (request, reply) => {
    const admin = request.requireRole("admin");
    const body = createBody.parse(request.body);

    const email = body.email.toLowerCase();
    const [dup] = await app.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    if (dup) throw new ConflictError("email_in_use", "email_in_use");

    const passwordHash = await hashPassword(body.password);
    const globalLimitMicro = body.globalLimitMicro ? BigInt(body.globalLimitMicro) : 0n;
    const betDelaySeconds = body.betDelaySeconds ?? 0;

    const created = await app.db.transaction(async (tx) => {
      const [u] = await tx
        .insert(users)
        .values({
          email,
          passwordHash,
          displayName: body.displayName ?? null,
          countryCode: body.countryCode ?? null,
          status: body.status,
          role: body.role,
          kycStatus: "none",
          globalLimitMicro,
          betDelaySeconds,
        })
        .returning();
      if (!u) throw new Error("user insert returned no row");

      await tx
        .insert(wallets)
        .values({ userId: u.id })
        .onConflictDoNothing({ target: wallets.userId });

      await tx.insert(adminAuditLog).values({
        actorUserId: admin.id,
        action: "user.create",
        targetType: "user",
        targetId: u.id,
        beforeJson: {},
        afterJson: {
          email: u.email,
          role: u.role,
          status: u.status,
          globalLimitMicro: u.globalLimitMicro.toString(),
          betDelaySeconds: u.betDelaySeconds,
        },
        ipInet: request.ip ?? null,
      });

      return u;
    });

    reply.code(201);
    return {
      user: {
        id: created.id,
        email: created.email,
        status: created.status,
        role: created.role,
        kycStatus: created.kycStatus,
        displayName: created.displayName,
        countryCode: created.countryCode,
        globalLimitMicro: created.globalLimitMicro.toString(),
        betDelaySeconds: created.betDelaySeconds,
        createdAt: created.createdAt.toISOString(),
      },
    };
  });

  app.delete("/admin/users/:id", async (request) => {
    const admin = request.requireRole("admin");
    const params = z.object({ id: z.string().uuid() }).parse(request.params);

    if (params.id === admin.id) {
      throw new BadRequestError("cannot_delete_self", "cannot_delete_self");
    }

    const [existing] = await app.db
      .select()
      .from(users)
      .where(eq(users.id, params.id))
      .limit(1);
    if (!existing) throw new NotFoundError("user_not_found", "user_not_found");

    const [activity] = (await app.db.execute(sql`
      SELECT
        (SELECT COUNT(*)::int FROM ${tickets} WHERE user_id = ${params.id}) AS ticket_count,
        (SELECT COUNT(*)::int FROM ${walletLedger} WHERE user_id = ${params.id}) AS ledger_count,
        (SELECT COUNT(*)::int FROM ${deposits} WHERE user_id = ${params.id}) AS deposit_count,
        (SELECT COUNT(*)::int FROM ${withdrawals} WHERE user_id = ${params.id}) AS withdrawal_count,
        (SELECT COALESCE(balance_micro, 0)::text FROM ${wallets} WHERE user_id = ${params.id}) AS balance_micro
    `)) as unknown as Array<{
      ticket_count: number;
      ledger_count: number;
      deposit_count: number;
      withdrawal_count: number;
      balance_micro: string | null;
    }>;
    const hasHistory =
      (activity?.ticket_count ?? 0) > 0 ||
      (activity?.ledger_count ?? 0) > 0 ||
      (activity?.deposit_count ?? 0) > 0 ||
      (activity?.withdrawal_count ?? 0) > 0 ||
      BigInt(activity?.balance_micro ?? "0") !== 0n;
    if (hasHistory) {
      throw new ConflictError(
        "user_has_financial_history",
        "user_has_financial_history",
      );
    }

    await app.db.transaction(async (tx) => {
      await tx.insert(adminAuditLog).values({
        actorUserId: admin.id,
        action: "user.delete",
        targetType: "user",
        targetId: params.id,
        beforeJson: {
          email: existing.email,
          role: existing.role,
          status: existing.status,
        },
        afterJson: {},
        ipInet: request.ip ?? null,
      });

      await tx.delete(wallets).where(eq(wallets.userId, params.id));
      await tx.delete(users).where(eq(users.id, params.id));
    });

    return { ok: true };
  });
}
