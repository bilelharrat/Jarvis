package com.askeden.edencode.ui

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * The app's glyphs. The iPhone draws SF Symbols, which Android can't ship; these are drawn to
 * match them in weight and shape, and the composer's and mockups' own SVGs are used as they are.
 */
object Glyphs {
    private fun icon(name: String, box: Float, stroke: Float, vararg paths: String, filled: List<String> = emptyList(), evenOdd: Boolean = false) =
        ImageVector.Builder(name, 24.dp, 24.dp, box, box).apply {
            for (d in paths) addPath(
                pathData = addPathNodes(d), fill = null, stroke = SolidColor(Color.Black), strokeLineWidth = stroke,
                strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round,
            )
            for (d in filled) addPath(
                pathData = addPathNodes(d), fill = SolidColor(Color.Black),
                pathFillType = if (evenOdd) androidx.compose.ui.graphics.PathFillType.EvenOdd else androidx.compose.ui.graphics.PathFillType.NonZero,
            )
        }.build()

    val chevronLeft = icon("back", 24f, 2.6f, "M15 4.5l-7.5 7.5 7.5 7.5")
    val chevronRight = icon("chev", 24f, 2.6f, "M9 4.5l7.5 7.5-7.5 7.5")
    val chevronDown = icon("chevd", 24f, 3f, "M5 8.5l7 7 7-7")
    val plus = icon("plus", 24f, 2.2f, "M12 4.5v15M4.5 12h15")
    /** plus.forwardslash.minus, as the iPhone's header shows Changes. */
    val changes = icon("changes", 24f, 2.1f, "M7.5 3.5v8M3.5 7.5h8", "M17.5 4.5L6.5 19.5", "M13.5 17h7.5")
    // The tab bar's SF Symbols, filled as iOS 26 draws them: rectangle.stack.fill, tray.fill, list.bullet, gearshape.fill.
    val tabSessions = icon("sessions", 24f, 0f, filled = listOf(
        "M6 9h12a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3v-6a3 3 0 0 1 3-3z", "M6 5.6h12a1 1 0 0 1 0 2H6a1 1 0 0 1 0-2z", "M8 2.4h8a0.9 0.9 0 0 1 0 1.8H8a0.9 0.9 0 0 1 0-1.8z",
    ))
    val tabInbox = icon("inbox", 24f, 0f, filled = listOf(
        "M7.6 3.5h8.8a2.4 2.4 0 0 1 2.3 1.7L21 12.6V18a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 18v-5.4l2.3-7.4a2.4 2.4 0 0 1 2.3-1.7zM7.7 5.4a0.7 0.7 0 0 0-0.7 0.5L5 12.3h4.1a0.9 0.9 0 0 1 0.9 0.9a2 2 0 0 0 4 0a0.9 0.9 0 0 1 0.9-0.9H19l-2-6.4a0.7 0.7 0 0 0-0.7-0.5z",
    ), evenOdd = true)
    val tabQueue = icon("queue", 24f, 2.1f, "M8.5 6h12M8.5 12h12M8.5 18h12", filled = listOf(
        "M4 4.6a1.4 1.4 0 1 1 0 2.8a1.4 1.4 0 0 1 0-2.8z", "M4 10.6a1.4 1.4 0 1 1 0 2.8a1.4 1.4 0 0 1 0-2.8z", "M4 16.6a1.4 1.4 0 1 1 0 2.8a1.4 1.4 0 0 1 0-2.8z",
    ))
    val tabSettings = icon("settings", 24f, 0f, filled = listOf("M20.15 10.43 L22.51 10.63 L22.51 13.37 L20.15 13.57 L18.87 16.65 L20.40 18.46 L18.46 20.40 L16.65 18.87 L13.57 20.15 L13.37 22.51 L10.63 22.51 L10.43 20.15 L7.35 18.87 L5.54 20.40 L3.60 18.46 L5.13 16.65 L3.85 13.57 L1.49 13.37 L1.49 10.63 L3.85 10.43 L5.13 7.35 L3.60 5.54 L5.54 3.60 L7.35 5.13 L10.43 3.85 L10.63 1.49 L13.37 1.49 L13.57 3.85 L16.65 5.13 L18.46 3.60 L20.40 5.54 L18.87 7.35Z M12 8.6a3.4 3.4 0 1 0 0 6.8a3.4 3.4 0 1 0 0-6.8z"), evenOdd = true)
    val warning = icon("warn", 24f, 2.2f, "M12 3l9 16H3z", "M12 10v4M12 17h.01")
    /** exclamationmark.triangle.fill: the triangle, its mark cut out. */
    val warningFill = icon("warnfill", 24f, 0f, filled = listOf("M10.3 3.6a2 2 0 0 1 3.4 0l8.3 14.4a2 2 0 0 1-1.7 3H3.7a2 2 0 0 1-1.7-3zM11 8.5h2l-0.3 6.2h-1.4zM12 16.3a1.15 1.15 0 1 1 0 2.3a1.15 1.15 0 0 1 0-2.3z"), evenOdd = true)
    /** questionmark.bubble.fill: the bubble, its mark cut out. */
    val questionFill = icon("qfill", 24f, 0f, filled = listOf("M6 3h12a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3h-5l-5 3.5V18H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3zM12 5.6c-1.9 0-3.2 1.2-3.3 2.9h1.8c0.1-0.8 0.6-1.3 1.5-1.3c0.8 0 1.4 0.5 1.4 1.2c0 0.6-0.3 0.9-1.1 1.4c-0.9 0.6-1.3 1.2-1.3 2.2v0.4h1.7v-0.3c0-0.6 0.2-0.9 1-1.4c0.9-0.6 1.5-1.3 1.5-2.4c0-1.6-1.3-2.7-3.2-2.7zM11.9 13.5a1.05 1.05 0 1 0 0 2.1a1.05 1.05 0 0 0 0-2.1z"), evenOdd = true)
    /** chevron.up.chevron.down, a menu picker's mark. */
    val upDown = icon("updown", 24f, 2.4f, "M8 9.5l4-4 4 4", "M8 14.5l4 4 4-4")
    val question = icon("question", 24f, 2.4f, "M9 9a3 3 0 1 1 4.5 2.6c-0.9 0.5-1.5 1.2-1.5 2.4", "M12 17.5h.01")
    val fingerprint = icon(
        "fingerprint", 24f, 1.8f,
        "M4.5 9.5a7.5 7.5 0 0 1 15 0v1.5", "M7 10a5 5 0 0 1 10 0v3.5", "M9.5 10.5a2.5 2.5 0 0 1 5 0v4.5", "M12 10.5v7", "M7 13.5v1.5a5 5 0 0 0 1.5 3.5", "M17 16.5a5 5 0 0 1-0.8 2",
    )
    val play = icon("play", 24f, 0f, filled = listOf("M7 4.5v15l12.5-7.5z"))
    val stop = icon("stop", 24f, 0f, filled = listOf("M7 6h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1z"))
    val speaker = icon("speaker", 24f, 1.8f, "M4 9v6h4l5 4V5L8 9z", "M16 9a4 4 0 0 1 0 6", "M18.5 6.5a7.5 7.5 0 0 1 0 11")
    /** text.bubble */
    val comment = icon("comment", 24f, 1.8f, "M6 4h12a2.5 2.5 0 0 1 2.5 2.5v8a2.5 2.5 0 0 1-2.5 2.5h-6.5L7 20.5V17H6a2.5 2.5 0 0 1-2.5-2.5v-8A2.5 2.5 0 0 1 6 4z", "M8 9h8M8 12.5h5.5")
    val check = icon("check", 24f, 2.4f, "M5 12.5l4.5 4.5L19 7.5")
    /** The ✓ SF draws in text: a light check. */
    val checkThin = icon("checkthin", 24f, 1.7f, "M4.5 12.5l5 5L19.5 6")
    val xmark = icon("x", 24f, 2.4f, "M6.5 6.5l11 11M17.5 6.5l-11 11")
    val photo = icon("photo", 24f, 1.8f, "M5 5h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z", "M3 16l5-5 4 4 3-3 6 6", "M15.5 9h.01")
    val branch = icon("branch", 24f, 2f, "M6 3v12", "M18 3a3 3 0 1 1 0 6 3 3 0 0 1 0-6z", "M6 15a3 3 0 1 1 0 6 3 3 0 0 1 0-6z", "M18 9a9 9 0 0 1-9 9")
    val bug = icon(
        "bug", 24f, 2f,
        "M12 8a3.5 3.5 0 0 1 3.5 3.5v3a3.5 3.5 0 0 1-7 0v-3A3.5 3.5 0 0 1 12 8z", "M9.5 5.5l1.2 2M14.5 5.5l-1.2 2", "M4.5 11h4M15.5 11h4", "M5 18l3.5-1.5M19 18l-3.5-1.5",
    )
    val handoff = icon("handoff", 24f, 1.8f, "M6.5 3h6a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z", "M12.5 12h9M18.5 9l3 3-3 3")
    val hand = icon(
        "hand", 24f, 1.8f,
        "M8 13V6.5a1.5 1.5 0 0 1 3 0V11", "M11 11V4.5a1.5 1.5 0 0 1 3 0V11", "M14 11V6a1.5 1.5 0 0 1 3 0v8a6 6 0 0 1-6 6h-0.5a6 6 0 0 1-5-2.7L3.8 14a1.5 1.5 0 0 1 2.5-1.7L8 14",
    )
    val pencil = icon("pencil", 24f, 1.8f, "M4 20h4L19 9l-4-4L4 16z", "M13 20h7")
    val desktop = icon("desktop", 24f, 1.8f, "M4 4h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z", "M8 20h8M12 16v4")
    val circle = icon("circle", 24f, 1.8f, "M12 3.5a8.5 8.5 0 1 1 0 17 8.5 8.5 0 0 1 0-17z")
    val checkCircle = icon("checkc", 24f, 1.8f, "M12 3.5a8.5 8.5 0 1 1 0 17 8.5 8.5 0 0 1 0-17z", "M8 12.5l2.8 2.8L16.5 9.5")
    val code = icon("code", 24f, 2f, "M8.5 7l-5 5 5 5M15.5 7l5 5-5 5M13.5 5l-3 14")
    val trash = icon("trash", 24f, 1.8f, "M4 7h16M10 7V4h4v3M6 7l1 13h10l1-13")
    val link = icon("link", 24f, 1.8f, "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1", "M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1")
    val bell = icon("bell", 24f, 1.8f, "M6 16V11a6 6 0 0 1 12 0v5l2 2H4z", "M10 20a2 2 0 0 0 4 0")
    val cloud = icon("cloud", 24f, 1.8f, "M7 18a4.5 4.5 0 0 1-0.6-9A6 6 0 0 1 18 9.5a4.3 4.3 0 0 1-0.5 8.5z")

