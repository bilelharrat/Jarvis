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
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChange
import androidx.compose.ui.input.pointer.util.VelocityTracker
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.foundation.systemGestureExclusion
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.gestures.rememberDraggableState
import androidx.compose.foundation.gestures.draggable
import androidx.compose.foundation.gestures.Orientation
import androidx.compose.runtime.key
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.setValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.animation.core.spring
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
 * The G design (2026-10-16; RootView.swift): no tab bar. One session fills the screen (or "What
 * should we build?" when none is open); ☰ or a swipe from the left edge slides the sessions
 * drawer over it, moving the screen's content aside; the Inbox, the Queue and Settings open from
 * the drawer as sheets; a session's changes push over it; pairing shows until a Mac is paired.
 */
@Composable
fun Root(store: EdenCodeStore, voice: com.askeden.edencode.services.Voice) {
    val screen = rememberBackdrop()
    val background = rememberBackdrop()
    val env = remember(store, screen, voice) { Env(store, screen, voice) }
    val density = androidx.compose.ui.platform.LocalDensity.current
    val width = with(density) { DrawerWidth.toPx() }
    // The finger's travel while it drags the drawer open or shut.
    var drag by remember { mutableFloatStateOf(0f) }
    val target = if (store.drawerOpen && store.paired) 1f else 0f
    val settled by animateFloatAsState(target, spring(dampingRatio = 0.88f, stiffness = 300f), label = "drawer")
    val progress = if (drag != 0f) (target + drag / width).coerceIn(0f, 1f) else settled
    LaunchedEffect(store.drawerOpen) { drag = 0f }
    val keyboard = androidx.compose.ui.platform.LocalSoftwareKeyboardController.current
    LaunchedEffect(store.drawerOpen) { if (store.drawerOpen) keyboard?.hide() }
    fun release(velocity: Float, opening: Boolean) {
        val travel = drag
        drag = 0f
        store.drawerOpen = if (opening) travel > 80 * density.density || velocity > 600f else !(travel < -80 * density.density || velocity < -600f)
    }
    val demoStrip = if (store.demo && store.paired) DemoStripHeight else 0.dp
    CompositionLocalProvider(LocalEnv provides env, LocalBackground provides background, LocalDrawer provides progress, LocalTopExtra provides demoStrip) {
        BackHandler(enabled = store.sheetCard != null || store.showPairing || store.panel != null || store.drawerOpen || store.path.isNotEmpty()) {
            store.back()
        }
        Box(Modifier.fillMaxSize()) {
            Box(
                Modifier.fillMaxSize().backdropSource(screen).drawerPull(
                    enabled = store.paired && !store.drawerOpen && store.path.isEmpty() && store.panel == null && store.sheetCard == null && !store.showPairing,
                    onStart = { keyboard?.hide() },
                    onDelta = { drag = (drag + it).coerceAtLeast(0f) },
                    onEnd = { release(it, opening = true) },
                ),
            ) {
                EdenBackground(Modifier.backdropSource(background))
                if (!store.paired) {
                    PairingScreen(first = true, onDone = {})
                } else {
                    val changes = store.path.lastOrNull() as? EdenCodeStore.Route.Changes
                    AnimatedContent(
                        targetState = changes?.id to store.openSession,
                        transitionSpec = {
                            val pushing = targetState.first != null && initialState.first == null
                            val popping = initialState.first != null && targetState.first == null
                            when {
                                pushing -> slideInHorizontally(tween(320)) { it } togetherWith slideOutHorizontally(tween(320)) { -it / 3 }
                                popping -> slideInHorizontally(tween(320)) { -it / 3 } togetherWith slideOutHorizontally(tween(320)) { it }
                                else -> fadeIn(tween(180)) togetherWith fadeOut(tween(140))
                            }
                        },
                        label = "screens",
                    ) { (changesOf, session) ->
                        Box(Modifier.fillMaxSize()) {
                            when {
                                changesOf != null -> ChangesScreen(changesOf)
                                session != null -> key(session) { SessionScreen(session) }
                                else -> NewScreen()
                            }
                        }
                    }
                }
            }
            if (store.paired) {
                if (progress > 0f) {
                    // The scrim right of the drawer (rgba(0,0,0,.08)): a tap closes it, a drag left shuts it.
                    Box(
                        Modifier.fillMaxSize().background(Color.Black.copy(alpha = (if (Eden.dark) 0.3f else 0.08f) * progress))
                            .clickable(remember { MutableInteractionSource() }, null) { store.drawerOpen = false }
                            .draggable(rememberDraggableState { drag = (drag + it).coerceAtMost(0f) }, Orientation.Horizontal, onDragStopped = { release(it, opening = false) })
                            .semantics { contentDescription = "Close your sessions" },
                    )
                }
                Box(
                    Modifier.graphicsLayer { translationX = -(width + 50.dp.toPx()) * (1f - progress) }
                        .draggable(rememberDraggableState { drag = (drag + it).coerceAtMost(0f) }, Orientation.Horizontal, onDragStopped = { release(it, opening = false) }),
                ) {
                    if (progress > 0f) SessionsDrawer(store) { store.drawerOpen = false }
                }
                if (!store.drawerOpen && store.path.isEmpty() && store.panel == null && store.sheetCard == null) {
                    // The left edge: a swipe opens the drawer. Android's back gesture owns that edge;
                    // it lets an app keep at most 200 dp of it, so the drawer keeps the middle 200.
                    Box(
                        Modifier.width(14.dp).fillMaxHeight().systemGestureExclusion { c ->
                            val band = with(density) { 100.dp.toPx() }
                            val mid = c.size.height / 2f
                            androidx.compose.ui.geometry.Rect(0f, mid - band, c.size.width.toFloat(), mid + band)
                        }
                            .draggable(rememberDraggableState { drag = (drag + it).coerceAtLeast(0f) }, Orientation.Horizontal, onDragStopped = { release(it, opening = true) }),
                    )
                }
            }
            if (store.demo && store.paired) DemoStrip(store, Modifier.align(Alignment.TopCenter))
            Sheets(store)
            if (store.scanning) {
                BackHandler { store.scanning = false }
                QrScanner(onCancel = { store.scanning = false }) { payload ->
                    store.scanning = false
                    store.pendingPair = payload
                }
            }
        }
    }
}

/**
 * A swipe to the right anywhere on the screen pulls the drawer open (the iPhone's whole-screen pan).
 * It watches in the Main pass, after the children, so a list or a pager that took the gesture keeps
 * it: only a mostly-horizontal (steeper than about 27 degrees counts as vertical) rightward movement
 * that nothing else consumed becomes the drawer's. The transcript's vertical scroll is untouched.
 */
private fun Modifier.drawerPull(enabled: Boolean, onStart: () -> Unit, onDelta: (Float) -> Unit, onEnd: (Float) -> Unit): Modifier =
    if (!enabled) this else pointerInput(Unit) {
        awaitEachGesture {
            val down = awaitFirstDown(requireUnconsumed = false)
            val tracker = VelocityTracker()
            tracker.addPosition(down.uptimeMillis, down.position)
            var dx = 0f
            var dy = 0f
            var pulling = false
            while (true) {
                val event = awaitPointerEvent()
                val change = event.changes.firstOrNull { it.id == down.id } ?: return@awaitEachGesture
                if (!pulling && change.isConsumed) return@awaitEachGesture  // a scroller took it
                if (!change.pressed) {
                    if (pulling) onEnd(tracker.calculateVelocity().x)
                    return@awaitEachGesture
                }
                val moved = change.positionChange()
                dx += moved.x
                dy += moved.y
                tracker.addPosition(change.uptimeMillis, change.position)
                if (!pulling) {
                    if (kotlin.math.hypot(dx, dy) < viewConfiguration.touchSlop) continue
                    if (dx > 0f && dx > 2f * kotlin.math.abs(dy)) {
                        pulling = true
                        onStart()
                        onDelta(dx)
                        change.consume()
                    } else return@awaitEachGesture
                } else {
                    onDelta(moved.x)
                    change.consume()
                }
            }
        }
    }

/** Height of the demo's strip, which the screens' headers make room for. */
val DemoStripHeight = 46.dp

/** The demo's strip over every screen: it's sample data, nothing reaches a Mac, and the way out. */
@Composable
private fun DemoStrip(store: EdenCodeStore, modifier: Modifier = Modifier) {
    val c = Eden.colors
    val top = WindowInsets.statusBars.asPaddingValues().calculateTopPadding()
    Row(
        modifier.fillMaxWidth().padding(top = top).height(DemoStripHeight).background(c.orange.copy(alpha = 0.18f))
            .padding(horizontal = 14.dp).semantics { contentDescription = "Demo mode. Sample sessions. Nothing reaches a Mac." },
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Column(Modifier.weight(1f)) {
            T("Demo", sf(13f, androidx.compose.ui.text.font.FontWeight.Bold), c.ink, maxLines = 1)
            T("Sample sessions. Nothing reaches a Mac.", sf(12f), c.ink, maxLines = 1)
        }
        Box(
            Modifier.height(32.dp).background(c.fill, RoundedCornerShape(50)).padding(horizontal = 14.dp)
                .pressable(0.95f, label = "Exit demo. Goes back to pairing with your Mac") { store.endDemo() },
            contentAlignment = Alignment.Center,
        ) { T("Exit demo", sf(13f, androidx.compose.ui.text.font.FontWeight.SemiBold), c.ink, maxLines = 1) }
    }
}

/** How far the drawer is open (0 shut, 1 open): the screen's content moves 300 aside under it. */
val LocalDrawer = androidx.compose.runtime.compositionLocalOf { 0f }

/** A screen's content (not its wallpaper) moving aside for the drawer, as GDrawer draws it. */
@Composable
fun Modifier.movesForDrawer(): Modifier {
    val progress = LocalDrawer.current
    return this.graphicsLayer { translationX = 300.dp.toPx() * progress }
}

/** The sheets over everything: the Inbox, the Queue or Settings; a card with no session; pairing another Mac. */
@Composable
private fun BoxScope.Sheets(store: EdenCodeStore) {
    val showing = store.sheetCard != null || store.showPairing || store.panel != null
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
    // The panel keeps showing what it showed while it slides away.
    var shown by remember { mutableStateOf(store.panel) }
    if (store.panel != null) shown = store.panel
    AnimatedVisibility(
        store.panel != null, Modifier.align(Alignment.BottomCenter),
        enter = slideInVertically(tween(340)) { it }, exit = slideOutVertically(tween(260)) { it },
    ) {
        PanelSheet(onDone = { store.panel = null }) {
            when (shown) {
                EdenCodeStore.Panel.Inbox -> InboxScreen()
                EdenCodeStore.Panel.Queue -> QueueScreen()
                EdenCodeStore.Panel.Settings -> SettingsScreen()
                null -> {}
            }
        }
    }
    AnimatedVisibility(
        store.showPairing, Modifier.align(Alignment.BottomCenter),
        enter = slideInVertically(tween(340)) { it }, exit = slideOutVertically(tween(260)) { it },
    ) {
        FormSheet(title = "", onCancel = { store.showPairing = false }, followKeyboard = true) {
            PairingScreen(first = false, onDone = { store.showPairing = false })
        }
    }
}
