package com.askeden.edencode.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.Orientation
import androidx.compose.foundation.gestures.draggable
import androidx.compose.foundation.gestures.rememberDraggableState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.askeden.edencode.model.CodeStatus
import com.askeden.edencode.model.PhoneSummary
import com.askeden.edencode.model.SessionList
import com.askeden.edencode.net.Pairing
import com.askeden.edencode.store.EdenCodeStore

/** The drawer's width (the mockup's 320), never more than the screen less 56 for the scrim. */
val DrawerWidth: Dp = 320.dp

/**
 * Your sessions (the GDrawer mockup), sliding in from the left over the screen it moves aside:
 * search, New session, the Inbox and the Queue (the tab bar's other pages, now here), every
 * session in one flat list by day with one coloured word for where it is, Exterminator Mode's runs,
 * and at the foot the Mac (tap to switch or pair another) and Settings.
 *
 * Kept in its own file on purpose: the owner may swap the sessions list's design again.
 */
@Composable
fun SessionsDrawer(store: EdenCodeStore, onClose: () -> Unit) {
    val g = gInk
    val dark = Eden.dark
    val screen = LocalEnv.current.screen
    val top = safeTop()
    val bottom = safeBottom()
    var dragged by remember { mutableStateOf(0f) }
    val drag = rememberDraggableState { dragged += it }
    Column(
        Modifier.width(DrawerWidth).fillMaxHeight()
            .draggable(drag, Orientation.Horizontal, onDragStopped = { if (dragged < -60f) onClose(); dragged = 0f })
            .boxShadow(if (dark) Color.Black.copy(alpha = 0.5f) else hex(0x283C78, 0.18f), y = 0.dp, x = 16.dp, blur = 44.dp, radius = 0.dp)
            .glass(screen, RoundedCornerShape(0.dp), if (dark) hex(0x1C1C22, 0.55f) else hex(0xFFFFFF, 0.38f), blur = 40.dp, saturate = 2f)
            .drawWithContent {
                drawContent()
                // inset -1px 0 0 rgba(255,255,255,.7) (the right edge) and inset 0 1px 0 rgba(255,255,255,.9) (the top).
                val w = 1.dp.toPx()
                drawRect(Color.White.copy(alpha = if (dark) 0.16f else 0.7f), Offset(size.width - w, 0f), androidx.compose.ui.geometry.Size(w, size.height))
            }
            .semantics { contentDescription = "Your sessions" },
    ) {
        Column(Modifier.padding(start = 16.dp, end = 16.dp, top = top - 6.dp, bottom = 10.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            DrawerSearch(store.search) { store.search = it }
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                NavRow(Glyphs.compose, "New session", selected = store.path.isEmpty() && store.tab == EdenCodeStore.Tab.New) { store.newSession() }
                NavRow(Glyphs.inboxLine, "Inbox", count = store.home.needsYouCount, selected = store.path.isEmpty() && store.tab == EdenCodeStore.Tab.Inbox) { store.show(EdenCodeStore.Tab.Inbox) }
                NavRow(Glyphs.queueLine, "Queue", selected = store.path.isEmpty() && store.tab == EdenCodeStore.Tab.Queue) { store.show(EdenCodeStore.Tab.Queue) }
            }
        }
        val open = (store.path.firstOrNull() as? EdenCodeStore.Route.Session)?.id
        val groups = SessionList.groups(store.home.sessions, store.search)
        Column(
            Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 10.dp),
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            store.problem?.let { Box(Modifier.padding(horizontal = 6.dp, vertical = 6.dp)) { ProblemBanner(it) } }
            groups.forEachIndexed { index, group ->
                T(group.title, sf(13f, Semibold), g.grey, Modifier.padding(start = 12.dp, end = 12.dp, top = if (index == 0) 10.dp else 14.dp, bottom = 4.dp).semantics { heading() }, maxLines = 1)
                for (s in group.sessions) DrawerRow(s, today = group.title == "Today", selected = s.id == open) { store.open(session = s.id) }
            }
            if (store.loaded && groups.isEmpty()) {
                T(if (store.search.isBlank()) "No sessions yet. Start one with New session, or on your Mac." else "No session has “${store.search.trim()}”.",
                    sf(14f), g.grey, Modifier.padding(horizontal = 12.dp, vertical = 14.dp))
            }
            if (store.home.exterminator.isNotEmpty()) {
                T("Exterminator Mode", sf(13f, Semibold), g.grey, Modifier.padding(start = 12.dp, end = 12.dp, top = 14.dp, bottom = 4.dp).semantics { heading() }, maxLines = 1)
                for (run in store.home.exterminator) {
                    Row(
                        Modifier.fillMaxWidth().pressable(0.98f, label = run.project) { run.taskID?.let { store.open(session = it) } }.padding(horizontal = 12.dp, vertical = 10.dp),
                        horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Column(Modifier.weight(1f)) {
                            T(run.project, sf(16f), g.ink, maxLines = 1)
                            T(run.line, sf(13f), g.grey, maxLines = 1)
                        }
                        Glyph(Glyphs.bug, 16.dp, g.orange)
                    }
                }
            }
            Spacer(Modifier.height(12.dp))
        }
        MacFoot(store, bottom)
    }
}

