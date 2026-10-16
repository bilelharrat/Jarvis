package com.askeden.edencode.ui

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.mutableStateOf
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.askeden.edencode.model.CodeStatus

// The G design (2026-10-16, the owner's pick: a ChatGPT/Claude-app layout in Liquid Glass). These
// are the pieces every G screen shares; the sizes and colours are the mockups' (GChat, GDrawer,
// GNew, GAsk .dc.html), in their 390-wide points.

/** The G mockups' words colours, light and dark: ink, the steps' grey, the two greys, needs-you orange, done green. */
class GInk(dark: Boolean) {
    val ink = if (dark) hex(0xF5F5F7) else hex(0x1D1D1F)
    val steps = if (dark) hex(0xD1D1D6) else hex(0x3A3A3C)
    val grey = if (dark) hex(0x98989D) else hex(0x8E8E93)
    val grey2 = if (dark) hex(0xAEAEB2) else hex(0x6E6E73)
    val needs = if (dark) hex(0xFFB340) else hex(0xC93400)
    val done = if (dark) hex(0x30D158) else hex(0x248A3D)
    val blue = if (dark) hex(0x0A84FF) else hex(0x007AFF)
    val green = if (dark) hex(0x30D158) else hex(0x34C759)
    val orange = if (dark) hex(0xFF9F0A) else hex(0xFF9500)
    val red = if (dark) hex(0xFF453A) else hex(0xFF3B30)
    val navy = hex(0x0E2747)
    /** rgba(120,120,128,.12–.14): the settings button, Not now. */
    val fill = if (dark) hex(0x787880, 0.28f) else hex(0x787880, 0.13f)

    /** A session's colour: its dot, its one word. */
    fun of(status: CodeStatus): Color = when (status) {
        CodeStatus.Working -> blue
        CodeStatus.NeedsYou -> orange
        CodeStatus.Done -> green
        CodeStatus.Failed -> red
        else -> grey
    }

    /** The coloured words under a title ("Needs your OK" is darker than its dot, as in the mockup). */
    fun words(status: CodeStatus): Color = when (status) {
        CodeStatus.Working -> blue
        CodeStatus.NeedsYou -> needs
        CodeStatus.Done -> done
        CodeStatus.Failed -> red
        else -> grey
    }
}

val gInk: GInk @Composable get() = if (Eden.dark) GInkDark else GInkLight
private val GInkLight = GInk(false)
private val GInkDark = GInk(true)

/** A 44-point round glass button (☰, ✎). */
@Composable
fun GCircleButton(icon: ImageVector, label: String, backdrop: Backdrop?, size: Dp = 44.dp, iconSize: Dp = 20.dp, onClick: () -> Unit) {
    Box(
        Modifier.size(size).gGlass(backdrop, size / 2).pressable(0.94f, label = label, onClick = onClick).semantics { contentDescription = label },
        contentAlignment = Alignment.Center,
    ) { Glyph(icon, iconSize, gInk.ink) }
}

/**
 * The floating header of every G screen: ☰ at the left, [middle] (the title pill, a project pill,
 * or nothing), ✎ (or a 44 gap) at the right; 16 in from the sides.
 */
@Composable
fun GHeader(backdrop: Backdrop?, onMenu: () -> Unit, onNew: (() -> Unit)?, modifier: Modifier = Modifier, middle: @Composable RowScope.() -> Unit) {
    Row(
        modifier.fillMaxWidth().padding(horizontal = 16.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically,
    ) {
        GCircleButton(Glyphs.menu, "Your sessions", backdrop, onClick = onMenu)
        middle()
        if (onNew != null) GCircleButton(Glyphs.compose, "New session", backdrop, onClick = onNew) else Spacer(Modifier.width(44.dp))
    }
}

/**
 * The title pill: the session's title, and a dot with its one word and its project. A tap opens
 * its menu ([menu]: the changes, read aloud, stop, your sessions), as the iPhone's does.
 */
@Composable
fun RowScope.GTitlePill(title: String, status: CodeStatus, project: String, backdrop: Backdrop?, menu: @Composable ColumnScope.(close: () -> Unit) -> Unit) {
    val g = gInk
    var open by remember { mutableStateOf(false) }
    val word = com.askeden.edencode.model.SessionList.word(status)
    val line = listOf(word, project).filter { it.isNotEmpty() }.joinToString(" · ")
    Box(Modifier.weight(1f)) {
        Column(
            Modifier.fillMaxWidth().height(44.dp).gGlass(backdrop, 22.dp)
                .pressable(0.98f, label = "$title. $line. Session actions") { open = true }
                .padding(horizontal = 12.dp)
                .semantics(mergeDescendants = true) { heading() },
            horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center,
        ) {
            T(title, sf(15f, Semibold, lineHeight = 18f), g.ink, Modifier.widthIn(max = 200.dp), maxLines = 1)
            Row(horizontalArrangement = Arrangement.spacedBy(5.dp), verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(6.dp).background(g.of(status), CircleShape))
                T(line, sf(11f, lineHeight = 13f), g.words(status), maxLines = 1)
            }
        }
        GlassMenu(open, { open = false }, offset = androidx.compose.ui.unit.DpOffset(0.dp, 50.dp)) { menu { open = false } }
    }
}

/** The mockups' spinner: a 14-point ring in blue, its right quarter open, turning. */
@Composable
fun RingSpinner(size: Dp = 14.dp, color: Color = gInk.blue) {
    val turn by rememberInfiniteTransition(label = "ring").animateFloat(0f, 360f, infiniteRepeatable(tween(900, easing = LinearEasing), RepeatMode.Restart), label = "turn")
    Canvas(Modifier.size(size).semantics { contentDescription = "Working" }) {
        val w = 2.dp.toPx()
        rotate(turn) {
            // border 2 with border-right transparent: three quarters, from 45° past the bottom right round to the top right.
            drawArc(color, startAngle = 45f + 90f - 90f, sweepAngle = 270f, useCenter = false,
                topLeft = androidx.compose.ui.geometry.Offset(w / 2, w / 2),
                size = androidx.compose.ui.geometry.Size(this.size.width - w, this.size.height - w), style = Stroke(w))
        }
    }
}

/** The navy tile with the Eden mark (the drawer's Mac, the composer's button, the New page). */
@Composable
fun EdenTile(size: Dp, mark: Dp, radius: Dp = size / 2, modifier: Modifier = Modifier) {
    Box(modifier.size(size).background(hex(0x0E2747), RoundedCornerShape(radius)), contentAlignment = Alignment.Center) {
        Glyph(Glyphs.edenMarkBold, mark, Color.White)
    }
}

/** A G page's large title under its header (Inbox, Queue, Settings). */
@Composable
fun GTitle(text: String) {
    T(text, sf(34f, Bold), gInk.ink, Modifier.fillMaxWidth().padding(horizontal = 20.dp).semantics { heading() }, maxLines = 1)
}
