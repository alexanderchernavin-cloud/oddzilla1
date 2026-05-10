package cc.oddzilla.app.nav

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.SnackbarHost
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import cc.oddzilla.app.common.LocalDeps
import cc.oddzilla.app.data.repo.AuthSessionState
import cc.oddzilla.app.ui.screens.auth.LoginScreen
import cc.oddzilla.app.ui.screens.auth.SignupScreen
import cc.oddzilla.app.ui.screens.bet.BetSlipSheet
import cc.oddzilla.app.ui.screens.community.CommunityProfileScreen
import cc.oddzilla.app.ui.screens.main.MainScaffold
import cc.oddzilla.app.ui.screens.match.MatchDetailScreen
import cc.oddzilla.app.ui.screens.sports.SportDetailScreen
import cc.oddzilla.app.ui.theme.OzTheme
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.systemBars

@Composable
fun OddzillaNav() {
    val deps = LocalDeps.current
    val auth by deps.authRepository.state.collectAsStateWithLifecycle()
    val navController = rememberNavController()
    val colors = OzTheme.colors
    var slipOpen by remember { mutableStateOf(false) }

    val startRoute = when (auth) {
        AuthSessionState.Unknown -> null
        AuthSessionState.LoggedOut -> Routes.LOGIN
        is AuthSessionState.LoggedIn -> Routes.MAIN
    }

    LaunchedEffect(auth) {
        when (auth) {
            AuthSessionState.LoggedOut -> {
                if (navController.currentDestination?.route != Routes.LOGIN &&
                    navController.currentDestination?.route != Routes.SIGNUP
                ) {
                    navController.navigate(Routes.LOGIN) {
                        popUpTo(0) { inclusive = true }
                        launchSingleTop = true
                    }
                }
            }
            is AuthSessionState.LoggedIn -> {
                val current = navController.currentDestination?.route
                if (current == null || current == Routes.LOGIN || current == Routes.SIGNUP) {
                    navController.navigate(Routes.MAIN) {
                        popUpTo(0) { inclusive = true }
                        launchSingleTop = true
                    }
                }
            }
            else -> Unit
        }
    }

    if (startRoute == null) {
        Box(modifier = Modifier.fillMaxSize().background(colors.bg), contentAlignment = Alignment.Center) {
            CircularProgressIndicator(color = colors.fg)
        }
        return
    }

    Box(modifier = Modifier.fillMaxSize().background(colors.bg)) {
        NavHost(navController = navController, startDestination = startRoute) {
            composable(Routes.LOGIN) {
                LoginScreen(onSwitchToSignup = { navController.navigate(Routes.SIGNUP) })
            }
            composable(Routes.SIGNUP) {
                SignupScreen(onSwitchToLogin = { navController.popBackStack(Routes.LOGIN, inclusive = false) })
            }
            composable(Routes.MAIN) {
                MainScaffold(
                    onNavigateSport = { slug -> navController.navigate(Routes.sport(slug)) },
                    onNavigateProfile = { nickname -> navController.navigate(Routes.profile(nickname)) },
                    onOpenSlip = { slipOpen = true },
                )
            }
            composable(
                Routes.SPORT,
                arguments = listOf(navArgument("slug") { type = NavType.StringType }),
            ) { entry ->
                val slug = entry.arguments?.getString("slug").orEmpty()
                SportDetailScreen(
                    slug = slug,
                    onBack = { navController.popBackStack() },
                    onMatchClicked = { id -> navController.navigate(Routes.match(id)) },
                )
            }
            composable(
                Routes.MATCH,
                arguments = listOf(navArgument("id") { type = NavType.StringType }),
            ) { entry ->
                val id = entry.arguments?.getString("id").orEmpty()
                MatchDetailScreen(
                    matchId = id,
                    onBack = { navController.popBackStack() },
                    onSlipPeekTap = { slipOpen = true },
                )
            }
            composable(
                Routes.PROFILE,
                arguments = listOf(navArgument("nickname") { type = NavType.StringType }),
            ) { entry ->
                val nick = entry.arguments?.getString("nickname").orEmpty()
                CommunityProfileScreen(
                    nickname = nick,
                    onBack = { navController.popBackStack() },
                    onProfileTap = { other -> navController.navigate(Routes.profile(other)) },
                )
            }
        }

        // Snackbar host hovers above every screen so messages from any
        // depth (e.g. copy-bet success deep inside community feed)
        // surface in the same place.
        SnackbarHost(
            hostState = deps.snackbar.hostState,
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .padding(WindowInsets.systemBars.asPaddingValues()),
        )
    }

    if (slipOpen) {
        BetSlipSheet(onDismiss = { slipOpen = false })
    }
}
