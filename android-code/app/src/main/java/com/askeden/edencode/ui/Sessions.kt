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

/** A tab's scrolling page: under the status bar, 16 in from the sides, clear of the tab bar; pull to refresh. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TabPage(onRefresh: suspend () -> Unit, content: @Composable ColumnScope.() -> Unit) {
    val scope = rememberCoroutineScope()
    var refreshing by remember { mutableStateOf(false) }
    val top = safeTop()
    val bottom = safeBottom()
    PullToRefreshBox(refreshing, onRefresh = {
        refreshing = true
        scope.launch { onRefresh(); refreshing = false }
    }, Modifier.fillMaxSize()) {
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState())
                .padding(top = top, start = 16.dp, end = 16.dp, bottom = 24.dp + TabBarHeight + bottom),
            verticalArrangement = Arrangement.spacedBy(14.dp),
            content = content,
        )
    }
}

/**
 * The Sessions tab (PhoneSessions mockup, SessionsView.swift): the Mac picker and +, the large
 * title, search, the Needs-you banner, the pin from a handoff, sessions grouped by project with
 * their status dots, Exterminator Mode's runs, and the usage glance.
 */
@Composable
fun SessionsScreen() {
    val store = LocalEnv.current.store
    val c = Eden.colors
    TabPage({ store.refreshAll() }) {
        Column(Modifier.padding(top = 12.dp, start = 4.dp, end = 4.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                MacPicker(store)
                Spacer(Modifier.weight(1f))
                Box(
                    Modifier.size(40.dp)
                        .boxShadow(c.accent.copy(alpha = 0.35f), y = 6.dp, blur = 16.dp, radius = 20.dp)
                        .background(c.accent, CircleShape)
                        .pressable(0.94f, label = "New session") { store.showNewSession = true }
                        .semantics { contentDescription = "New session" },
                    contentAlignment = Alignment.Center,
                ) { Glyph(Glyphs.plus, 20.dp, Color.White) }
            }
            LargeTitle("Sessions", Modifier.semantics { heading() })
        }
        SearchField(store.search, { store.search = it }, Modifier.padding(horizontal = 4.dp))
        store.problem?.let { ProblemBanner(it) }
        if (store.home.needsYouCount > 0) NeedsYouBanner(store)
        store.home.pinned?.let { pinned ->
            BannerRow(Glyphs.handoff, c.accent, "From your Mac", pinned.title, Modifier.pressable(0.98f) { store.open(session = pinned.id) })
        }
        val groups = groups(store)
        for ((project, sessions) in groups) {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                SectionTitle(project)
                Column(Modifier.fillMaxWidth().edenCard()) {
                    sessions.forEachIndexed { index, session ->
                        SessionRow(session, store.home.attention.firstOrNull { it.taskID == session.id }) {
                            store.push(EdenCodeStore.Route.Session(session.id))
                        }
                        if (index < sessions.size - 1) RowDivider(36.dp)
                    }
                }
            }
        }
        if (store.loaded && groups.isEmpty() && store.problem == null) EmptyCard(
            Glyphs.code, c.accent, "No sessions yet", "Start one here, or on your Mac. It shows up here as it works.", "New session",
        ) { store.showNewSession = true }
        if (store.home.exterminator.isNotEmpty()) {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                SectionTitle("Exterminator Mode")
                Column(Modifier.fillMaxWidth().edenCard()) {
                    for (run in store.home.exterminator) {
                        Row(
                            Modifier.fillMaxWidth().pressable(0.98f) { run.taskID?.let { store.open(session = it) } }.padding(horizontal = 14.dp, vertical = 12.dp),
                            horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Glyph(Glyphs.bug, 17.dp, c.orange)
                            Column(verticalArrangement = Arrangement.spacedBy(1.dp)) {
                                T(run.project, sf(15f, Medium), c.ink, maxLines = 1)
                                T(run.line, sf(13f), c.muted)
                            }
                        }
                    }
                }
            }
        }
        UsageGlance(store.usage)
    }
}

private fun groups(store: EdenCodeStore): List<Pair<String, List<PhoneSummary>>> {
    val query = store.search.trim().lowercase()
    return store.home.byProject.mapNotNull { (project, sessions) ->
        val kept = if (query.isEmpty()) sessions else sessions.filter { it.title.lowercase().contains(query) || it.project.lowercase().contains(query) }
        if (kept.isEmpty()) null else project to kept
    }
}

@Composable
private fun SearchField(value: String, onChange: (String) -> Unit, modifier: Modifier) {
    val c = Eden.colors
    BasicTextField(
        value, onChange,
        modifier.fillMaxWidth().background(c.fill.copy(alpha = c.fill.alpha * 1.15f), RoundedCornerShape(11.dp))
            .padding(horizontal = 12.dp, vertical = 9.dp).semantics { contentDescription = "Search sessions" },
        textStyle = sf(16f, lineHeight = 21f).copy(color = c.ink), singleLine = true, cursorBrush = SolidColor(c.accent),
        decorationBox = { inner -> Box { if (value.isEmpty()) T("Search", sf(16f, lineHeight = 21f), placeholderInk(), maxLines = 1); inner() } },
    )
}

