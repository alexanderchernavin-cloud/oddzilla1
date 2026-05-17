package cc.oddzilla.app.web

import android.annotation.SuppressLint
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import cc.oddzilla.app.BuildConfig
import cc.oddzilla.app.data.api.PersistentCookieJar
import cc.oddzilla.app.data.repo.DevicesRepository
import cc.oddzilla.app.fcm.registerPushIfLoggedIn
import cc.oddzilla.app.fcm.unregisterPush
import cc.oddzilla.app.ui.theme.OzTheme
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import okhttp3.Cookie
import okhttp3.HttpUrl.Companion.toHttpUrl

// Single-WebView host. After the design pivot in v0.5.0 the app is a
// thin Chromium shell over https://oddzilla.cc — the web is already
// responsive (mobile drawers, sticky bet-slip bar, mobile-first
// breakpoints in apps/web/src/app/globals.css), so wrapping it gives
// pixel-identical parity with what the user sees in Chrome on the
// phone. Native chrome that DOES stay native:
//   • System splash screen (installSplashScreen in MainActivity)
//   • UpdateGate overlay (UpdateController polls /app/version.json
//     once on cold start, no auth required, sits above the WebView so
//     mandatory updates can't be bypassed)
//   • Cookie sync — every page load mirrors the WebView's CookieManager
//     state into PersistentCookieJar so the OkHttp client used by
//     DevicesRepository (FCM device-register, currently scaffolded —
//     see fcm/README.md) authenticates against the same session.
//
// Things deliberately not wired:
//   • No JS bridge. The web app already covers every flow the native
//     UI used to cover; nothing today needs to reach back into native.
//   • No file-chooser override. Storefront has no <input type=file>
//     (verified at the time of writing). Add one when avatar upload
//     ships — the contract is `WebChromeClient.onShowFileChooser`.

private const val TARGET_HOST = "oddzilla.cc"
private const val TARGET_URL = "https://$TARGET_HOST/"

@SuppressLint("SetJavaScriptEnabled")
@Composable
fun WebViewHost(
    cookieJar: PersistentCookieJar,
    devicesRepository: DevicesRepository,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val colors = OzTheme.colors

    // Persisted across config changes so rotation doesn't reload the
    // page and lose scroll/form state. AndroidView's `factory` runs
    // once; subsequent compositions reuse the same WebView instance.
    var webViewRef by remember { mutableStateOf<WebView?>(null) }
    var loading by remember { mutableStateOf(true) }

    val activity = context as? Activity

    BackHandler(enabled = true) {
        val wv = webViewRef
        if (wv != null && wv.canGoBack()) {
            wv.goBack()
        } else {
            // Falling out: minimize instead of finishing the activity so
            // the WebView stays warm if the user re-launches. moveTaskToBack
            // is the standard "user pressed back at the root" behaviour.
            activity?.moveTaskToBack(true)
        }
    }

    Box(modifier = modifier.fillMaxSize().background(colors.bg)) {
        AndroidView(
            modifier = Modifier
                .fillMaxSize()
                .systemBarsPadding(),
            factory = { ctx ->
                createConfiguredWebView(
                    ctx = ctx,
                    cookieJar = cookieJar,
                    devicesRepository = devicesRepository,
                    onLoadingChanged = { loading = it },
                ).also { web ->
                    webViewRef = web
                    web.loadUrl(TARGET_URL)
                }
            },
        )

        if (loading) {
            // First-paint spinner so a cold start doesn't flash the bone
            // background for ~300ms before the page hydrates. Cleared
            // on WebViewClient#onPageStarted's first call (page begins
            // rendering) — anything beyond that is the web app's
            // responsibility.
            Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(color = colors.fg)
            }
        }
    }

    DisposableEffect(Unit) {
        onDispose {
            // Persist cookies one more time on dispose. Android's
            // CookieManager is durable on its own, but the OkHttp jar
            // mirror needs an explicit nudge, AND CookieManager's
            // SQLite writes are async — without an explicit flush()
            // a hard process kill before the next housekeeping pass
            // can leave the just-set login cookies on the I/O queue
            // and the next launch boots to the login screen.
            mirrorCookiesToOkHttp(cookieJar)
            CookieManager.getInstance().flush()
        }
    }
}

