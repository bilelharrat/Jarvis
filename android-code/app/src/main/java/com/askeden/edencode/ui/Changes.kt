package com.askeden.edencode.ui

import android.view.accessibility.AccessibilityManager
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.defaultMinSize
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
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.askeden.edencode.model.PhoneChanges
import com.askeden.edencode.model.PhoneComment
import com.askeden.edencode.model.PhoneReceipt
import com.askeden.edencode.model.Spoken
import com.askeden.edencode.net.MacError
import com.askeden.edencode.store.io
import kotlinx.coroutines.async
import kotlinx.coroutines.launch

/**
 * What a session changed (PhoneChanges mockup, ChangesScreen.swift): Turn or Session, the turn's
 * receipt, each file's hunks with Keep, Undo and a comment on a line (a tap on the line), Read
 * aloud, and Undo all / Open pull request at the bottom.
 */
@Composable
fun ChangesScreen(id: Int) {
    val env = LocalEnv.current
    val store = env.store
    val voice = env.speech
    val c = Eden.colors
    val scope = rememberCoroutineScope()
    val view = LocalView.current
    var which by remember { mutableStateOf("turn") }
    var changes by remember { mutableStateOf<PhoneChanges?>(null) }
    var receipt by remember { mutableStateOf<PhoneReceipt?>(null) }
    var problem by remember { mutableStateOf<String?>(null) }
    var said by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var commenting by remember { mutableStateOf<Pair<String, PhoneChanges.Line>?>(null) }
    var confirmUndoAll by remember { mutableStateOf(false) }
    val backdrop = rememberBackdrop()

    LaunchedEffect(which) {
        val backend = store.backend ?: return@LaunchedEffect
        try {
            val r = scope.async { runCatching { io { backend.receipts(id) } }.getOrNull() }
            changes = io { backend.changes(id, which) }
            receipt = r.await()?.receipts?.lastOrNull()
            problem = null
        } catch (e: Exception) {
            if (e is kotlinx.coroutines.CancellationException) throw e
            problem = MacError.describe(e)
        }
    }

    fun announce(text: String) {
        if ((view.context.getSystemService(android.content.Context.ACCESSIBILITY_SERVICE) as AccessibilityManager).isEnabled) view.announceForAccessibility(text)
    }

    fun act(hunks: List<String>, action: String) {
        val backend = store.backend ?: return
        if (hunks.isEmpty()) return
        busy = true
        scope.launch {
            try {
                val result = io { backend.hunk(id, hunks, action, which) }
                result.changes?.let { changes = it }
                said = result.said.ifEmpty { null }
                announce(if (action == "undo") result.said.ifEmpty { "Undone" } else if (action == "keep") "Kept" else "Not kept")
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                problem = MacError.describe(e)
            } finally {
                busy = false
            }
        }
    }

    val top = safeTop()
    val bottom = safeBottom()
    Box(Modifier.fillMaxSize()) {
        Box(Modifier.fillMaxSize().backdropSource(backdrop)) {
            EdenBackground()
            Column(
                Modifier.fillMaxSize().verticalScroll(rememberScrollState())
                    .padding(top = top - 6.dp, start = 14.dp, end = 14.dp, bottom = bottom + 8.dp + 50.dp + 90.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Row(Modifier.padding(start = 2.dp), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                    // The G header's round glass button, as ☰ is on the session.
                    GCircleButton(Glyphs.chevronLeft, "Back to session", LocalBackground.current, iconSize = 18.dp) { store.back() }
                    T("Changes", sf(22f, Bold), c.ink, Modifier.weight(1f).semantics { heading() }, maxLines = 1)
                    Segmented(listOf("turn" to "Turn", "session" to "Session"), which, Modifier.width(150.dp)) { which = it }
                }
                problem?.let { ProblemBanner(it) }
                said?.let { T(it, sf(13f), c.muted, Modifier.padding(horizontal = 4.dp)) }
                receipt?.let { ReceiptCard(it) }
                val found = changes
                if (found != null) {
                    if (found.files.isEmpty()) {
                        T(
                            if (found.git) "No changes in this view." else "This folder isn’t a git repository.", sf(15f), c.muted,
                            Modifier.fillMaxWidth().edenCard(radius = 20.dp).padding(24.dp), align = TextAlign.Center,
                        )
                    }
                    for (file in found.files) {
                        FileCard(
                            file, busy, voice.speaking == "f${file.path}",
                            onKeep = { act(listOf(it.id), if (it.kept) "unkeep" else "keep") },
                            onUndo = { act(listOf(it.id), "undo") },
                            onComment = { line -> commenting = file.path to line },
                            onRead = { voice.toggle(Spoken.file(file), "f${file.path}") },
                        )
                    }
                } else if (problem == null) {
                    Box(Modifier.fillMaxWidth().padding(40.dp), contentAlignment = Alignment.Center) { Spinner(c.muted, 22.dp) }
                }
            }
        }
        Row(
            Modifier.align(Alignment.BottomCenter).padding(start = 14.dp, end = 14.dp, bottom = bottom + 8.dp).fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            val canUndo = !busy && changes?.unkeptHunks?.isNotEmpty() == true
            Box(
                Modifier.weight(1f).height(50.dp)
                    .glass(backdrop, RoundedCornerShape(50), if (Eden.dark) hex(0x2C2C30, 0.55f) else hex(0xFFFFFF, 0.65f), blur = 30.dp)
                    .border(1.dp, if (Eden.dark) Color.White.copy(alpha = 0.16f) else Color.White.copy(alpha = 0.9f), RoundedCornerShape(50))
                    .pressable(0.97f, enabled = canUndo, label = "Undo all") { confirmUndoAll = true },
                contentAlignment = Alignment.Center,
            ) { T("Undo all", sf(15f, Semibold), c.ink, maxLines = 1) }
            Box(
                Modifier.weight(1.4f).height(50.dp).background(c.ink, RoundedCornerShape(50))
                    .pressable(0.97f, enabled = !busy && changes?.files?.isNotEmpty() == true, label = "Open pull request") {
                        val backend = store.backend ?: return@pressable
                        busy = true
                        said = "Writing the pull request…"
                        scope.launch {
                            try {
                                said = io { backend.openPullRequest(id) }.said
                            } catch (e: Exception) {
                                if (e is kotlinx.coroutines.CancellationException) throw e
                                said = null
                                problem = MacError.describe(e)
                            } finally {
                                busy = false
                            }
                        }
                    },
                contentAlignment = Alignment.Center,
            ) { T("Open pull request", sf(15f, Semibold), c.onInk, maxLines = 1) }
        }

        if (confirmUndoAll) ConfirmDialog(
            "Undo every change in this view that you haven’t kept?", null, "Undo all", destructive = true, onDismiss = { confirmUndoAll = false },
        ) {
            confirmUndoAll = false
            act(changes?.unkeptHunks ?: emptyList(), "undo")
        }

        commenting?.let { (path, line) ->
            Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.25f)).pressable(1f) { commenting = null }, contentAlignment = Alignment.BottomCenter) {
                CommentSheet(path, line, onCancel = { commenting = null }) { text ->
                    commenting = null
                    val backend = store.backend ?: return@CommentSheet
                    scope.launch {
                        try {
                            io { backend.comment(id, listOf(PhoneComment(path, line.number, if (line.kind == PhoneChanges.Line.Kind.Removed) "o" else null, line.text.trim(), text))) }
                            said = "Sent your comment to the session."
                        } catch (e: Exception) {
                            if (e is kotlinx.coroutines.CancellationException) throw e
                            problem = MacError.describe(e)
                        }
                    }
                }
            }
        }
    }
}

