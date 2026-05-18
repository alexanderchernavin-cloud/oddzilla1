# Firebase Cloud Messaging setup

End-to-end push for winning bets is fully wired in code. Activation is a one-shot operator step: create the Firebase project and drop `google-services.json` into `apps/mobile-android/app/`. No further code edits.

## What's already in place

**Server side** (live in production):
- Outbox table `push_notifications_outbox` (migration `0058_push_notifications_outbox`).
- `services/settlement` enqueues a `bet_won` row inside the same tx as `SettleTicket` when a winning ticket pays out, then fires `NOTIFY push_outbox`.
- `services/api` runs `startPushOutboxWorker` (see [`services/api/src/modules/push/`](../../../../../../../services/api/src/modules/push/)) — LISTEN + 30 s sweep, dispatches via Firebase Admin SDK `sendEachForMulticast`, soft-revokes dead tokens, retries up to 5x.
- Service-account JSON mounted at `/srv/oddzilla-firebase/service-account.json` on the box; api logs `push: outbox worker started firebase=enabled`.

**Client side** (in code, gated on Firebase project):
- Gradle wiring: `apps/mobile-android/build.gradle.kts` declares the Google Services plugin classpath. `apps/mobile-android/app/build.gradle.kts` applies the plugin conditionally on `app/google-services.json` existing (so the project keeps building on fresh checkouts) and emits `BuildConfig.FIREBASE_ENABLED` based on the same check.
- Firebase deps: `firebase-bom` + `firebase-messaging-ktx` in `app/build.gradle.kts`.
- [`FcmService.kt`](./FcmService.kt) registered in `AndroidManifest.xml` — handles `onNewToken` (re-register on rotation) and `onMessageReceived` (post tray notification with deep-link).
- [`PushBootstrap.kt`](./PushBootstrap.kt) gates every FCM call on `BuildConfig.FIREBASE_ENABLED` and on the auth state in `PersistentCookieJar`.
- [`WebViewHost`](../web/WebViewHost.kt) calls `registerPushIfLoggedIn` / `unregisterPush` on every `onPageFinished` at the login/logout transition edges.
- `MainActivity` prompts for `POST_NOTIFICATIONS` on Android 13+ on cold start.
- `app/google-services.json` is in the root `.gitignore` (alongside the existing entry that already covered it).

## Activation — drop `google-services.json` and ship

1. Firebase Console → **Add project** → "Oddzilla".
2. **Add an Android app** → package name **`cc.oddzilla.app`** (and a second one with package name `cc.oddzilla.app.debug` if you want a separate Firebase project for debug builds).
3. Skip Google Analytics.
4. Download **`google-services.json`** → drop at `apps/mobile-android/app/google-services.json`. The path is gitignored.
5. From `apps/mobile-android/`: `./gradlew :app:assembleRelease` — the build now picks the JSON up, applies the Google Services plugin, sets `BuildConfig.FIREBASE_ENABLED=true`, and emits an APK that registers FCM tokens against `POST /api/devices/register` on every logged-in page load.
6. Ship the APK via `apps/mobile-android/scripts/release.ps1` (or the GH Actions `workflow_dispatch -release=true` path).

Once the new APK is installed on a logged-in device, watch:

```sql
-- Devices registering as users open the app.
SELECT COUNT(*) FROM user_devices WHERE revoked_at IS NULL;

-- Pushes draining cleanly (last_error IS NULL on the latest rows).
SELECT date_trunc('hour', sent_at) AS h,
       last_error,
       COUNT(*) AS n
  FROM push_notifications_outbox
 WHERE sent_at >= now() - interval '24 hours'
 GROUP BY 1, 2
 ORDER BY 1 DESC, n DESC;
```

The first winning ticket on a device with a registered token will land in the system tray with "You won! / {payout} {currency} from your {stake} {currency} {bet}."; tapping deep-links to `bets` (handled by the in-WebView routing — see [`FcmService.onMessageReceived`](./FcmService.kt)).

## Why the conditional plugin

The Google Services Gradle plugin parses `google-services.json` at configure time and fails the build hard when the file is missing. Conditionally applying it (`if (file("google-services.json").exists()) apply(...)`) means a fresh `git clone` builds cleanly and the FCM path is a runtime no-op (`BuildConfig.FIREBASE_ENABLED=false`) instead of a build-time failure. Same shape as the `keystore.properties` fallback to the debug keystore for unsigned local builds.

## Disabling FCM at runtime (debug only)

If you want to suppress push entirely for a debug session, delete `app/google-services.json` and rebuild — `FIREBASE_ENABLED=false` flips, every FCM call short-circuits, and the server-side outbox keeps draining (rows mark sent with `last_error='no_devices'` or `firebase_disabled` once the api side's mount is removed too).

## Where each piece lives

| Concern | Location |
| --- | --- |
| Outbox schema + migration | [`packages/db/migrations/0058_push_notifications_outbox.sql`](../../../../../../../packages/db/migrations/0058_push_notifications_outbox.sql) |
| Drizzle schema | [`packages/db/src/schema/push-notifications.ts`](../../../../../../../packages/db/src/schema/push-notifications.ts) |
| Producer (settlement, Go) | [`services/settlement/internal/store/push.go`](../../../../../../../services/settlement/internal/store/push.go) + call site in `services/settlement/internal/settler/settler.go` `maybeSettleTicket` |
| Firebase Admin SDK init (api) | [`services/api/src/modules/push/firebase.ts`](../../../../../../../services/api/src/modules/push/firebase.ts) |
| Render outbox payload → FCM message | [`services/api/src/modules/push/render.ts`](../../../../../../../services/api/src/modules/push/render.ts) |
| LISTEN + sweep + dispatch worker | [`services/api/src/modules/push/worker.ts`](../../../../../../../services/api/src/modules/push/worker.ts) |
| Worker boot + shutdown wiring | [`services/api/src/server.ts`](../../../../../../../services/api/src/server.ts) (`startPushOutboxWorker`) |
| Compose mount + env | `api` service in [`docker-compose.yml`](../../../../../../../docker-compose.yml) (`FIREBASE_SERVICE_ACCOUNT_PATH` + the `/run/firebase` bind) |
| Device intake (REST) | [`services/api/src/modules/devices/routes.ts`](../../../../../../../services/api/src/modules/devices/routes.ts) (`POST /devices/register` etc.; migration 0045) |
| Android device-register client | [`apps/mobile-android/app/src/main/java/cc/oddzilla/app/data/repo/DevicesRepository.kt`](../data/repo/DevicesRepository.kt) |
| Android FCM service | [`FcmService.kt`](./FcmService.kt) |
| Android push bootstrap (login-gated register / unregister) | [`PushBootstrap.kt`](./PushBootstrap.kt) |
| Android WebView hook | [`WebViewHost.kt`](../web/WebViewHost.kt) (`onPageFinished` transition edge) |
| Notification permission prompt | [`MainActivity.kt`](../MainActivity.kt) |

Future event kinds (`cashout_offered`, `bet_inspired`, …) plug into the same outbox by:
1. Producer writes a row with a new `kind` + JSONB payload.
2. Add a renderer branch in `services/api/src/modules/push/render.ts`.
3. Add a branch in `worker.ts` `processRow` if the new kind needs a non-default code path; the default falls through to `unsupported_kind:<kind>` so unknown rows never silently retain.
