package cc.oddzilla.app.update

import kotlinx.serialization.Serializable

// Mirrors /srv/oddzilla-apk/version.json on the server. Caddy serves
// the file at https://oddzilla.cc/app/version.json with no-cache
// headers so update prompts propagate within minutes.
//
//   versionCode               monotonic int; >current means new build
//   versionName               human-readable (e.g. "0.2.0")
//   apkUrl                    full URL to the .apk; null means no
//                             release published yet (initial state)
//   sha256                    hex digest of the .apk; the downloader
//                             verifies this before launching the
//                             system installer to defend against a
//                             tampered .apk on the wire
//   releaseNotes              shown in the update dialog
//   mandatory                 true → modal cannot be dismissed; the
//                             user must tap "Update now" to keep
//                             using the app
//   minSupportedVersionCode   if BuildConfig.VERSION_CODE is below this,
//                             treat as mandatory regardless of the
//                             `mandatory` flag (post-mortem switch for
//                             builds with critical bugs)

@Serializable
data class VersionManifest(
    val versionCode: Int,
    val versionName: String,
    val apkUrl: String? = null,
    val sha256: String? = null,
    val releaseNotes: String? = null,
    val mandatory: Boolean = false,
    val minSupportedVersionCode: Int = 0,
)
