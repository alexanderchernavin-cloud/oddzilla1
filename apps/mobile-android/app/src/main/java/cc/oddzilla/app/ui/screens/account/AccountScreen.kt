package cc.oddzilla.app.ui.screens.account

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import cc.oddzilla.app.BuildConfig
import cc.oddzilla.app.R
import cc.oddzilla.app.common.LocalDeps
import cc.oddzilla.app.data.repo.AuthSessionState
import cc.oddzilla.app.ui.components.OzGhostButton
import cc.oddzilla.app.ui.theme.OzTheme
import kotlinx.coroutines.launch

@Composable
fun AccountScreen() {
    val deps = LocalDeps.current
    val colors = OzTheme.colors
    val scope = rememberCoroutineScope()
    val auth by deps.authRepository.state.collectAsStateWithLifecycle()
    val email = (auth as? AuthSessionState.LoggedIn)?.user?.email ?: ""

    Box(modifier = Modifier.fillMaxSize().padding(horizontal = 24.dp)) {
        Column(
            modifier = Modifier.fillMaxSize().padding(top = 40.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
            horizontalAlignment = Alignment.Start,
        ) {
            Text("Account", style = MaterialTheme.typography.displayMedium, color = colors.fg)
            if (email.isNotBlank()) {
                Text(email, style = MaterialTheme.typography.bodyMedium, color = colors.fgMuted)
            }
            Text(
                stringResource(R.string.account_version, BuildConfig.VERSION_NAME, BuildConfig.VERSION_CODE),
                style = MaterialTheme.typography.labelSmall,
                color = colors.fgDim,
            )
            Box(modifier = Modifier.padding(top = 32.dp)) {
                OzGhostButton(
                    text = stringResource(R.string.account_logout),
                    onClick = { scope.launch { deps.authRepository.logout() } },
                )
            }
        }
    }
}
