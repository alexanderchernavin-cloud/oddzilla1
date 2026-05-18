package cc.oddzilla.app.fcm

import android.util.Log
import cc.oddzilla.app.BuildConfig
import cc.oddzilla.app.data.api.PersistentCookieJar
import cc.oddzilla.app.data.repo.DevicesRepository
import com.google.firebase.messaging.FirebaseMessaging
import kotlinx.coroutines.tasks.await

// Bootstrap helpers called by WebViewHost on every `onPageFinished`.
//
// Why login-state-gated, not "just register on launch":
//   The auth state lives inside the WebView (cookies on oddzilla.cc),
//   not native code. Registering an FCM token against an unauthenticated
//   API call would 401 — the api enforces auth on POST /devices/register.
//   We mirror cookies into PersistentCookieJar after each navigation,
//   then check whether the jar holds a refreshToken (= logged in).
//
//   • logged-in transition (was=false, is=true)  → register
//   • logged-out transition (was=true, is=false) → unregister
//   • stable logged-in (was=true, is=true)       → no-op (token already
//                                                  on file; SDK rotates
//                                                  via FcmService.onNewToken)
//   • stable logged-out (was=false, is=false)    → no-op
//
// FIREBASE_ENABLED is the build-time flag set from the google-services.json
// presence check in app/build.gradle.kts. Without it, FirebaseMessaging
// throws IllegalStateException because FirebaseInitProvider didn't run.

private const val TAG = "PushBootstrap"

suspend fun registerPushIfLoggedIn(
    cookieJar: PersistentCookieJar,
    devicesRepo: DevicesRepository,
) {
    if (!BuildConfig.FIREBASE_ENABLED) return
    if (!cookieJar.hasRefreshCookie()) return
    runCatching {
        val token = FirebaseMessaging.getInstance().token.await()
        devicesRepo.register(token)
    }.onFailure { e ->
        Log.w(TAG, "register failed: ${e.message}")
    }
}

suspend fun unregisterPush(
    devicesRepo: DevicesRepository,
) {
    if (!BuildConfig.FIREBASE_ENABLED) return
    runCatching {
        val token = FirebaseMessaging.getInstance().token.await()
        devicesRepo.unregister(token)
    }.onFailure { e ->
        Log.w(TAG, "unregister failed: ${e.message}")
    }
}
