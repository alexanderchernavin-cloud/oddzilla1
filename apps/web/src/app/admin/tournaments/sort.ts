// Sort keys for /admin/tournaments, shared by the server page and the
// client editor.
//
// This file exists ONLY because it must NOT carry "use client".
// `SORT_KEYS` is a runtime value, and every export of a "use client"
// module becomes a client REFERENCE PROXY when a server component
// imports it — so `SORT_KEYS.includes(...)` inside page.tsx threw
// "includes is not a function" in production while typechecking cleanly
// and building cleanly, because the types are identical on both sides
// and only the runtime marshalling differs.
//
// Types are erased, so importing `SortKey`, `TournamentRow` etc. from the
// client module is fine. Values are not. Keep runtime constants that the
// server needs in a plain module like this one.

/** Mirrors the API allowlist in services/api/src/modules/admin/tournaments.ts. */
export const SORT_KEYS = [
  "default",
  "name",
  "sport",
  "category",
  "tier",
  "source",
] as const;

export type SortKey = (typeof SORT_KEYS)[number];
