package cc.oddzilla.app.nav

// Stable route keys used by the NavHost graph and the bottom-bar tabs.
// String constants instead of an enum so the navigation-compose API
// (which expects strings) doesn't trigger conversion noise at every
// call site.

object Routes {
    const val LOGIN = "auth/login"
    const val SIGNUP = "auth/signup"
    const val MAIN = "main"

    // Sub-routes pushed on top of MAIN.
    const val SPORT = "sport/{slug}"
    fun sport(slug: String) = "sport/$slug"

    const val MATCH = "match/{id}"
    fun match(id: String) = "match/$id"

    const val PROFILE = "profile/{nickname}"
    fun profile(nickname: String) = "profile/$nickname"

    // Bottom-bar tabs nested inside MAIN.
    const val TAB_SPORTS = "main/sports"
    const val TAB_COMMUNITY = "main/community"
    const val TAB_BETS = "main/bets"
    const val TAB_WALLET = "main/wallet"
    const val TAB_ACCOUNT = "main/account"
}
