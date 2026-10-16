package com.askeden.edencode.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.verticalScroll
import com.askeden.edencode.model.PhoneOptions

/**
 * Eden chat's input bar, as the Eden iPhone app shows it (askeden/web/chat: index.html's
 * .jc-composer, app.css + mobile.css at phone width), redrawn point for point as the iPhone app's
 * EdenComposer does: a 22 rounded glass bar 8 in from the edges, the Eden mark in a 30 orb that
 * opens the drawer (+, the mode pill, the model pill), the text, Dictate, Talk while it's empty, and
 * the 32 send button that turns into Stop while the session works.
 */
@Composable
fun EdenComposer(
    text: String,
    onText: (String) -> Unit,
    working: Boolean,
    modeID: String,
    modeLabel: String,
    modelLabel: String,
    modes: List<PhoneOptions.Mode>,
    models: List<PhoneOptions.Model>,
    modelRef: String = "",
    routedLabel: String = "",
    dictating: Boolean,
    talking: Boolean,
    attachments: Int,
    backdrop: Backdrop?,
    startExpanded: Boolean = false,
    onSend: () -> Unit,
    onSteer: () -> Unit,
    onStop: () -> Unit,
    onDictate: () -> Unit,
    onTalk: () -> Unit,
    onMode: (String) -> Unit,
    onModel: (PhoneOptions.Model) -> Unit,
    onPictures: () -> Unit,
) {
    val dark = Eden.dark
    val ink = remember(dark) { ComposerInk(dark) }
    var focused by remember { mutableStateOf(false) }
    var expanded by remember { mutableStateOf(startExpanded) }
    val empty = text.isBlank() && attachments == 0
    val shape = RoundedCornerShape(22.dp)

    Column(
        Modifier
            .padding(horizontal = 8.dp)
            .fillMaxWidth()
            // --clear-shadow: 0 10px 30px -14px rgb(0 0 0 / .2); dark 0 14px 36px -14px / .6
            .boxShadow(Color.Black.copy(alpha = if (dark) 0.6f else 0.2f), y = if (dark) 14.dp else 10.dp, blur = if (dark) 36.dp else 30.dp, radius = 22.dp, spread = (-14).dp)
            .drawBehind {
                // --clear-edge (0 0 0 .5px black 9 %; dark 55 %), or, while typing, the accent ring and its glow.
                val r = 22.dp.toPx()
                if (focused) {
                    val g = 4.dp.toPx()
                    drawRoundRect(ink.glow.copy(alpha = 0.12f), Offset(-g, -g), Size(size.width + 2 * g, size.height + 2 * g), CornerRadius(r + g))
                    drawRoundRect(ink.accent.copy(alpha = 0.42f), Offset(-0.5.dp.toPx(), -0.5.dp.toPx()), Size(size.width + 1.dp.toPx(), size.height + 1.dp.toPx()), CornerRadius(r + 0.5.dp.toPx()), style = Stroke(1.dp.toPx()))
                } else {
                    val e = 0.25.dp.toPx()
                    drawRoundRect(Color.Black.copy(alpha = if (dark) 0.55f else 0.09f), Offset(-e, -e), Size(size.width + 2 * e, size.height + 2 * e), CornerRadius(r + e), style = Stroke(0.5.dp.toPx()))
                }
            }
            .then(
                if (focused) Modifier.background(ink.surface, shape)
                // --clear-fill over --clear-blur (blur 22, saturate 175 %), with the material under it as SwiftUI draws.
                else Modifier.glass(backdrop, shape, if (dark) hex(0x1C1C1F, 0.42f) else hex(0xF2F4F8, 0.42f), blur = 22.dp, saturate = 1.0f, fallbackTint = if (dark) hex(0x1C1C1F, 0.9f) else hex(0xFFFFFF, 0.88f))
                    .background(Brush.verticalGradient(listOf(Color.White.copy(alpha = if (dark) 0.075f else 0.34f), Color.White.copy(alpha = if (dark) 0.02f else 0.16f))), shape),
            )
            .topRim(22.dp, Color.White.copy(alpha = if (dark) 0.16f else 0.75f), Color.White.copy(alpha = if (dark) 0.1f else 0.45f))
            .clip(shape)
            .padding(start = 12.dp, top = 9.dp, end = 10.dp, bottom = 9.dp),
    ) {
        Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            // The orb.
            Box(
                Modifier.padding(bottom = 1.dp).size(30.dp)
                    .then(if (expanded) Modifier.boxShadow(ink.glow.copy(alpha = 0.45f), y = 0.dp, blur = 16.dp, radius = 15.dp) else Modifier)
                    .background(if (expanded) ink.accent else ink.accent.copy(alpha = 0.13f), CircleShape)
                    .then(if (!expanded) Modifier.border(1.dp, ink.accent.copy(alpha = 0.32f), CircleShape) else Modifier)
                    .pressable(0.9f, label = "Composer options") { expanded = !expanded }
                    .semantics { contentDescription = "Composer options"; stateDescription = if (expanded) "Open" else "Closed" },
                contentAlignment = Alignment.Center,
            ) { Glyph(Glyphs.edenMark, 15.dp, if (expanded) Color.White else ink.ink) }

            BasicTextField(
                text, onText,
                Modifier.weight(1f).defaultMinSize(minHeight = 34.dp).padding(vertical = 5.dp)
                    .onFocusChanged { focused = it.isFocused }
                    .semantics { contentDescription = "Message Eden Code" },
                textStyle = sf(16f, lineHeight = 24f).copy(color = ink.ink),
                maxLines = 6,
                cursorBrush = SolidColor(ink.accent),
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                keyboardActions = KeyboardActions(onSend = { onSend() }),
                decorationBox = { inner ->
                    Box(contentAlignment = Alignment.CenterStart) {
                        if (text.isEmpty()) T(if (working) "Steer or reply…" else "Message Eden Code…", sf(14.5f, lineHeight = 24f), ink.subtle, maxLines = 1)
                        inner()
                    }
                },
            )
            if (working && text.isNotBlank()) {
                Row(
                    Modifier.padding(bottom = 1.dp).height(30.dp)
                        .background(ink.accent.copy(alpha = 0.13f), RoundedCornerShape(50))
                        .border(0.5.dp, ink.accent.copy(alpha = 0.3f), RoundedCornerShape(50))
                        .pressable(0.94f, label = "Steer: send into the running step", onClick = onSteer)
                        .padding(start = 9.dp, end = 11.dp),
                    horizontalArrangement = Arrangement.spacedBy(5.dp), verticalAlignment = Alignment.CenterVertically,
                ) {
                    Glyph(Glyphs.steer, 13.dp, ink.ink)
                    T("Steer", sf(12f, Semibold), ink.ink, maxLines = 1)
                }
            }
            RoundComposerButton(if (dictating) "Stop dictating" else "Dictate", dictating, ink, onDictate) { Glyph(Glyphs.mic, 15.dp, it) }
            if (empty && !working) {
                RoundComposerButton(if (talking) "Stop reading" else "Read the last reply aloud", talking, ink, onTalk) { Glyph(Glyphs.talk, 15.dp, it) }
            }
            val stop = working && empty
            Box(
                Modifier.padding(start = 2.dp, bottom = 1.dp).size(32.dp)
                    .then(if (!stop) Modifier.boxShadow(ink.accent.copy(alpha = 0.3f), y = 1.dp, blur = 2.dp, radius = 16.dp) else Modifier)
                    .background(if (stop) ink.ink else ink.accent, CircleShape)
                    .then(if (!stop) Modifier.topRim(16.dp, Color.White.copy(alpha = 0.22f), Color.Transparent) else Modifier)
                    .pressable(0.94f, label = if (stop) "Stop" else "Send") { if (stop) onStop() else onSend() }
                    .semantics { contentDescription = if (stop) "Stop" else "Send" },
                contentAlignment = Alignment.Center,
            ) {
                if (stop) Box(Modifier.size(9.dp).background(ink.surface, RoundedCornerShape(2.dp)))
                else Glyph(Glyphs.send, 15.dp, ink.ink)
            }
        }
        AnimatedVisibility(expanded, enter = fadeIn(tween(200, 60)) + expandVertically(spring(0.86f, 600f)), exit = fadeOut(tween(150)) + shrinkVertically(tween(260))) {
            Drawer(ink, modeID, modeLabel, modelLabel, modelRef, routedLabel, modes, models, attachments, onMode, onModel, onPictures)
        }
    }
}