@Composable
private fun NeedsYouBanner(store: EdenCodeStore) {
    val c = Eden.colors
    val n = store.home.needsYouCount
    val summary = Transcript.summary(store.home.attention)
    Row(
        Modifier.fillMaxWidth()
            .background(c.orange.copy(alpha = 0.16f), RoundedCornerShape(18.dp))
            .border(1.dp, c.cardRim.copy(alpha = c.cardRim.alpha * 0.8f), RoundedCornerShape(18.dp))
            .pressable(0.98f, label = "Needs you, $n. $summary") { store.tab = EdenCodeStore.Tab.Inbox }
            .padding(horizontal = 14.dp, vertical = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically,
    ) {
        Badge(c.orange) { T("$n", sf(15f, Bold), Color.White, maxLines = 1) }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
            T("Needs you", sf(15f, Semibold), c.ink, maxLines = 1)
            T(summary, sf(13f), c.muted, maxLines = 1)
        }
        RowTail()
        Chevron()
    }
}

@Composable
fun BannerRow(icon: androidx.compose.ui.graphics.vector.ImageVector, tint: Color, title: String, subtitle: String, modifier: Modifier = Modifier) {
    val c = Eden.colors
    Row(
        modifier.fillMaxWidth().edenCard().padding(horizontal = 14.dp, vertical = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically,
    ) {
        Badge(tint) { Glyph(icon, 17.dp, Color.White) }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
            T(title, sf(15f, Semibold), c.ink, maxLines = 1)
            T(subtitle, sf(13f), c.muted, maxLines = 1)
        }
        RowTail()
        Chevron()
    }
}

/** One session: its dot, its title, and what it's doing (or waits on). */
@Composable
fun SessionRow(session: PhoneSummary, waiting: PhoneCard?, onClick: () -> Unit) {
    val c = Eden.colors
    val subtitle = waiting?.approval?.question ?: listOfNotNull(
        session.status.label,
        session.updatedAt?.let { relative(it) },
        session.model.ifEmpty { null },
    ).joinToString(" · ")
    Row(
        Modifier.fillMaxWidth().pressable(0.98f, label = "${session.title}, ${session.status.label}", onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically,
    ) {
        StatusDot(session.status)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
            T(session.title, sf(15f, Medium), c.ink, maxLines = 1)
            T(subtitle, sf(13f), c.subtitleInk(session.status), maxLines = 1)
        }
        RowTail()
        Chevron()
    }
}

/** "4 min ago", as `.relative(presentation: .numeric, unitsStyle: .abbreviated)` says it. */
fun relative(at: Long, now: Long = System.currentTimeMillis()): String {
    val s = ((now - at) / 1000).coerceAtLeast(0)
    return when {
        s < 60 -> "$s sec. ago"
        s < 3600 -> "${s / 60} min. ago"
        s < 86400 -> "${s / 3600} hr. ago"
        else -> "${s / 86400} days ago"
    }
}

/** "MacBook Air ▾": which Mac, and pairing another. */
@Composable
fun MacPicker(store: EdenCodeStore) {
    val c = Eden.colors
    val dark = Eden.dark
    var open by remember { mutableStateOf(false) }
    val shape = RoundedCornerShape(50)
    Box {
        Row(
            Modifier
                .boxShadow(hex(0x1E2850, if (dark) 0.3f else 0.08f), y = 2.dp, blur = 8.dp, radius = 999.dp)
                .glassControl(999.dp)
                .topRim(999.dp, if (dark) Color.White.copy(alpha = 0.2f) else Color.White, Color.Transparent)
                .pressable(0.96f, label = "Switch Mac") { open = true }
                .padding(horizontal = 14.dp, vertical = 7.dp)
                .semantics { contentDescription = "Mac: ${store.current?.macLabel ?: "none"}. Switch Mac" },
            horizontalArrangement = Arrangement.spacedBy(5.dp), verticalAlignment = Alignment.CenterVertically,
        ) {
            T(store.current?.macLabel ?: "Your Mac", sf(14f), c.ink, maxLines = 1)
            Glyph(Glyphs.chevronDown, 10.dp, c.ink)
        }
        GlassMenu(open, { open = false }) {
            for (mac in store.macs) {
                GlassMenuItem(mac.macLabel, checked = store.current?.let { Pairing.same(it, mac) } == true) {
                    open = false
                    store.select(mac)
                }
            }
            GlassMenuItem("Pair another Mac") {
                open = false
                store.showPairing = true
            }
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
