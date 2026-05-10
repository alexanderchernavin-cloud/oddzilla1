package cc.oddzilla.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Modifier
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import cc.oddzilla.app.ui.theme.OddzillaTheme
import cc.oddzilla.app.ui.theme.OzTheme
import cc.oddzilla.app.update.UpdateGate
import cc.oddzilla.app.web.WebViewHost

// Single-activity host. Since v0.5.0 the user-facing surface is a
// Chromium WebView pointing at https://oddzilla.cc — see
// cc/oddzilla/app/web/WebViewHost.kt for the rationale. Native chrome
// kept on top of the WebView:
//   • System splash screen (installSplashScreen below)
//   • UpdateGate overlay — modal sits above the WebView so a mandatory
//     update still can't be tapped past

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        // Splash dismisses on first frame paint; the WebView itself
        // shows a spinner via WebViewHost until the page hydrates.
        installSplashScreen()
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        val deps = (application as OddzillaApp).deps

        setContent {
            OddzillaTheme {
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .background(OzTheme.colors.bg),
                ) {
                    WebViewHost(cookieJar = deps.cookieJar)
                    UpdateGate(deps.updateController)
                }

                LaunchedEffect(Unit) {
                    // Cold-start version manifest fetch. No auth, no
                    // cookies — the manifest is public at
                    // https://oddzilla.cc/app/version.json.
                    deps.updateController.check()
                }
            }
        }
    }
}