@SuppressLint("SetJavaScriptEnabled")
private fun createConfiguredWebView(
    ctx: Context,
    cookieJar: PersistentCookieJar,
    devicesRepository: DevicesRepository,
    onLoadingChanged: (Boolean) -> Unit,
): WebView {
    // Login-state transition tracking. Each onPageFinished compares
    // wasLoggedIn (the previous snapshot) against the current jar
    // state and fires register/unregister on the transition edges.
    // false-initial means a fresh launch with cookies already on disk
    // still fires register exactly once — the first onPageFinished
    // observes a logged-in state and acts as a transition.
    val pushScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    var wasLoggedIn = false
    // Global cookie acceptance + per-WebView third-party cookies. Disir
    // widgets and Twitch / YouTube embeds load inside iframes from
    // *.oddin.gg / twitch.tv / youtube-nocookie.com — those are
    // third-party from the WebView's POV.
    CookieManager.getInstance().setAcceptCookie(true)

    val web = WebView(ctx).apply {
        layoutParams = ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT,
        )
        setBackgroundColor(0)
        isVerticalScrollBarEnabled = true
        isHorizontalScrollBarEnabled = false
        settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            loadsImagesAutomatically = true
            useWideViewPort = true
            loadWithOverviewMode = true
            allowFileAccess = false
            allowContentAccess = false
            // Strict default; every embed (Twitch / YT / Disir) is
            // HTTPS, and we never want a downgrade to slip through.
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            // Append a UA token so backend logs can distinguish the
            // Android shell from mobile Chrome. The leading UA is
            // whatever the system WebView ships, which already carries
            // the Mobile token so responsive CSS branches kick in.
            userAgentString = "${userAgentString} Oddzilla-Android/${BuildConfig.VERSION_NAME}"
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false)
            cacheMode = WebSettings.LOAD_DEFAULT
            mediaPlaybackRequiresUserGesture = true
        }
    }

    CookieManager.getInstance().setAcceptThirdPartyCookies(web, true)

    web.webViewClient = object : WebViewClient() {
        override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
            onLoadingChanged(false)
        }

        override fun onPageFinished(view: WebView?, url: String?) {
            onLoadingChanged(false)
            // Mirror cookies into the OkHttp jar so DevicesRepository
            // (FCM register) sees the same session as the WebView.
            mirrorCookiesToOkHttp(cookieJar)
            // Push WebView's in-memory cookie cache to disk. Without
            // this an app process kill can lose the freshly-set
            // oddzilla_refresh / oddzilla_access pair and the next
            // launch shows the login screen even though the user
            // never logged out.
            CookieManager.getInstance().flush()
            // FCM token register/unregister on auth-state transitions.
            // No-op when google-services.json is absent (PushBootstrap
            // reads BuildConfig.FIREBASE_ENABLED).
            val isLoggedIn = cookieJar.hasRefreshCookie()
            when {
                !wasLoggedIn && isLoggedIn -> pushScope.launch {
                    registerPushIfLoggedIn(cookieJar, devicesRepository)
                }
                wasLoggedIn && !isLoggedIn -> pushScope.launch {
                    unregisterPush(devicesRepository)
                }
            }
            wasLoggedIn = isLoggedIn
        }

        override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
            val url = request?.url ?: return false
            // Stay inside the WebView for our own host + Disir + Twitch
            // / YouTube / Kick / Gjirafa. Anything else (mailto:, tel:,
            // intent://, http(s) to a third-party domain that isn't an
            // iframe) gets handed to the system.
            if (isInAppHost(url)) return false

            return try {
                val intent = Intent(Intent.ACTION_VIEW, url).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                view?.context?.startActivity(intent)
                true
            } catch (_: ActivityNotFoundException) {
                // No app handles this scheme — let the WebView try
                // (will surface as net::ERR_UNKNOWN_URL_SCHEME, fine).
                false
            }
        }

        override fun onReceivedError(view: WebView?, request: WebResourceRequest?, error: WebResourceError?) {
            // Only act on the main-frame error — sub-resource errors
            // (a single iframe failing) should not blank the whole UI.
            if (request?.isForMainFrame != true) return
            onLoadingChanged(false)
        }
    }

    web.webChromeClient = object : WebChromeClient() {
        override fun onPermissionRequest(request: PermissionRequest?) {
            // Storefront has no feature that needs camera / mic. Deny
            // silently — the web layer will surface its own
            // "unavailable" UI if it ever matters.
            request?.deny()
        }
    }

    return web
}

private fun isInAppHost(url: Uri): Boolean {
    val host = url.host ?: return false
    if (host.equals(TARGET_HOST, ignoreCase = true)) return true
    if (host.endsWith(".$TARGET_HOST", ignoreCase = true)) return true
    // Iframes: Disir + Twitch + YouTube + Kick + Gjirafa are loaded by
    // the page itself (frame-src in the web CSP). Most stay inside
    // their <iframe>; this list catches the rare cases where one does
    // a full-page swap so the user stays inside the app.
    val embeddable = setOf(
        "twitch.tv", "www.twitch.tv", "player.twitch.tv",
        "youtube.com", "www.youtube.com", "youtube-nocookie.com", "www.youtube-nocookie.com",
        "kick.com", "player.kick.com",
        "video.gjirafa.com",
        "oddin.gg",
    )
    return embeddable.any { host == it || host.endsWith(".$it") }
}

// Translates Android CookieManager state for `https://oddzilla.cc`
// into okhttp3.Cookie entries on the persistent jar. Idempotent —
// the jar's `saveFromResponse` overwrites any existing cookie with
// the same (domain, path, name) triple.
private fun mirrorCookiesToOkHttp(jar: PersistentCookieJar) {
    val raw = CookieManager.getInstance().getCookie(TARGET_URL) ?: return
    val httpUrl = TARGET_URL.toHttpUrl()
    val cookies = raw.split(";").mapNotNull { piece ->
        val trimmed = piece.trim()
        if (trimmed.isEmpty()) return@mapNotNull null
        val eq = trimmed.indexOf('=')
        if (eq <= 0) return@mapNotNull null
        val name = trimmed.substring(0, eq).trim()
        val value = trimmed.substring(eq + 1).trim()
        // CookieManager.getCookie() does not surface attributes — we
        // synthesise something the OkHttp jar will accept. Domain pin
        // to oddzilla.cc matches what the API actually emits (see
        // COOKIE_DOMAIN in /home/team/oddzilla/.env: .oddzilla.cc).
        Cookie.Builder()
            .name(name)
            .value(value)
            .domain(TARGET_HOST)
            .path("/")
            .expiresAt(System.currentTimeMillis() + 30L * 24 * 60 * 60 * 1000)
            .secure()
            .build()
    }
    if (cookies.isNotEmpty()) {
        jar.saveFromResponse(httpUrl, cookies)
    }
}
