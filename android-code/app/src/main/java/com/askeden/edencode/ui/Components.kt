package com.askeden.edencode.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.askeden.edencode.model.CodeStatus

/** SwiftUI's Text: the style, a colour, and a line limit, ending in "…". */
@Composable
fun T(
    text: String,
    style: TextStyle,
    color: Color,
    modifier: Modifier = Modifier,
    maxLines: Int = Int.MAX_VALUE,
    align: TextAlign? = null,
    headOverflow: Boolean = false,
) {
    val shown = if (headOverflow && text.length > 48) "…" + text.takeLast(47) else text
    BasicText(
        shown, modifier, style.copy(color = color, textAlign = align ?: TextAlign.Unspecified),
        overflow = TextOverflow.Ellipsis, maxLines = maxLines, softWrap = maxLines != 1,
    )
}

/** A small round button (back, changes), 34 pt, on the screen's light fill. */
@Composable
fun RoundGlassButton(icon: ImageVector, label: String, size: Dp = 34.dp, iconSize: Dp = 15.dp, onClick: () -> Unit) {
    val c = Eden.colors
    Box(
        Modifier
            .size(size)
            .background(c.fill, CircleShape)
            .pressable(0.94f, label = label, onClick = onClick)
            .semantics { contentDescription = label },
        contentAlignment = Alignment.Center,
    ) { Glyph(icon, iconSize, c.ink) }
}

/** A status dot (10 pt). */
@Composable
fun StatusDot(status: CodeStatus) {
    Box(Modifier.size(10.dp).background(Eden.colors.dot(status), CircleShape))
}

/** A capsule chip (Read aloud, files changed…). */
@Composable
fun Chip(text: String, icon: ImageVector? = null, tint: Color = Eden.colors.ink, fill: Color = Eden.colors.fill, modifier: Modifier = Modifier, iconSize: Dp = 13.dp) {
    Row(
        modifier.background(fill, RoundedCornerShape(50)).padding(horizontal = 12.dp, vertical = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(5.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (icon != null) Glyph(icon, iconSize, tint)
        T(text, sf(13f, Medium), tint, maxLines = 1)
    }
}

@Composable
fun ProblemBanner(text: String) {
    val c = Eden.colors
    Row(
        Modifier.fillMaxWidth().background(c.orange.copy(alpha = 0.14f), RoundedCornerShape(14.dp)).padding(12.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Glyph(Glyphs.warning, 14.dp, c.orange, Modifier.padding(top = 2.dp))
        T(text, sf(13f), c.ink)
    }
}

/** SwiftUI's Spacer(minLength: 8) in a 12-spaced HStack: the room a row leaves before its chevron. */
@Composable
fun androidx.compose.foundation.layout.RowScope.RowTail() = androidx.compose.foundation.layout.Spacer(Modifier.width(8.dp))

/** A row's trailing chevron (13 pt semibold). */
@Composable
fun Chevron() = Glyph(Glyphs.chevronRight, 12.dp, Eden.colors.chevron)

/** The coloured square of a banner row or a card row (34 pt, 10 corners). */
@Composable
fun Badge(color: Color, content: @Composable () -> Unit) {
    Box(Modifier.size(34.dp).background(color, RoundedCornerShape(10.dp)), contentAlignment = Alignment.Center) { content() }
}

/** A section's small capital title ("ASKEDEN / SITE"). */
@Composable
fun SectionTitle(text: String) {
    T(text.uppercase(), sf(13f, Semibold), Eden.colors.muted, Modifier.padding(horizontal = 6.dp), maxLines = 1)
}

/** The 0.5 pt row divider, inset past the dot. */
@Composable
fun RowDivider(start: Dp) {
    Box(Modifier.padding(start = start).fillMaxWidth().height(0.34.dp).background(Eden.colors.separator))
}
