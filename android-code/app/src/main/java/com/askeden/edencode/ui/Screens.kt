package com.askeden.edencode.ui

import android.os.Build
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import com.askeden.edencode.BuildConfig
import com.askeden.edencode.model.CodeModes
import com.askeden.edencode.model.Money
import com.askeden.edencode.model.PhoneOptions
import com.askeden.edencode.net.CertificatePin
import com.askeden.edencode.net.MacError
import com.askeden.edencode.net.PairingLink
import com.askeden.edencode.net.Pairing
import com.askeden.edencode.store.MacStore
import com.askeden.edencode.store.io
import kotlinx.coroutines.launch
import kotlin.math.roundToInt

/** Settings (SettingsView.swift): the Macs, how away-from-home works, spoken replies, the ongoing notification, usage. */
@Composable
fun SettingsScreen() {
    val store = LocalEnv.current.store
    val c = Eden.colors
    var removing by remember { mutableStateOf<Pairing?>(null) }
    LaunchedEffect(Unit) { store.refreshUsage() }
    val top = safeTop()
    val bottom = safeBottom()
    Box(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(bottom = bottom + 40.dp)) {
            LargeTitle("Settings", Modifier.padding(start = 16.dp, top = 0.dp, bottom = 16.dp))
            FormSection(
                header = "Macs",
                footer = "Away from home, Eden Code reaches your Mac through Eden’s encrypted relay when this phone is signed in to your Eden account, or over Tailscale.",
            ) {
                for (mac in store.macs) {
                    // Unpairing is a long press (the iPhone's swipe), with its confirmation.
                    FormRow(onClick = { store.select(mac) }, onLongClick = { removing = mac }, dividerStart = 48.dp) {
                        Glyph(Glyphs.desktop, 21.dp, c.accent)
                        Column(
                            Modifier.weight(1f).padding(vertical = 3.dp).semantics {
                                customActions = listOf(androidx.compose.ui.semantics.CustomAccessibilityAction("Unpair") { removing = mac; true })
                            },
                            verticalArrangement = Arrangement.spacedBy(2.dp),
                        ) {
                            T(mac.macLabel, sf(17f), c.ink, maxLines = 1)
                            T(listOfNotNull(mac.address, mac.shortFingerprint).joinToString(" · "), sf(12f), c.muted, maxLines = 1)
                        }
                        if (store.current?.let { Pairing.same(it, mac) } == true) Glyph(Glyphs.checkThin, 19.dp, c.accent)
                    }
                }
                FormRow(onClick = { store.showPairing = true }, divider = false) {
                    Glyph(Glyphs.plus, 21.dp, c.accent)
                    T("Pair another Mac", sf(17f), c.accent, maxLines = 1)
                }
            }
            FormSection(header = "Reading aloud") {
                FormToggle("Read replies aloud as they come", store.speakReplies, divider = false) { store.changeSpeakReplies(it) }
            }
            // The Lock Screen's Live Activities, in Android's words: an ongoing notification.
            FormSection(header = "Notifications") {
                FormToggle("Running sessions in notifications", store.liveOn, divider = false) { store.changeLiveOn(it) }
            }
            store.usage?.let { usage ->
                FormSection(header = "Usage") {
                    FormValueRow("Today", Money.text(usage.today))
                    if (usage.dayCap > 0) FormValueRow("Daily cap", Money.text(usage.dayCap))
                    FormValueRow("Last 7 days", Money.text(usage.week), divider = usage.windows.isNotEmpty())
                    usage.windows.forEachIndexed { i, w -> FormValueRow(w.label, w.percent?.let { "${it.roundToInt()}%" } ?: "—", divider = i < usage.windows.size - 1) }
                }
            }
            FormSection { FormValueRow("Version", BuildConfig.VERSION_NAME, divider = false) }
        }
        removing?.let { mac ->
            ConfirmDialog(
                "Unpair ${mac.macLabel}?", "Eden Code on this phone forgets it. Remove the device on the Mac too, in Settings › iPhone & Watch.",
                "Unpair", destructive = true, onDismiss = { removing = null },
            ) {
                removing = null
                store.remove(mac)
            }
        }
    }
}

/**
 * Pair with a Mac (PairingView.swift): its address, the certificate fingerprint to compare with the
 * Mac's Settings, then the six-digit code from Settings › iPhone & Watch › Pair a phone. A pasted
 * pairing link (jarvis-pair://…) fills all three.
 */