@Composable
private fun DrawerSearch(value: String, onChange: (String) -> Unit) {
    val g = gInk
    val dark = Eden.dark
    val shape = RoundedCornerShape(12.dp)
    Row(
        Modifier.fillMaxWidth().height(40.dp)
            .background(if (dark) Color.White.copy(alpha = 0.08f) else Color.White.copy(alpha = 0.5f), shape)
            .topRim(12.dp, if (dark) Color.White.copy(alpha = 0.18f) else Color.White, Color.Transparent)
            .padding(horizontal = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically,
    ) {
        Glyph(Glyphs.search, 16.dp, g.grey)
        BasicTextField(
            value, onChange, Modifier.weight(1f).semantics { contentDescription = "Search sessions" },
            textStyle = sf(16f, lineHeight = 20f).copy(color = g.ink), singleLine = true, cursorBrush = SolidColor(g.blue),
            decorationBox = { inner -> Box { if (value.isEmpty()) T("Search", sf(16f, lineHeight = 20f), g.grey2, maxLines = 1); inner() } },
        )
    }
}

/** New session (and Inbox, Queue): an icon and a semibold word, as the mockup's New session row. */
@Composable
private fun NavRow(icon: androidx.compose.ui.graphics.vector.ImageVector, label: String, count: Int = 0, selected: Boolean, onClick: () -> Unit) {
    val g = gInk
    Row(
        Modifier.fillMaxWidth().selectedFill(selected).pressable(0.98f, label = if (count > 0) "$label, $count" else label, onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically,
    ) {
        Glyph(icon, 20.dp, g.ink)
        T(label, sf(16f, Semibold), g.ink, Modifier.weight(1f), maxLines = 1)
        if (count > 0) Box(Modifier.height(20.dp).background(g.orange, RoundedCornerShape(10.dp)).padding(horizontal = 7.dp), contentAlignment = Alignment.Center) {
            T("$count", sf(13f, Semibold, lineHeight = 15f), Color.White, maxLines = 1)
        }
    }
}

/** One session: its title, the coloured word for where it is, and its dot (or the ring while it works). */
@Composable
private fun DrawerRow(s: PhoneSummary, today: Boolean, selected: Boolean, onClick: () -> Unit) {
    val g = gInk
    val line = SessionList.statusLine(s.status, today)
    Row(
        Modifier.fillMaxWidth().selectedFill(selected)
            .pressable(0.98f, label = listOfNotNull(s.title, line).joinToString(", "), onClick = onClick)
            .semantics { this.selected = selected }
            .padding(horizontal = 12.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            T(s.title, sf(16f, lineHeight = 20f), g.ink, maxLines = 1)
            if (line != null) T(line, sf(13f, lineHeight = 16f), g.words(s.status), maxLines = 1)
        }
        if (line != null) {
            if (s.status == CodeStatus.Working) RingSpinner()
            else Box(Modifier.size(9.dp).background(g.of(s.status), CircleShape))
        }
    }
}

/** The open row's fill: white at 55% with a bright top edge (in dark, a faint white). */
@Composable
private fun Modifier.selectedFill(on: Boolean): Modifier {
    if (!on) return this
    val dark = Eden.dark
    return this.background(if (dark) Color.White.copy(alpha = 0.10f) else Color.White.copy(alpha = 0.55f), RoundedCornerShape(12.dp))
        .topRim(12.dp, if (dark) Color.White.copy(alpha = 0.2f) else Color.White, Color.Transparent)
}

/** The Mac this phone talks to (tap: switch, or pair another) and Settings. */
@Composable
private fun MacFoot(store: EdenCodeStore, bottom: Dp) {
    val g = gInk
    val dark = Eden.dark
    var picking by remember { mutableStateOf(false) }
    Box(Modifier.fillMaxWidth().height(1.dp).background(if (dark) Color.White.copy(alpha = 0.08f) else Color.Black.copy(alpha = 0.06f)))
    Row(
        Modifier.fillMaxWidth().padding(start = 18.dp, end = 18.dp, top = 12.dp, bottom = bottom),
        horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.weight(1f)) {
            Row(
                Modifier.fillMaxWidth().pressable(0.98f, label = "Mac: ${store.current?.macLabel ?: "none"}. Switch Mac") { picking = true },
                horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically,
            ) {
                EdenTile(32.dp, 16.dp)
                Column(Modifier.weight(1f)) {
                    T(store.current?.macLabel ?: "Your Mac", sf(15f, Medium, lineHeight = 18f), g.ink, maxLines = 1)
                    T(
                        when {
                            store.switchedOff -> "Eden Code is off on it"
                            store.problem != null -> "Can’t reach it"
                            store.loaded -> "Connected"
                            else -> "Connecting…"
                        },
                        sf(12f, lineHeight = 15f), if (store.problem != null) g.needs else g.grey, maxLines = 1,
                    )
                }
            }
            GlassMenu(picking, { picking = false }) {
                for (mac in store.macs) {
                    GlassMenuItem(mac.macLabel, checked = store.current?.let { Pairing.same(it, mac) } == true) {
                        picking = false
                        store.select(mac)
                    }
                }
                GlassMenuItem("Pair another Mac") {
                    picking = false
                    store.showPairing = true
                }
            }
        }
        Box(
            Modifier.size(36.dp).background(g.fill, CircleShape)
                .pressable(0.94f, label = "Settings") { store.show(EdenCodeStore.Tab.Settings) }
                .semantics { contentDescription = "Settings" },
            contentAlignment = Alignment.Center,
        ) { Glyph(Glyphs.gear, 18.dp, g.ink) }
    }
}
