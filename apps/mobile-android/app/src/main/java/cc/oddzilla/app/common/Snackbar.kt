package cc.oddzilla.app.common

import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHostState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

// Centralised snackbar surface. Repos / ViewModels post messages
// via SnackbarController; the host is mounted once at MainActivity
// so a snackbar from any deep screen surfaces in the same place.

class SnackbarController {
    val hostState = SnackbarHostState()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    fun show(message: String, actionLabel: String? = null, duration: SnackbarDuration = SnackbarDuration.Short) {
        scope.launch {
            hostState.showSnackbar(message = message, actionLabel = actionLabel, duration = duration)
        }
    }
}
