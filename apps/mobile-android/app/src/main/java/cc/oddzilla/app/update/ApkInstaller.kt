package cc.oddzilla.app.update

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.core.content.FileProvider
import java.io.File

// Launches the system package installer for a downloaded APK. Android
// 8+ requires the calling package to either hold REQUEST_INSTALL_PACKAGES
// (declared in our manifest) AND have the user grant "Install unknown
// apps" for this source. We handle both:
//
//   • install() builds a content:// URI via FileProvider and fires the
//     ACTION_VIEW intent with the APK MIME type; the OS handles the
//     rest (signature check, install confirmation UI).
//
//   • canRequestPackageInstalls() probes whether the user has granted
//     the permission. The UI calls this before showing "Update now"
//     and routes to openInstallSourcesSettings() when it returns false
//     so the user can flip the toggle without leaving an Intent error
//     stranded.

object ApkInstaller {
    fun install(context: Context, apkFile: File) {
        val authority = "${context.packageName}.fileprovider"
        val uri: Uri = FileProvider.getUriForFile(context, authority, apkFile)
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        context.startActivity(intent)
    }

    fun canRequestPackageInstalls(context: Context): Boolean {
        return context.packageManager.canRequestPackageInstalls()
    }

    fun openInstallSourcesSettings(context: Context) {
        val intent = Intent(
            Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
            Uri.parse("package:${context.packageName}"),
        ).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        context.startActivity(intent)
    }
}
