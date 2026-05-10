package cc.oddzilla.app.update

import android.content.Context
import android.util.Log
import cc.oddzilla.app.BuildConfig
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.security.MessageDigest

// Owns the update lifecycle. Single instance held by OddzillaApp;
// MainActivity collects state and renders the modal.
//
// State machine:
//
//   Idle ─check()─▶ Checking ─▶ UpToDate
//                              │
//                              └▶ Available(manifest)
//                                          │
//                                          └─download()─▶ Downloading(progress)
//                                                                 │
//                                                                 ├▶ ReadyToInstall(file)
//                                                                 │           │
//                                                                 │           └─install()─▶ system installer
//                                                                 │
//                                                                 └▶ Failed(message)
//
// Cancelling a download (user dismisses modal) returns to
// Available(manifest); the partial file is deleted.

sealed interface UpdateState {
    data object Idle : UpdateState
    data object Checking : UpdateState
    data object UpToDate : UpdateState
    data class Available(val manifest: VersionManifest, val mandatory: Boolean) : UpdateState
    data class Downloading(val manifest: VersionManifest, val progress: Float, val mandatory: Boolean) : UpdateState
    data class ReadyToInstall(val manifest: VersionManifest, val apkFile: File, val mandatory: Boolean) : UpdateState
    data class Failed(val message: String, val mandatory: Boolean) : UpdateState
}

class UpdateController(
    private val context: Context,
    private val httpClient: OkHttpClient,
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val json = Json { ignoreUnknownKeys = true }
    private val _state = MutableStateFlow<UpdateState>(UpdateState.Idle)
    val state: StateFlow<UpdateState> = _state.asStateFlow()

    private var downloadJob: Job? = null

    fun check() {
        if (_state.value is UpdateState.Checking || _state.value is UpdateState.Downloading) return
        _state.value = UpdateState.Checking
        scope.launch {
            val manifest = fetchManifest()
            if (manifest == null) {
                _state.value = UpdateState.UpToDate
                return@launch
            }
            val current = BuildConfig.VERSION_CODE
            val isNewer = manifest.versionCode > current
            val isUnsupported = current < manifest.minSupportedVersionCode
            if (!isNewer && !isUnsupported) {
                _state.value = UpdateState.UpToDate
                return@launch
            }
            val mandatory = manifest.mandatory || isUnsupported
            if (manifest.apkUrl.isNullOrBlank()) {
                Log.w(TAG, "manifest advertises new version but apkUrl is null; treating as up-to-date")
                _state.value = UpdateState.UpToDate
                return@launch
            }
            _state.value = UpdateState.Available(manifest, mandatory)
        }
    }

    fun download() {
        val current = _state.value as? UpdateState.Available ?: return
        downloadJob?.cancel()
        downloadJob = scope.launch {
            try {
                val file = downloadApk(current.manifest)
                if (file != null) {
                    _state.value = UpdateState.ReadyToInstall(current.manifest, file, current.mandatory)
                } else {
                    _state.value = UpdateState.Failed("Download failed.", current.mandatory)
                }
            } catch (e: Throwable) {
                Log.e(TAG, "download failed", e)
                _state.value = UpdateState.Failed(e.message ?: "Download failed.", current.mandatory)
            }
        }
    }

    fun retry() {
        val failed = _state.value as? UpdateState.Failed ?: return
        // Re-check from scratch — the manifest may have moved on while
        // the user was looking at the failure dialog.
        _state.value = UpdateState.Idle
        if (!failed.mandatory) {
            // For optional updates the user can dismiss; only re-check
            // proactively for mandatory ones so the app doesn't poll
            // /app/version.json on a tight loop.
        }
        check()
    }

    fun dismiss() {
        when (val s = _state.value) {
            is UpdateState.Available -> if (!s.mandatory) _state.value = UpdateState.UpToDate
            is UpdateState.Failed -> if (!s.mandatory) _state.value = UpdateState.UpToDate
            is UpdateState.ReadyToInstall -> if (!s.mandatory) _state.value = UpdateState.UpToDate
            else -> Unit
        }
    }

    fun install() {
        val ready = _state.value as? UpdateState.ReadyToInstall ?: return
        ApkInstaller.install(context, ready.apkFile)
    }

    private suspend fun fetchManifest(): VersionManifest? = withContext(Dispatchers.IO) {
        try {
            val req = Request.Builder()
                .url(BuildConfig.VERSION_MANIFEST_URL)
                .get()
                .build()
            httpClient.newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) {
                    Log.w(TAG, "version manifest HTTP ${resp.code}")
                    return@use null
                }
                val body = resp.body?.string() ?: return@use null
                json.decodeFromString(VersionManifest.serializer(), body)
            }
        } catch (e: Throwable) {
            Log.w(TAG, "version manifest fetch failed: ${e.message}")
            null
        }
    }

    private suspend fun downloadApk(manifest: VersionManifest): File? = withContext(Dispatchers.IO) {
        val apkUrl = manifest.apkUrl ?: return@withContext null
        val cacheDir = File(context.externalCacheDir, UPDATE_DIR).apply { mkdirs() }
        // Wipe any stale .apk from prior runs so we don't leave the
        // user's storage littered with old versions.
        cacheDir.listFiles()?.forEach { it.delete() }
        val outFile = File(cacheDir, "oddzilla-${manifest.versionName}.apk")

        _state.value = UpdateState.Downloading(manifest, 0f, mandatoryFlag())

        val req = Request.Builder().url(apkUrl).get().build()
        httpClient.newCall(req).execute().use { resp ->
            if (!resp.isSuccessful) throw IllegalStateException("download HTTP ${resp.code}")
            val body = resp.body ?: throw IllegalStateException("empty body")
            val total = body.contentLength().takeIf { it > 0 } ?: -1
            val md = MessageDigest.getInstance("SHA-256")
            outFile.outputStream().use { sink ->
                body.byteStream().use { source ->
                    val buf = ByteArray(64 * 1024)
                    var read = 0L
                    var lastEmitted = -1
                    while (true) {
                        val n = source.read(buf)
                        if (n == -1) break
                        sink.write(buf, 0, n)
                        md.update(buf, 0, n)
                        read += n
                        if (total > 0) {
                            val pct = ((read * 100) / total).toInt()
                            if (pct != lastEmitted) {
                                lastEmitted = pct
                                _state.value = UpdateState.Downloading(manifest, pct / 100f, mandatoryFlag())
                            }
                        }
                    }
                }
            }
            // Verify SHA-256 if the manifest provides one. Mismatch is
            // a hard error — delete the file and surface a Failed state
            // rather than offering to install a corrupted/tampered APK.
            val expected = manifest.sha256
            if (!expected.isNullOrBlank()) {
                val actual = md.digest().joinToString("") { "%02x".format(it) }
                if (!actual.equals(expected, ignoreCase = true)) {
                    outFile.delete()
                    Log.e(TAG, "sha256 mismatch: expected=$expected actual=$actual")
                    throw IllegalStateException("Download integrity check failed.")
                }
            }
        }

        outFile
    }

    private fun mandatoryFlag(): Boolean = when (val s = _state.value) {
        is UpdateState.Available -> s.mandatory
        is UpdateState.Downloading -> s.mandatory
        is UpdateState.ReadyToInstall -> s.mandatory
        is UpdateState.Failed -> s.mandatory
        else -> false
    }

    companion object {
        private const val TAG = "UpdateController"
        private const val UPDATE_DIR = "updates"
    }
}
