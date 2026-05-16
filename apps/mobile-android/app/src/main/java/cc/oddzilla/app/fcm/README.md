# Firebase Cloud Messaging setup

The mobile push pipeline ships in two halves.

**Server-side is live and waiting on credentials**:
- Migration `0058_push_notifications_outbox` adds the durable outbox table.
- `services/settlement` enqueues a `bet_won` row inside the same tx that flips a winning ticket to `settled`, then fires `NOTIFY push_outbox`.
- `services/api` runs `startPushOutboxWorker` (see [`services/api/src/modules/push/`](../../../../../../../services/api/src/modules/push/)) — it LISTENs on the channel + sweeps every 30 s, dispatches via Firebase Admin SDK, soft-revokes dead tokens, and bumps `attempts` / `last_error` on transient failures.
- Without a Firebase service-account JSON mounted, the worker runs in graceful-idle: rows are marked sent with `last_error='firebase_disabled'` so the queue drains and the table size stays bounded.

**Server activation** — once a Firebase project exists:
1. Firebase Console → Project settings → Service accounts → **Generate new private key**.
2. On the box: `sudo install -m 600 -o 1000 -g 1000 service-account.json /srv/oddzilla-firebase/service-account.json`. UID 1000 is the api container's node user. The compose mount uses the directory `/srv/oddzilla-firebase` (not the file), so a missing file doesn't abort `docker compose up` — Docker auto-creates the dir and the worker just stays in idle mode.
3. `make recreate api` to pick up the mount. Logs should show `push: outbox worker started firebase=enabled`.

**Client-side FCM is intentionally not wired up by default** because the Google Services Gradle plugin fails the build when `google-services.json` is missing. Follow the steps below once you create a Firebase project — the entire client integration is ~15 minutes of work.

---

## 1. Create a Firebase project

