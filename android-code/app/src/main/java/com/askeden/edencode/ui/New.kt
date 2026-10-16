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

/** The three starters (NewSessionSheet.swift): what they say, under it, and what they put in the input bar. */
val starters = listOf(
    Starter("Fix a bug", "Exterminator Mode", "Find and fix this bug: "),
    Starter("Explain the project", "Where things live", "Explain this project: where things live and how the parts fit together."),
    Starter("Review changes", "Before you push", "Review my uncommitted changes before I push: bugs, risks, anything missing."),
)

/**
 * A new session (G3, NewSessionSheet.swift's NewSessionScreen): ☰ and the project pill (which
 * project; an isolated copy) over the wallpaper, the Eden mark and "What should we build?", three
 * starters, and Eden chat's input bar (its drawer picks Manual or Accept edits and the model).
 * Send starts it (POST /new, then its pictures) and its session fills the screen.
 */
@Composable
fun NewScreen() {
    val env = LocalEnv.current
    val store = env.store
    val voice = env.speech
    val g = gInk
    val scope = rememberCoroutineScope()
    val context = androidx.compose.ui.platform.LocalContext.current
    val options = store.options
    val backdrop = rememberBackdrop()
    var project by remember { mutableStateOf(options.projects.firstOrNull()?.name ?: "") }
    var text by remember { mutableStateOf(DebugComposer.typed ?: "") }
    // The Mac's default mode is taken until the owner picks one.
    var modePicked by remember { mutableStateOf(false) }
    var mode by remember { mutableStateOf("ask") }
    var model by remember { mutableStateOf<PhoneOptions.Model?>(null) }
    var isolated by remember { mutableStateOf(false) }
    var starting by remember { mutableStateOf(false) }
    var problem by remember { mutableStateOf<String?>(null) }
    var picking by remember { mutableStateOf(false) }
    var pictures by remember { mutableStateOf(emptyList<com.askeden.edencode.net.Picture>()) }
    LaunchedEffect(options.projects, options.defaultMode) {
        if (options.projects.none { it.name == project }) project = options.projects.firstOrNull()?.name ?: ""
        if (!modePicked) mode = if (CodeModes.phone.any { it.id == options.defaultMode }) options.defaultMode else "ask"
    }
    LaunchedEffect(Unit) { if (options.projects.isEmpty()) store.refreshAll() }
    LaunchedEffect(voice.heard) { if (voice.heard.isNotEmpty() && voice.listening) text = voice.heard }
    val pick = androidx.activity.compose.rememberLauncherForActivityResult(androidx.activity.result.contract.ActivityResultContracts.PickMultipleVisualMedia(6)) { uris ->
        scope.launch { pictures = pictures + loadPictures(context, uris) }
    }
    val top = safeTop()
    val mac = store.current?.macLabel ?: "Mac"

    fun start() {
        if (starting || store.backend == null) return
        val prompt = text.trim()
        if (project.isEmpty()) { problem = "Choose a project first."; return }
        if (prompt.isEmpty() && pictures.isEmpty()) return
        starting = true
        problem = null
        voice.stopDictation()
        scope.launch {
            problem = store.newSession(project, prompt, mode, model?.ref, isolated, pictures)
            starting = false
            if (problem == null) { text = ""; pictures = emptyList() }
        }
    }

    androidx.compose.foundation.layout.BoxWithConstraints(Modifier.fillMaxSize()) {
        val heroTop = maxHeight * (250f / 844f)
        Box(Modifier.fillMaxSize().backdropSource(backdrop)) {
            EdenBackground()
            Column(
                Modifier.fillMaxWidth().padding(top = heroTop, start = 30.dp, end = 30.dp).movesForDrawer(),
                horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                EdenTile(56.dp, 30.dp, radius = 16.dp)
                T("What should we build?", sf(26f, Bold, extraTracking = -0.52f - sfTracking(26f) - robotoCorrection(26f, Bold)), g.ink,
                    Modifier.semantics { heading() }, align = TextAlign.Center)
                T(if (project.isEmpty()) "On your $mac" else "In $project, on your $mac", sf(15f), g.grey, align = TextAlign.Center)
            }
        }

        Column(Modifier.padding(top = top - 6.dp).movesForDrawer(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            GHeader(backdrop, onMenu = { store.drawerOpen = true }, onNew = null) {
                Spacer(Modifier.weight(1f))
                Box {
                    Row(
                        Modifier.height(44.dp).gGlass(backdrop, 22.dp)
                            .pressable(0.96f, label = "Project: ${project.ifEmpty { "none" }}${if (isolated) ", in an isolated copy" else ""}. Change") { picking = true }
                            .padding(horizontal = 16.dp),
                        horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically,
                    ) {
                        T(project.ifEmpty { "Choose a project" }, sf(15f, Semibold), g.ink, maxLines = 1)
                        if (isolated) Glyph(Glyphs.branch, 12.dp, g.blue)
                        Glyph(Glyphs.chevD, 12.dp, g.ink)
                    }
                    GlassMenu(picking, { picking = false }) {
                        GlassMenuItem("Project", footnote = true) {}
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
            (problem ?: store.problem)?.let { Box(Modifier.padding(horizontal = 16.dp)) { ProblemBanner(it) } }
        }

        Column(
            Modifier.align(Alignment.BottomCenter).fillMaxWidth().padding(bottom = keyboardOrSafeBottom() + 8.dp).movesForDrawer(),
            horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(18.dp),
        ) {
            if (text.isBlank()) {
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
            if (pictures.isNotEmpty()) {
                Row(
                    Modifier.gGlass(backdrop, 999.dp).padding(horizontal = 10.dp, vertical = 5.dp),
                    horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically,
                ) {
                    Glyph(Glyphs.photo, 13.dp, g.steps)
                    T("${pictures.size} picture${if (pictures.size == 1) "" else "s"}", sf(12f, Medium), g.steps, maxLines = 1)
                    T("✕", sf(12f, Semibold), g.steps, Modifier.pressable(label = "Remove pictures") { pictures = emptyList() })
                }
            }
            EdenComposer(
                text = text, onText = { text = it }, working = starting,
                modeID = mode, modeLabel = CodeModes.short(mode),
                modelLabel = model?.name ?: options.modelName(options.defaultModel),
                modes = options.modes, models = options.models, modelRef = model?.ref ?: options.defaultModel,
                dictating = voice.listening, talking = false, attachments = pictures.size,
                backdrop = backdrop, startExpanded = DebugComposer.open,
                onSend = { start() }, onSteer = { start() }, onStop = {},
                onDictate = { scope.launch { voice.toggleDictation() } },
                onTalk = {}, onMode = { mode = it; modePicked = true }, onModel = { model = it },
                onPictures = { pick.launch(androidx.activity.result.PickVisualMediaRequest(androidx.activity.result.contract.ActivityResultContracts.PickVisualMedia.ImageOnly)) },
            )
        }
    }
}
