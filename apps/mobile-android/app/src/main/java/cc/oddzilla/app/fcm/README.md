# Firebase Cloud Messaging setup

The mobile push pipeline ships in two halves.

**Server-side is live and waiting for tokens** (migration `0045_user_devices` + `POST /devices/register` in `services/api/src/modules/devices/routes.ts`). Tokens land in the `user_devices` table; `DevicesRepository` on the mobile side talks to the endpoint.

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

## 4. Wire token registration on app launch

In `MainActivity.kt`, after `deps.authRepository.bootstrap()` resolves to `LoggedIn`:

```kotlin
import com.google.firebase.messaging.FirebaseMessaging

LaunchedEffect(authState) {
    if (authState is AuthSessionState.LoggedIn) {
        runCatching {
            val token = FirebaseMessaging.getInstance().token.await()
            deps.devicesRepository.register(token)
        }
    }
}
```

(`kotlinx.coroutines.tasks.await` lives in `kotlinx-coroutines-play-services` — add `implementation("org.jetbrains.kotlinx:kotlinx-coroutines-play-services:1.9.0")` if you don't already have it.)

In `AccountScreen.kt`'s logout flow, before calling `authRepository.logout()`:

```kotlin
runCatching {
    val token = FirebaseMessaging.getInstance().token.await()
    deps.devicesRepository.unregister(token)
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

## Server-side (Firebase Admin SDK on the api)

The api currently writes to `user_devices` but doesn't send pushes. To enable sending:

1. Generate a service account JSON in Firebase Console → Project settings → Service accounts → Generate new private key
2. Drop it on the box at `/srv/oddzilla-firebase/service-account.json` (mode 600, owned by the api container's UID)
3. Mount it into the api container in `docker-compose.yml`:
   ```yaml
   api:
     volumes:
       - /srv/oddzilla-firebase/service-account.json:/run/firebase/service-account.json:ro
     environment:
       GOOGLE_APPLICATION_CREDENTIALS: /run/firebase/service-account.json
   ```
4. `pnpm --filter @oddzilla/api add firebase-admin` and write a small `services/api/src/lib/push.ts` wrapper around `admin.messaging().sendEachForMulticast()`
5. Call the wrapper from the settlement service (when `tickets.status` flips to `settled` / `voided` / `cashed_out`) and from the api's bet-placement path (acceptance acknowledgement)

Decision points to make then: which events trigger pushes (settlement always; cashout offer always; copy-bet inspiration only when the originator has the `bet_inspired` notification preference set to true), how to render rich notifications with deep links, and whether to batch high-volume operators with FCM topic subscriptions instead of per-token sends.

This is genuinely a separate session of work — the scaffolding above is set up so that's all you need to do, no bigger refactors.
