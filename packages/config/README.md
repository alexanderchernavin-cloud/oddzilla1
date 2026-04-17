# @oddzilla/config

Central env parsing for TS services. zod-backed. Fail-fast on missing or
invalid values.

```ts
import { loadEnv } from "@oddzilla/config";

const env = loadEnv();
// env.DATABASE_URL, env.REDIS_URL, env.API_PORT, ... all typed.
```

Call `loadEnv()` exactly once at service boot. Cached on subsequent calls.

If a required variable is missing, the process prints the zod error paths
and exits with code 1 — no silent misconfigurations.

Every variable is documented in [`../../.env.example`](../../.env.example).
