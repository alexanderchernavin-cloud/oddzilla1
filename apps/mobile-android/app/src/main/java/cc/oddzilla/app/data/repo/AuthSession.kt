package cc.oddzilla.app.data.repo

import cc.oddzilla.app.data.api.AuthUserDto

// Runtime auth state observed by the navigation host. Unknown means
// "still bootstrapping — show splash"; LoggedOut routes to login;
// LoggedIn routes to the main scaffold.

sealed interface AuthSessionState {
    data object Unknown : AuthSessionState
    data object LoggedOut : AuthSessionState
    data class LoggedIn(val user: AuthUserDto) : AuthSessionState
}
