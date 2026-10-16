package com.askeden.edencode.ui

import android.graphics.BlurMaskFilter
import android.os.Build
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.composed
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.RoundRect
import androidx.compose.ui.graphics.BlurEffect
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.ColorMatrix
import androidx.compose.ui.graphics.Outline
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.TileMode
import androidx.compose.ui.graphics.drawOutline
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.clipPath
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.layer.GraphicsLayer
import androidx.compose.ui.graphics.layer.drawLayer
import androidx.compose.ui.graphics.rememberGraphicsLayer
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

// Liquid Glass on Android. iOS blurs whatever is behind a surface; Compose can only blur what it
// draws itself, so a screen's content is recorded into a GraphicsLayer (a Backdrop) and each glass
// surface draws that recording again, offset to where the surface sits, through a RenderEffect
// blur and a saturation boost (API 31+), clipped to its shape, under its tint and rim. Below API 31
// there's no RenderEffect: the surface is the same tint made more opaque instead.

val blurSupported: Boolean get() = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S

/** What glass surfaces see through them: one recording of a screen's content, and where it sits. */
@Stable
class Backdrop(val layer: GraphicsLayer) {
    var origin by mutableStateOf(Offset.Zero)
}

@Composable
fun rememberBackdrop(): Backdrop {
    val layer = rememberGraphicsLayer()
    return remember(layer) { Backdrop(layer) }
}

/** Records this content as the backdrop that glass drawn over it shows, blurred. */
fun Modifier.backdropSource(backdrop: Backdrop): Modifier = this
    .onGloballyPositioned { backdrop.origin = it.positionInRoot() }
    .drawWithContent {
        backdrop.layer.record { this@drawWithContent.drawContent() }
        drawLayer(backdrop.layer)
    }

private fun saturation(amount: Float) = ColorFilter.colorMatrix(ColorMatrix().apply { setToSaturation(amount) })

/**
 * A glass surface: the backdrop blurred by [blur] (CSS `blur()`, so a Gaussian of half that) and
 * saturated, then [tint] over it, in [shape]. [fallbackTint] is what shows without blur.
 */
fun Modifier.glass(
    backdrop: Backdrop?,
    shape: Shape,
    tint: Color,
    blur: Dp = 30.dp,
    saturate: Float = 1.8f,
    fallbackTint: Color = tint.copy(alpha = (tint.alpha + 0.22f).coerceAtMost(0.96f)),
): Modifier = composed {
    var where by remember { mutableStateOf(Offset.Zero) }
    this
        .onGloballyPositioned { where = it.positionInRoot() }
        .drawWithCache {
            val outline = shape.createOutline(size, layoutDirection, this)
            val child = if (backdrop != null && blurSupported) obtainGraphicsLayer() else null
            child?.apply {
                val sigma = blur.toPx() / 2f
                renderEffect = BlurEffect(sigma, sigma, TileMode.Clamp)
                colorFilter = saturation(saturate)
            }
            onDrawBehind {
                if (child != null && backdrop != null) {
                    val shift = where - backdrop.origin
                    child.record(size = backdrop.layer.size) {
                        translate(-shift.x, -shift.y) { drawLayer(backdrop.layer) }
                    }
                    clipPath(outline.path()) { drawLayer(child) }
                    drawOutline(outline, tint)
                } else {
                    drawOutline(outline, fallbackTint)
                }
            }
        }
}

private fun Outline.path(): Path = when (this) {
    is Outline.Generic -> path
    is Outline.Rectangle -> Path().apply { addRect(rect) }
    is Outline.Rounded -> Path().apply { addRoundRect(roundRect) }
}

/**
 * A CSS `box-shadow: x y blur spread color` (or SwiftUI `.shadow(radius:)`, whose radius is half a
 * CSS blur) drawn behind a rounded shape. Hardware shadows on API 28+; nothing on 26–27.
 */
fun Modifier.boxShadow(color: Color, y: Dp, blur: Dp, radius: Dp, spread: Dp = 0.dp, x: Dp = 0.dp): Modifier = drawBehind {
    if (color.alpha == 0f) return@drawBehind
    val b = blur.toPx()
    val s = spread.toPx()
    val r = radius.toPx() + s
    // Like CSS, the shadow shows only outside the box (a glass card stays clear), and the shape that
    // casts it is drawn far off to the side so only its shadow lands here.
    val far = 20000f
    val sigma = b / 2f
    val shadowRadius = if (sigma <= 0.5f) 0.01f else (sigma - 0.5f) / 0.57735f
    drawIntoCanvas { canvas ->
        val native = canvas.nativeCanvas
        val paint = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply {
            this.color = android.graphics.Color.BLACK
            setShadowLayer(shadowRadius, far + x.toPx(), y.toPx(), color.toArgb())
        }
        native.save()
        val own = android.graphics.Path().apply {
            addRoundRect(0f, 0f, size.width, size.height, radius.toPx(), radius.toPx(), android.graphics.Path.Direction.CW)
        }
        native.clipOutPathCompat(own)
        native.drawRoundRect(-s - far, -s, size.width + s - far, size.height + s, r, r, paint)
        native.restore()
    }
}

@Suppress("DEPRECATION")
private fun android.graphics.Canvas.clipOutPathCompat(path: android.graphics.Path) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) clipOutPath(path) else clipPath(path, android.graphics.Region.Op.DIFFERENCE)
}

/**
 * The soft coloured wallpaper behind every screen (the G mockups' background): blue top left,
 * violet right, teal low left, peach bottom right, over a pale blue-grey. Each light is a CSS
 * `radial-gradient(circle at x y, colour 0, transparent p%)`, whose p is of the distance to the
 * farthest corner, drawn the same way here. Dark keeps the same lights, deeper.
 */
