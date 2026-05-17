// /community/avatars/* — public read surface for the avatar picker, plus
// the equip endpoint and the BYTEA-backed image serve. Mirrors the shape
// established for community profile / tickets in routes.ts.
//
// Three endpoints:
//   GET  /community/avatars                 — list active templates
//   GET  /community/avatars/:slug/image     — stream uploaded image bytes
//                                             (static seeds 404 here; they
//                                             live under apps/web/public)
//   PUT  /community/me/avatar               — authed equip
//
// The image-serve route deliberately skips the rate limiter that fronts
// /community/feed — avatar URLs render once per page-view and are CDN-
// cacheable downstream, so a 60/min cap would falsely throttle a user
// scrolling a 20-card feed where every card carries an upload-backed
// avatar. The route's own caching headers (immutable + public) carry
// the long-tail load.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, asc, eq } from "drizzle-orm";
import { avatarTemplates, users } from "@oddzilla/db";
import type {
  AvatarTemplateListResponse,
  AvatarTemplateSummary,
  EquipAvatarRequest,
  CommunityMe,
} from "@oddzilla/types";
import { BadRequestError, NotFoundError } from "../../lib/errors.js";
import { resolveAvatarUrl } from "./avatar-url.js";
import { nudgeProfileComplete } from "../zillapass/writer.js";

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,62}[a-z0-9]$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const equipBody = z
  .object({
    templateId: z
      .string()
      .regex(UUID_RE, "invalid_template_id")
      .nullable(),
  })
  .strict();

const writeRateLimit = {
  rateLimit: { max: 30, timeWindow: "1 minute" },
};

export default async function communityAvatarRoutes(app: FastifyInstance) {
  // ─── Picker list ─────────────────────────────────────────────────────────
  //
  // Public, anonymous. Returns active templates only — hidden rows are
  // visible only via /admin/avatars. Ordered by sort_order then name so
  // operators can hand-curate the picker without a tie-breaker fallback
  // on uuid.
  app.get(
    "/community/avatars",
    async (): Promise<AvatarTemplateListResponse> => {
      const rows = await app.db
        .select({
          id: avatarTemplates.id,
          slug: avatarTemplates.slug,
          name: avatarTemplates.name,
          category: avatarTemplates.category,
          rarity: avatarTemplates.rarity,
          imagePath: avatarTemplates.imagePath,
        })
        .from(avatarTemplates)
        .where(eq(avatarTemplates.status, "active"))
        .orderBy(asc(avatarTemplates.sortOrder), asc(avatarTemplates.name));

      const templates: AvatarTemplateSummary[] = rows.map((r) => ({
        id: r.id,
        slug: r.slug,
        name: r.name,
        category: r.category,
        rarity: r.rarity as AvatarTemplateSummary["rarity"],
        imageUrl: resolveAvatarUrl({ slug: r.slug, imagePath: r.imagePath }),
      }));

      return { templates };
    },
  );

  // ─── Image serve (BYTEA path only) ───────────────────────────────────────
  //
  // Fast path is the static seed: those rows have image_path set and
  // are served directly by Next.js public/ at the same URL pattern, so
  // this route only ever hits the upload path. We still gate on slug
  // shape because UUID-shaped slugs would otherwise mask each other in
  // logs.
  app.get<{ Params: { slug: string } }>(
    "/community/avatars/:slug/image",
    async (request, reply) => {
      const { slug } = request.params;
      if (!SLUG_RE.test(slug)) throw new NotFoundError();

      const [row] = await app.db
        .select({
          status: avatarTemplates.status,
          imagePath: avatarTemplates.imagePath,
          imageData: avatarTemplates.imageData,
          imageMime: avatarTemplates.imageMime,
        })
        .from(avatarTemplates)
        .where(eq(avatarTemplates.slug, slug))
        .limit(1);

      if (!row) throw new NotFoundError();
      // Static seeds are served by Next.js — instruct the client to
      // hit the public path instead of round-tripping bytes through
      // the api. 308 Permanent so browsers cache the redirect target.
      if (row.imagePath) {
        return reply.code(308).redirect(row.imagePath);
      }
      if (!row.imageData) throw new NotFoundError();
      // Hidden templates: existing equipped users can still load the
      // image (otherwise their card chrome breaks). The picker is what
      // gets gated, not the byte-serve.
      reply
        .header("content-type", row.imageMime ?? "application/octet-stream")
        // Avatar bytes are content-addressed by slug; once uploaded
        // they don't mutate (admin re-upload writes a new slug). Long
        // immutable cache is safe and saves repeat round-trips.
        .header("cache-control", "public, max-age=31536000, immutable")
        .send(Buffer.from(row.imageData));
    },
  );

  // ─── Equip ───────────────────────────────────────────────────────────────
  //
  // PUT /community/me/avatar — authed. Setting templateId to null
  // clears the equip (UI falls back to a monogram). Validates that
  // the requested template exists and is active before writing, so a
  // user can't sneak a hidden template back onto themselves.
  app.put(
    "/community/me/avatar",
    { config: writeRateLimit },
    async (request): Promise<CommunityMe> => {
      const u = request.requireAuth();
      const body: EquipAvatarRequest = equipBody.parse(request.body);

      if (body.templateId !== null) {
        const [t] = await app.db
          .select({
            id: avatarTemplates.id,
            status: avatarTemplates.status,
          })
          .from(avatarTemplates)
          .where(eq(avatarTemplates.id, body.templateId))
          .limit(1);
        if (!t) throw new NotFoundError("template_not_found", "template_not_found");
        if (t.status !== "active") {
          throw new BadRequestError("template_unavailable", "template_unavailable");
        }
      }

      const [updated] = await app.db
        .update(users)
        .set({ avatarTemplateId: body.templateId, updatedAt: new Date() })
        .where(eq(users.id, u.id))
        .returning({
          ticketsPublic: users.ticketsPublic,
          nickname: users.nickname,
          bio: users.bio,
          avatarTemplateId: users.avatarTemplateId,
        });
      if (!updated) throw new NotFoundError();

      // Nudge ZillaPass — if the user now has both nickname AND
      // avatar set, the `profile_complete` task flips done. Best-
      // effort; the writer logs and swallows failures so the user-
      // visible PUT never breaks on engagement-engine errors.
      await nudgeProfileComplete(app, u.id);

      // Resolve the avatar URL for the new equip in a second roundtrip
      // — small enough to be free, keeps the response self-contained.
      const avatarUrl = await loadAvatarUrl(app, updated.avatarTemplateId);

      return {
        ticketsPublic: updated.ticketsPublic,
        nickname: updated.nickname,
        bio: updated.bio,
        avatarTemplateId: updated.avatarTemplateId,
        avatarUrl,
      };
    },
  );
}

// Helper: load and resolve the avatar URL for a single template id.
// Used by the equip handler to round-trip the new URL back to the
// client without forcing a follow-up GET /community/me.
async function loadAvatarUrl(
  app: FastifyInstance,
  templateId: string | null,
): Promise<string | null> {
  if (!templateId) return null;
  const [row] = await app.db
    .select({
      slug: avatarTemplates.slug,
      imagePath: avatarTemplates.imagePath,
    })
    .from(avatarTemplates)
    .where(
      and(
        eq(avatarTemplates.id, templateId),
        // A hidden template still resolves to a URL (existing equips
        // keep working) — the picker side is what filters by status.
      ),
    )
    .limit(1);
  if (!row) return null;
  return resolveAvatarUrl({ slug: row.slug, imagePath: row.imagePath });
}
