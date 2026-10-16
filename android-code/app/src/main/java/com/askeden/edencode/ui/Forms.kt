package com.askeden.edencode.ui

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.combinedClickable
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.DpOffset
import androidx.compose.ui.unit.dp

// iOS's grouped Form, sheet and controls, drawn the way the iPhone app shows them (Settings, New
// session, the pairing sheet): no Material look anywhere the iPhone has none.

/** iOS's secondarySystemGroupedBackground: a Form's rows. */
@Composable
fun formRowFill(): Color = if (Eden.dark) hex(0x1C1C1E, 0.92f) else hex(0xFFFFFF, 0.85f)

/** iOS's secondary label (a row's value). */
@Composable
fun secondaryLabel(): Color = if (Eden.dark) hex(0xEBEBF5, 0.6f) else hex(0x3C3C43, 0.6f)

/** iOS's placeholder (tertiary label). */
@Composable
fun placeholderInk(): Color = if (Eden.dark) hex(0xEBEBF5, 0.3f) else hex(0x3C3C43, 0.3f)

/** A large title ("Settings"), as a navigation bar shows it. */
@Composable
fun LargeTitle(text: String, modifier: Modifier = Modifier) {
    T(text, sf(34f, Bold, extraTracking = -0.68f - sfTracking(34f), lineHeight = 41f), Eden.colors.ink, modifier, maxLines = 1)
}

/** iOS 26's grouped section: a semibold header in sentence case, 26-cornered rows, a footnote. */
@Composable
fun FormSection(header: String? = null, footer: String? = null, content: @Composable ColumnScope.() -> Unit) {
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp)) {
        if (header != null) T(header, sf(17f, Semibold), secondaryLabel(), Modifier.padding(start = 16.dp, bottom = 9.dp))
        Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(26.dp)).background(formRowFill()), content = content)
        if (footer != null) T(footer, sf(13f, lineHeight = 17f), secondaryLabel(), Modifier.padding(start = 16.dp, end = 16.dp, top = 7.dp))
    }
    Spacer(Modifier.height(if (footer != null) 20.dp else 30.dp))
}

@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
fun FormRow(
    onClick: (() -> Unit)? = null,
    divider: Boolean = true,
    dividerStart: androidx.compose.ui.unit.Dp = 16.dp,
    onLongClick: (() -> Unit)? = null,
    content: @Composable RowScope.() -> Unit,
) {
    Column {
        Row(
            Modifier.fillMaxWidth().defaultMinSize(minHeight = 50.dp)
                .then(
                    if (onClick != null || onLongClick != null) Modifier.combinedClickable(onClick = onClick ?: {}, onLongClick = onLongClick)
                    else Modifier,
                )
                .padding(horizontal = 16.dp, vertical = 11.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            content = content,
        )
        if (divider) RowDivider(dividerStart)
    }
}

@Composable
fun FormValueRow(label: String, value: String, divider: Boolean = true) {
    FormRow(divider = divider) {
        T(label, sf(17f), Eden.colors.ink, Modifier.weight(1f), maxLines = 1)
        T(value, sf(17f), secondaryLabel(), maxLines = 1)
    }
}

/** iOS's switch: 63 × 28 in iOS 26's look, green when on. */
@Composable
fun IosSwitch(on: Boolean, label: String, onChange: (Boolean) -> Unit) {
    val track by animateColorAsState(if (on) Eden.colors.accent else if (Eden.dark) hex(0x787880, 0.32f) else hex(0x787880, 0.16f), tween(180), label = "track")
    val x by animateDpAsState(if (on) 24.dp else 2.dp, tween(180), label = "knob")
    Box(
        Modifier.size(63.dp, 28.dp).clip(RoundedCornerShape(50)).background(track)
            .clickable(remember { MutableInteractionSource() }, null) { onChange(!on) }
            .semantics { role = Role.Switch; stateDescription = if (on) "On" else "Off" },
    ) {
        Box(
            Modifier.offset(x = x, y = 2.dp).size(37.dp, 24.dp)
                .boxShadow(Color.Black.copy(alpha = 0.15f), y = 3.dp, blur = 8.dp, radius = 12.dp)
                .background(Color.White, RoundedCornerShape(50)),
        )
    }
}

@Composable
fun FormToggle(label: String, on: Boolean, divider: Boolean = true, onChange: (Boolean) -> Unit) {
    FormRow(divider = divider) {
        T(label, sf(17f), Eden.colors.ink, Modifier.weight(1f))
        IosSwitch(on, label, onChange)
    }
}

/** A Picker row: the label, the value and ⌃⌄, a menu of the choices. */
@Composable
fun <T> FormPicker(
    label: String,
    choices: List<T>,
    selected: T?,
    name: (T) -> String,
    enabled: (T) -> Boolean = { true },
    divider: Boolean = true,
    navigation: Boolean = false,
    onPick: (T) -> Unit,
) {
    var open by remember { mutableStateOf(false) }
    Box {
        FormRow(onClick = { open = true }, divider = divider) {
            T(label, sf(17f), Eden.colors.ink, Modifier.weight(1f), maxLines = 1)
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                T(selected?.let(name) ?: "", sf(17f), secondaryLabel(), Modifier.widthIn(max = 220.dp), maxLines = 1)
                if (navigation) Glyph(Glyphs.chevronRight, 13.dp, secondaryLabel()) else Glyph(Glyphs.upDown, 14.dp, secondaryLabel())
            }
        }
        GlassMenu(open, { open = false }, Modifier.align(Alignment.TopEnd)) {
            for (choice in choices) {
                GlassMenuItem(name(choice), checked = choice == selected, enabled = enabled(choice)) {
                    open = false
                    onPick(choice)
                }
            }
        }
    }
}

