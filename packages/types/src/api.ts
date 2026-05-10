// Shared API contract types. Keep in lockstep with services/api handlers.
//
// Auth + wallet shapes intentionally live elsewhere:
//   - SessionUser (`apps/web/src/lib/auth.ts`) for the /auth/me response —
//     web component-local since no other consumer needs it.
//   - WalletSnapshot / WalletListResponse (`./wallet.ts`) for /wallet
//     (multi-currency since migration 0014; the legacy single-currency
//     WalletSummary that lived here was unused).

export interface HealthResponse {
  status: "ok" | "degraded" | "down";
  db: "ok" | "down";
  redis: "ok" | "down";
  uptimeSeconds: number;
  version: string;
}