@Composable
private fun RoundComposerButton(label: String, pressed: Boolean, ink: ComposerInk, onClick: () -> Unit, glyph: @Composable (Color) -> Unit) {
    Box(
        Modifier.padding(bottom = 1.dp).size(30.dp)
            .background(if (pressed) ink.accent.copy(alpha = 0.13f) else Color.Transparent, CircleShape)
            .pressable(0.94f, label = label, onClick = onClick)
            .semantics { contentDescription = label },
        contentAlignment = Alignment.Center,
    ) { glyph(if (pressed) ink.accent else ink.ink) }
}

@Composable
private fun Drawer(
    ink: ComposerInk,
    modeID: String,
    modeLabel: String,
    modelLabel: String,
    modelRef: String,
    routedLabel: String,
    modes: List<PhoneOptions.Mode>,
    models: List<PhoneOptions.Model>,
    attachments: Int,
    onMode: (String) -> Unit,
    onModel: (PhoneOptions.Model) -> Unit,
    onPictures: () -> Unit,
) {
    var modeOpen by remember { mutableStateOf(false) }
    var modelOpen by remember { mutableStateOf(false) }
    Column(Modifier.padding(top = 9.dp)) {
        Row(
            Modifier.fillMaxWidth()
                .drawBehind {
                    drawRect(Brush.horizontalGradient(listOf(Color.Transparent, ink.ink.copy(alpha = 0.14f), Color.Transparent)), size = Size(size.width, 0.5.dp.toPx()))
                }
                .padding(top = 10.dp, bottom = 2.dp),
            horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                Modifier.size(26.dp).background(ink.ink.copy(alpha = 0.11f), CircleShape).border(0.5.dp, ink.ink.copy(alpha = 0.11f), CircleShape)
                    .pressable(0.94f, label = "Add pictures", onClick = onPictures)
                    .semantics { contentDescription = if (attachments > 0) "Add pictures, $attachments added" else "Add pictures" },
                contentAlignment = Alignment.Center,
            ) { Glyph(Glyphs.composerPlus, 15.dp, ink.ink) }
            Box {
                Row(
                    Modifier.height(26.dp).background(ink.accent.copy(alpha = 0.15f), RoundedCornerShape(50))
                        .border(0.5.dp, ink.accent.copy(alpha = 0.4f), RoundedCornerShape(50))
                        .pressable(0.96f, label = "Mode, $modeLabel") { modeOpen = true }
                        .padding(horizontal = 10.dp),
                    horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically,
                ) {
                    Glyph(if (modeID == "edits") Glyphs.pencil else Glyphs.hand, 12.dp, ink.accentInk)
                    // The pill's short words ("Bypass", as the Mac's composer), never cut off.
                    T(modeLabel, sf(12f, Semibold, lineHeight = 15f), ink.accentInk, maxLines = 1)
                    Glyph(Glyphs.chevD, 9.dp, ink.accentInk)
                }
                GlassMenu(modeOpen, { modeOpen = false }) {
                    for (mode in modes) GlassMenuItem(mode.name, checked = mode.id == modeID) { modeOpen = false; onMode(mode.id) }
                    GlassMenuItem("Bypass permissions and Auto are set on your Mac", footnote = true) {}
                }
            }
            Spacer(Modifier.weight(1f).widthIn(min = 4.dp))
            Box {
                Row(
                    // SwiftUI's .frame(maxWidth: 150) on the menu's label: the pill takes the full 150.
                    Modifier.height(26.dp).width(150.dp).background(ink.ink.copy(alpha = 0.06f), RoundedCornerShape(50))
                        .border(0.5.dp, ink.ink.copy(alpha = 0.11f), RoundedCornerShape(50))
                        .pressable(0.96f, label = "Model, $modelLabel") { modelOpen = true }
                        .padding(horizontal = 9.dp),
                    horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.CenterHorizontally), verticalAlignment = Alignment.CenterVertically,
                ) {
                    Box(Modifier.size(6.dp).boxShadow(ink.glow.copy(alpha = 0.6f), 0.dp, 4.dp, 3.dp).background(ink.accent, CircleShape))
                    T(modelLabel.ifEmpty { "Model" }, sf(12f, Semibold, lineHeight = 15f), ink.ink2, Modifier.weight(1f, fill = false), maxLines = 1)
                    Glyph(Glyphs.chevD, 9.dp, ink.ink2)
                }
                if (modelOpen) ModelSheet(models, modelRef, modelLabel, routedLabel, onDismiss = { modelOpen = false }) {
                    modelOpen = false
                    onModel(it)
                }
            }
        }
    }
}

