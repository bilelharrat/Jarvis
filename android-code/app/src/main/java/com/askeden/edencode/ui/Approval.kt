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

/**
 * A card to answer (PhoneApprove mockup, ApprovalSheet.swift): a dark glass sheet with the risk
 * icon, the question and where it's from, the command, Deny and Allow (with the fingerprint for a
 * command or an "always", as the Mac asks Touch ID), and the always-allow link. A Mac-only card
 * takes only its no here. A Claude question shows its options. Always dark, as on the iPhone.
 */
@Composable
fun ApprovalSheet(card: PhoneCard) {
    val store = LocalEnv.current.store
    val scope = rememberCoroutineScope()
    val pm = LocalContext.current.packageManager
    val with = remember { biometricWords(pm) }
    var working by remember { mutableStateOf(false) }
    var instead by remember { mutableStateOf("") }
    var problem by remember { mutableStateOf<String?>(null) }
    val session = store.home.sessions.firstOrNull { it.id == card.taskID }
    val standing = card.yesChoices.filter(card::isStanding)
    val yes = card.yesChoices.firstOrNull { !card.isStanding(it) }

    fun answer(choice: ApprovalChoice, feedback: String? = null) {
        working = true
        scope.launch {
            val ok = store.answer(card, choice, feedback)
            working = false
            if (ok) store.sheetCard = null
            else if (!card.needsBiometrics(choice)) problem = "Your Mac didn’t take that answer. The card may have gone."
        }
    }

    val explanation = when {
        card.macOnly -> "This one needs Touch ID on your Mac. You can say no from here; to allow it, answer on your Mac."
        card.faceID -> "It runs on your Mac. Your $with makes sure it’s you before it does."
        card.approval.isQuestion -> "Pick one, or tell it what to do instead."
        else -> "Eden Code is waiting on your answer."
    }
    val shape = RoundedCornerShape(34.dp)
    val bottom = safeBottom()
    val screen = LocalEnv.current.screen
    EdenTheme(dark = true) {
        // The card rising over a dimmed screen, as the mockup draws it (ApprovalOverlay on the iPhone).
        Column(
            Modifier.padding(start = 10.dp, end = 10.dp, bottom = bottom + 8.dp).imePadding().fillMaxWidth()
                .boxShadow(Color.Black.copy(alpha = 0.5f), y = 30.dp, blur = 80.dp, radius = 34.dp)
                .glass(screen, shape, hex(0x262835, 0.9f), blur = 40.dp, saturate = 1.2f, fallbackTint = hex(0x282A38, 0.97f))
                .topRim(34.dp, Color.White.copy(alpha = 0.22f), Color.Transparent)
                .border(1.dp, Color.White.copy(alpha = 0.22f), shape)
                .pressable(1f) {}
                .padding(start = 20.dp, top = 12.dp, end = 20.dp, bottom = 20.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                Box(Modifier.size(40.dp, 5.dp).background(Color.White.copy(alpha = 0.3f), RoundedCornerShape(50)))
            }
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically, modifier = Modifier.semantics(mergeDescendants = true) {}) {
                Box(
                    Modifier.size(44.dp).background(if (card.approval.isQuestion) hex(0x0A84FF) else hex(0xFF9500), RoundedCornerShape(12.dp)),
                    contentAlignment = Alignment.Center,
                ) { Glyph(if (card.approval.isQuestion) Glyphs.question else Glyphs.warning, 22.dp, Color.White) }
                Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    T(card.approval.question, sf(17f, Semibold), Color.White)
                    T(listOfNotNull(session?.title, session?.project).joinToString(" · "), sf(13f), hex(0xC7C7CC), maxLines = 1)
                }
            }
            if (card.approval.detail.isNotEmpty()) {
                SelectionContainer {
                    T(
                        card.approval.detail.removePrefix("$ "), sf(13f, mono = true, lineHeight = 19.5f), hex(0xE5E5EA),
                        Modifier.fillMaxWidth().background(Color.Black.copy(alpha = 0.35f), RoundedCornerShape(16.dp)).padding(horizontal = 14.dp, vertical = 12.dp),
                        maxLines = 8,
                    )
                }
            }
            T(explanation, sf(13f, lineHeight = 19f), hex(0xD1D1D6))
            problem?.let { T(it, sf(13f), hex(0xFF6961)) }
            if (card.approval.isQuestion && !card.macOnly) {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    for (choice in card.yesChoices) {
                        Box(Modifier.fillMaxWidth().defaultMinSize(minHeight = 46.dp).background(Color.White, RoundedCornerShape(50)).pressable(0.97f, enabled = !working, label = choice.label) { answer(choice) }, contentAlignment = Alignment.Center) {
                            T(choice.label, sf(15f, Semibold), hex(0x1D1D1F), maxLines = 1)
                        }
                    }
                    Box(Modifier.fillMaxWidth().defaultMinSize(minHeight = 46.dp).background(Color.White.copy(alpha = 0.16f), RoundedCornerShape(50)).pressable(0.97f, enabled = !working, label = card.noChoice.label) { answer(card.noChoice, instead) }, contentAlignment = Alignment.Center) {
                        T(card.noChoice.label, sf(15f, Semibold), Color.White, maxLines = 1)
                    }
                }
            } else {
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Box(
                        Modifier.weight(1f).height(50.dp).background(Color.White.copy(alpha = 0.16f), RoundedCornerShape(50))
                            .border(1.dp, Color.White.copy(alpha = 0.24f), RoundedCornerShape(50))
                            .pressable(0.97f, enabled = !working, label = card.noChoice.label) { answer(card.noChoice, instead) },
                        contentAlignment = Alignment.Center,
                    ) { T(card.noChoice.label, sf(15f, Semibold), Color.White, maxLines = 1) }
                    if (card.macOnly) {
                        Row(Modifier.weight(1f).height(50.dp), horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.CenterHorizontally), verticalAlignment = Alignment.CenterVertically) {
                            Glyph(Glyphs.desktop, 15.dp, Color.White.copy(alpha = 0.7f))
                            T("Answer on your Mac", sf(14f, Semibold), Color.White.copy(alpha = 0.7f), maxLines = 1)
                        }
                    } else if (yes != null) {
                        val bio = card.needsBiometrics(yes)
                        Row(
                            Modifier.weight(1.4f).height(50.dp).background(Color.White, RoundedCornerShape(50))
                                .pressable(0.97f, enabled = !working, label = yes.label) { answer(yes) }.padding(horizontal = 12.dp),
                            horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally), verticalAlignment = Alignment.CenterVertically,
                        ) {
                            if (bio) Glyph(Glyphs.fingerprint, 18.dp, hex(0x1D1D1F))
                            AutoShrinkText(if (bio) "${yes.label} with $with" else yes.label, 15f, Semibold, hex(0x1D1D1F), min = 0.8f)
                        }
                    }
                }
            }
            if (!card.macOnly) {
                BasicTextField(
                    instead, { instead = it },
                    Modifier.fillMaxWidth().background(Color.White.copy(alpha = 0.08f), RoundedCornerShape(50)).padding(horizontal = 14.dp, vertical = 10.dp),
                    textStyle = sf(14f).copy(color = Color.White), singleLine = true, cursorBrush = SolidColor(hex(0x0A84FF)),
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                    keyboardActions = KeyboardActions(onSend = { answer(card.noChoice, instead) }),
                    decorationBox = { inner -> Box { if (instead.isEmpty()) T("Or tell it what to do instead", sf(14f), Color.White.copy(alpha = 0.45f), maxLines = 1); inner() } },
                )
            }
            for (choice in standing) {
                Box(Modifier.fillMaxWidth().pressable(0.98f, enabled = !working && !card.macOnly, label = choice.label) { answer(choice) }, contentAlignment = Alignment.Center) {
                    T(choice.label, sf(14f), hex(0x8FC7FF), maxLines = 1)
                }
            }
        }
    }
}
