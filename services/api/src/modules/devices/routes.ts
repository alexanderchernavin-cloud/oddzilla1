// /devices/* — push-notification device registry.
//
//   POST /devices/register     Upsert the caller's device (FCM token + platform)
//   POST /devices/unregister   Soft-revoke a token (called on logout)
//   GET  /devices              Caller's live devices (debug surface)
//
// The actual push-sending (Firebase Admin SDK or APNs) is intentionally
// not wired here — adding it is a separate piece of work that needs a
// service-account credential on the api host. This module is the
// half that's idempotent and safe to ship without push-sender:
// tokens land in `user_devices` and stay there until either a logout
// revokes them or another user registers the same token (which
// auto-revokes the prior owner so a hand-me-down phone doesn't keep
// pushing to the previous account).

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, eq, isNull, sql } from "drizzle-orm";
import { userDevices } from "@oddzilla/db";

const registerBody = z.object({
  token: z.string().min(8).max(2048),
  platform: z.enum(["android", "ios", "web"]),
  appVersion: z.string().max(32).optional(),
  deviceLabel: z.string().max(128).optional(),
});

const unregisterBody = z.object({
  token: z.string().min(8).max(2048),
});

const writeRateLimit = {
  rateLimit: { max: 30, timeWindow: "1 minute" },
};

export default async function devicesRoutes(app: FastifyInstance) {
  app.post("/devices/register", { config: writeRateLimit }, async (request) => {
    const u = request.requireAuth();
    const body = registerBody.parse(request.body);

    // Two writes in one transaction: revoke the same token on any
    // OTHER user (hand-me-down phone protection), then upsert for
    // this user. Order matters — if we upsert first, the revoke would
    // sweep our own row.
    await app.db.transaction(async (tx) => {
      await tx
        .update(userDevices)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(userDevices.token, body.token),
            sql`${userDevices.userId} <> ${u.id}::uuid`,
            isNull(userDevices.revokedAt),
          ),
        );

      await tx
        .insert(userDevices)
        .values({
          userId: u.id,
          token: body.token,
          platform: body.platform,
          appVersion: body.appVersion ?? null,
          deviceLabel: body.deviceLabel ?? null,
        })
        .onConflictDoUpdate({
          target: [userDevices.userId, userDevices.token],
          set: {
            platform: body.platform,
            appVersion: body.appVersion ?? null,
            deviceLabel: body.deviceLabel ?? null,
            lastSeenAt: new Date(),
            revokedAt: null,
          },
        });
    });

    return { ok: true };
  });

  app.post("/devices/unregister", { config: writeRateLimit }, async (request) => {
    const u = request.requireAuth();
    const body = unregisterBody.parse(request.body);
    await app.db
      .update(userDevices)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(userDevices.userId, u.id),
          eq(userDevices.token, body.token),
          isNull(userDevices.revokedAt),
        ),
      );
    return { ok: true };
  });

  app.get("/devices", async (request) => {
    const u = request.requireAuth();
    const rows = await app.db
      .select({
        id: userDevices.id,
        platform: userDevices.platform,
        appVersion: userDevices.appVersion,
        deviceLabel: userDevices.deviceLabel,
        registeredAt: userDevices.registeredAt,
        lastSeenAt: userDevices.lastSeenAt,
        revokedAt: userDevices.revokedAt,
      })
      .from(userDevices)
      .where(and(eq(userDevices.userId, u.id), isNull(userDevices.revokedAt)));
    return { devices: rows };
  });
}
