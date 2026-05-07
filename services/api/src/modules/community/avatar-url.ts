// Single source of truth for resolving an avatar template to a public
// URL. Two storage modes coexist on the avatar_templates table; both
// the public list endpoint and every join (feed cards, profile, me)
// route through this helper so the rule lives in one place.
//
//   • Static seed   image_path = '/avatars/kaiju-01.png'
//                   → return as-is (served by Next.js public/).
//   • Admin upload  image_path = NULL, bytes in image_data
//                   → return '/api/community/avatars/{slug}/image'.
//
// The /api prefix matches the Caddyfile: every /api/* path is
// reverse-proxied to the api container; everything else hits the web
// container. Keeping the prefix here means callers paste imageUrl
// straight into <img src> with no further rewriting.

export interface AvatarRow {
  slug: string;
  imagePath: string | null;
}

export function resolveAvatarUrl(row: AvatarRow): string {
  if (row.imagePath) return row.imagePath;
  return `/api/community/avatars/${row.slug}/image`;
}

// Optional template — returns null when the user has no equipped
// avatar. Convenience for joins that LEFT-OUTER a template and
// can hand the row directly through.
export function resolveOptionalAvatarUrl(
  row: AvatarRow | null | undefined,
): string | null {
  if (!row) return null;
  return resolveAvatarUrl(row);
}
