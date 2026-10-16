package com.askeden.edencode.ui

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.askeden.edencode.model.CodeModes
import com.askeden.edencode.model.PhoneOptions
import kotlinx.coroutines.launch

/** A starter on the New page: its two lines, and what it puts in the composer. */
data class Starter(val title: String, val subtitle: String, val prompt: String)

/**
 * The phone can't start Exterminator Mode itself (its sessions run in Manual or Accept edits), so
 * "Fix a bug" asks for the same thing in words: find it, prove it, fix it, prove the fix.
 */
val starters = listOf(
    Starter("Fix a bug", "Exterminator Mode", "Find and fix this bug, and prove the fix with a test: "),
    Starter("Explain the project", "Where things live", "Explain this project: where things live, how the pieces fit, and where to start."),
    Starter("Review changes", "Before you push", "Review the uncommitted changes before I push: anything risky, unfinished or untested?"),
)

/**
 * A new session (the GNew mockup), the app's home: ☰, the project pill (its menu also holds
 * "Work in an isolated copy"), "What should we build?", three starters, and Eden chat's input
 * bar, whose ⌄ drawer picks the mode and the model as in a session. Sending starts the session
 * on the Mac and opens it.
 */
@Composable
fun NewScreen() {
    val env = LocalEnv.current
    val store = env.store
    val voice = env.speech
    val g = gInk
    val scope = rememberCoroutineScope()
    val options = store.options
    val backdrop = rememberBackdrop()
    var project by remember { mutableStateOf(options.projects.firstOrNull()?.name ?: "") }
    var text by remember { mutableStateOf(DebugComposer.typed ?: "") }
    var mode by remember { mutableStateOf(if (CodeModes.phone.any { it.id == options.defaultMode }) options.defaultMode else "ask") }
    var model by remember { mutableStateOf<PhoneOptions.Model?>(null) }
    var isolated by remember { mutableStateOf(false) }
    var starting by remember { mutableStateOf(false) }
    var problem by remember { mutableStateOf<String?>(null) }
    var picking by remember { mutableStateOf(false) }
    LaunchedEffect(options.projects) { if (options.projects.none { it.name == project }) project = options.projects.firstOrNull()?.name ?: "" }
    LaunchedEffect(Unit) { if (options.projects.isEmpty()) store.refreshAll() }
    LaunchedEffect(voice.heard) { if (voice.heard.isNotEmpty() && voice.listening) text = voice.heard }
    val top = safeTop()
    val mac = store.current?.macLabel ?: "your Mac"
    val modelLabel = model?.name ?: options.models.firstOrNull { it.ref == options.defaultModel }?.name ?: "Your default"

    fun start() {
        if (starting || project.isEmpty() || text.isBlank()) return
        starting = true
        voice.stopDictation()
        scope.launch {
            problem = store.newSession(project, text.trim(), mode, model?.ref, isolated)
            starting = false
            if (problem == null) text = ""
        }
    }

    Box(Modifier.fillMaxSize()) {
        Box(Modifier.fillMaxSize().backdropSource(backdrop)) {
            EdenBackground()
            Column(
                Modifier.fillMaxWidth().padding(top = top + 198.dp, start = 30.dp, end = 30.dp),
                horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                EdenTile(56.dp, 30.dp, radius = 16.dp)
                T("What should we build?", sf(26f, Bold, extraTracking = -0.52f - sfTracking(26f) - robotoCorrection(26f, Bold)), g.ink,
                    Modifier.semantics { heading() }, align = TextAlign.Center)
                T(if (project.isEmpty()) "On your $mac" else "In ${project.substringBefore(" /")}, on your $mac", sf(15f), g.grey, align = TextAlign.Center)
                problem?.let { T(it, sf(14f), g.red, align = TextAlign.Center) }
            }
        }

        GHeader(backdrop, onMenu = { store.drawerOpen = true }, onNew = null, modifier = Modifier.padding(top = top - 6.dp)) {
            Spacer(Modifier.weight(1f))
            Box {
                Row(
                    Modifier.height(44.dp).gGlass(backdrop, 22.dp).pressable(0.96f, label = "Project: $project. Change") { picking = true }.padding(horizontal = 16.dp),
                    horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically,
                ) {
                    T(project.substringBefore(" /").ifEmpty { "Project" }, sf(15f, Semibold), g.ink, maxLines = 1)
                    Glyph(Glyphs.chevD, 12.dp, g.ink)
                }
                GlassMenu(picking, { picking = false }) {
                    for (p in options.projects) {
                        GlassMenuItem(if (p.branch.isEmpty()) p.name else "${p.name} · ${p.branch}", checked = p.name == project) {
                            picking = false
                            project = p.name
                        }
                    }
                    GlassMenuItem("Work in an isolated copy", checked = isolated) { isolated = !isolated }
                }
            }
            Spacer(Modifier.weight(1f))
        }

        Column(
            Modifier.align(Alignment.BottomCenter).fillMaxWidth().imePadding().padding(bottom = safeBottom() + 8.dp),
            verticalArrangement = Arrangement.spacedBy(18.dp),
        ) {
            if (text.isEmpty()) {
                Row(
                    Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    for (s in starters) {
                        Column(
                            Modifier.width(170.dp).gGlass(backdrop, 18.dp).pressable(0.97f, label = "${s.title}. ${s.subtitle}") { text = s.prompt }
                                .padding(horizontal = 14.dp, vertical = 12.dp),
                        ) {
                            T(s.title, sf(14f, Semibold, lineHeight = 17f), g.ink, maxLines = 1)
                            T(s.subtitle, sf(14f, lineHeight = 17f), g.grey, maxLines = 1)
                        }
                    }
                }
            }
            voice.problem?.let { T(it, sf(12f), g.red, Modifier.fillMaxWidth().padding(horizontal = 20.dp), align = TextAlign.Center) }
            EdenComposer(
                text = text, onText = { text = it }, working = false,
                modeID = mode, modeLabel = CodeModes.name(mode), modelLabel = modelLabel,
                modes = options.modes, models = options.models,
                dictating = voice.listening, talking = false, attachments = 0,
                backdrop = backdrop, startExpanded = DebugComposer.open,
                placeholder = "Ask Eden Code to build or fix…",
                onSend = { start() }, onSteer = { start() }, onStop = {},
                onDictate = { scope.launch { voice.toggleDictation() } },
                onTalk = {}, onMode = { mode = it }, onModel = { model = it }, onPictures = {},
            )
        }
    }
}
