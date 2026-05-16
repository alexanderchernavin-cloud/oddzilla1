package cc.oddzilla.app.data.api

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.HttpUrl
import java.util.concurrent.ConcurrentHashMap

// Persistent cookie jar backed by DataStore. The Oddzilla API sets two
// cookies on login (`accessToken` short-lived JWT, `refreshToken`
// 30-day rotating) with Domain=.oddzilla.cc, HttpOnly, Secure,
// SameSite=Lax. We persist whatever the server sends so a process
// restart doesn't kick the user back to the login screen.
//
// Implementation note: in-memory Map<host, List<Cookie>> for the hot
// path; DataStore writes happen async on every save. A snapshot is
// loaded synchronously at construction (runBlocking once) so the very
// first request after process start sees the restored cookies. After
// that everything is non-blocking.

private val Context.cookieDataStore by preferencesDataStore(name = "oddzilla_cookies")
private val COOKIE_KEY = stringPreferencesKey("cookies_json")

@Serializable
private data class StoredCookie(
    val name: String,
    val value: String,
    val domain: String,
    val path: String,
    val expiresAt: Long,
    val secure: Boolean,
    val httpOnly: Boolean,
    val hostOnly: Boolean,
    val persistent: Boolean,
)

@Serializable
private data class CookieEnvelope(val cookies: List<StoredCookie> = emptyList())

class PersistentCookieJar(private val context: Context) : CookieJar {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val json = Json { ignoreUnknownKeys = true }

    // Keyed by effective tld+1 host (e.g. "oddzilla.cc"). OkHttp will
    // ask for cookies per request URL; we filter our flat store on
    // load. Concurrent map so save/load don't lock the request thread.
    private val store = ConcurrentHashMap<String, Cookie>()

    init {
        // Synchronous restore. Acceptable on Application#onCreate which
        // already does I/O. After this the jar is non-blocking.
        runBlocking {
            val raw = context.cookieDataStore.data.first()[COOKIE_KEY] ?: return@runBlocking
            val envelope = runCatching { json.decodeFromString<CookieEnvelope>(raw) }.getOrNull()
                ?: return@runBlocking
            envelope.cookies.forEach { sc ->
                val cookie = Cookie.Builder()
                    .name(sc.name)
                    .value(sc.value)
                    .also { if (sc.hostOnly) it.hostOnlyDomain(sc.domain) else it.domain(sc.domain) }
                    .path(sc.path)
                    .expiresAt(sc.expiresAt)
                    .also { if (sc.secure) it.secure() }
                    .also { if (sc.httpOnly) it.httpOnly() }
                    .build()
                if (sc.persistent && cookie.expiresAt > System.currentTimeMillis()) {
                    store[cookie.cacheKey()] = cookie
                }
            }
        }
    }

    override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) {
        val now = System.currentTimeMillis()
        cookies.forEach { c ->
            // Drop expired cookies (server may emit a Set-Cookie with
            // Max-Age=0 to clear) and keep only domains we use.
            if (c.expiresAt <= now) {
                store.remove(c.cacheKey())
            } else {
                store[c.cacheKey()] = c
            }
        }
        persist()
    }

    override fun loadForRequest(url: HttpUrl): List<Cookie> {
        val now = System.currentTimeMillis()
        val matching = store.values.filter { it.matches(url) && it.expiresAt > now }
        // Cull expired ones lazily so the store doesn't grow forever.
        store.values.removeAll { it.expiresAt <= now }
        return matching
    }

    fun clear() {
        store.clear()
        persist()
    }

    // Cookie names mirror the api: services/api/src/lib/cookies.ts sets
    // `oddzilla_access` + `oddzilla_refresh`. The earlier shape probed
    // `accessToken` / `refreshToken` and never matched, so
    // PushBootstrap.registerPushIfLoggedIn silently early-returned on
    // every page load and no device ever registered. Keep these in
    // sync if the server-side constants ever change.
    fun hasAccessCookie(): Boolean =
        store.values.any { it.name == "oddzilla_access" && it.expiresAt > System.currentTimeMillis() }

    fun hasRefreshCookie(): Boolean =
        store.values.any { it.name == "oddzilla_refresh" && it.expiresAt > System.currentTimeMillis() }

    private fun Cookie.cacheKey(): String = "$domain|$path|$name"

    private fun persist() {
        val snapshot = store.values
            .filter { it.persistent }
            .map { c ->
                StoredCookie(
                    name = c.name,
                    value = c.value,
                    domain = c.domain,
                    path = c.path,
                    expiresAt = c.expiresAt,
                    secure = c.secure,
                    httpOnly = c.httpOnly,
                    hostOnly = c.hostOnly,
                    persistent = c.persistent,
                )
            }
        val payload = json.encodeToString(CookieEnvelope.serializer(), CookieEnvelope(snapshot))
        scope.launch {
            context.cookieDataStore.edit { prefs ->
                prefs[COOKIE_KEY] = payload
            }
        }
    }
}