/**
 * The model picker (2026-10-16), as the Mac's model menu: Model Router first, then each provider's
 * models under its heading, every row by its name (the Mac sends names, never raw ids) with its
 * note under it (a provider, what it needs), the one in use checked. A bottom sheet over the whole
 * screen: the drop-down it replaces opened over the input bar and the keyboard.
 */
@OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
@Composable
fun ModelSheet(
    models: List<PhoneOptions.Model>,
    currentRef: String,
    currentLabel: String,
    routedLabel: String,
    onDismiss: () -> Unit,
    onPick: (PhoneOptions.Model) -> Unit,
) {
    val c = Eden.colors
    val dark = Eden.dark
    val keyboard = androidx.compose.ui.platform.LocalSoftwareKeyboardController.current
    androidx.compose.runtime.LaunchedEffect(Unit) { keyboard?.hide() }
    // The current row: by its ref; a list from an older Mac (or a fixture) may only match by name.
    val current = models.firstOrNull { it.ref == currentRef }?.ref ?: models.firstOrNull { it.name == currentLabel }?.ref
    androidx.compose.material3.ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = androidx.compose.material3.rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = if (dark) hex(0x1F2130) else hex(0xF4F6FB),
        shape = RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp),
        tonalElevation = 0.dp,
    ) {
        Column(
            Modifier.fillMaxWidth().androidxVerticalScroll()
                .padding(start = 16.dp, end = 16.dp, bottom = safeBottom() + 8.dp)
                .semantics { contentDescription = "Choose a model" },
        ) {
            T("Model", sf(17f, Semibold), c.ink, Modifier.padding(start = 4.dp, bottom = 8.dp))
            var heading: String? = null
            for (model in models) {
                if (model.group != heading) {
                    heading = model.group
                    if (model.group.isNotEmpty()) {
                        T(model.group, sf(13f, Semibold), c.muted, Modifier.padding(start = 4.dp, top = 14.dp, bottom = 4.dp))
                    }
                }
                val note = if (model.router && model.ref == current && routedLabel.isNotEmpty()) "Now on $routedLabel · ${model.note}".trimEnd(' ', '·') else model.note
                ModelRow(model.name, note, checked = model.ref == current, enabled = !model.needsKey, router = model.router) { onPick(model) }
                if (model.router) Box(Modifier.padding(top = 6.dp).fillMaxWidth().height(0.5.dp).background(c.separator))
            }
        }
    }
}

@Composable
private fun ModelRow(name: String, note: String, checked: Boolean, enabled: Boolean, router: Boolean, onClick: () -> Unit) {
    val c = Eden.colors
    Row(
        Modifier.fillMaxWidth().defaultMinSize(minHeight = 52.dp)
            .background(if (checked) c.accent.copy(alpha = 0.10f) else Color.Transparent, RoundedCornerShape(14.dp))
            .pressable(0.98f, enabled = enabled, label = if (note.isEmpty()) name else "$name, $note", onClick = onClick)
            .semantics { if (checked) stateDescription = "Selected" }
            .padding(horizontal = 12.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            T(name, sf(16f, if (router) Semibold else Medium), if (enabled) c.ink else c.muted, maxLines = 1)
            if (note.isNotEmpty()) T(note, sf(12.5f), c.muted, maxLines = 2)
        }
        Box(Modifier.width(20.dp), contentAlignment = Alignment.Center) { if (checked) Glyph(Glyphs.check, 15.dp, c.accent) }
    }
}

@Composable
private fun Modifier.androidxVerticalScroll(): Modifier = this.verticalScroll(androidx.compose.foundation.rememberScrollState())
