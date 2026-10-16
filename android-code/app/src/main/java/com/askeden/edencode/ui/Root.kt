package com.askeden.edencode.ui

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.slideOutVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.askeden.edencode.store.EdenCodeStore

/** What the screens share: the store, and the Backdrop the floating chrome blurs. */
class Env(val store: EdenCodeStore, val screen: Backdrop, val speech: com.askeden.edencode.services.Voice)

val LocalEnv = androidx.compose.runtime.staticCompositionLocalOf<Env> { error("no Env") }

/** The floating tab bar's height (8 + 4 + 22 + 2 + 13 + 4 + 8), for the space content leaves under it. */
val TabBarHeight: Dp = 60.dp

/**
 * Four tabs under a floating glass tab bar (Sessions, Inbox, Queue, Settings), a session or its
 * changes pushed over Sessions, the approval sheet over everything, and pairing when no Mac is
 * paired yet (RootView.swift).
 */
@Composable
fun Root(store: EdenCodeStore, voice: com.askeden.edencode.services.Voice) {
    val screen = rememberBackdrop()
    val background = rememberBackdrop()
    val env = remember(store, screen, voice) { Env(store, screen, voice) }
    CompositionLocalProvider(LocalEnv provides env, LocalBackground provides background) {
        BackHandler(enabled = store.sheetCard != null || store.showNewSession || store.showPairing || store.path.isNotEmpty() || store.tab != EdenCodeStore.Tab.Sessions) {
            store.back()
        }
        Box(Modifier.fillMaxSize()) {
            Box(Modifier.fillMaxSize().backdropSource(screen)) {
                EdenBackground(Modifier.backdropSource(background))
                if (!store.paired) {
                    PairingScreen(first = true, onDone = {})
                } else {
                    val route = store.path.lastOrNull()
                    AnimatedContent(
                        targetState = route to store.tab,
                        transitionSpec = {
                            val pushing = (targetState.first != null && initialState.first == null) ||
                                (targetState.first is EdenCodeStore.Route.Changes && initialState.first is EdenCodeStore.Route.Session)
                            val popping = initialState.first != null && (targetState.first == null || targetState.first is EdenCodeStore.Route.Session && initialState.first is EdenCodeStore.Route.Changes)
                            when {
                                pushing -> slideInHorizontally(tween(320)) { it } togetherWith slideOutHorizontally(tween(320)) { -it / 3 }
                                popping -> slideInHorizontally(tween(320)) { -it / 3 } togetherWith slideOutHorizontally(tween(320)) { it }
                                else -> fadeIn(tween(160)) togetherWith fadeOut(tween(160))
                            }
                        },
                        label = "screens",
                    ) { (r, tab) ->
                        Box(Modifier.fillMaxSize()) {
                            when (r) {
                                is EdenCodeStore.Route.Session -> SessionScreen(r.id)
                                is EdenCodeStore.Route.Changes -> ChangesScreen(r.id)
                                null -> when (tab) {
                                    EdenCodeStore.Tab.Sessions -> SessionsScreen()
                                    EdenCodeStore.Tab.Inbox -> InboxScreen()
                                    EdenCodeStore.Tab.Queue -> QueueScreen()
                                    EdenCodeStore.Tab.Settings -> SettingsScreen()
                                }
                            }
                        }
                    }
                }
            }
            if (store.paired) {
                AnimatedVisibility(
                    visible = store.path.isEmpty(),
                    modifier = Modifier.align(Alignment.BottomCenter),
                    enter = fadeIn(tween(200)), exit = fadeOut(tween(120)),
                ) { TabBar(store) }
            }
            Sheets(store)
        }
    }
}

/**
 * iOS 26's floating glass tab bar: 21 in from the sides, 22 above the bottom edge, 60 tall, four
 * equal segments, the selected one in a tinted capsule, SF's filled symbols over 10 pt labels.
 */
