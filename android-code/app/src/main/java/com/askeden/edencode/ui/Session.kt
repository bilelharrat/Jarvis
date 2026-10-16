package com.askeden.edencode.ui

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.ui.semantics.onLongClick
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.foundation.gestures.detectTapGestures
import com.askeden.edencode.model.CodeStatus
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.askeden.edencode.model.PhoneCard
import com.askeden.edencode.model.PhoneEntry
import com.askeden.edencode.model.PhoneView
import com.askeden.edencode.model.Transcript
import com.askeden.edencode.net.Picture
import com.askeden.edencode.store.EdenCodeStore
import com.askeden.edencode.store.SessionModel
import kotlinx.coroutines.launch
import java.io.ByteArrayOutputStream

/** Debug launches can type into the composer and open its drawer (EDENCODETyped, EDENCODEComposerOpen). */
object DebugComposer {
    var typed: String? = null
    var open: Boolean = false
}

/**
 * One session, filling the screen (the GChat mockup): over the wallpaper, a floating ☰, the title
 * pill (its dot and one word, its project; tap for the changes) and ✎; the owner's words in blue
 * bubbles, Eden's replies in frosted glass, the steps in a glass panel, the running step with its
 * ring, "N files changed ›", the isolated copy's Land and Discard, and Eden chat's input bar. A
 * card that waits on the owner takes the input bar's place (GAsk) until answered, or until
 * Reply instead, which turns the bar into the answer.
 */
