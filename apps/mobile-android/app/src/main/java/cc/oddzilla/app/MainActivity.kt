package cc.oddzilla.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Modifier
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import cc.oddzilla.app.common.LocalDeps
import cc.oddzilla.app.nav.OddzillaNav
import cc.oddzilla.app.ui.theme.OddzillaTheme
import cc.oddzilla.app.update.UpdateGate
import cc.oddzilla.app.ui.theme.OzTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        // Splash screen is dismissed as soon as the first frame draws —
        // we don't gate on a network call here, the Compose root shows
        // its own bootstrapping spinner via OddzillaNav.
        installSplashScreen()
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        val deps = (application as OddzillaApp).deps

        setContent {
            OddzillaTheme {
                CompositionLocalProvider(LocalDeps provides deps) {
                    Box(
                        modifier = Modifier
                            .fillMaxSize()
                            .background(OzTheme.colors.bg),
                    ) {
                        OddzillaNav()
                        // Update modal renders above everything (login,
                        // bottom-tabs, dialogs) so a mandatory update
                        // can't be bypassed by the user touching the
                        // page underneath.
                        UpdateGate(deps.updateController)
                    }

                    // Kick off the auth bootstrap and the version-manifest
                    // check on first composition. Both are no-ops on
                    // subsequent recompositions (the controllers track
                    // their own state).
                    LaunchedEffect(Unit) {
                        deps.authRepository.bootstrap()
                        deps.updateController.check()
                    }
                }
            }
        }
    }
}
