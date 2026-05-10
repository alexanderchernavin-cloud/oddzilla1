package cc.oddzilla.app.common

import cc.oddzilla.app.data.api.PersistentCookieJar
import cc.oddzilla.app.data.repo.DevicesRepository
import cc.oddzilla.app.update.UpdateController

// Service-locator container held by OddzillaApp. Since the v0.5.0
// WebView pivot the surface is small: a cookie jar shared between the
// WebView's CookieManager and the OkHttp client, the update flow
// controller (cold-start version-manifest fetch + APK download), and
// the device-register repository (currently scaffolded — see fcm/).
// All user-facing screens live inside the WebView and don't need
// native dependencies.

class OddzillaDeps(
    val cookieJar: PersistentCookieJar,
    val updateController: UpdateController,
    val devicesRepository: DevicesRepository,
)