@Composable
fun SessionScreen(id: Int) {
    val env = LocalEnv.current
    val store = env.store
    val voice = env.speech
    val backend = store.backend ?: return
    val model = remember(id, backend) { SessionModel(id, backend) }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val clipboard = androidx.compose.ui.platform.LocalClipboardManager.current
    var text by remember { mutableStateOf(DebugComposer.typed ?: "") }
    var pictures by remember { mutableStateOf(emptyList<Picture>()) }
    var confirmCopy by remember { mutableStateOf<String?>(null) }
    // Cards answered here, hidden before the Mac's next answer drops them; and "Reply instead":
    // the card whose question the input bar answers in words.
    var answered by remember(id) { mutableStateOf(emptySet<String>()) }
    var replyingTo by remember(id) { mutableStateOf<String?>(null) }
    val backdrop = rememberBackdrop()
    val c = Eden.colors

    DisposableEffect(model) {
        model.start(scope)
        onDispose {
            model.stopWatching()
            voice.stopDictation()
        }
    }
    LaunchedEffect(voice.heard) { if (voice.heard.isNotEmpty()) text = voice.heard }
    val lastI = model.entries.lastOrNull()?.i
    LaunchedEffect(lastI) {
        val last = model.entries.lastOrNull()
        if (store.speakReplies && last != null && last.role == PhoneEntry.Role.Assistant) voice.speak(last.text, "r${last.i}")
    }
    val pick = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(6)) { uris ->
        scope.launch { pictures = pictures + loadPictures(context, uris) }
    }

    // The first card of this session's that waits on the owner.
    val pending = (model.view.cards + store.home.attention.filter { it.taskID == id }).firstOrNull { it.id !in answered }
    val replyCard = pending?.takeIf { it.id == replyingTo }
    // The summary from the session list until the session's own view comes.
    val summary = store.home.sessions.firstOrNull { it.id == id }
    val status = when {
        pending != null -> CodeStatus.NeedsYou
        model.view.status != CodeStatus.Unknown -> model.view.status
        else -> summary?.status ?: CodeStatus.Unknown
    }
    val title = model.view.title.ifEmpty { summary?.title ?: "Session" }
    val project = model.view.project.ifEmpty { summary?.project ?: "" }
    val filesChanged = model.latestReceipt?.fileCount ?: 0
    val lastReply = model.entries.lastOrNull { it.role == PhoneEntry.Role.Assistant }

    val top = safeTop()
    // The header's foot: the status bar (or the cutout), then its 44 row (it sits 6 up into the inset).
    val headerFoot = top - 6.dp + 44.dp
    // The input bar sits above the keyboard while it's up, else above the gesture bar.
    val bottomInset = keyboardOrSafeBottom()
    val keyboard = imeBottom()
    var composerHeight by remember { mutableIntStateOf(0) }
    val density = LocalDensity.current
    val list = rememberLazyListState()
    val rows = Transcript.visibleRows(model.rows, model.working)
    // Whether the owner is reading the end (they scrolled up: new words don't pull them down).
    val atEnd by remember {
        androidx.compose.runtime.derivedStateOf {
            val info = list.layoutInfo
            val last = info.visibleItemsInfo.lastOrNull()
            last == null || (last.index >= info.totalItemsCount - 1 && last.offset + last.size <= info.viewportEndOffset + 4)
        }
    }

    // Following the end: true until the owner scrolls up to read, true again once they're back down.
    var follow by remember { mutableStateOf(true) }
    LaunchedEffect(list.isScrollInProgress) { if (!list.isScrollInProgress) follow = atEnd }
    suspend fun toEnd() {
        val count = list.layoutInfo.totalItemsCount
        if (count > 0) list.scrollToItem(count - 1, Int.MAX_VALUE / 2)  // (clamped to the very end)
    }
    // The latest message stays in sight above the input bar: when it comes, and (while following)
    // as the bar grows (the composer's options, a card) or the keyboard opens or closes.
    LaunchedEffect(model.entries.size, model.view.live.length) { toEnd(); follow = true }
    LaunchedEffect(composerHeight, keyboard) { if (follow || keyboard > 0.dp) toEnd() }

    Box(Modifier.fillMaxSize()) {
        Box(Modifier.fillMaxSize().backdropSource(backdrop)) {
            EdenBackground()
            LazyColumn(
                Modifier.fillMaxSize().movesForDrawer(),
                state = list,
                contentPadding = PaddingValues(
                    start = 20.dp, end = 20.dp, top = headerFoot + 14.dp,
                    // The input bar (measured inside its own padding) and what it sits on.
                    bottom = with(density) { composerHeight.toDp() } + bottomInset + 8.dp + 16.dp,
                ),
                verticalArrangement = Arrangement.spacedBy(if (pending == null) 18.dp else 16.dp),
            ) {
                (model.problem ?: store.problem)?.let { item("problem") { ProblemBanner(it) } }
                items(rows, key = { it.key }) { row ->
                    when (row) {
                        is Transcript.Row.User -> UserBubble(row.entry.text)
                        is Transcript.Row.Steps -> Steps(row.steps)
                        is Transcript.Row.Reply -> {
                            val e = row.entry
                            ReplyBubble(e.text, typing = false, speaking = voice.speaking == "r${e.i}") { close ->
                                GlassMenuItem("Copy") { close(); clipboard.setText(androidx.compose.ui.text.AnnotatedString(e.text)) }
                                GlassMenuItem(if (voice.speaking == "r${e.i}") "Stop reading" else "Read aloud") { close(); voice.toggle(e.text, "r${e.i}") }
                                if (filesChanged > 0) GlassMenuItem("See the changes") { close(); store.push(EdenCodeStore.Route.Changes(id)) }
                            }
                        }
                        is Transcript.Row.Note -> T(
                            row.entry.text, sf(13f), c.muted,
                            Modifier.fillMaxWidth().background(c.fill.copy(alpha = c.fill.alpha * 0.6f), RoundedCornerShape(14.dp)).padding(horizontal = 12.dp, vertical = 8.dp),
                        )
                    }
                }
                if (model.view.live.isNotEmpty()) item("live") { ReplyBubble(model.view.live, typing = true, speaking = false) {} }
                if (filesChanged > 0) item("files") { FilesChanged(filesChanged) { store.push(EdenCodeStore.Route.Changes(id)) } }
                model.view.copy?.let { copy -> item("copy") { CopyBar(copy) { confirmCopy = it } } }
                if (model.view.todos.isNotEmpty()) item("todos") { TodoList(model.view.todos) }
                // The one live status line (with what TalkBack says as it changes).
                if (model.working) item("doing") {
                    Box(Modifier.semantics { contentDescription = model.statusLine; liveRegion = LiveRegionMode.Polite }) {
                        Running(model.view.doing.replace("…", "").ifEmpty { "Working" })
                    }
                }
            }
        }

        GTopScrim(backdrop, bottomInset + 8.dp, Modifier.align(Alignment.BottomCenter), fade = 14.dp, bottom = true)
        // The frosted band under the clock and the header, then the floating header: ☰, the title pill (its menu), ✎.
        GTopScrim(backdrop, headerFoot + 4.dp)
        GHeader(backdrop, onMenu = { store.drawerOpen = true }, onNew = { store.newSession() }, modifier = Modifier.padding(top = top - 6.dp).movesForDrawer()) {
            GTitlePill(title, status, project, backdrop) { close ->
                if (filesChanged > 0 || model.latestReceipt != null) GlassMenuItem("See the changes") { close(); store.push(EdenCodeStore.Route.Changes(id)) }
                lastReply?.let { last ->
                    GlassMenuItem(if (voice.speaking == "last") "Stop reading" else "Read the last reply aloud") { close(); voice.toggle(last.text, "last") }
                }
                if (model.working) GlassMenuItem("Stop", destructive = true) { close(); scope.launch { model.stop() } }
                GlassMenuItem("Your sessions") { close(); store.drawerOpen = true }
            }
        }

        // The bottom: a card that waits, or the input bar.
        Column(
            Modifier.align(Alignment.BottomCenter).fillMaxWidth().padding(bottom = bottomInset + 8.dp)
                .onSizeChanged { composerHeight = it.height }.movesForDrawer(),
            horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            if (pending != null && replyingTo != pending.id) {
                AskCard(pending, backdrop, Modifier.padding(horizontal = 12.dp),
                    onReplyInstead = if (pending.macOnly) null else ({ replyingTo = pending.id }),
                    onAnswered = { answered = answered + pending.id })
                return@Column
            }
            if (replyCard != null) {
                Row(
                    Modifier.padding(horizontal = 24.dp).gGlass(backdrop, 999.dp)
                        .pressable(0.97f, label = "Replying to ${replyCard.approval.question}. Back to the question") { replyingTo = null }
                        .padding(horizontal = 12.dp, vertical = 6.dp),
                    horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically,
                ) {
                    Glyph(Glyphs.replyArrow, 12.dp, c.ink2)
                    T("Replying to: ${replyCard.approval.question}", sf(12f, Medium), c.ink2, Modifier.weight(1f, fill = false), maxLines = 1)
                    Glyph(Glyphs.xmark, 10.dp, c.ink2)
                }
            }
            model.said?.let { T(it, sf(12f), c.muted) }
            voice.problem?.let { T(it, sf(12f), c.failInk, Modifier.padding(horizontal = 20.dp), align = TextAlign.Center) }
            if (pictures.isNotEmpty()) {
                Row(
                    Modifier.gGlass(backdrop, 999.dp).padding(horizontal = 10.dp, vertical = 5.dp),
                    horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically,
                ) {
                    Glyph(Glyphs.photo, 13.dp, c.ink2)
                    T("${pictures.size} picture${if (pictures.size == 1) "" else "s"}", sf(12f, Medium), c.ink2, maxLines = 1)
                    Box(Modifier.size(16.dp).background(c.ink2, CircleShape).pressable(label = "Remove pictures") { pictures = emptyList() }, contentAlignment = Alignment.Center) {
                        Glyph(Glyphs.xmark, 9.dp, if (Eden.dark) Color.Black else Color.White)
                    }
                }
            }
            val view = model.view
            EdenComposer(
                text = text, onText = { text = it }, working = model.working,
                modeID = view.mode, modeLabel = view.modeShort, modelLabel = view.modelLabel,
                modelRef = view.model, routedLabel = view.routedLabel,
                modes = store.options.modes, models = store.options.models,
                dictating = voice.listening, talking = voice.speaking == "last", attachments = pictures.size,
                backdrop = backdrop, startExpanded = DebugComposer.open,
                onSend = {
                    if (replyCard != null) {
                        // "Reply instead": the card's no, with the owner's words for what to do instead.
                        val said = text.trim()
                        voice.stopDictation()
                        text = ""
                        scope.launch {
                            if (store.answer(replyCard, replyCard.noChoice, said)) { answered = answered + replyCard.id; replyingTo = null } else text = said
                        }
                    } else submit(model, text, pictures, false, scope, voice) { t, p -> text = t; pictures = p }
                },
                onSteer = { submit(model, text, pictures, true, scope, voice) { t, p -> text = t; pictures = p } },
                onStop = { scope.launch { model.stop() } },
                onDictate = { scope.launch { voice.toggleDictation() } },
                onTalk = { lastReply?.let { voice.toggle(it.text, "last") } },
                onMode = { scope.launch { model.setMode(it) } },
                onModel = { scope.launch { model.setModel(it) } },
                onPictures = { pick.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) },
            )
        }

        confirmCopy?.let { action ->
            ConfirmDialog(
                title = if (action == "land") "Land this copy into its branch?" else "Discard this copy?",
                message = "Your Mac puts up its card; answer it here or there.",
                confirm = if (action == "land") "Land" else "Discard", destructive = action != "land",
                onDismiss = { confirmCopy = null },
            ) {
                confirmCopy = null
                scope.launch { if (action == "land") model.land() else model.discard() }
            }
        }
    }
}

