package com.askeden.edencode.ui

import android.content.pm.PackageManager
import android.os.Build
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import com.askeden.edencode.model.ApprovalChoice
import com.askeden.edencode.model.PhoneCard
import kotlinx.coroutines.launch

/** What the button says the phone checks first: the iPhone's "with Face ID" in Android's words. */
fun biometricWords(pm: PackageManager): String = when {
    pm.hasSystemFeature(PackageManager.FEATURE_FINGERPRINT) -> "fingerprint"
    Build.VERSION.SDK_INT >= 29 && pm.hasSystemFeature(PackageManager.FEATURE_FACE) -> "face unlock"
    else -> "screen lock"
}

/** Why a card asks, in a line (AskCard.why on the iPhone, the phone's own check in its words). */
fun askWhy(card: PhoneCard, with: String): String = when {
    card.macOnly -> "This one needs Touch ID on your Mac. You can say no here; to allow it, answer on your Mac."
    card.approval.isQuestion -> "Pick one, or reply in your own words."
    card.faceID -> "It runs this on your Mac. Your $with makes sure it’s you first."
    else -> "The session waits for your answer."
}

/** The no's words: "Not now" for an approval's plain deny, the Mac's own otherwise (a question's "Skip"). */
fun askNoLabel(card: PhoneCard): String {
    val no = card.noChoice
    if (card.approval.isQuestion) return no.label
    return if (no.id.lowercase() in setOf("deny", "no", "reject") || no.label.lowercase() in setOf("deny", "no")) "Not now" else no.label
}

/**
 * A card that waits on the owner, inside its session (G4, ApprovalSheet.swift's AskCard): a glass
 * card where the input bar was, with the question, why it asks, the command, Not now and Allow
 * (the fingerprint first for a command or an "always", as the Mac asks Touch ID), and a row of
 * links: a question's skip, Reply instead (the input bar comes back; what the owner writes goes
 * back as the card's no, with those words), Always… (the always-allow answers). A Mac-only card
 * takes only its no here. A Claude question shows its options.
 */
@Composable
fun AskCard(card: PhoneCard, backdrop: Backdrop?, modifier: Modifier = Modifier, onReplyInstead: (() -> Unit)? = null, onAnswered: () -> Unit = {}) {
    val store = LocalEnv.current.store
    val g = gInk
    val dark = Eden.dark
    val scope = rememberCoroutineScope()
    val pm = LocalContext.current.packageManager
    val with = remember { biometricWords(pm) }
    var working by remember { mutableStateOf(false) }
    var problem by remember { mutableStateOf<String?>(null) }
    var always by remember { mutableStateOf(false) }
    val standing = card.yesChoices.filter(card::isStanding)
    val yes = card.yesChoices.firstOrNull { !card.isStanding(it) }

    fun answer(choice: ApprovalChoice) {
        working = true
        problem = null
        scope.launch {
            val ok = store.answer(card, choice)
            working = false
            if (ok) {
                onAnswered()
                if (store.sheetCard?.id == card.id) store.sheetCard = null
            } else problem = if (card.needsBiometrics(choice))
                "Not allowed: your $with didn’t confirm it. A phone with no screen lock can’t allow this; answer on your Mac."
            else "Your Mac didn’t take that answer. The card may have gone."
        }
    }

    Column(
        modifier.fillMaxWidth()
            .gGlass(backdrop, 30.dp, tint = if (dark) hex(0x2C2C30, 0.62f) else hex(0xFFFFFF, 0.55f), shadowY = 16.dp, shadowBlur = 40.dp, shadowAlpha = 0.2f)
            .pressable(1f) {}
            .padding(16.dp)
            .semantics { contentDescription = "Eden Code asks" },
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        T(card.approval.question, sf(17f, Semibold), g.ink, Modifier.semantics { heading() })
        T(askWhy(card, with), sf(14f, lineHeight = 20.3f), g.grey2)
        if (card.approval.detail.isNotEmpty()) {
            SelectionContainer {
                T(
                    card.approval.detail.removePrefix("$ "), sf(12f, mono = true, extraTracking = -0.25f, lineHeight = 16f), g.steps,
                    Modifier.fillMaxWidth().gGlass(null, 12.dp, tint = if (dark) Color.Black.copy(alpha = 0.3f) else Color.White.copy(alpha = 0.6f), shadowAlpha = 0f)
                        .padding(horizontal = 12.dp, vertical = 10.dp).semantics { contentDescription = "Command: ${card.approval.detail}" },
                    maxLines = 6,
                )
            }
        }
        problem?.let { T(it, sf(13f), g.red) }
        if (card.approval.isQuestion && !card.macOnly) {
            for (choice in card.yesChoices) AskButton(choice.label, g.fill, g.ink, !working, Modifier.fillMaxWidth(), minHeight = 46.dp) { answer(choice) }
        } else {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                AskButton(askNoLabel(card), g.fill, g.ink, !working, Modifier.weight(1f)) { answer(card.noChoice) }
                if (card.macOnly) {
                    Row(Modifier.weight(1.3f).height(50.dp), horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.CenterHorizontally), verticalAlignment = Alignment.CenterVertically) {
                        Glyph(Glyphs.desktop, 15.dp, g.grey2)
                        T("Answer on your Mac", sf(14f, Semibold), g.grey2, maxLines = 1)
                    }
                } else if (yes != null) {
                    val bio = card.needsBiometrics(yes)
                    AskButton(yes.label, g.blue, Color.White, !working, Modifier.weight(1.3f), icon = if (bio) Glyphs.fingerprint else null,
                        label = if (bio) "${yes.label}, with your $with" else yes.label) { answer(yes) }
                }
            }
        }
        // The links: a question's skip, Reply instead, Always….
        val skip = card.approval.isQuestion && !card.macOnly
        val showAlways = standing.isNotEmpty() && !card.macOnly
        if (onReplyInstead != null || skip || showAlways) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(22.dp, Alignment.CenterHorizontally)) {
                if (skip) AskLink(askNoLabel(card), !working) { answer(card.noChoice) }
                if (onReplyInstead != null) AskLink("Reply instead", !working, onReplyInstead)
                if (showAlways) Box {
                    AskLink("Always…", !working) { always = true }
                    GlassMenu(always, { always = false }) {
                        for (choice in standing) GlassMenuItem(choice.label) { always = false; answer(choice) }
                    }
                }
            }
        }
    }
}

@Composable
private fun AskLink(text: String, enabled: Boolean, onClick: () -> Unit) {
    T(text, sf(15f), gInk.blue, Modifier.pressable(0.97f, enabled = enabled, label = text, onClick = onClick).padding(vertical = 2.dp), maxLines = 1)
}

/** Not now, Allow, a question's options: 50 tall, a capsule, 16 semibold. */
@Composable
private fun AskButton(text: String, fill: Color, ink: Color, enabled: Boolean, modifier: Modifier, icon: androidx.compose.ui.graphics.vector.ImageVector? = null, label: String = text, minHeight: androidx.compose.ui.unit.Dp = 50.dp, onClick: () -> Unit) {
    Row(
        modifier.defaultMinSize(minHeight = minHeight).background(fill, RoundedCornerShape(25.dp))
            .pressable(0.97f, enabled = enabled, label = label, onClick = onClick).padding(horizontal = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally), verticalAlignment = Alignment.CenterVertically,
    ) {
        if (icon != null) Glyph(icon, 18.dp, ink)
        AutoShrinkText(text, 16f, Semibold, ink, min = 0.8f)
    }
}
