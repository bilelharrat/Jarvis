package com.askeden.edencode.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.askeden.edencode.model.Money
import com.askeden.edencode.model.PhoneCard
import com.askeden.edencode.model.PhoneSummary
import com.askeden.edencode.model.PhoneUsage
import com.askeden.edencode.model.Transcript
import com.askeden.edencode.net.Pairing
import com.askeden.edencode.store.EdenCodeStore
import kotlinx.coroutines.launch
import kotlin.math.roundToInt

/**
 * A page the drawer opens (Inbox, Queue): the G header's ☰ and ✎ floating over it, then its large
 * title and content, 16 in from the sides; pull to refresh.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TabPage(onRefresh: suspend () -> Unit, content: @Composable ColumnScope.() -> Unit) {
    val store = LocalEnv.current.store
    val scope = rememberCoroutineScope()
    var refreshing by remember { mutableStateOf(false) }
    val top = safeTop()
    val bottom = safeBottom()
    val backdrop = rememberBackdrop()
    Box(Modifier.fillMaxSize()) {
        PullToRefreshBox(refreshing, onRefresh = {
            refreshing = true
            scope.launch { onRefresh(); refreshing = false }
        }, Modifier.fillMaxSize().backdropSource(backdrop)) {
            EdenBackground()
            Column(
                Modifier.fillMaxSize().verticalScroll(rememberScrollState())
                    .padding(top = top - 6.dp + 44.dp + 12.dp, start = 16.dp, end = 16.dp, bottom = 24.dp + bottom),
                verticalArrangement = Arrangement.spacedBy(14.dp),
                content = content,
            )
        }
        GHeader(backdrop, onMenu = { store.drawerOpen = true }, onNew = { store.newSession() }, modifier = Modifier.padding(top = top - 6.dp)) {
            Spacer(Modifier.weight(1f))
        }
    }
}

/** Today's spending and the 5-hour window. */
@Composable
fun UsageGlance(usage: PhoneUsage?) {
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        UsageTile("Today", usage?.let { Money.text(it.today) + if (it.dayCap > 0) " of ${Money.text(it.dayCap)}" else "" } ?: "$ —", Modifier.weight(1f))
        UsageTile(usage?.fiveHour?.label ?: "5-hour limit", usage?.fiveHour?.percent?.let { "${it.roundToInt()}%" } ?: "—%", Modifier.weight(1f))
    }
}

@Composable
private fun UsageTile(label: String, value: String, modifier: Modifier) {
    val c = Eden.colors
    Column(
        modifier.edenCard().padding(horizontal = 14.dp, vertical = 12.dp).semantics(mergeDescendants = true) {},
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        T(label, sf(12f), c.muted, maxLines = 1)
        AutoShrinkText(value, 22f, Bold, c.ink, min = 0.6f)
    }
}

/** `.minimumScaleFactor`: one line, shrunk until it fits. */
@Composable
fun AutoShrinkText(text: String, size: Float, weight: androidx.compose.ui.text.font.FontWeight, color: Color, min: Float = 0.8f, modifier: Modifier = Modifier) {
    var scale by remember(text) { mutableStateOf(1f) }
    androidx.compose.foundation.text.BasicText(
        text, modifier, sf(size * scale, weight).copy(color = color), maxLines = 1, softWrap = false,
        onTextLayout = { if (it.hasVisualOverflow && scale > min) scale = (scale - 0.05f).coerceAtLeast(min) },
    )
}

/** A centred empty state on a card ("No sessions yet"). */
@Composable
fun EmptyCard(icon: androidx.compose.ui.graphics.vector.ImageVector, tint: Color, title: String, body: String, action: String? = null, onAction: () -> Unit = {}) {
    val c = Eden.colors
    Column(
        Modifier.fillMaxWidth().edenCard(radius = 20.dp).padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Glyph(icon, 30.dp, tint)
        T(title, sf(17f, Semibold), c.ink, align = TextAlign.Center)
        T(body, sf(15f), c.muted, align = TextAlign.Center)
        if (action != null) GlassButton(action, true, onClick = onAction)
    }
}

@Composable
fun SpacerH(h: Int) = Spacer(Modifier.height(h.dp))