private fun submit(model: SessionModel, text: String, pictures: List<Picture>, steer: Boolean, scope: kotlinx.coroutines.CoroutineScope,
                   voice: com.askeden.edencode.services.Voice, restore: (String, List<Picture>) -> Unit) {
    voice.stopDictation()
    restore("", emptyList())
    scope.launch {
        val sent = model.send(text, steer, pictures)
        if (!sent) restore(text, pictures)
    }
}

/** Pictures from the photo picker as JPEGs the Mac's composer takes (at most 2048 on a side, 8 MB each). */
internal suspend fun loadPictures(context: android.content.Context, uris: List<Uri>): List<Picture> = com.askeden.edencode.store.io {
    uris.take(6).mapIndexedNotNull { index, uri ->
        val bytes = context.contentResolver.openInputStream(uri)?.use { it.readBytes() } ?: return@mapIndexedNotNull null
        val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: return@mapIndexedNotNull null
        val scale = minOf(1f, 2048f / maxOf(bitmap.width, bitmap.height))
        val scaled = if (scale < 1f) Bitmap.createScaledBitmap(bitmap, (bitmap.width * scale).toInt(), (bitmap.height * scale).toInt(), true) else bitmap
        val out = ByteArrayOutputStream()
        scaled.compress(Bitmap.CompressFormat.JPEG, 80, out)
        out.toByteArray().takeIf { it.size < 8_000_000 }?.let { Picture("photo-${index + 1}.jpg", "image/jpeg", it) }
    }
}

