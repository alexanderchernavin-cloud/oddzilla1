package cc.oddzilla.app.data.repo

import cc.oddzilla.app.data.api.LoginRequest
import cc.oddzilla.app.data.api.OddzillaApi
import cc.oddzilla.app.data.api.PersistentCookieJar
import cc.oddzilla.app.data.api.SignupRequest
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import retrofit2.HttpException

// Auth state holder + REST glue. Owns the StateFlow consumed by the
// nav host; mutates it when login / signup / logout / bootstrap
// resolve. Errors bubble up to the ViewModel as exceptions; no
// swallowed failures.

class AuthRepository(
    private val api: OddzillaApi,
    private val cookieJar: PersistentCookieJar,
) {
    private val _state = MutableStateFlow<AuthSessionState>(AuthSessionState.Unknown)
    val state: StateFlow<AuthSessionState> = _state.asStateFlow()

    suspend fun bootstrap() {
        if (!cookieJar.hasAccessCookie() && !cookieJar.hasRefreshCookie()) {
            _state.value = AuthSessionState.LoggedOut
            return
        }
        try {
            val me = api.me()
            _state.value = AuthSessionState.LoggedIn(me.user)
        } catch (e: HttpException) {
            // 401: TokenAuthenticator already attempted refresh and
            // gave up. Treat as logged-out and clear the stale cookies
            // so the next launch doesn't waste a roundtrip.
            if (e.code() == 401) {
                cookieJar.clear()
                _state.value = AuthSessionState.LoggedOut
            } else {
                // Server reachable but borked; leave Unknown so the
                // caller can decide whether to retry. Surfaced via
                // throw so the ViewModel can render an error state.
                throw e
            }
        }
    }

    suspend fun login(email: String, password: String, deviceId: String?): AuthSessionState.LoggedIn {
        val resp = api.login(LoginRequest(email = email, password = password, deviceId = deviceId))
        val s = AuthSessionState.LoggedIn(resp.user)
        _state.value = s
        return s
    }

    suspend fun signup(
        email: String,
        password: String,
        displayName: String?,
    ): AuthSessionState.LoggedIn {
        val resp = api.signup(
            SignupRequest(email = email, password = password, displayName = displayName),
        )
        val s = AuthSessionState.LoggedIn(resp.user)
        _state.value = s
        return s
    }

    suspend fun logout() {
        runCatching { api.logout() }
        cookieJar.clear()
        _state.value = AuthSessionState.LoggedOut
    }
}