/** iOS 26's menu: a rounded glass popover with 17 pt rows and a checkmark on the current one. */
@Composable
fun GlassMenu(open: Boolean, onDismiss: () -> Unit, modifier: Modifier = Modifier, offset: DpOffset = DpOffset(0.dp, 4.dp), content: @Composable ColumnScope.() -> Unit) {
    Box(modifier) {
        DropdownMenu(
            expanded = open, onDismissRequest = onDismiss, offset = offset,
            shape = RoundedCornerShape(22.dp),
            containerColor = if (Eden.dark) hex(0x2C2C30, 0.97f) else hex(0xF7F7FA, 0.98f),
            tonalElevation = 0.dp, shadowElevation = 12.dp,
            content = content,
        )
    }
}

@Composable
fun GlassMenuItem(text: String, checked: Boolean = false, enabled: Boolean = true, footnote: Boolean = false, onClick: () -> Unit) {
    val c = Eden.colors
    DropdownMenuItem(
        text = { T(text, sf(if (footnote) 13f else 17f), if (footnote) c.muted else if (enabled) c.ink else c.muted, maxLines = 2) },
        leadingIcon = if (footnote) null else ({ Box(Modifier.width(18.dp)) { if (checked) Glyph(Glyphs.check, 15.dp, c.ink) } }),
        onClick = onClick, enabled = enabled && !footnote,
    )
}

/** iOS 26's .glass / .glassProminent buttons: a capsule of glass, or of the accent. */
@Composable
fun GlassButton(text: String, prominent: Boolean, modifier: Modifier = Modifier, enabled: Boolean = true, height: androidx.compose.ui.unit.Dp = 36.dp, style: TextStyle = sf(15f, Semibold), tinted: Boolean = false, onClick: () -> Unit) {
    val c = Eden.colors
    val shape = RoundedCornerShape(50)
    // tinted: a plain .glass button that takes the app's blue tint on iOS (Queue's Open): blue
    // words, and in dark a faint blue cast to the glass.
    // Disabled, a prominent button is plain glass with grey words, as iOS 26 draws it.
    val bright = prominent && enabled
    Box(
        modifier
            .height(height)
            .then(
                if (bright) Modifier.background(c.accent, shape)
                else Modifier.background(if (Eden.dark) (if (tinted) c.accent.copy(alpha = 0.16f) else hex(0xFFFFFF, 0.12f)) else hex(0xFFFFFF, 0.62f), shape).border(1.dp, c.cardRim, shape),
            )
            .pressable(0.96f, enabled = enabled, label = text, dim = !prominent, onClick = onClick)
            .padding(horizontal = 16.dp),
        contentAlignment = Alignment.Center,
    ) { T(text, style, if (bright) Color.White else if (!enabled) placeholderInk() else if (tinted) c.accent else c.ink, maxLines = 1) }
}

/** The segmented control (Turn | Session): a capsule track with a white thumb. */
@Composable
fun Segmented(options: List<Pair<String, String>>, selected: String, modifier: Modifier = Modifier, onPick: (String) -> Unit) {
    val c = Eden.colors
    Row(
        modifier.height(32.dp).background(if (Eden.dark) hex(0x767680, 0.24f) else hex(0x767680, 0.12f), RoundedCornerShape(50)).padding(2.dp),
    ) {
        for ((id, label) in options) {
            val on = id == selected
            Box(
                Modifier.weight(1f).fillMaxHeight()
                    .then(if (on) Modifier.boxShadow(Color.Black.copy(alpha = 0.12f), y = 3.dp, blur = 8.dp, radius = 999.dp)
                        .background(if (Eden.dark) hex(0x636366) else Color.White, RoundedCornerShape(50)) else Modifier)
                    .clickable(remember { MutableInteractionSource() }, null) { onPick(id) }
                    .semantics { role = Role.Tab; this.selected = on },
                contentAlignment = Alignment.Center,
            ) { T(label, sf(13f, if (on) Semibold else Medium), c.ink, maxLines = 1) }
        }
    }
}

