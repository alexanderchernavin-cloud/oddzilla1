package cc.oddzilla.app.fcm

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import cc.oddzilla.app.OddzillaApp
import cc.oddzilla.app.R
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

// FCM message handler. Registered in AndroidManifest.xml under
// <application>. Receives push payloads built by services/api's
// push-outbox worker (services/api/src/modules/push/render.ts) — the
// channel id below must match the worker's android.notification.channelId.
//
// Lifecycle notes:
//   • onNewToken fires when FCM rotates the token (app reinstall,
//     data clear, vendor rotation). We re-register so user_devices
//     points at the live token. Best-effort — failures retry on the
//     next foreground via PushBootstrap.registerPushIfLoggedIn().
//
//   • onMessageReceived is invoked when the app is foregrounded OR
//     when the inbound message has BOTH `notification` AND `data`
//     blocks (which our server-side dispatch always sends; see
//     services/api/src/modules/push/worker.ts). For purely
//     `notification`-only payloads with the app backgrounded, FCM
//     auto-posts the tray notification and this method is NOT called.

class FcmService : FirebaseMessagingService() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val channelId = "oddzilla-default"

    override fun onNewToken(token: String) {
        val deps = (application as OddzillaApp).deps
        scope.launch {
            runCatching { deps.devicesRepository.register(token) }
        }
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val title = message.notification?.title ?: message.data["title"] ?: "Oddzilla"
        val body = message.notification?.body ?: message.data["body"] ?: return
        val deepLink = message.data["deepLink"]
        ensureChannel()
        val notification = NotificationCompat.Builder(this, channelId)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentTitle(title)
            .setContentText(body)
            .setAutoCancel(true)
            .build()
        val nm = ContextCompat.getSystemService(this, NotificationManager::class.java)
        // Tag-by-deepLink so repeat pushes for the same target collapse
        // instead of stacking (e.g. two wins on the same ticket via a
        // re-settle generation would otherwise post twice).
        nm?.notify(deepLink?.hashCode() ?: 0, notification)
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = ContextCompat.getSystemService(this, NotificationManager::class.java) ?: return
        if (nm.getNotificationChannel(channelId) != null) return
        val channel = NotificationChannel(
            channelId,
            "Bet updates",
            NotificationManager.IMPORTANCE_DEFAULT,
        ).apply {
            description = "Bet acceptance, settlement, cashout offers, copy-bet inspirations."
        }
        nm.createNotificationChannel(channel)
    }
}