@Composable
private fun TabBar(store: EdenCodeStore) {
    val dark = Eden.dark
    val env = LocalEnv.current
    val shape = RoundedCornerShape(50)
    Row(
        Modifier
            .padding(start = 21.dp, end = 21.dp, bottom = safeBottom() - 12.dp)
            .fillMaxWidth()
            .height(60.dp)
            .boxShadow(if (dark) Color.Black.copy(alpha = 0.45f) else hex(0x1E2850, 0.14f), y = 8.dp, blur = 28.dp, radius = 30.dp)
            .glass(env.screen, shape, if (dark) hex(0x2C2C30, 0.5f) else hex(0xFFFFFF, 0.42f), blur = 24.dp, saturate = 2.1f)
            .topRim(30.dp, if (dark) Color.White.copy(alpha = 0.22f) else Color.White, Color.Transparent)
            .border(1.dp, if (dark) Color.White.copy(alpha = 0.14f) else Color.White.copy(alpha = 0.7f), shape)
            .padding(4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        TabItem("Sessions", Glyphs.tabSessions, store.tab == EdenCodeStore.Tab.Sessions, 0) { store.tab = EdenCodeStore.Tab.Sessions }
        TabItem("Inbox", Glyphs.tabInbox, store.tab == EdenCodeStore.Tab.Inbox, store.home.needsYouCount) { store.tab = EdenCodeStore.Tab.Inbox }
        TabItem("Queue", Glyphs.tabQueue, store.tab == EdenCodeStore.Tab.Queue, 0) { store.tab = EdenCodeStore.Tab.Queue }
        TabItem("Settings", Glyphs.tabSettings, store.tab == EdenCodeStore.Tab.Settings, 0) { store.tab = EdenCodeStore.Tab.Settings }
    }
}

@Composable
private fun RowScope.TabItem(label: String, icon: ImageVector, selected: Boolean, badge: Int, onClick: () -> Unit) {
    val c = Eden.colors
    val ink = if (selected) c.accent else c.ink
    Box(
        Modifier.weight(1f).fillMaxHeight()
            .background(if (selected) (if (Eden.dark) Color.White.copy(alpha = 0.12f) else hex(0x1D1D1F, 0.06f)) else Color.Transparent, RoundedCornerShape(50))
            .clickable(remember { MutableInteractionSource() }, null, onClick = onClick)
            .semantics { role = Role.Tab; this.selected = selected; contentDescription = if (badge > 0) "$label, $badge" else label },
        contentAlignment = Alignment.Center,
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(1.dp)) {
            Box {
                Glyph(icon, 28.dp, ink)
                if (badge > 0) {
                    Box(
                        Modifier.align(Alignment.TopEnd).offset(x = 9.dp, y = (-4).dp).size(18.dp).background(c.red, CircleShape),
                        contentAlignment = Alignment.Center,
                    ) { T("$badge", sf(12f, Semibold, lineHeight = 14f), Color.White, maxLines = 1) }
                }
            }
            T(label, sf(10f, Semibold, lineHeight = 12f), ink, maxLines = 1)
        }
    }
}

/** The sheets over everything: an approval, a new session, pairing another Mac. */
@Composable
private fun BoxScope.Sheets(store: EdenCodeStore) {
    val showing = store.sheetCard != null || store.showNewSession || store.showPairing
    AnimatedVisibility(showing, enter = fadeIn(tween(220)), exit = fadeOut(tween(200))) {
        Box(
            Modifier.fillMaxSize().background(Color.Black.copy(alpha = if (store.sheetCard != null) 0.35f else 0.25f))
                .clickable(remember { MutableInteractionSource() }, null) { store.back() },
        )
    }
    AnimatedVisibility(
        store.sheetCard != null, Modifier.align(Alignment.BottomCenter),
        enter = slideInVertically(tween(340)) { it }, exit = slideOutVertically(tween(260)) { it },
    ) {
        store.sheetCard?.let { ApprovalSheet(it) }
    }
    AnimatedVisibility(
        store.showNewSession, Modifier.align(Alignment.BottomCenter),
        enter = slideInVertically(tween(340)) { it }, exit = slideOutVertically(tween(260)) { it },
    ) { NewSessionSheet() }
    AnimatedVisibility(
        store.showPairing, Modifier.align(Alignment.BottomCenter),
        enter = slideInVertically(tween(340)) { it }, exit = slideOutVertically(tween(260)) { it },
    ) {
        FormSheet(title = "", onCancel = { store.showPairing = false }) {
            PairingScreen(first = false, onDone = { store.showPairing = false })
        }
    }
}