/** The turn's proof: risk, and a grid of what was checked. */
@Composable
fun ReceiptCard(receipt: PhoneReceipt) {
    val c = Eden.colors
    val riskInk = when (receipt.risk) {
        "high" -> c.red
        "medium" -> c.orange
        else -> c.lowRisk
    }
    Column(Modifier.fillMaxWidth().edenCard(radius = 20.dp).padding(14.dp).semantics(mergeDescendants = true) {}, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            T("Receipt", sf(15f, Semibold), c.ink, Modifier.weight(1f))
            T(receipt.riskLabel, sf(12f, Semibold), riskInk, Modifier.background(riskInk.copy(alpha = 0.16f), RoundedCornerShape(50)).padding(horizontal = 8.dp, vertical = 3.dp), maxLines = 1)
        }
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) { receipt.rows.chunked(2).forEach { pair ->
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                for (row in pair) {
                    Row(Modifier.weight(1f), horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                        val mark = row.mark
                        if (mark == PhoneReceipt.Row.Mark.Good) Glyph(Glyphs.checkThin, 13.dp, c.checkGreen, Modifier.padding(top = 2.dp))
                        else T(if (mark == PhoneReceipt.Row.Mark.Bad) "✗" else "•", sf(13f), if (mark == PhoneReceipt.Row.Mark.Bad) c.red else c.needsInk, maxLines = 1)
                        T(row.text, sf(13f), c.ink, maxLines = 2)
                    }
                }
                if (pair.size == 1) Box(Modifier.weight(1f))
            }
        } }
        if (receipt.why.isNotEmpty() && receipt.risk != "low") T("Why: ${receipt.why}", sf(12f), c.muted)
    }
}

