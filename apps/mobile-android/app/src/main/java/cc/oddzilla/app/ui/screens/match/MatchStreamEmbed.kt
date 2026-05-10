package cc.oddzilla.app.ui.screens.match

import android.annotation.SuppressLint
import android.view.ViewGroup
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import cc.oddzilla.app.data.api.StreamSource
import cc.oddzilla.app.ui.theme.OzTheme

// Hosts a small WebView that loads the embed URL for one stream
// platform. Native ExoPlayer would need m3u8 stream URLs we don't
// have — every supported platform publishes an iframe embed instead.
//
// Platform → embed URL:
//   twitch:   https://player.twitch.tv/?channel=<embedId>&parent=oddzilla.cc&autoplay=false&muted=true
//   youtube:  https://www.youtube-nocookie.com/embed/<embedId>?modestbranding=1&rel=0
//   kick:     https://player.kick.com/<embedId>
//   gjirafa:  https://video.gjirafa.com/embed/<embedId>
//
// The `parent=` param Twitch demands must be a domain registered with
// the Twitch app; oddzilla.cc qualifies (it embeds the same widget on
// the web). Streams without a recognisable embed fall through to a
// "Open in browser" affordance instead of loading raw URLs in the
// WebView (defence against javascript: / data: schemes the API
// already strips, but cheap belt + suspenders).

private const val TWITCH_PARENT = "oddzilla.cc"

private fun StreamSource.embedUrl(): String? = when (platform.lowercase()) {
    "twitch" -> embedId?.let {
        "https://player.twitch.tv/?channel=$it&parent=$TWITCH_PARENT&autoplay=false&muted=true"
    }
    "youtube" -> embedId?.let {
        "https://www.youtube-nocookie.com/embed/$it?modestbranding=1&rel=0"
    }
    "kick" -> embedId?.let { "https://player.kick.com/$it" }
    "gjirafa" -> embedId?.let { "https://video.gjirafa.com/embed/$it" }
    else -> null
}

@Composable
fun MatchStreamEmbed(streams: List<StreamSource>, modifier: Modifier = Modifier) {
    val embeddable = remember(streams) { streams.filter { it.embedUrl() != null } }
    if (embeddable.isEmpty()) return

    val colors = OzTheme.colors
    var selectedIndex by remember { mutableStateOf(0) }
    val active = embeddable[selectedIndex.coerceAtMost(embeddable.lastIndex)]
    val embedUrl = active.embedUrl() ?: return

    Box(modifier = modifier.fillMaxWidth().padding(horizontal = 16.dp)) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(12.dp))
                .background(colors.bgSunken)
                .border(BorderStroke(1.dp, colors.border), RoundedCornerShape(12.dp)),
        ) {
            Box(modifier = Modifier.fillMaxWidth().aspectRatio(16f / 9f)) {
                StreamWebView(url = embedUrl)
            }
            if (embeddable.size > 1) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(8.dp),
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    embeddable.forEachIndexed { idx, s ->
                        val on = idx == selectedIndex
                        Box(
                            modifier = Modifier
                                .clip(RoundedCornerShape(percent = 50))
                                .background(if (on) colors.accent else Color(0xFF000000).copy(alpha = 0.4f))
                                .clickable { selectedIndex = idx }
                                .padding(horizontal = 10.dp, vertical = 4.dp),
                        ) {
                            Text(
                                s.platform.replaceFirstChar(Char::titlecase),
                                style = MaterialTheme.typography.labelSmall,
                                color = if (on) colors.accentFg else colors.bg,
                            )
                        }
                    }
                }
            }
        }
        Spacer(Modifier.height(4.dp))
    }
}

@SuppressLint("SetJavaScriptEnabled")
@Composable
private fun StreamWebView(url: String) {
    AndroidView(
        modifier = Modifier.fillMaxWidth(),
        factory = { context ->
            WebView(context).apply {
                layoutParams = ViewGroup.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT,
                )
                settings.apply {
                    javaScriptEnabled = true
                    domStorageEnabled = true
                    mediaPlaybackRequiresUserGesture = false
                    cacheMode = WebSettings.LOAD_DEFAULT
                    mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
                    // Don't load anything from file:// or content://; the
                    // embed only needs network HTTPS.
                    allowFileAccess = false
                    allowContentAccess = false
                }
                webChromeClient = WebChromeClient()
                webViewClient = WebViewClient()
                loadUrl(url)
            }
        },
        update = { view ->
            // Avoid double-loading when Compose reuses the AndroidView.
            if (view.url != url) view.loadUrl(url)
        },
    )
}
