package cc.oddzilla.app.data.api

import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.POST

// Retrofit interface. Since the v0.5.0 WebView pivot the storefront
// surface lives entirely inside the WebView, so the only REST contract
// the native shell still owns is push-notification device registration
// (called from the FCM service that lives in fcm/, currently
// scaffolded — see fcm/README.md). Add new endpoints sparingly: if it
// can live in the web app, keep it there.

interface OddzillaApi {
    @POST("devices/register")
    suspend fun registerDevice(@Body body: RegisterDeviceRequest)

    @POST("devices/unregister")
    suspend fun unregisterDevice(@Body body: UnregisterDeviceRequest)

    @GET("devices")
    suspend fun listDevices(): DevicesResponse
}
