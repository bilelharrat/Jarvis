package com.askeden.edencode.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.PlatformTextStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.LineHeightStyle
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.sp
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.statusBars
import com.askeden.edencode.model.CodeStatus

/** A hex colour, with alpha. */
fun hex(rgb: Long, alpha: Float = 1f): Color = Color((rgb and 0xFFFFFF).toInt() or (0xFF shl 24)).copy(alpha = alpha)

/**
 * Eden Code's look (the iPhone app's EdenTheme, from the owner's approved mockups, 2026-10-16):
 * Apple's system colours over a soft blue, violet and teal light, every surface glass; light and
 * dark follow the phone.
 */
class EdenColors(val dark: Boolean) {
    private fun c(light: Long, dark: Long, la: Float = 1f, da: Float = 1f) = if (this.dark) hex(dark, da) else hex(light, la)

    val accent = c(0x007AFF, 0x0A84FF)
    val orange = c(0xFF9500, 0xFF9F0A)
    val green = c(0x34C759, 0x30D158)
    val red = c(0xFF3B30, 0xFF453A)
    val ink = c(0x1D1D1F, 0xF5F5F7)
    val ink2 = c(0x3A3A3C, 0xD1D1D6)
    val muted = c(0x6E6E73, 0xAEAEB2)
    val chevron = c(0x8E8E93, 0x8E8E93)
    val checkGreen = c(0x248A3D, 0x30D158)
    val needsInk = c(0xA35200, 0xFFB340)
    val failInk = c(0xC4271C, 0xFF6961)
    val fill = c(0x787880, 0x787880, 0.14f, 0.24f)
    val card = c(0xFFFFFF, 0x2C2C30, 0.78f, 0.62f)
    val cardRim = c(0xFFFFFF, 0xFFFFFF, 0.85f, 0.16f)
    val divider = c(0x000000, 0xFFFFFF, 0.06f, 0.08f)
    /** SwiftUI's Divider (the system separator), which the iPhone app overlays with [divider]. */
    val separator = c(0x3C3C43, 0x545458, 0.33f, 0.62f)
    val addedBG = c(0xE6F6EA, 0x1E3A26)
    val addedInk = c(0x1B5E2C, 0x8FE3A4)
    val removedBG = c(0xFDECEC, 0x45201F)
    val removedInk = c(0x9B1C1C, 0xFFA6A0)
    val onInk = c(0xFFFFFF, 0x1D1D1F)
    val lowRisk = c(0x1B5E2C, 0x30D158)

    fun dot(status: CodeStatus): Color = when (status) {
        CodeStatus.Working -> accent
        CodeStatus.NeedsYou -> orange
        CodeStatus.Done -> green
        CodeStatus.Failed -> red
        else -> chevron
    }

    fun subtitleInk(status: CodeStatus): Color = when (status) {
        CodeStatus.NeedsYou -> needsInk
        CodeStatus.Failed -> failInk
        else -> muted
    }
}

/** Eden chat's colour tokens for the composer (askeden/web/chat/app.css :root and [data-theme=dark]). */
class ComposerInk(dark: Boolean) {
    val accent = if (dark) hex(0x2696EA) else hex(0x0B87D6)
    val accentInk = if (dark) hex(0x70BEF8) else hex(0x0468AE)
    val glow = if (dark) hex(0x40B0F0) else hex(0x38A8E8)
    val ink = if (dark) hex(0xF5F5F7) else hex(0x1D1D1F)
    val ink2 = if (dark) hex(0xB2B2B8) else hex(0x58585E)
    val subtle = if (dark) hex(0x66666C) else hex(0xA2A2A8)
    val surface = if (dark) hex(0x1C1C1F) else hex(0xFFFFFF)
}

val LocalEden = staticCompositionLocalOf { EdenColors(false) }

object Eden {
    val colors: EdenColors
        @Composable @ReadOnlyComposable get() = LocalEden.current
    val dark: Boolean
        @Composable @ReadOnlyComposable get() = LocalEden.current.dark
}

@Composable
fun EdenTheme(dark: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    CompositionLocalProvider(LocalEden provides EdenColors(dark), content = content)
}

/**
 * SF Pro's default tracking at each size, in points (Apple's Human Interface Guidelines table; 20 pt
 * and up is SF Pro Display). Android has no SF: the system sans (Roboto, or the phone maker's) is
 * drawn at the iPhone's sizes and weights with this tracking, which is the closest it can come.
 */
fun sfTracking(size: Float): Float = when {
    size <= 11f -> 0.06f
    size <= 12f -> 0f
    size <= 13f -> -0.08f
    size <= 14f -> -0.15f
    size <= 15f -> -0.23f
    size <= 16f -> -0.31f
    size <= 17f -> -0.43f
    size <= 19f -> -0.45f
    size <= 22f -> 0.35f
    size <= 28f -> 0.38f
    else -> 0.37f
}

/** SwiftUI's line height for `.system(size:)` text: SF Pro's ascender plus descender, 1.193 × the size. */
fun sfLineHeight(size: Float): Float = size * 1.193f

/**
 * Roboto isn't SF: at text sizes it's narrower than SF Pro Text, at display sizes wider than SF
 * Pro Display. Measured against the iPhone app's screenshots at the same point sizes, this much
 * tracking more (or less) makes a line take the width it takes on the iPhone.
 */
fun robotoCorrection(size: Float, weight: FontWeight): Float = when {
    size >= 30f -> 0.25f
    size >= 20f -> -0.28f
    weight.weight >= 500 -> when {
        size >= 15f -> 0.63f
        size >= 13f -> 0.42f
        else -> 0.3f
    }
    size >= 15f -> 0.45f
    size >= 13f -> 0.28f
    else -> 0.1f
}

/**
 * `.font(.system(size:weight:))`: the size, weight and tracking (plus any `.tracking(x)`) of the
 * iPhone app, with Android's font padding off so text sits where SwiftUI puts it.
 */
fun sf(size: Float, weight: FontWeight = FontWeight.Normal, extraTracking: Float = 0f, lineHeight: Float? = null, mono: Boolean = false): TextStyle =
    TextStyle(
        fontSize = size.sp,
        fontWeight = weight,
        fontFamily = if (mono) FontFamily.Monospace else FontFamily.SansSerif,
        letterSpacing = (if (mono) extraTracking else sfTracking(size) + robotoCorrection(size, weight) + extraTracking).sp,
        lineHeight = (lineHeight ?: sfLineHeight(size)).sp,
        platformStyle = PlatformTextStyle(includeFontPadding = false),
        lineHeightStyle = LineHeightStyle(LineHeightStyle.Alignment.Center, LineHeightStyle.Trim.None),
    )

val Semibold = FontWeight.SemiBold
val Medium = FontWeight.Medium
val Bold = FontWeight.Bold

fun Float.toSp(): TextUnit = this.sp

/**
 * The iPhone's safe area (iPhone 17: 62 at the top, 34 at the bottom), or Android's own bars when
 * they're taller, so every screen sits where it sits on the iPhone.
 */
@Composable
fun safeTop(): Dp = maxOf(WindowInsets.statusBars.asPaddingValues().calculateTopPadding(), 62.dp)

@Composable
fun safeBottom(): Dp = maxOf(WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding(), 34.dp)