    // The composer's own SVGs (askeden/web/chat/index.html), in their 16 × 16 box.
    val mic = icon("mic", 16f, 1.5f, "M8 1.8a2.4 2.4 0 0 1 2.4 2.4v3.2a2.4 2.4 0 0 1-4.8 0V4.2A2.4 2.4 0 0 1 8 1.8z", "M3.3 7.6a4.7 4.7 0 0 0 9.4 0M8 12.4v2")
    val talk = icon("talk", 16f, 1.6f, "M2.5 6.5v3M5 4.5v7M8 2.5v11M11 4.5v7M13.5 6.5v3")
    val send = icon("send", 16f, 0f, filled = listOf("M8 2.5l5 5-1.1 1.1L8.8 5.5V13.5H7.2V5.5L4.1 8.6 3 7.5z"))
    val steer = icon("steer", 16f, 1.7f, "M3 13c0-5 3-8 8-8", "M8 2l3 3-3 3")
    val composerPlus = icon("cplus", 16f, 1.7f, "M8 3v10M3 8h10")
    val chevD = icon("chev10", 10f, 1.6f, "M2.5 3.8L5 6.3l2.5-2.5")

    /** The Eden mark (the orb's mask: two polygons in a 43 81 410 422 box, stroked 18). */
    val edenMark: ImageVector = ImageVector.Builder("eden", 15.dp, 15.dp, 422f, 422f).apply {
        // viewBox 43 81 410 422, centred in a square 422 box.
        val dx = -43f + 6f
        val dy = -81f
        fun poly(points: List<Pair<Int, Int>>) = points.mapIndexed { i, (x, y) -> (if (i == 0) "M" else "L") + "${x + dx} ${y + dy}" }.joinToString(" ") + "Z"
        for (p in listOf(
            listOf(211 to 93, 314 to 90, 444 to 236, 343 to 353, 249 to 352, 333 to 251),
            listOf(252 to 235, 160 to 346, 282 to 491, 186 to 494, 52 to 350, 151 to 234),
        )) addPath(addPathNodes(poly(p)), fill = null, stroke = SolidColor(Color.Black), strokeLineWidth = 18f, strokeLineJoin = StrokeJoin.Round)
    }.build()
}

@Composable
fun Glyph(icon: ImageVector, size: Dp, color: Color, modifier: Modifier = Modifier, description: String? = null) {
    Image(icon, description, modifier.size(size), colorFilter = ColorFilter.tint(color))
}