/** The owner's words: a blue bubble with a light top sheen (GChat), at most 78 % of the width. */
@Composable
private fun UserBubble(text: String) {
    androidx.compose.foundation.layout.BoxWithConstraints(Modifier.fillMaxWidth(), contentAlignment = Alignment.CenterEnd) {
        val shape = RoundedCornerShape(20.dp)
        SelectionContainer {
            T(
                text, sf(16f, lineHeight = 21.6f), Color.White,
                Modifier.widthIn(max = maxWidth * 0.78f)
                    .boxShadow(hex(0x007AFF, 0.25f), y = 6.dp, blur = 16.dp, radius = 20.dp)
                    .background(hex(0x007AFF, 0.88f), shape)
                    .background(androidx.compose.ui.graphics.Brush.verticalGradient(0f to Color.White.copy(alpha = 0.25f), 0.55f to Color.White.copy(alpha = 0f)), shape)
                    .topRim(20.dp, Color.White.copy(alpha = 0.45f), Color.Transparent)
                    .padding(horizontal = 14.dp, vertical = 10.dp)
                    .semantics { contentDescription = "You: $text" },
            )
        }
    }
}

/** The steps so far in one glass panel, ✓ each (the running one is the status line under the transcript). */
@Composable
private fun Steps(steps: List<PhoneEntry>) {
    val g = gInk
    Column(
        Modifier.gGlass(LocalBackground.current, 16.dp).padding(horizontal = 14.dp, vertical = 10.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        for (step in steps) {
            Row(
                horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.semantics(mergeDescendants = true) { contentDescription = (if (step.stepFailed) "Failed: " else "Done: ") + step.stepLine },
            ) {
                if (step.stepFailed) T("✗", sf(14f), g.red, maxLines = 1) else Glyph(Glyphs.check, 13.dp, g.green)
                T(step.stepLine.replace("…", ""), sf(14f, lineHeight = 17f), g.steps, maxLines = 2)
            }
        }
    }
}

/** What runs now: the blue ring and its words, in grey. */
@Composable
private fun Running(text: String) {
    Row(
        horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier.semantics(mergeDescendants = true) { contentDescription = "Running: $text" },
    ) {
        RingSpinner()
        T(text, sf(14f, lineHeight = 17f), gInk.grey2, maxLines = 2)
    }
}

/** Eden's reply in frosted glass, at most 88 % of the width; a long press opens [menu] (copy, read aloud, the changes). */
@Composable
fun ReplyBubble(text: String, typing: Boolean, speaking: Boolean, menu: @Composable androidx.compose.foundation.layout.ColumnScope.(close: () -> Unit) -> Unit) {
    val g = gInk
    var open by remember { mutableStateOf(false) }
    val haptics = androidx.compose.ui.platform.LocalHapticFeedback.current
    androidx.compose.foundation.layout.BoxWithConstraints(Modifier.fillMaxWidth()) {
        val most = maxWidth * 0.88f
        Box {
            Column(
                Modifier.widthIn(max = most).gGlass(LocalBackground.current, 20.dp)
                    // The menu opens when the finger lifts after a long press: opened while it is
                    // still down, the release would land on whichever item came up under it.
                    .then(if (typing) Modifier else Modifier
                        .semantics { onLongClick(label = "Reply actions") { open = true; true } }
                        .pointerInput(Unit) {
                            var held = false
                            detectTapGestures(
                                onLongPress = { held = true; haptics.performHapticFeedback(androidx.compose.ui.hapticfeedback.HapticFeedbackType.LongPress) },
                                onPress = { tryAwaitRelease(); if (held) { held = false; open = true } },
                            )
                        })
                    .padding(horizontal = 14.dp, vertical = 12.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                T(text, sf(16f, lineHeight = 24f), g.ink)
                if (typing) {
                    Row(horizontalArrangement = Arrangement.spacedBy(4.dp), modifier = Modifier.semantics { contentDescription = "Writing" }) {
                        repeat(3) { Box(Modifier.size(5.dp).background(g.grey, CircleShape)) }
                    }
                } else if (speaking) {
                    Row(horizontalArrangement = Arrangement.spacedBy(5.dp), verticalAlignment = Alignment.CenterVertically) {
                        Glyph(Glyphs.speaker, 13.dp, g.blue)
                        T("Reading aloud", sf(13f, Medium), g.blue, maxLines = 1)
                    }
                }
            }
            GlassMenu(open, { open = false }) { menu { open = false } }
        }
    }
}

/** "2 files changed ›": a small glass button to the changes. */
@Composable
private fun FilesChanged(count: Int, onClick: () -> Unit) {
    val g = gInk
    val words = "$count file${if (count == 1) "" else "s"} changed"
    Row(
        Modifier.gGlass(LocalBackground.current, 14.dp).pressable(0.97f, label = words, onClick = onClick).padding(horizontal = 14.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically,
    ) {
        Glyph(Glyphs.diffBox, 16.dp, g.ink)
        T(words, sf(14f, lineHeight = 17f), g.ink, maxLines = 1)
        T("›", sf(14f, lineHeight = 17f), g.grey, maxLines = 1)
    }
}

@Composable
private fun CopyBar(copy: PhoneView.Copy, onAction: (String) -> Unit) {
    val c = Eden.colors
    Row(
        Modifier.fillMaxWidth().edenCard().padding(12.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically,
    ) {
        Glyph(Glyphs.branch, 17.dp, c.accent)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
            T("Isolated copy", sf(14f, Semibold), c.ink, maxLines = 1)
            T("${copy.branch} → ${copy.into}", sf(12f), c.muted, maxLines = 1)
        }
        GlassButton("Discard", false, enabled = !copy.busy, style = sf(13f, Semibold), height = 34.dp) { onAction("discard") }
        GlassButton("Land", true, enabled = !copy.busy, style = sf(13f, Semibold), height = 34.dp) { onAction("land") }
    }
}

@Composable
private fun TodoList(todos: List<PhoneView.Todo>) {
    val c = Eden.colors
    Column(Modifier.fillMaxWidth().edenCard().padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        T("Plan", sf(13f, Semibold), c.muted)
        for (todo in todos) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                Glyph(if (todo.done) Glyphs.checkCircle else Glyphs.circle, 16.dp, if (todo.done) c.muted else c.ink)
                T(todo.text, sf(14f), if (todo.done) c.muted else c.ink)
            }
        }
    }
}

/** iOS's confirmation dialog: an action sheet at the bottom, its message, the action and Cancel. */
@Composable
fun ConfirmDialog(title: String, message: String?, confirm: String, destructive: Boolean, onDismiss: () -> Unit, onConfirm: () -> Unit) {
    val c = Eden.colors
    val sheet = if (Eden.dark) hex(0x2C2C2E, 0.96f) else hex(0xF2F2F7, 0.97f)
    Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.25f)).pressable(1f, onClick = onDismiss), contentAlignment = Alignment.BottomCenter) {
        Column(
            Modifier.padding(horizontal = 8.dp).padding(bottom = safeBottom() + 8.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Column(Modifier.fillMaxWidth().background(sheet, RoundedCornerShape(28.dp))) {
                Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 14.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    T(title, sf(13f, Semibold), c.muted, align = TextAlign.Center)
                    message?.let { T(it, sf(13f), c.muted, align = TextAlign.Center) }
                }
                RowDivider(0.dp)
                Box(Modifier.fillMaxWidth().height(57.dp).pressable(0.99f, label = confirm, onClick = onConfirm), contentAlignment = Alignment.Center) {
                    T(confirm, sf(17f), if (destructive) c.red else c.accent)
                }
            }
            Box(Modifier.fillMaxWidth().height(57.dp).background(sheet, RoundedCornerShape(28.dp)).pressable(0.99f, label = "Cancel", onClick = onDismiss), contentAlignment = Alignment.Center) {
                T("Cancel", sf(17f, Semibold), c.accent)
            }
            Spacer(Modifier.height(0.dp))
        }
    }
}
