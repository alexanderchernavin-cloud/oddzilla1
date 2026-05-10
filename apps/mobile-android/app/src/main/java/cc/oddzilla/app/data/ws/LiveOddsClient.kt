package cc.oddzilla.app.data.ws

import android.util.Log
import cc.oddzilla.app.BuildConfig
import cc.oddzilla.app.data.api.HttpClientFactory
import cc.oddzilla.app.data.api.WsClientPing
import cc.oddzilla.app.data.api.WsClientSubscribe
import cc.oddzilla.app.data.api.WsClientUnsubscribe
import cc.oddzilla.app.data.api.WsHello
import cc.oddzilla.app.data.api.WsMatchStatusFrame
import cc.oddzilla.app.data.api.WsOddsFrame
import cc.oddzilla.app.data.api.WsTicketFrame
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

// Authenticated WebSocket fanout for live odds. One singleton per app;
// every screen that wants live odds calls subscribe(matchIds) and
// observes oddsFlow. Subscriptions are refcounted so multiple screens
// (sport list + match detail) can listen to the same match without
// duplicate sends to the gateway.
//
// Auth piggybacks on the OkHttp cookie jar — the WS upgrade carries
// the accessToken cookie and the gateway authenticates it during
// handshake (services/ws-gateway/src/server.ts). When the access
// cookie expires mid-session, the gateway closes with 1008/1011 and
// we reconnect; the TokenAuthenticator on the REST client refreshes
// the cookie on the next REST call.
//
// Inbound frames are dispatched as:
//   WsOddsFrame      → odds StateFlow keyed by "$matchId:$marketId:$outcomeId"
//   WsMatchStatusFrame → matchStatus StateFlow keyed by matchId
//   WsTicketFrame    → ticketUpdates SharedFlow (one-shot per ticket update)

data class OddsKey(val matchId: String, val marketId: String, val outcomeId: String)

data class OddsTick(
    val odds: String,
    val active: Boolean,
    val ts: Long,
)