/** One file's hunks. */
@Composable
fun FileCard(
    file: PhoneChanges.File,
    busy: Boolean,
    speaking: Boolean,
    onKeep: (PhoneChanges.Hunk) -> Unit,
    onUndo: (PhoneChanges.Hunk) -> Unit,
    onComment: (PhoneChanges.Line) -> Unit,
    onRead: () -> Unit,
) {
    val c = Eden.colors
    val shape = RoundedCornerShape(20.dp)
    Column(Modifier.fillMaxWidth().background(c.card.copy(alpha = (c.card.alpha * 1.1f).coerceAtMost(1f)), shape).border(1.dp, c.cardRim, shape).clip(shape)) {
        Row(Modifier.padding(horizontal = 14.dp, vertical = 10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            T(file.path, sf(12f, mono = true), c.ink, Modifier.weight(1f), maxLines = 1, headOverflow = true)
            T("+${file.added} −${file.removed}", sf(12f), c.muted, maxLines = 1)
            Box(Modifier.pressable(0.9f, label = if (speaking) "Stop reading" else "Read this change aloud", onClick = onRead)) {
                Glyph(if (speaking) Glyphs.stop else Glyphs.speaker, 13.dp, c.muted)
            }
        }
        RowDivider(0.dp)
        when {
            file.sensitive -> Note("Credentials: changed, lines withheld.")
            file.binary -> Note("A binary file changed.")
            file.omitted -> Note("Too big to show here: open it on your Mac.")
        }
        for (hunk in file.hunks) {
            for (line in hunk.lines) DiffLine(line, Modifier.pressable(1f, label = "Comment on this line") { onComment(line) })
            if (hunk.cut > 0) Note("${hunk.cut} more lines on your Mac.")
            if (hunk.kept) {
                Row(
                    Modifier.pressable(0.98f, label = "Kept. Tap to un-keep") { onKeep(hunk) }.padding(horizontal = 12.dp, vertical = 10.dp),
                    horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically,
                ) {
                    Glyph(Glyphs.checkThin, 15.dp, c.checkGreen)
                    T("Kept", sf(13f), c.checkGreen, maxLines = 1)
                }
            } else {
                Row(Modifier.padding(horizontal = 12.dp, vertical = 10.dp).semantics { contentDescription = "Change ${hunk.n}" }, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Box(Modifier.weight(1f).defaultMinSize(minHeight = 40.dp).background(c.accent, RoundedCornerShape(50)).pressable(0.97f, enabled = !busy, label = "Keep") { onKeep(hunk) }, contentAlignment = Alignment.Center) {
                        T("Keep", sf(15f, Semibold), Color.White, maxLines = 1)
                    }
                    Box(Modifier.weight(1f).defaultMinSize(minHeight = 40.dp).background(c.fill, RoundedCornerShape(50)).pressable(0.97f, enabled = !busy, label = "Undo") { onUndo(hunk) }, contentAlignment = Alignment.Center) {
                        T("Undo", sf(15f), c.ink, maxLines = 1)
                    }
                    Box(
                        Modifier.size(40.dp).background(c.fill, CircleShape)
                            .pressable(0.97f, enabled = !busy, label = "Comment on this change") { (hunk.lines.firstOrNull { it.kind != PhoneChanges.Line.Kind.Context } ?: hunk.lines.firstOrNull())?.let(onComment) }
                            .semantics { contentDescription = "Comment on this change" },
                        contentAlignment = Alignment.Center,
                    ) { Glyph(Glyphs.comment, 16.dp, c.ink) }
                }
            }
        }
    }
}

@Composable
private fun Note(text: String) = T(text, sf(12f), Eden.colors.muted, Modifier.padding(horizontal = 14.dp, vertical = 8.dp))

@Composable
fun DiffLine(line: PhoneChanges.Line, modifier: Modifier = Modifier) {
    val c = Eden.colors
    val (prefix, ink, bg) = when (line.kind) {
        PhoneChanges.Line.Kind.Added -> Triple("+", c.addedInk, c.addedBG)
        PhoneChanges.Line.Kind.Removed -> Triple("−", c.removedInk, c.removedBG)
        else -> Triple(" ", c.ink2, Color.Transparent)
    }
    T(
        "$prefix ${line.text}", sf(11.5f, mono = true, lineHeight = 15f), ink,
        modifier.fillMaxWidth().background(bg).padding(horizontal = 12.dp, vertical = 2.dp)
            .semantics { contentDescription = "${when (line.kind) { PhoneChanges.Line.Kind.Added -> "Added"; PhoneChanges.Line.Kind.Removed -> "Removed"; else -> "Line" }} ${line.number}: ${line.text}" },
    )
}

@Composable
private fun CommentSheet(path: String, line: PhoneChanges.Line, onCancel: () -> Unit, onSend: (String) -> Unit) {
    val c = Eden.colors
    var text by remember { mutableStateOf("") }
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { focus.requestFocus() }
    SmallSheet(260.dp) {
        T("${path.substringAfterLast('/')}:${line.number}", sf(13f, mono = true), c.muted, maxLines = 1)
        DiffLine(line, Modifier.clip(RoundedCornerShape(8.dp)))
        FilledField(
            text, { text = it }, "What should change here?", Modifier.focusRequester(focus), style = sf(17f), radius = 14.dp,
            minLines = 2, maxLines = 4, keyboard = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
        )
        Row(verticalAlignment = Alignment.CenterVertically) {
            GlassButton("Cancel", false, onClick = onCancel)
            Box(Modifier.weight(1f))
            GlassButton("Send to session", true, enabled = text.isNotBlank()) { onSend(text.trim()) }
        }
        Box(Modifier.height(safeBottom()))
    }
}
