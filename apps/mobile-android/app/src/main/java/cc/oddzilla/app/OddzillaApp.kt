package cc.oddzilla.app

import android.app.Application
import cc.oddzilla.app.common.OddzillaDeps
import cc.oddzilla.app.data.api.HttpClientFactory
import cc.oddzilla.app.data.api.OddzillaApi
import cc.oddzilla.app.data.api.PersistentCookieJar
import cc.oddzilla.app.data.repo.DevicesRepository
import cc.oddzilla.app.update.UpdateController

// Application class. Constructed once on process start. Since the
// v0.5.0 WebView pivot the dependency graph is intentionally small:
//
//   • PersistentCookieJar — durable accessToken + refreshToken store.
//     The WebView is the user-facing source of truth; WebViewHost
//     mirrors its CookieManager state into this jar after every page
//     load so the OkHttp client below can reach authenticated
//     endpoints (currently just FCM device-register).
//
//   • UpdateController — cold-start version-manifest fetch from
//     /app/version.json (public, no cookies needed) + APK download
//     with SHA-256 verify, hand-off to the system installer.
//
//   • DevicesRepository — kept around for the FCM scaffolding in fcm/
//     (the SDK is intentionally not added until a Firebase project
//     exists; see fcm/README.md).

class OddzillaApp : Application() {

    lateinit var deps: OddzillaDeps
        private set

    override fun onCreate() {
        super.onCreate()

        val cookieJar = PersistentCookieJar(this)
        val (httpClient, retrofit) = HttpClientFactory.build(
            cookieJar = cookieJar,
            versionName = BuildConfig.VERSION_NAME,
        )
        val api: OddzillaApi = retrofit.create(OddzillaApi::class.java)

        val devicesRepository = DevicesRepository(api = api)
        val updateController = UpdateController(context = this, httpClient = httpClient)

        deps = OddzillaDeps(
            cookieJar = cookieJar,
            updateController = updateController,
            devicesRepository = devicesRepository,
        )
    }
}
