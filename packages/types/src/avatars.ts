// Shared API contract for the Avatar Templates surface (PRD V1).
// Keep in lockstep with services/api/src/modules/avatars/*.

// Rarity tiers from the PRD cosmetics framework. Free-text on the
// wire to leave a 'mythic' / etc. extension door open without a
// breaking change.
export type AvatarRarity = "common" | "rare" | "epic" | "legendary";

// 'active' = listed by /community/avatars; 'hidden' = soft-deleted,
// keeps existing equips intact. Admin sees both.
export type AvatarStatus = "active" | "hidden";

// Public-shape template returned from /community/avatars and embedded
// inside community responses. Image bytes are NEVER on this object —
// callers always go through the URL.
export interface AvatarTemplateSummary {
  id: string;
  slug: string;
  name: string;
  category: string;
  rarity: AvatarRarity;
  // Resolved URL (already incorporates /avatars/... vs /community/
  // avatars/:slug/image, depending on storage mode). Server-resolved
  // so the client never has to know about image_path vs image_data.
  imageUrl: string;
}

// Admin shape — same fields plus mutable metadata visible only to
// staff. createdAt is ISO-8601.
export interface AvatarTemplateAdminSummary extends AvatarTemplateSummary {
  status: AvatarStatus;
  sortOrder: number;
  createdAt: string;
  // Carries through whether the row is a static seed (immutable
  // image bytes; PATCH metadata only) or an admin upload (image bytes
  // can be replaced via re-upload).
  source: "seed" | "upload";
}

// GET /community/avatars
export interface AvatarTemplateListResponse {
  templates: AvatarTemplateSummary[];
}

// GET /admin/avatars — includes hidden rows, full metadata.
export interface AvatarTemplateAdminListResponse {
  templates: AvatarTemplateAdminSummary[];
}

// PUT /community/me/avatar
export interface EquipAvatarRequest {
  // null clears the equipped avatar; the user falls back to the
  // monogram fallback in the UI.
  templateId: string | null;
}

// PATCH /admin/avatars/:id — every field optional, server rejects
// with 400 'no_changes' on an empty patch (mirrors the community
// profile patch shape).
export interface AvatarTemplatePatchRequest {
  name?: string;
  category?: string;
  rarity?: AvatarRarity;
  status?: AvatarStatus;
  sortOrder?: number;
}

// Per-PRD avatar size keys. The web layer maps them to next/image
// width/quality props; the server only needs to know the original.
export type AvatarSize = "xs" | "sm" | "md" | "lg" | "original";

export const AVATAR_SIZES: Record<AvatarSize, number | null> = {
  xs: 32,
  sm: 64,
  md: 128,
  lg: 256,
  original: null,
};
