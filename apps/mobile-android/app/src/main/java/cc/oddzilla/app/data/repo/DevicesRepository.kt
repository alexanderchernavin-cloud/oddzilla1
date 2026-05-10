package cc.oddzilla.app.data.repo

import cc.oddzilla.app.BuildConfig
import cc.oddzilla.app.data.api.DeviceSummary
import cc.oddzilla.app.data.api.OddzillaApi
import cc.oddzilla.app.data.api.RegisterDeviceRequest
import cc.oddzilla.app.data.api.UnregisterDeviceRequest

// Push-notification device registry client. The mobile FCM scaffolding
// (see fcm/ — currently commented-out until a Firebase project is
// wired up) calls register() once a token is obtained, and
// unregister() on logout. The endpoint is idempotent — repeat calls
// from the same token + user just bump last_seen_at.

class DevicesRepository(private val api: OddzillaApi) {

    suspend fun register(
        token: String,
        platform: String = "android",
        deviceLabel: String? = null,
    ) {
        api.registerDevice(
            RegisterDeviceRequest(
                token = token,
                platform = platform,
                appVersion = BuildConfig.VERSION_NAME,
                deviceLabel = deviceLabel,
            ),
        )
    }

    suspend fun unregister(token: String) {
        api.unregisterDevice(UnregisterDeviceRequest(token = token))
    }

    suspend fun list(): List<DeviceSummary> = api.listDevices().devices
}
