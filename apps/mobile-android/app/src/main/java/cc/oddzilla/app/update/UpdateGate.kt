package cc.oddzilla.app.update

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.DialogProperties
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import cc.oddzilla.app.R
import cc.oddzilla.app.ui.components.OzGhostButton
import cc.oddzilla.app.ui.components.OzPrimaryButton
import cc.oddzilla.app.ui.theme.OzTheme

// Update modal driven by UpdateController.state. Mounted at the root
// of the app so it overlays whatever screen is showing — login,
// sports list, anywhere. Cannot be dismissed during Downloading or
// when the manifest marks the update mandatory.

@Composable
fun UpdateGate(controller: UpdateController) {
    val context = LocalContext.current
    val state by controller.state.collectAsStateWithLifecycle()

    when (val s = state) {
        is UpdateState.Available -> AvailableDialog(
            manifest = s.manifest,
            mandatory = s.mandatory,
            onUpdate = {
                if (ApkInstaller.canRequestPackageInstalls(context)) {
                    controller.download()
                } else {
                    ApkInstaller.openInstallSourcesSettings(context)
                }
            },
            onDismiss = { controller.dismiss() },
        )
        is UpdateState.Downloading -> DownloadingDialog(progress = s.progress)
        is UpdateState.ReadyToInstall -> ReadyDialog(
            mandatory = s.mandatory,
            onInstall = { controller.install() },
            onDismiss = { controller.dismiss() },
        )
        is UpdateState.Failed -> FailedDialog(
            mandatory = s.mandatory,
            onRetry = { controller.retry() },
            onDismiss = { controller.dismiss() },
        )
        else -> Unit
    }
}

@Composable
private fun AvailableDialog(
    manifest: VersionManifest,
    mandatory: Boolean,
    onUpdate: () -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = { if (!mandatory) onDismiss() },
        properties = DialogProperties(
            dismissOnBackPress = !mandatory,
            dismissOnClickOutside = !mandatory,
        ),
        title = { Text(stringResource(R.string.update_title)) },
        text = {
            Column {
                Text(stringResource(R.string.update_body))
                if (!manifest.releaseNotes.isNullOrBlank()) {
                    Spacer(Modifier.height(12.dp))
                    Text(
                        manifest.releaseNotes,
                        style = MaterialTheme.typography.bodySmall,
                        color = OzTheme.colors.fgMuted,
                    )
                }
                if (mandatory) {
                    Spacer(Modifier.height(12.dp))
                    Text(
                        stringResource(R.string.update_mandatory_note),
                        style = MaterialTheme.typography.labelMedium,
                        color = OzTheme.colors.negative,
                    )
                }
                Spacer(Modifier.height(12.dp))
                Text(
                    "v${manifest.versionName} (${manifest.versionCode})",
                    style = MaterialTheme.typography.labelSmall,
                    color = OzTheme.colors.fgDim,
                )
            }
        },
        confirmButton = {
            OzPrimaryButton(text = stringResource(R.string.update_now), onClick = onUpdate)
        },
        dismissButton = if (mandatory) null else {
            { OzGhostButton(text = stringResource(R.string.update_later), onClick = onDismiss) }
        },
    )
}

@Composable
private fun DownloadingDialog(progress: Float) {
    AlertDialog(
        onDismissRequest = { /* not dismissible while downloading */ },
        properties = DialogProperties(
            dismissOnBackPress = false,
            dismissOnClickOutside = false,
        ),
        title = { Text(stringResource(R.string.update_downloading)) },
        text = {
            Column {
                LinearProgressIndicator(
                    progress = { progress.coerceIn(0f, 1f) },
                    modifier = Modifier.fillMaxWidth().height(6.dp),
                )
                Spacer(Modifier.height(8.dp))
                Text("${(progress * 100).toInt()}%", style = MaterialTheme.typography.labelMedium)
            }
        },
        confirmButton = { /* none */ },
    )
}

@Composable
private fun ReadyDialog(
    mandatory: Boolean,
    onInstall: () -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = { if (!mandatory) onDismiss() },
        properties = DialogProperties(
            dismissOnBackPress = !mandatory,
            dismissOnClickOutside = !mandatory,
        ),
        title = { Text(stringResource(R.string.update_title)) },
        text = { Text(stringResource(R.string.update_install_prompt)) },
        confirmButton = {
            OzPrimaryButton(text = stringResource(R.string.update_now), onClick = onInstall)
        },
        dismissButton = if (mandatory) null else {
            { OzGhostButton(text = stringResource(R.string.update_later), onClick = onDismiss) }
        },
    )
}

@Composable
private fun FailedDialog(
    mandatory: Boolean,
    onRetry: () -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = { if (!mandatory) onDismiss() },
        properties = DialogProperties(
            dismissOnBackPress = !mandatory,
            dismissOnClickOutside = !mandatory,
        ),
        title = { Text(stringResource(R.string.update_title)) },
        text = { Text(stringResource(R.string.update_failed)) },
        confirmButton = {
            OzPrimaryButton(text = stringResource(R.string.update_now), onClick = onRetry)
        },
        dismissButton = if (mandatory) null else {
            { OzGhostButton(text = stringResource(R.string.update_later), onClick = onDismiss) }
        },
    )
}