/** A text field on the light fill (pairing, the comment sheet). */
@Composable
fun FilledField(
    value: String,
    onChange: (String) -> Unit,
    placeholder: String,
    modifier: Modifier = Modifier,
    style: TextStyle = sf(16f),
    radius: androidx.compose.ui.unit.Dp = 12.dp,
    minLines: Int = 1,
    maxLines: Int = 1,
    keyboard: KeyboardOptions = KeyboardOptions.Default,
    fill: Color = Eden.colors.fill,
    ink: Color = Eden.colors.ink,
    hint: Color = placeholderInk(),
) {
    BasicTextField(
        value, onChange, modifier.fillMaxWidth().background(fill, RoundedCornerShape(radius)).padding(12.dp),
        textStyle = style.copy(color = ink), minLines = minLines, maxLines = maxLines, singleLine = maxLines == 1,
        keyboardOptions = keyboard, cursorBrush = SolidColor(Eden.colors.accent),
        decorationBox = { inner ->
            Box {
                if (value.isEmpty()) T(placeholder, style, hint, maxLines = maxLines, align = style.textAlign)
                inner()
            }
        },
    )
}

/**
 * An iOS sheet at its large detent: rounded at the top, over a dimmed screen, the Eden lights in
 * it, a navigation bar with Cancel, the title and an action.
 */
@Composable
fun FormSheet(
    title: String,
    onCancel: () -> Unit,
    action: String? = null,
    actionEnabled: Boolean = true,
    busy: Boolean = false,
    onAction: () -> Unit = {},
    content: @Composable ColumnScope.() -> Unit,
) {
    val top = safeTop()
    val shape = RoundedCornerShape(topStart = 38.dp, topEnd = 38.dp)
    Box(
        Modifier.fillMaxSize().padding(top = top + 1.dp).clip(shape)
            .clickable(remember { MutableInteractionSource() }, null) {}
            .imePadding(),
    ) {
        EdenBackground()
        Column(Modifier.fillMaxSize()) {
            Box(Modifier.fillMaxWidth().height(76.dp).padding(horizontal = 16.dp)) {
                GlassButton("Cancel", false, Modifier.align(Alignment.CenterStart), height = 44.dp, style = sf(17f), onClick = onCancel)
                T(title, sf(17f, Semibold), Eden.colors.ink, Modifier.align(Alignment.Center), maxLines = 1)
                if (action != null) {
                    if (busy) {
                        androidx.compose.material3.CircularProgressIndicator(Modifier.align(Alignment.CenterEnd).size(22.dp), color = Eden.colors.accent, strokeWidth = 2.dp)
                    } else {
                        GlassButton(action, true, Modifier.align(Alignment.CenterEnd), enabled = actionEnabled, height = 44.dp, style = sf(17f, Semibold), onClick = onAction)
                    }
                }
            }
            Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(top = 4.dp, bottom = 40.dp), content = content)
        }
    }
}

/** A small bottom sheet at a fixed height (the comment sheet's 260 pt detent). */
@Composable
fun SmallSheet(height: androidx.compose.ui.unit.Dp, content: @Composable ColumnScope.() -> Unit) {
    val shape = RoundedCornerShape(topStart = 38.dp, topEnd = 38.dp)
    Column(
        Modifier.fillMaxWidth().heightIn(min = height).clip(shape)
            .background(if (Eden.dark) hex(0x1C1C1E) else hex(0xF2F2F7))
            .clickable(remember { MutableInteractionSource() }, null) {}
            .imePadding()
            .padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
        content = content,
    )
}

@Composable
fun Spinner(color: Color = Eden.colors.accent, size: androidx.compose.ui.unit.Dp = 18.dp) {
    androidx.compose.material3.CircularProgressIndicator(Modifier.size(size), color = color, strokeWidth = 2.dp)
}

@Composable
fun NumberBadge(n: Int) {
    Box(Modifier.size(22.dp).background(Eden.colors.accent, CircleShape), contentAlignment = Alignment.Center) {
        T("$n", sf(13f, Bold, lineHeight = 15f), Color.White, maxLines = 1)
    }
}
