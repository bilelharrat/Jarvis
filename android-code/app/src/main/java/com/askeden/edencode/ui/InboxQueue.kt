package com.askeden.edencode.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.askeden.edencode.model.CodeModes
import com.askeden.edencode.model.PhoneCard
import com.askeden.edencode.model.PhoneSummary
import com.askeden.edencode.model.PhoneTodoCard
import kotlinx.coroutines.launch

/** Needs attention (InboxView.swift): every card that waits on the owner, each opening its session, where it waits. */
@Composable
fun InboxScreen() {
    val store = LocalEnv.current.store
    val c = Eden.colors
    TabPage({ store.refreshHome() }) {
        LargeTitle("Inbox", Modifier.padding(start = 4.dp, end = 4.dp).semantics { heading() })
        val cards = store.home.attention
        if (cards.isEmpty()) {
            EmptyCard(Glyphs.checkCircle, c.green, "Nothing waits on you", "Approvals and questions from your sessions show up here, and as notifications.")
        } else {
            Column(Modifier.fillMaxWidth().edenCard()) {
                cards.forEachIndexed { index, card ->
                    CardRow(card, store.home.sessions.firstOrNull { it.id == card.taskID }) { store.showCard(card) }
                    if (index < cards.size - 1) RowDivider(60.dp)
                }
            }
        }
    }
}

@Composable
fun CardRow(card: PhoneCard, session: PhoneSummary?, onClick: () -> Unit) {
    val c = Eden.colors
    Row(
        Modifier.fillMaxWidth().pressable(0.98f, label = card.approval.question, onClick = onClick).padding(horizontal = 14.dp, vertical = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically,
    ) {
        Badge(if (card.approval.isQuestion) c.accent else c.orange) {
            Glyph(if (card.approval.isQuestion) Glyphs.questionFill else if (card.faceID) Glyphs.warningFill else Glyphs.hand, 19.dp, Color.White)
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
            T(card.approval.question, sf(15f, Medium), c.ink, maxLines = 2)
            T(listOfNotNull(session?.title, session?.project, if (card.macOnly) "Answer on your Mac" else null).joinToString(" · "), sf(13f), c.muted, maxLines = 1)
        }
        RowTail()
        Chevron()
    }
}

/** The to-do queue (QueueView.swift): each project's cards, with Start (never in Auto or Bypass from here). */
@Composable
fun QueueScreen() {
    val store = LocalEnv.current.store
    val c = Eden.colors
    val scope = rememberCoroutineScope()
    var problem by remember { mutableStateOf<String?>(null) }
    var starting by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) { store.refreshTodos() }
    TabPage({ store.refreshTodos(); store.refreshUsage() }) {
        LargeTitle("Queue", Modifier.padding(start = 4.dp, end = 4.dp).semantics { heading() })
        problem?.let { ProblemBanner(it) }
        if (store.todos.cards.isEmpty()) {
            EmptyCard(Glyphs.tabQueue, c.accent, "No to-dos", "Write work ahead on your Mac’s agent board; it waits here to start.")
        }
        for ((project, cards) in store.todos.byProject) {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                SectionTitle(project)
                Column(Modifier.fillMaxWidth().edenCard()) {
                    cards.forEachIndexed { index, card ->
                        TodoRow(card, store.options.modelName(card.model), starting, onOpen = { id -> store.open(session = id) }) {
                            starting = card.id
                            scope.launch {
                                problem = store.startTodo(card)
                                starting = null
                            }
                        }
                        if (index < cards.size - 1) RowDivider(14.dp)
                    }
                }
            }
        }
        UsageGlance(store.usage)
    }
}

@Composable
private fun TodoRow(card: PhoneTodoCard, modelName: String, starting: String?, onOpen: (Int) -> Unit, onStart: () -> Unit) {
    val c = Eden.colors
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            T(card.title.ifEmpty { card.prompt }, sf(15f, Medium), c.ink, maxLines = 2)
            T(
                listOfNotNull(card.stateLabel, card.mode.ifEmpty { null }?.let(CodeModes::name), card.model.ifEmpty { null }?.let { modelName }).joinToString(" · "),
                sf(13f), c.muted,
            )
        }
        val task = card.taskID
        when {
            task != null && !card.waiting -> GlassButton("Open", false, style = sf(13f, Semibold), height = 34.dp) { onOpen(task) }
            card.waiting && card.startsOnMacOnly -> T(
                "On your Mac", sf(12f), c.muted,
                Modifier.semantics { contentDescription = "Starts on your Mac: its mode is ${CodeModes.name(card.mode)}" }, maxLines = 1,
            )
            card.waiting -> if (starting == card.id) Box(Modifier.padding(horizontal = 18.dp)) { Spinner() } else {
                GlassButton("Start", true, enabled = starting == null, style = sf(13f, Semibold), height = 34.dp, onClick = onStart)
            }
        }
    }
}