1. Go to https://console.firebase.google.com → **Add project** → "Oddzilla"
2. Add an Android app → package name **`cc.oddzilla.app`** (or `cc.oddzilla.app.debug` if you want a separate Firebase project per build flavour)
3. Skip Google Analytics (we don't ship it)
4. Download **`google-services.json`** → drop it at `apps/mobile-android/app/google-services.json` (already in `.gitignore`)

## 2. Uncomment the Gradle wiring

In `apps/mobile-android/build.gradle.kts` (root), add the plugin classpath:

```kotlin
plugins {
    alias(libs.plugins.androidApplication) apply false
    alias(libs.plugins.kotlinAndroid) apply false
    alias(libs.plugins.kotlinCompose) apply false
    alias(libs.plugins.kotlinSerialization) apply false
    id("com.google.gms.google-services") version "4.4.2" apply false   // <— add
}
```

In `apps/mobile-android/app/build.gradle.kts`, apply the plugin and add the deps:

```kotlin
plugins {
    alias(libs.plugins.androidApplication)
    alias(libs.plugins.kotlinAndroid)
    alias(libs.plugins.kotlinCompose)
    alias(libs.plugins.kotlinSerialization)
    id("com.google.gms.google-services")                                // <— add
}

dependencies {
    // …existing…
    implementation(platform("com.google.firebase:firebase-bom:33.7.0")) // <— add
    implementation("com.google.firebase:firebase-messaging-ktx")        // <— add
}
```

## 3. Activate `FcmService`

Rename `FcmService.kt.example` → `FcmService.kt` and uncomment its body. The file lives in `cc.oddzilla.app.fcm`.

Add the service declaration to `app/src/main/AndroidManifest.xml` inside `<application>`:

```xml
<service
    android:name=".fcm.FcmService"
    android:exported="false">
    <intent-filter>
        <action android:name="com.google.firebase.MESSAGING_EVENT" />
    </intent-filter>
</service>
```

The `oddzilla-default` notification channel id used in the server-side render path (`services/api/src/modules/push/worker.ts`) matches the one `FcmService.ensureChannel()` creates — no extra coordination needed.

## 4. Wire token registration on app launch

Since the v0.5.0 WebView pivot the auth state lives inside the WebView,
not native code. The cleanest hook is `WebViewHost`'s
`onPageFinished` — the same place we already mirror cookies into the
OkHttp jar. After mirroring, check whether the jar holds a
`refreshToken` (means: a logged-in session); if so, fetch the FCM
token and call `devicesRepository.register`.

In `WebViewHost.kt`, extend the page-finished hook (currently calls
`mirrorCookiesToOkHttp`) to also fire registration. Pass a small
callback through from `MainActivity` so the registration code stays
in `OddzillaApp` / a small `PushBootstrap.kt` and `WebViewHost` stays
UI-only:

```kotlin
import com.google.firebase.messaging.FirebaseMessaging
import kotlinx.coroutines.tasks.await

suspend fun registerPushIfLoggedIn(
    cookieJar: PersistentCookieJar,
    devicesRepo: DevicesRepository,
) {
    if (!cookieJar.hasRefreshCookie()) return
    runCatching {
        val token = FirebaseMessaging.getInstance().token.await()
        devicesRepo.register(token)
    }
}
```

(`kotlinx.coroutines.tasks.await` lives in `kotlinx-coroutines-play-services` — add `implementation("org.jetbrains.kotlinx:kotlinx-coroutines-play-services:1.9.0")` if you don't already have it.)

For unregister-on-logout: after the WebView's logout call lands (the
storefront calls `POST /auth/logout` and the API emits Set-Cookie
clears for `accessToken` + `refreshToken`), the next `onPageFinished`
sees an empty jar — detect the transition and fire `unregister`. A
simple `was-logged-in` boolean flag in `WebViewHost` is enough:

```kotlin
val wasLoggedIn = cookieJar.hasRefreshCookie()
mirrorCookiesToOkHttp(cookieJar)
val isLoggedIn = cookieJar.hasRefreshCookie()
if (wasLoggedIn && !isLoggedIn) {
    runCatching {
        val token = FirebaseMessaging.getInstance().token.await()
        devicesRepo.unregister(token)
    }
}
```

## 5. Permission flow (Android 13+)

`POST_NOTIFICATIONS` is already declared in `AndroidManifest.xml`. Add a runtime permission prompt on first foreground after login — Compose makes this a one-liner:

```kotlin
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts

val launcher = rememberLauncherForActivityResult(
    contract = ActivityResultContracts.RequestPermission(),
) { /* user accepted or declined */ }

LaunchedEffect(Unit) {
    if (Build.VERSION.SDK_INT >= 33) {
        launcher.launch(android.Manifest.permission.POST_NOTIFICATIONS)
    }
}
```

---

## Server-side reference (already wired)

The api side of this pipeline is fully implemented; the table below lists where each piece lives so you can adjust or extend without hunting.

| Concern | Location |
| --- | --- |
| Outbox schema + migration | [`packages/db/migrations/0058_push_notifications_outbox.sql`](../../../../../../../packages/db/migrations/0058_push_notifications_outbox.sql) |
| Drizzle schema | [`packages/db/src/schema/push-notifications.ts`](../../../../../../../packages/db/src/schema/push-notifications.ts) |
| Producer (settlement, Go) | [`services/settlement/internal/store/push.go`](../../../../../../../services/settlement/internal/store/push.go) + call site in `services/settlement/internal/settler/settler.go` `maybeSettleTicket` |
| Firebase Admin SDK init | [`services/api/src/modules/push/firebase.ts`](../../../../../../../services/api/src/modules/push/firebase.ts) |
| Render outbox payload → FCM message | [`services/api/src/modules/push/render.ts`](../../../../../../../services/api/src/modules/push/render.ts) |
| LISTEN + sweep + dispatch worker | [`services/api/src/modules/push/worker.ts`](../../../../../../../services/api/src/modules/push/worker.ts) |
| Worker boot + shutdown wiring | [`services/api/src/server.ts`](../../../../../../../services/api/src/server.ts) (`startPushOutboxWorker`) |
| Compose mount + env | `api` service in [`docker-compose.yml`](../../../../../../../docker-compose.yml) (`FIREBASE_SERVICE_ACCOUNT_PATH` + the `/run/firebase` bind) |

Future event kinds (`cashout_offered`, `bet_inspired`, …) plug into the same outbox by:
1. Producer writes a row with a new `kind` + JSONB payload.
2. Add a renderer branch in `services/api/src/modules/push/render.ts`.
3. Add a branch in `worker.ts` `processRow` if the new kind needs a non-default code path; the default falls through to `unsupported_kind:<kind>` so unknown rows never silently retain.

Operator surface for an audit:

```sql
-- Pending rows: should normally trend toward zero.
SELECT COUNT(*) FROM push_notifications_outbox WHERE sent_at IS NULL;

-- Rows that gave up (max_attempts) or that the worker dropped for
-- diagnostic reasons (firebase_disabled, no_devices, all_tokens_dead).
SELECT kind, last_error, COUNT(*) AS n
  FROM push_notifications_outbox
 WHERE sent_at IS NOT NULL AND last_error IS NOT NULL
 GROUP BY 1, 2 ORDER BY n DESC LIMIT 20;
```

Pruning is a future-me problem — the table grows ~1 row per winning ticket. At a rough 50 wins/match × 100 matches/day = 5 000 rows/day, a year is under 2M rows. When that becomes uncomfortable, add a daily `DELETE FROM push_notifications_outbox WHERE sent_at < now() - interval '30 days'` cron.
