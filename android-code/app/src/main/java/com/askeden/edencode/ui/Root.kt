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
import androidx.compose.foundation.layout.imePadding
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.runtime.getValue
import androidx.compose.animation.core.animateFloatAsState
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

/**
 * The G design (2026-10-16): no tab bar. A session fills the screen, or with none open the New
 * page; ☰ slides the sessions drawer in from the left (moving the screen aside, as the ChatGPT and
 * Claude apps do), which also reaches the Inbox, the Queue and Settings; a session's changes are
 * pushed over it; a card from no session we know, and pairing, rise over everything.
 */
@Composable
fun Root(store: EdenCodeStore, voice: com.askeden.edencode.services.Voice) {
    val screen = rememberBackdrop()
    val background = rememberBackdrop()
    val env = remember(store, screen, voice) { Env(store, screen, voice) }
    val drawer by animateFloatAsState(if (store.drawerOpen && store.paired) 1f else 0f, tween(320), label = "drawer")
    CompositionLocalProvider(LocalEnv provides env, LocalBackground provides background) {
        BackHandler(enabled = store.sheetCard != null || store.showPairing || store.drawerOpen || store.path.isNotEmpty() || store.tab != EdenCodeStore.Tab.New) {
            store.back()
        }
        Box(Modifier.fillMaxSize()) {
            Box(Modifier.fillMaxSize().backdropSource(screen)) {
                EdenBackground(Modifier.backdropSource(background))
                if (!store.paired) {
                    PairingScreen(first = true, onDone = {})
                } else {
                    val route = store.path.lastOrNull()
                    Box(Modifier.fillMaxSize().graphicsLayer { translationX = drawer * 300.dp.toPx() }) {
                        AnimatedContent(
                            targetState = route to store.tab,
                            transitionSpec = {
                                val pushing = targetState.first is EdenCodeStore.Route.Changes && initialState.first is EdenCodeStore.Route.Session
                                val popping = initialState.first is EdenCodeStore.Route.Changes && targetState.first is EdenCodeStore.Route.Session
                                when {
                                    pushing -> slideInHorizontally(tween(320)) { it } togetherWith slideOutHorizontally(tween(320)) { -it / 3 }
                                    popping -> slideInHorizontally(tween(320)) { -it / 3 } togetherWith slideOutHorizontally(tween(320)) { it }
                                    else -> fadeIn(tween(180)) togetherWith fadeOut(tween(140))
                                }
                            },
                            label = "screens",
                        ) { (r, tab) ->
                            Box(Modifier.fillMaxSize()) {
                                when (r) {
                                    is EdenCodeStore.Route.Session -> SessionScreen(r.id)
                                    is EdenCodeStore.Route.Changes -> ChangesScreen(r.id)
                                    null -> when (tab) {
                                        EdenCodeStore.Tab.New -> NewScreen()
                                        EdenCodeStore.Tab.Inbox -> InboxScreen()
                                        EdenCodeStore.Tab.Queue -> QueueScreen()
                                        EdenCodeStore.Tab.Settings -> SettingsScreen()
                                    }
                                }
                            }
                        }
                    }
                }
            }
            if (drawer > 0f) {
                // The scrim right of the drawer (rgba(0,0,0,.08)): a tap closes it.
                Box(
                    Modifier.fillMaxSize().graphicsLayer { alpha = drawer }.background(Color.Black.copy(alpha = if (Eden.dark) 0.3f else 0.08f))
                        .clickable(remember { MutableInteractionSource() }, null) { store.drawerOpen = false },
                )
                Box(Modifier.graphicsLayer { translationX = (drawer - 1f) * (DrawerWidth.toPx() + 60.dp.toPx()) }) {
                    SessionsDrawer(store) { store.drawerOpen = false }
                }
            }
            Sheets(store)
        }
    }
}

/** The sheets over everything: an approval, a new session, pairing another Mac. */
@Composable
private fun BoxScope.Sheets(store: EdenCodeStore) {
    val showing = store.sheetCard != null || store.showPairing
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
        store.sheetCard?.let { card ->
            AskCard(card, LocalEnv.current.screen, Modifier.padding(start = 12.dp, end = 12.dp, bottom = safeBottom() + 8.dp).imePadding(), onAnswered = { store.sheetCard = null })
        }
    }
    AnimatedVisibility(
        store.showPairing, Modifier.align(Alignment.BottomCenter),
        enter = slideInVertically(tween(340)) { it }, exit = slideOutVertically(tween(260)) { it },
    ) {
        FormSheet(title = "", onCancel = { store.showPairing = false }) {
            PairingScreen(first = false, onDone = { store.showPairing = false })
        }
    }
}
