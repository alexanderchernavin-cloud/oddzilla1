// Shared API contract types. Keep in lockstep with services/api handlers.

export interface AuthLoginRequest {
  email: string;
  password: string;
  deviceId?: string;
}

export interface AuthSignupRequest {
  email: string;
  password: string;
  displayName?: string;
  countryCode?: string;
}

export interface AuthTokens {
  accessToken: string;
  accessTokenExpiresAt: string; // ISO-8601
}

export interface AuthMe {
  id: string;
  email: string;
  role: "user" | "admin" | "support";
  status: "active" | "blocked" | "pending_kyc";
  displayName?: string | null;
  kycStatus: "none" | "pending" | "approved" | "rejected";
}

export interface WalletSummary {
  balanceMicro: string; // bigint serialized as string
  lockedMicro: string;
  currency: "USDT";
}

export interface HealthResponse {
  status: "ok" | "degraded" | "down";
  db: "ok" | "down";
  redis: "ok" | "down";
  uptimeSeconds: number;
  version: string;
}
