package com.askeden.edencode.ui

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
    var text by remember { mutableStateOf(DebugComposer.typed ?: "") }
    var pictures by remember { mutableStateOf(emptyList<Picture>()) }
    var confirmCopy by remember { mutableStateOf<String?>(null) }
    // The card the input bar answers after Reply instead (its id), and the card that waits.
    var replyingTo by remember(id) { mutableStateOf<String?>(null) }
    val asking = model.view.cards.firstOrNull()
    val replyCard = model.view.cards.firstOrNull { it.id == replyingTo }
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

    val top = safeTop()
    var composerHeight by remember { mutableIntStateOf(0) }
    val density = LocalDensity.current
    val list = rememberLazyListState()
    val rows = model.rows
    val lastReply = model.entries.lastOrNull { it.role == PhoneEntry.Role.Assistant }?.i

    LaunchedEffect(model.entries.size, model.view.live.length) {
        val count = list.layoutInfo.totalItemsCount
        if (count > 0) list.animateScrollToItem(count - 1)
    }

    Box(Modifier.fillMaxSize()) {
        Box(Modifier.fillMaxSize().backdropSource(backdrop)) {
            EdenBackground()
            LazyColumn(
                Modifier.fillMaxSize(),
                state = list,
                contentPadding = PaddingValues(
                    start = 20.dp, end = 20.dp, top = top - 6.dp + 44.dp + 12.dp,
                    bottom = with(density) { composerHeight.toDp() } + 18.dp,
                ),
                verticalArrangement = Arrangement.spacedBy(18.dp),
            ) {
                model.problem?.let { item("problem") { ProblemBanner(it) } }
                items(rows, key = { it.key }) { row ->
                    when (row) {
                        is Transcript.Row.User -> UserBubble(row.entry.text)
                        is Transcript.Row.Steps -> Steps(row.steps, model.working)
                        is Transcript.Row.Reply -> Column(verticalArrangement = Arrangement.spacedBy(18.dp)) {
                            ReplyBubble(row.entry.text, typing = false, speaking = voice.speaking == "r${row.entry.i}") {
                                voice.toggle(row.entry.text, "r${row.entry.i}")
                            }
                            // "2 files changed ›" under the last reply, when its turn changed files.
                            val files = model.latestReceipt?.fileCount ?: 0
                            if (row.entry.i == lastReply && files > 0) FilesChanged(files) { store.push(EdenCodeStore.Route.Changes(id)) }
                        }
                        is Transcript.Row.Note -> T(
                            row.entry.text, sf(13f), c.muted,
                            Modifier.fillMaxWidth().background(c.fill.copy(alpha = c.fill.alpha * 0.6f), RoundedCornerShape(14.dp)).padding(horizontal = 12.dp, vertical = 8.dp),
                        )
                    }
                }
                if (model.view.live.isNotEmpty()) item("live") { ReplyBubble(model.view.live, typing = true, speaking = false) {} }
                if (model.working && model.view.doing.isNotEmpty() && rows.lastOrNull() !is Transcript.Row.Steps) item("doing") { Running(model.view.doing) }
                model.view.copy?.let { copy -> item("copy") { CopyBar(copy) { confirmCopy = it } } }
                if (model.view.todos.isNotEmpty()) item("todos") { TodoList(model.view.todos) }
                // What the title pill's word says, for TalkBack as it changes.
                item("bottom") { Box(Modifier.fillMaxWidth().height(1.dp).semantics { contentDescription = model.statusLine; liveRegion = LiveRegionMode.Polite }) }
            }
        }

        // The floating header: ☰, the title pill, ✎.
        GHeader(backdrop, onMenu = { store.drawerOpen = true }, onNew = { store.newSession() }, modifier = Modifier.padding(top = top - 6.dp)) {
            GTitlePill(model.title, model.view.status, model.view.project, backdrop) { store.push(EdenCodeStore.Route.Changes(id)) }
        }

        // The composer.
        val bottom = safeBottom()
        Column(
            Modifier.align(Alignment.BottomCenter).fillMaxWidth().imePadding().padding(bottom = bottom + 8.dp)
                .onSizeChanged { composerHeight = it.height },
            horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            model.said?.let { T(it, sf(12f), c.muted) }
            voice.problem?.let { T(it, sf(12f), c.failInk, Modifier.padding(horizontal = 20.dp), align = TextAlign.Center) }
            if (pictures.isNotEmpty()) {
                Row(
                    Modifier.edenCard(backdrop, 999.dp).padding(horizontal = 10.dp, vertical = 5.dp),
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
            if (asking != null && replyingTo != asking.id) {
                AskCard(asking, backdrop, Modifier.padding(horizontal = 12.dp), onReplyInstead = { replyingTo = asking.id })
                return@Column
            }
            if (replyCard != null) {
                T("Answer the question instead", sf(13f), gInk.blue, Modifier.pressable(0.97f, label = "Answer the question instead") { replyingTo = null })
            }
            EdenComposer(
                text = text, onText = { text = it }, working = model.working,
                modeID = view.mode, modeLabel = view.modeLabel, modelLabel = view.modelLabel,
                modes = store.options.modes, models = store.options.models,
                dictating = voice.listening, talking = voice.speaking == "last", attachments = pictures.size,
                backdrop = backdrop, startExpanded = DebugComposer.open,
                placeholder = if (replyCard != null) "Tell it what to do instead…" else null,
                onSend = {
                    if (replyCard != null) {
                        val said = text.trim()
                        if (said.isNotEmpty()) scope.launch { if (store.answer(replyCard, replyCard.noChoice, said)) { text = ""; replyingTo = null } }
                    } else submit(model, text, pictures, false, scope, voice) { t, p -> text = t; pictures = p }
                },
                onSteer = { submit(model, text, pictures, true, scope, voice) { t, p -> text = t; pictures = p } },
                onStop = { scope.launch { model.stop() } },
                onDictate = { scope.launch { voice.toggleDictation() } },
                onTalk = { model.entries.lastOrNull { it.role == PhoneEntry.Role.Assistant }?.let { voice.toggle(it.text, "last") } },
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
private suspend fun loadPictures(context: android.content.Context, uris: List<Uri>): List<Picture> = com.askeden.edencode.store.io {
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

/** The steps so far in one glass panel, ✓ each; the one running now is its own line with the ring. */
@Composable
private fun Steps(steps: List<PhoneEntry>, working: Boolean) {
    val g = gInk
    val runningLast = working && steps.lastOrNull()?.stepRunning == true
    val done = if (runningLast) steps.dropLast(1) else steps
    Column(verticalArrangement = Arrangement.spacedBy(18.dp)) {
        if (done.isNotEmpty()) {
            Column(
                Modifier.gGlass(LocalBackground.current, 16.dp).padding(horizontal = 14.dp, vertical = 10.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                for (step in done) {
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
        if (runningLast) Running(steps.last().stepLine.replace("…", ""))
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

/** Eden's reply in frosted glass, at most 88 % of the width; a long press reads it aloud (or stops). */
@Composable
fun ReplyBubble(text: String, typing: Boolean, speaking: Boolean, onRead: () -> Unit) {
    val g = gInk
    androidx.compose.foundation.layout.BoxWithConstraints(Modifier.fillMaxWidth()) {
        Column(
            Modifier.widthIn(max = maxWidth * 0.88f).gGlass(LocalBackground.current, 20.dp)
                .semantics { customActions = listOf(androidx.compose.ui.semantics.CustomAccessibilityAction(if (speaking) "Stop reading" else "Read aloud") { onRead(); true }) }
                .padding(horizontal = 14.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            SelectionContainer { T(text, sf(16f, lineHeight = 24f), g.ink) }
            if (typing) {
                Row(horizontalArrangement = Arrangement.spacedBy(4.dp), modifier = Modifier.semantics { contentDescription = "Writing" }) {
                    repeat(3) { Box(Modifier.size(5.dp).background(g.grey, CircleShape)) }
                }
            } else if (speaking) {
                Row(Modifier.pressable(0.96f, label = "Stop reading", onClick = onRead), horizontalArrangement = Arrangement.spacedBy(5.dp), verticalAlignment = Alignment.CenterVertically) {
                    Glyph(Glyphs.stop, 12.dp, g.blue)
                    T("Stop reading", sf(13f, Medium), g.blue, maxLines = 1)
                }
            }
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