@Composable
fun EdenBackground(modifier: Modifier = Modifier) {
    val dark = Eden.dark
    Canvas(modifier.fillMaxSize()) {
        drawRect(hex(if (dark) 0x141A2E else 0xE4EAF6))
        fun glow(rgb: Long, fx: Float, fy: Float, stop: Float) {
            val at = Offset(size.width * fx, size.height * fy)
            val far = maxOf(at.x, size.width - at.x).let { w -> maxOf(at.y, size.height - at.y).let { h -> kotlin.math.sqrt(w * w + h * h) } }
            val radius = far * stop
            drawRect(Brush.radialGradient(listOf(hex(rgb), hex(rgb, 0f)), center = at, radius = radius))
        }
        glow(if (dark) 0x3C5BD8 else 0x8EC2FF, 0.12f, 0.08f, 0.45f)
        glow(if (dark) 0x8A3FD1 else 0xCDB2FF, 0.92f, 0.38f, 0.42f)
        glow(if (dark) 0x138A8A else 0x8BE6D4, 0.25f, 0.78f, 0.45f)
        glow(if (dark) 0x7A3C55 else 0xFFC9A8, 0.85f, 0.95f, 0.40f)
    }
}

/**
 * The G design's Liquid Glass (every floating control, bubble and panel): the backdrop blurred
 * 24 and saturated 1.9×, white at 42% over it (or [tint]), a bright top edge and a faint white
 * ring inside, and a soft blue-grey shadow (`0 6 18 rgba(40,60,120,.10)`). In dark the glass is a
 * deep grey and the edges dimmer. [backdrop] null (or no RenderEffect) draws the tint more opaque.
 */
@Composable
fun Modifier.gGlass(
    backdrop: Backdrop?,
    radius: Dp,
    tint: Color? = null,
    shadowY: Dp = 6.dp,
    shadowBlur: Dp = 18.dp,
    shadowAlpha: Float = 0.10f,
    blur: Dp = 24.dp,
    saturate: Float = 1.9f,
): Modifier {
    val dark = Eden.dark
    val shape = RoundedCornerShape(radius)
    val fill = tint ?: if (dark) hex(0x2C2C30, 0.5f) else hex(0xFFFFFF, 0.42f)
    return this
        .boxShadow(if (dark) Color.Black.copy(alpha = shadowAlpha * 3.5f) else hex(0x283C78, shadowAlpha), y = shadowY, blur = shadowBlur, radius = radius)
        .glass(backdrop, shape, fill, blur = blur, saturate = saturate)
        .border(1.dp, if (dark) Color.White.copy(alpha = 0.14f) else Color.White.copy(alpha = 0.55f), shape)
        .topRim(radius, if (dark) Color.White.copy(alpha = 0.28f) else Color.White.copy(alpha = 0.95f), Color.Transparent)
}

/** The mockups' white glass card (18–20 corners, a bright 1 pt rim), over the screen's lights. */
@Composable
fun Modifier.edenCard(backdrop: Backdrop? = LocalBackground.current, radius: Dp = 18.dp, tint: Color? = null, saturate: Float = 1.8f): Modifier {
    val c = Eden.colors
    val shape = RoundedCornerShape(radius)
    return this
        .glass(backdrop, shape, tint ?: c.card, blur = 30.dp, saturate = saturate, fallbackTint = tint ?: c.card)
        .border(1.dp, c.cardRim, shape)
}

/** The background's own recording: what cards inside a scrolling list see through them. */
val LocalBackground = androidx.compose.runtime.staticCompositionLocalOf<Backdrop?> { null }

/** SwiftUI's PressScale: shrinks while pressed (no ripple: the iPhone has none). */
fun Modifier.pressable(scale: Float = 0.94f, enabled: Boolean = true, label: String? = null, dim: Boolean = true, onClick: () -> Unit): Modifier = composed {
    val source = remember { MutableInteractionSource() }
    val pressed by source.collectIsPressedAsState()
    val s by animateFloatAsState(if (pressed && enabled) scale else 1f, tween(120), label = "press")
    this
        .graphicsLayer { scaleX = s; scaleY = s; alpha = if (enabled || !dim) 1f else 0.45f }
        .clickable(interactionSource = source, indication = null, enabled = enabled, onClickLabel = label, onClick = onClick)
}

/** A hairline rim inside a rounded shape with a brighter top line (Eden chat's --clear-rim). */
fun Modifier.topRim(radius: Dp, top: Color, hairline: Color): Modifier = drawWithContent {
    drawContent()
    val r = radius.toPx()
    val inset = 0.25.dp.toPx()
    drawRoundRect(hairline, topLeft = Offset(inset, inset), size = androidx.compose.ui.geometry.Size(size.width - 2 * inset, size.height - 2 * inset),
        cornerRadius = CornerRadius(r), style = Stroke(0.5.dp.toPx()))
    val lineH = 1.dp.toPx()
    clipPath(Path().apply { addRoundRect(RoundRect(Rect(0f, 0f, size.width, size.height), CornerRadius(r))) }) {
        drawRect(Brush.verticalGradient(0f to top, 1f to top.copy(alpha = 0f), startY = 0f, endY = lineH * 1.6f),
            size = androidx.compose.ui.geometry.Size(size.width, lineH * 1.6f))
    }
}

/** A small glass control (the Mac picker, a back button): white glass, or in dark a deep grey one. */
@Composable
fun Modifier.glassControl(radius: Dp): Modifier =
    if (Eden.dark) edenCard(radius = radius, tint = hex(0x26262C, 0.6f), saturate = 1.1f) else edenCard(radius = radius, tint = hex(0xFFFFFF, 0.6f))

@Composable
fun Fill(modifier: Modifier = Modifier, color: Color) = Box(modifier.background(color))
