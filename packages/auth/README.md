# @oddzilla/auth

Password hashing and JWT helpers. Pure functions, no I/O.

## Password

argon2id via `@node-rs/argon2`. Parameters tuned for Hetzner CPX22
(~50 ms/hash):

```ts
import { hashPassword, verifyPassword } from "@oddzilla/auth";

const hash = await hashPassword("plaintext");
await verifyPassword(hash, "plaintext");  // true
```

Revisit `memoryCost` / `timeCost` on hardware upgrade.

## JWT

HS256 access tokens via `jose`. Opaque refresh tokens (48 random bytes,
base64url) stored as SHA-256 hashes in `sessions.refresh_token_hash`.

```ts
import {
  secretKey, signAccessToken, verifyAccessToken,
  newRefreshToken, hashRefreshToken,
} from "@oddzilla/auth";

const key = secretKey(process.env.JWT_SECRET!);
const token = await signAccessToken(
  { sub: userId, role: "user", sid: sessionId },
  key,
  900, // 15 minutes
);
const claims = await verifyAccessToken(token, key);
```

## Rotation

- Access token TTL 15 min (from `JWT_ACCESS_TTL_SECONDS`).
- Refresh token TTL 30 d (from `REFRESH_TTL_DAYS`); rotated every use,
  old row marked `revoked_at`.
- `JWT_SECRET` rotation invalidates all access tokens — users get new ones
  on next refresh. Do this every 6 months.