class LiveOddsClient(
    private val client: OkHttpClient,
) {
    private val json = HttpClientFactory.json
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val lock = ReentrantLock()

    private val refCount = HashMap<String, Int>()
    private val subscribed = HashSet<String>()

    private var ws: WebSocket? = null
    private var connectJob: Job? = null
    private var pingJob: Job? = null
    private var reconnectAttempt = 0

    private val _odds = MutableStateFlow<Map<OddsKey, OddsTick>>(emptyMap())
    val odds: StateFlow<Map<OddsKey, OddsTick>> = _odds.asStateFlow()

    private val _matchStatus = MutableStateFlow<Map<String, String>>(emptyMap())
    val matchStatus: StateFlow<Map<String, String>> = _matchStatus.asStateFlow()

    private val _ticketUpdates = MutableSharedFlow<WsTicketFrame>(extraBufferCapacity = 32)
    val ticketUpdates: SharedFlow<WsTicketFrame> = _ticketUpdates.asSharedFlow()

    private val _connected = MutableStateFlow(false)
    val connected: StateFlow<Boolean> = _connected.asStateFlow()

    private val openSockets = AtomicInteger(0)

    fun subscribe(matchIds: Collection<String>) {
        if (matchIds.isEmpty()) return
        val toSend = mutableListOf<String>()
        lock.withLock {
            for (m in matchIds) {
                val n = (refCount[m] ?: 0) + 1
                refCount[m] = n
                if (n == 1) toSend += m
            }
        }
        ensureConnected()
        if (toSend.isNotEmpty()) sendSubscribe(toSend)
    }

    fun unsubscribe(matchIds: Collection<String>) {
        if (matchIds.isEmpty()) return
        val toSend = mutableListOf<String>()
        lock.withLock {
            for (m in matchIds) {
                val n = (refCount[m] ?: 0) - 1
                if (n <= 0) {
                    refCount.remove(m)
                    subscribed.remove(m)
                    toSend += m
                } else {
                    refCount[m] = n
                }
            }
        }
        if (toSend.isNotEmpty()) sendUnsubscribe(toSend)
    }

    fun shutdown() {
        connectJob?.cancel()
        pingJob?.cancel()
        ws?.close(1000, "shutdown")
        ws = null
        _connected.value = false
    }

    private fun ensureConnected() {
        if (ws != null && _connected.value) return
        if (connectJob?.isActive == true) return
        connectJob = scope.launch { connectLoop() }
    }

    private suspend fun connectLoop() {
        while (true) {
            try {
                val request = Request.Builder().url(BuildConfig.WS_URL).build()
                val socket = client.newWebSocket(request, listener)
                ws = socket
                openSockets.incrementAndGet()
                // Wait until the socket is closed; the listener flips
                // _connected and we'll fall through here when it dies.
                while (_connected.value || openSockets.get() > 0) {
                    delay(1000)
                    if (ws !== socket) break
                }
            } catch (e: Throwable) {
                Log.w(TAG, "ws connect error: ${e.message}")
            }
            // Backoff before reconnect (capped). Successful frames reset
            // the counter from inside the listener.
            val backoffMs = (250L * (1 shl reconnectAttempt.coerceAtMost(6))).coerceAtMost(15_000)
            reconnectAttempt = (reconnectAttempt + 1).coerceAtMost(8)
            delay(backoffMs)
            // If nothing is subscribed and we're not actively wanted,
            // exit the loop. ensureConnected() restarts it on next
            // subscribe.
            val anyRefs = lock.withLock { refCount.isNotEmpty() }
            if (!anyRefs) return
        }
    }

    private fun sendSubscribe(matchIds: List<String>) {
        val text = json.encodeToString(WsClientSubscribe.serializer(), WsClientSubscribe(matchIds = matchIds))
        if (ws?.send(text) != true) {
            // Couldn't send right now; mark as unsent. They'll be re-sent
            // when we reconnect via resyncSubscriptions().
            lock.withLock { matchIds.forEach { subscribed.remove(it) } }
        } else {
            lock.withLock { matchIds.forEach { subscribed.add(it) } }
        }
    }

    private fun sendUnsubscribe(matchIds: List<String>) {
        val text = json.encodeToString(WsClientUnsubscribe.serializer(), WsClientUnsubscribe(matchIds = matchIds))
        ws?.send(text)
    }

    private fun resyncSubscriptions() {
        val pending = lock.withLock {
            subscribed.clear()
            refCount.keys.toList()
        }
        if (pending.isNotEmpty()) sendSubscribe(pending)
    }

    private fun startPingLoop() {
        pingJob?.cancel()
        pingJob = scope.launch {
            while (_connected.value) {
                delay(30_000)
                ws?.send(json.encodeToString(WsClientPing.serializer(), WsClientPing()))
            }
        }
    }

    private val listener = object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            _connected.value = true
            reconnectAttempt = 0
            resyncSubscriptions()
            startPingLoop()
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            handleFrame(text)
        }

        override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
            handleFrame(bytes.utf8())
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            Log.w(TAG, "ws failure: ${t.message}")
            _connected.value = false
            openSockets.decrementAndGet().coerceAtLeast(0)
            ws = null
            ensureConnected()
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            _connected.value = false
            openSockets.decrementAndGet().coerceAtLeast(0)
            ws = null
            ensureConnected()
        }
    }

    private fun handleFrame(raw: String) {
        // Parse just the discriminator first; full deserialization
        // happens against the matching DTO. ignoreUnknownKeys keeps us
        // forward-compatible with new frame types.
        val type = runCatching {
            val element = json.parseToJsonElement(raw)
            (element as? JsonObject)?.get("type")?.let { (it as? JsonPrimitive)?.contentOrNull }
        }.getOrNull() ?: return

        when (type) {
            "hello" -> runCatching {
                val hello = json.decodeFromString(WsHello.serializer(), raw)
                Log.d(TAG, "ws hello user=${hello.userId} role=${hello.role}")
            }
            "odds" -> runCatching {
                val frame = json.decodeFromString(WsOddsFrame.serializer(), raw)
                applyOddsFrame(frame)
            }
            "match_status" -> runCatching {
                val frame = json.decodeFromString(WsMatchStatusFrame.serializer(), raw)
                _matchStatus.value = _matchStatus.value + (frame.matchId to frame.status)
            }
            "ticket" -> runCatching {
                val frame = json.decodeFromString(WsTicketFrame.serializer(), raw)
                scope.launch { _ticketUpdates.emit(frame) }
            }
            "pong", "error" -> Unit
            else -> Log.d(TAG, "unknown frame type=$type")
        }
    }

    private fun applyOddsFrame(frame: WsOddsFrame) {
        val current = _odds.value.toMutableMap()
        for (out in frame.outcomes) {
            val key = OddsKey(frame.matchId, frame.marketId, out.outcomeId)
            current[key] = OddsTick(odds = out.odds, active = out.active && frame.status == 1, ts = frame.ts)
        }
        _odds.value = current
    }

    fun oddsFor(matchId: String, marketId: String, outcomeId: String): OddsTick? =
        _odds.value[OddsKey(matchId, marketId, outcomeId)]

    companion object {
        private const val TAG = "LiveOddsClient"
    }
}
