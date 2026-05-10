package cc.oddzilla.app.data.api

import kotlinx.serialization.Serializable

// Wire types. Since the v0.5.0 WebView pivot the only REST contract
// the native shell still owns is push-notification device
// registration. The much larger pre-pivot DTO surface (auth, catalog,
// wallet, bets, community, cashout) lived in this file and was
// removed wholesale — those flows are handled inside the WebView now.

@Serializable
data class RegisterDeviceRequest(
    val token: String,
    val platform: String = "android",
    val appVersion: String? = null,
    val deviceLabel: String? = null,
)

@Serializable
data class UnregisterDeviceRequest(val token: String)

@Serializable
data class DevicesResponse(val devices: List<DeviceSummary>)

@Serializable
data class DeviceSummary(
    val id: String,
    val platform: String,
    val appVersion: String? = null,
    val deviceLabel: String? = null,
    val registeredAt: String,
    val lastSeenAt: String,
    val revokedAt: String? = null,
)
