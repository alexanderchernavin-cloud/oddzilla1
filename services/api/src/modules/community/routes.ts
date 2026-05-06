// /community/* endpoints (Phase 10.1).
//
// Public reads:
//   GET    /community/users/:nickname/profile?currency=USDT|OZ
//
// Authed self-management:
//   GET    /community/me
//   PATCH  /community/me/visibility
//   PATCH  /community/me/profile
//
// Phase 10.2 will add /community/feed and /community/users/:nickname/tickets
// once the community_tickets projection table exists. Phase 10.3 adds
// /community/copy/:communityTicketId.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { users } from "@oddzilla/db";
import type {
  CommunityProfile,
  CommunityMe,
  CommunityVisibilityRequest,
  CommunityProfileRequest,
} from "@oddzilla/types";
import { isCurrency, DEFAULT_CURRENCY } from "@oddzilla/types";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../../lib/errors.js";

// Same shape AuthService uses for `users` writes — limit per-IP-per-user
// abuse on the nickname squat path.
const writeRateLimit = {
  rateLimit: { max: 30, timeWindow: "1 minute" },
};

// Mirrors the DB-side CHECK constraint from migration 0024.
const NICKNAME_RE = /^[A-Za-z0-9_]{3,20}$/;

const visibilityBody = z.object({
  ticketsPublic: z.boolean(),
});

const profileBody = z
  .object({
    nickname: z
      .string()
      .regex(NICKNAME_RE, "nickname_invalid")
      .nullable()
      .optional(),
    bio: z.string().max(280).nullable().optional(),
  })
  .strict();

export default async function communityRoutes(app: FastifyInstance) {
  // ─── Public profile ──────────────────────────────────────────────────────
  //
  // Returns nickname / bio / joinedAt and a per-currency stats block. The
  // 10.1 stats are zeroed placeholders — Phase 10.2 backfills these from
  // `community_tickets`. Anonymous; no auth required.
  app.get<{
    Params: { nickname: string };
    Querystring: { currency?: string };
  }>("/community/users/:nickname/profile", async (request) => {
    const nickname = request.params.nickname;
    if (!NICKNAME_RE.test(nickname)) throw new NotFoundError();

    const currency =
      request.query.currency && isCurrency(request.query.currency)
        ? request.query.currency
        : DEFAULT_CURRENCY;

    const [u] = await app.db
      .select({
        nickname: users.nickname,
        bio: users.bio,
        ticketsPublic: users.ticketsPublic,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(eq(users.nickname, nickname))
      .limit(1);

    // Visibility filter: a user with tickets_public=false has no public
    // surface. Returning 404 (rather than 403) avoids leaking that the
    // handle is taken.
    if (!u || !u.nickname || !u.ticketsPublic) throw new NotFoundError();

    const profile: CommunityProfile = {
      nickname: u.nickname,
      bio: u.bio,
      joinedAt: u.createdAt.toISOString(),
      stats: {
        currency,
        settledTickets: 0,
        wins: 0,
        winRatePct: 0,
        roiPct: 0,
        badgeCount: 0,
      },
    };
    return profile;
  });

  // ─── Self view ───────────────────────────────────────────────────────────

  app.get("/community/me", async (request): Promise<CommunityMe> => {
    const u = request.requireAuth();
    const [me] = await app.db
      .select({
        ticketsPublic: users.ticketsPublic,
        nickname: users.nickname,
        bio: users.bio,
      })
      .from(users)
      .where(eq(users.id, u.id))
      .limit(1);
    if (!me) throw new NotFoundError();
    return me;
  });

  // ─── Visibility toggle ───────────────────────────────────────────────────

  app.patch(
    "/community/me/visibility",
    { config: writeRateLimit },
    async (request): Promise<CommunityMe> => {
      const u = request.requireAuth();
      const body: CommunityVisibilityRequest = visibilityBody.parse(
        request.body,
      );
      const [updated] = await app.db
        .update(users)
        .set({ ticketsPublic: body.ticketsPublic, updatedAt: new Date() })
        .where(eq(users.id, u.id))
        .returning({
          ticketsPublic: users.ticketsPublic,
          nickname: users.nickname,
          bio: users.bio,
        });
      if (!updated) throw new NotFoundError();
      return updated;
    },
  );

  // ─── Nickname / bio ──────────────────────────────────────────────────────
  //
  // Both fields are optional; at least one must be present. Nickname
  // collisions surface as 409 nickname_taken (citext UNIQUE on the
  // column). The DB-side CHECK is the second line of defence — zod
  // rejects malformed input first.
  app.patch(
    "/community/me/profile",
    { config: writeRateLimit },
    async (request): Promise<CommunityMe> => {
      const u = request.requireAuth();
      const body: CommunityProfileRequest = profileBody.parse(request.body);

      if (body.nickname === undefined && body.bio === undefined) {
        throw new BadRequestError("no_changes", "no_changes");
      }

      const patch: Partial<typeof users.$inferInsert> = { updatedAt: new Date() };
      if (body.nickname !== undefined) patch.nickname = body.nickname;
      if (body.bio !== undefined) patch.bio = body.bio;

      try {
        const [updated] = await app.db
          .update(users)
          .set(patch)
          .where(eq(users.id, u.id))
          .returning({
            ticketsPublic: users.ticketsPublic,
            nickname: users.nickname,
            bio: users.bio,
          });
        if (!updated) throw new NotFoundError();
        return updated;
      } catch (err) {
        // 23505 = unique_violation. The nickname column is the only
        // unique on this UPDATE path — citext makes the comparison
        // case-insensitive so "Alex" and "alex" collide as expected.
        if (isUniqueViolation(err)) {
          throw new ConflictError("nickname_taken", "nickname_taken");
        }
        throw err;
      }
    },
  );
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "23505"
  );
}
