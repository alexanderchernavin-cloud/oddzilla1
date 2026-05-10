// Postgres error-code helpers. Drizzle wraps postgres-js errors in a
// `DrizzleQueryError`, so a thrown error from drizzle has shape
// `{ name: 'DrizzleQueryError', cause: { code: '23505', ... } }`.
// Walking `.cause` once means handlers don't need to know which
// driver layer surfaced the failure.

export function pgCode(err: unknown): string | null {
  if (err === null || typeof err !== "object") return null;
  const direct = (err as { code?: unknown }).code;
  if (typeof direct === "string") return direct;
  const cause = (err as { cause?: unknown }).cause;
  if (cause) return pgCode(cause);
  return null;
}

// 23505 = unique_violation in the SQL standard SQLSTATE space.
export function isUniqueViolation(err: unknown): boolean {
  return pgCode(err) === "23505";
}
