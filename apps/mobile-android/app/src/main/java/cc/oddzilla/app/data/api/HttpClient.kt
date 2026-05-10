package cc.oddzilla.app.data.api

import cc.oddzilla.app.BuildConfig
import kotlinx.serialization.json.Json
import okhttp3.Authenticator
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.Route
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Retrofit
import retrofit2.converter.kotlinx.serialization.asConverterFactory
import java.util.concurrent.TimeUnit

// Builds the OkHttp + Retrofit stack. Three interceptors / one auth:
//
//   • OriginInterceptor stamps the Origin + Referer headers on every
//     request so the API's CSRF plugin (services/api/src/plugins/csrf.ts)
//     accepts state-changing methods. CORS_ORIGINS includes
//     https://oddzilla.cc, so this is the canonical mobile origin.
//
//   • UserAgentInterceptor identifies us in api logs / audit rows.
//
//   • TokenAuthenticator catches 401s and tries POST /auth/refresh
//     once before giving up. The cookie jar absorbs whatever new
//     accessToken+refreshToken the API rotates, so the retry hits
//     with fresh credentials transparently.
//
// Cookies are handled by the PersistentCookieJar (constructed by
// OddzillaApp), which restores accessToken + refreshToken across
// process restarts.

object HttpClientFactory {
    val json = Json {
        ignoreUnknownKeys = true
        explicitNulls = false
        encodeDefaults = false
    }

    fun build(cookieJar: PersistentCookieJar, versionName: String): Pair<OkHttpClient, Retrofit> {
        val origin = OriginInterceptor
        val ua = UserAgentInterceptor(versionName)

        // A bare client used only by the Authenticator to call
        // /auth/refresh. Shares the cookie jar so new tokens land
        // back in the main client's jar; has no Authenticator of
        // its own to avoid recursion.
        val refreshClient = OkHttpClient.Builder()
            .cookieJar(cookieJar)
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(15, TimeUnit.SECONDS)
            .addInterceptor(origin)
            .addInterceptor(ua)
            .build()

        val refreshUrl = BuildConfig.API_BASE_URL.trimEnd('/') + "/auth/refresh"
        val authenticator = TokenAuthenticator(
            refreshUrl = refreshUrl,
            refreshClient = refreshClient,
        )

        val builder = OkHttpClient.Builder()
            .cookieJar(cookieJar)
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .writeTimeout(30, TimeUnit.SECONDS)
            .addInterceptor(origin)
            .addInterceptor(ua)
            .authenticator(authenticator)

        if (BuildConfig.DEBUG) {
            builder.addInterceptor(
                HttpLoggingInterceptor().apply { level = HttpLoggingInterceptor.Level.BASIC },
            )
        }

        val client = builder.build()
        val contentType = "application/json".toMediaType()
        val retrofit = Retrofit.Builder()
            .baseUrl(BuildConfig.API_BASE_URL)
            .client(client)
            .addConverterFactory(json.asConverterFactory(contentType))
            .build()

        return client to retrofit
    }
}

private object OriginInterceptor : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val original = chain.request()
        val requested = original.newBuilder()
            .header("Origin", BuildConfig.ORIGIN_HEADER)
            .header("Referer", BuildConfig.ORIGIN_HEADER + "/")
            .build()
        return chain.proceed(requested)
    }
}

private class UserAgentInterceptor(private val versionName: String) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request().newBuilder()
            .header("User-Agent", "Oddzilla-Android/$versionName")
            .build()
        return chain.proceed(request)
    }
}

private class TokenAuthenticator(
    private val refreshUrl: String,
    private val refreshClient: OkHttpClient,
) : Authenticator {
    override fun authenticate(route: Route?, response: Response): Request? {
        // Already retried once or this IS the refresh call → give up.
        if (responseChainLength(response) >= 2) return null
        if (response.request.url.toString() == refreshUrl) return null

        // Synchronize so concurrent 401s don't fire N parallel refreshes.
        synchronized(this) {
            val req = Request.Builder()
                .url(refreshUrl)
                .post("".toRequestBody(null))
                .build()
            val refreshResp = try {
                refreshClient.newCall(req).execute()
            } catch (_: Throwable) {
                return null
            }
            refreshResp.use { if (!it.isSuccessful) return null }
        }

        // Retry the original request. The cookie jar will inject the
        // new accessToken automatically.
        return response.request.newBuilder().build()
    }

    private fun responseChainLength(r: Response): Int {
        var n = 1
        var prior = r.priorResponse
        while (prior != null) {
            n++
            prior = prior.priorResponse
        }
        return n
    }
}