@Composable
fun PairingScreen(first: Boolean, onDone: () -> Unit) {
    val store = LocalEnv.current.store
    val c = Eden.colors
    val scope = rememberCoroutineScope()
    var address by remember { mutableStateOf(DebugPairing.server ?: "") }
    var code by remember { mutableStateOf("") }
    var probed by remember { mutableStateOf<Pair<String, String>?>(null) }
    var working by remember { mutableStateOf(false) }
    var problem by remember { mutableStateOf<String?>(null) }
    val codeFocus = remember { FocusRequester() }
    var pairingWith by remember { mutableStateOf<String?>(null) }  // the Mac's name while a scanned code pairs
    var pairedWith by remember { mutableStateOf<String?>(null) }

    /**
     * Pairs with a scanned code: its fingerprint pinned, its addresses tried in turn, the code
     * sent once. Success shows for a moment before the app moves on.
     */
    fun pairScanned(payload: com.askeden.edencode.net.PairPayload) {
        if (working) return
        working = true
        problem = null
        pairingWith = payload.label
        scope.launch {
            try {
                val pairing = io {
                    com.askeden.edencode.net.PairPayload.pair(payload) { base, fp, code -> MacStore.pair(base, fp, code, "${Build.MODEL} (Eden Code)") }
                }
                pairingWith = null
                pairedWith = pairing.macName ?: payload.label
                kotlinx.coroutines.delay(1200)
                working = false
                store.added(pairing)
                pairedWith = null
                onDone()
            } catch (e: Exception) {
                working = false
                pairingWith = null
                problem = com.askeden.edencode.net.PairPayload.scanProblem(e)
            }
        }
    }
    // A code opened from the camera app (edencode://pair?…), or why it couldn't be read.
    LaunchedEffect(store.pendingPair, store.pendingPairProblem) {
        store.pendingPairProblem?.let { problem = it; store.pendingPairProblem = null }
        store.pendingPair?.let { store.pendingPair = null; pairScanned(it) }
    }

    fun pair() {
        val p = probed ?: return
        if (code.length != 6 || working) return
        working = true
        problem = null
        scope.launch {
            try {
                val pairing = io { MacStore.pair(p.first, p.second, code, "${Build.MODEL} (Eden Code)") }
                store.added(pairing)
                onDone()
            } catch (e: Exception) {
                code = ""
                problem = MacError.describe(e)
            } finally {
                working = false
            }
        }
    }

    fun probe() {
        PairingLink.parse(address)?.let { link ->
            probed = link.baseURL to link.fingerprint
            code = link.code
            pair()
            return
        }
        working = true
        problem = null
        scope.launch {
            try {
                probed = io { MacStore.probe(address) }
                DebugPairing.code?.let { code = it; pair() }
                runCatching { codeFocus.requestFocus() }
            } catch (e: Exception) {
                problem = MacError.describe(e)
            } finally {
                working = false
            }
        }
    }
    LaunchedEffect(Unit) { if (DebugPairing.server != null && probed == null) probe() }

    val top = if (first) safeTop() else 0.dp
    Box(Modifier.fillMaxSize()) {
    Column(
        Modifier.fillMaxSize().then(if (first) Modifier.verticalScroll(rememberScrollState()) else Modifier)
            .padding(top = top + if (first) 40.dp else 2.dp, start = 20.dp, end = 20.dp, bottom = 30.dp),
        verticalArrangement = Arrangement.spacedBy(20.dp), horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Box(
                Modifier.size(84.dp).boxShadow(Color.Black.copy(alpha = 0.2f), y = 8.dp, blur = 24.dp, radius = 22.dp)
                    .background(Brush.verticalGradient(listOf(hex(0x1F3B73), hex(0x0F1E3D))), RoundedCornerShape(22.dp)),
                contentAlignment = Alignment.Center,
            ) { Glyph(Glyphs.edenMark, 44.dp, Color.White) }
            T(if (first) "Eden Code" else "Pair a Mac", sf(34f, Bold), c.ink, maxLines = 1)
            T("Carry on from your phone: your sessions, their changes and what waits on you, from Eden Code on your Mac.", sf(15f), c.muted, align = TextAlign.Center)
        }
        problem?.let { ProblemBanner(it) }
        val shown = pairedWith
        val busy = pairingWith
        when {
            shown != null -> Row(
                Modifier.fillMaxWidth().height(50.dp).edenCard(radius = 20.dp).semantics { liveRegion = androidx.compose.ui.semantics.LiveRegionMode.Polite },
                horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally), verticalAlignment = Alignment.CenterVertically,
            ) {
                Glyph(Glyphs.checkCircle, 20.dp, c.checkGreen)
                T("Paired with $shown", sf(17f, Semibold), c.checkGreen, maxLines = 1)
            }
            busy != null -> Row(
                Modifier.fillMaxWidth().height(50.dp).edenCard(radius = 20.dp),
                horizontalArrangement = Arrangement.spacedBy(10.dp, Alignment.CenterHorizontally), verticalAlignment = Alignment.CenterVertically,
            ) {
                Spinner(c.accent)
                T("Pairing with $busy…", sf(15f, Medium), c.ink, maxLines = 1)
            }
            else -> Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Row(
                    Modifier.fillMaxWidth().height(50.dp).background(c.accent, RoundedCornerShape(50))
                        .pressable(0.97f, enabled = !working, dim = false, label = "Scan QR code. Scans the code in Eden Code › On your phone on your Mac") { store.scanning = true },
                    horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally), verticalAlignment = Alignment.CenterVertically,
                ) {
                    Glyph(Glyphs.qrScan, 20.dp, Color.White)
                    T("Scan QR code", sf(17f, Semibold), Color.White, maxLines = 1)
                }
                T("On your Mac, open Eden Code › On your phone (or Settings › iPhone › Pair the Eden Code app) and scan its code. Or type it below.",
                    sf(13f), c.muted, align = TextAlign.Center)
            }
        }
        Column(Modifier.fillMaxWidth().edenCard(radius = 20.dp).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Step(1, "On your Mac, open Eden › Settings › iPhone & Watch and turn on “Let my phone connect”. In Eden Code › More › Open on my phone, turn on Eden Code on your phone.")
            FilledField(
                address, { address = it; probed = null }, "Mac address, like my-mac.local",
                keyboard = KeyboardOptions(keyboardType = KeyboardType.Uri, autoCorrectEnabled = false),
            )
            val p = probed
            if (p != null) {
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    T("Compare with your Mac’s Settings › iPhone & Watch:", sf(13f), c.muted)
                    T(CertificatePin.short(p.second), sf(17f, Semibold, mono = true), c.ink, maxLines = 1)
                }
                Step(2, "Click Pair a phone on the Mac and type its six-digit code.")
                FilledField(
                    code, { new -> code = new.filter { it.isDigit() }.take(6); if (code.length == 6) pair() }, "123456",
                    Modifier.focusRequester(codeFocus), style = sf(28f, Semibold, mono = true, lineHeight = 34f).copy(textAlign = TextAlign.Center),
                    keyboard = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
                )
            }
        }
        val enabled = !working && address.isNotBlank() && (probed == null || code.length == 6)
        Box(
            // .glassProminent: the accent while it can be pressed, plain glass with grey words while it can't.
            Modifier.fillMaxWidth().height(50.dp)
                .then(if (enabled || working) Modifier.background(c.accent, RoundedCornerShape(50)) else Modifier.edenCard(radius = 25.dp, tint = if (Eden.dark) hex(0xFFFFFF, 0.1f) else hex(0xFFFFFF, 0.55f)))
                .pressable(0.97f, enabled = enabled, dim = false, label = if (probed == null) "Find my Mac" else "Pair") { if (probed == null) probe() else pair() },
            contentAlignment = Alignment.Center,
        ) {
            if (working) Spinner(Color.White) else T(if (probed == null) "Find my Mac" else "Pair", sf(17f, Semibold), if (enabled) Color.White else placeholderInk(), maxLines = 1)
        }
        if (first && BuildConfig.DEBUG) {
            T("Look around with sample sessions", sf(14f), c.accent, Modifier.pressable(0.97f) { DebugPairing.useFixtures?.invoke() })
        }
        Spacer(Modifier.height(0.dp))
    }
    }
}

/** Debug launches can fill the pairing screen (EDENCODEServer, EDENCODECode) or switch to the sample sessions. */
object DebugPairing {
    var server: String? = null
    var code: String? = null
    var useFixtures: (() -> Unit)? = null
}

@Composable
private fun Step(n: Int, text: String) {
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.Top) {
        NumberBadge(n)
        T(text, sf(14f), Eden.colors.ink2, Modifier.weight(1f))
    }
}
