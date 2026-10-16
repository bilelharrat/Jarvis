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
 * One session, live (PhoneSession mockup, SessionScreen.swift): a floating glass header pill
 * (back, title, project · model, Changes), the transcript (the owner's words in blue bubbles,
 * steps as "✓ Read file" lines, Eden's replies on glass with Read aloud and the files changed),
 * its cards inline, the isolated copy's Land and Discard, and Eden chat's composer.
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
                    start = 16.dp, end = 16.dp, top = top + 8.dp + 56.dp + 12.dp,
                    bottom = with(density) { composerHeight.toDp() } + 12.dp,
                ),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                model.problem?.let { item("problem") { ProblemBanner(it) } }
                items(rows, key = { it.key }) { row ->
                    when (row) {
                        is Transcript.Row.User -> UserBubble(row.entry.text)
                        is Transcript.Row.Steps -> Steps(row.steps, model.working)
                        is Transcript.Row.Reply -> ReplyBubble(
                            row.entry.text, typing = false, speaking = voice.speaking == "r${row.entry.i}",
                            filesChanged = if (row.entry.i == lastReply) model.latestReceipt?.fileCount ?: 0 else 0,
                            onRead = { voice.toggle(row.entry.text, "r${row.entry.i}") },
                            onChanges = { store.push(EdenCodeStore.Route.Changes(id)) },
                        )
                        is Transcript.Row.Note -> T(
                            row.entry.text, sf(13f), c.muted,
                            Modifier.fillMaxWidth().background(c.fill.copy(alpha = c.fill.alpha * 0.6f), RoundedCornerShape(14.dp)).padding(horizontal = 12.dp, vertical = 8.dp),
                        )
                    }
                }
                if (model.view.live.isNotEmpty()) item("live") { ReplyBubble(model.view.live, typing = true, speaking = false, filesChanged = 0, onRead = {}, onChanges = {}) }
                items(model.view.cards, key = { "card" + it.id }) { InlineCard(it) { store.sheetCard = it } }
                model.view.copy?.let { copy -> item("copy") { CopyBar(copy) { confirmCopy = it } } }
                if (model.view.todos.isNotEmpty()) item("todos") { TodoList(model.view.todos) }
                item("bottom") {
                    T(model.statusLine, sf(12f), c.muted, Modifier.fillMaxWidth().semantics { liveRegion = LiveRegionMode.Polite }, align = TextAlign.Center)
                }
            }
        }

        // The header pill.
        Row(
            Modifier.padding(top = top + 4.dp, start = 12.dp, end = 12.dp).fillMaxWidth()
                .boxShadow(hex(0x1E2850, if (Eden.dark) 0.4f else 0.12f), y = 6.dp, blur = 20.dp, radius = 999.dp)
                .glass(backdrop, RoundedCornerShape(50), if (Eden.dark) hex(0x2C2C30, 0.5f) else hex(0xFFFFFF, 0.6f), blur = 30.dp, saturate = 1.9f)
                .topRim(999.dp, if (Eden.dark) Color.White.copy(alpha = 0.2f) else Color.White, Color.Transparent)
                .border(1.dp, if (Eden.dark) Color.White.copy(alpha = 0.16f) else Color.White.copy(alpha = 0.85f), RoundedCornerShape(50))
                .padding(horizontal = 10.dp, vertical = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically,
        ) {
            RoundGlassButton(Glyphs.chevronLeft, "Back to sessions") { store.back() }
            Column(Modifier.weight(1f).semantics(mergeDescendants = true) {}, horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(1.dp)) {
                T(model.title, sf(15f, Semibold), c.ink, maxLines = 1)
                T(listOf(model.view.project, model.view.modelLabel).filter { it.isNotEmpty() }.joinToString(" · "), sf(11f), c.muted, maxLines = 1)
            }
            RoundGlassButton(Glyphs.changes, "Changes", iconSize = 17.dp) { store.push(EdenCodeStore.Route.Changes(id)) }
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
            EdenComposer(
                text = text, onText = { text = it }, working = model.working,
                modeID = view.mode, modeLabel = view.modeLabel, modelLabel = view.modelLabel,
                modes = store.options.modes, models = store.options.models,
                dictating = voice.listening, talking = voice.speaking == "last", attachments = pictures.size,
                backdrop = backdrop, startExpanded = DebugComposer.open,
                onSend = { submit(model, text, pictures, false, scope, voice) { t, p -> text = t; pictures = p } },
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

@Composable
private fun UserBubble(text: String) {
    val c = Eden.colors
    Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.CenterEnd) {
        SelectionContainer {
            T(
                text, sf(15f, lineHeight = 21f), Color.White,
                Modifier.widthIn(max = 300.dp).background(c.accent, RoundedCornerShape(20.dp)).padding(horizontal = 14.dp, vertical = 10.dp)
                    .semantics { contentDescription = "You: $text" },
            )
        }
    }
}

@Composable
private fun Steps(steps: List<PhoneEntry>, working: Boolean) {
    val c = Eden.colors
    Column(Modifier.padding(horizontal = 2.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        steps.forEachIndexed { index, step ->
            val running = index == steps.size - 1 && working && step.stepRunning
            Row(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                modifier = Modifier.semantics(mergeDescendants = true) { contentDescription = (if (running) "Running: " else "Done: ") + step.stepLine },
            ) {
                if (!running && !step.stepFailed) Glyph(Glyphs.checkThin, 14.dp, c.checkGreen, Modifier.padding(top = 2.dp))
                else T(if (running) "◌" else "✗", sf(14f), if (running) c.accent else c.red, maxLines = 1)
                T(step.stepLine.replace("…", ""), sf(14f), if (running) c.ink else c.ink2, maxLines = 2)
            }
        }
    }
}

/** Eden's reply on glass, with Read aloud and the files it changed. */
@Composable
fun ReplyBubble(text: String, typing: Boolean, speaking: Boolean, filesChanged: Int, onRead: () -> Unit, onChanges: () -> Unit) {
    val c = Eden.colors
    Column(
        Modifier.widthIn(max = 360.dp)
            .background(c.card, RoundedCornerShape(20.dp)).border(1.dp, c.cardRim, RoundedCornerShape(20.dp))
            .padding(horizontal = 14.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        SelectionContainer { T(text, sf(15f, lineHeight = 21f), c.ink) }
        if (typing) {
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp), modifier = Modifier.semantics { contentDescription = "Writing" }) {
                repeat(3) { Box(Modifier.size(5.dp).background(c.muted, CircleShape)) }
            }
        } else {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Chip(if (speaking) "Stop" else "Read aloud", if (speaking) Glyphs.stop else Glyphs.play, modifier = Modifier.pressable(0.96f, label = if (speaking) "Stop reading" else "Read aloud", onClick = onRead))
                if (filesChanged > 0) Chip("$filesChanged file${if (filesChanged == 1) "" else "s"} changed", modifier = Modifier.pressable(0.96f, onClick = onChanges))
            }
        }
    }
}

/** A card inside the transcript: opens the approval sheet. */
@Composable
private fun InlineCard(card: PhoneCard, onClick: () -> Unit) {
    val c = Eden.colors
    Row(
        Modifier.fillMaxWidth().background(c.orange.copy(alpha = 0.14f), RoundedCornerShape(18.dp)).pressable(0.98f, label = card.approval.question, onClick = onClick).padding(12.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically,
    ) {
        Badge(if (card.approval.isQuestion) c.accent else c.orange) { Glyph(if (card.approval.isQuestion) Glyphs.questionFill else Glyphs.warningFill, 19.dp, Color.White) }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
            T(card.approval.question, sf(15f, Semibold), c.ink, maxLines = 2)
            T(if (card.macOnly) "Answer on your Mac" else "Tap to answer", sf(13f), c.needsInk, maxLines = 1)
        }
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
