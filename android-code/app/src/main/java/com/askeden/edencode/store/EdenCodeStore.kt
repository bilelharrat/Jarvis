package com.askeden.edencode.store

import android.content.Context
import android.os.Build
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.askeden.edencode.model.PhoneCard
import com.askeden.edencode.model.PhoneHome
import com.askeden.edencode.model.PhoneOptions
import com.askeden.edencode.model.PhoneTodoCard
import com.askeden.edencode.model.PhoneTodos
import com.askeden.edencode.model.PhoneUsage
import com.askeden.edencode.model.ApprovalChoice
import com.askeden.edencode.net.CodeBackend
import com.askeden.edencode.net.LiveBackend
import com.askeden.edencode.net.MacApi
import com.askeden.edencode.net.MacError
import com.askeden.edencode.net.MacRoute
import com.askeden.edencode.net.Pairing
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/** Sample data in place of a Mac: debug builds only (src/debug), null in release (src/release). */
interface Fixtures {
    val backend: CodeBackend
    val macs: List<Pairing>
}

/** What the store asks of Android (notifications, the widget, the ongoing notification, biometrics). */
interface Platform {
    /** Every fresh /home: the widget, the ongoing notification, and a local notification on a change. */
    fun homeChanged(previous: PhoneHome?, home: PhoneHome, mac: String, liveOn: Boolean, inFront: Boolean)
    /** The owner's fingerprint, face or screen lock; false when they didn't confirm. */
    suspend fun confirmOwner(reason: String): Boolean
    /** The Firebase token for every paired Mac, once Firebase is set up. */
    fun registerPush(macs: List<Pairing>)
    val inFront: Boolean
}

/**
 * The app's state (EdenCodeStore.swift): the paired Macs and the one in use, what it says (sessions,
 * the cards that wait, the pin, options, usage, the to-do column), and where the app should go next
 * (a push, a handoff, the ongoing notification tapped). One per app.
 */
class EdenCodeStore(context: Context, private val platform: Platform, fixtures: Fixtures?) {
    /**
     * What shows when no session is open (the G design, 2026-10-16: no tab bar; the drawer reaches
     * all of them). New is the "What should we build?" page, the app's home.
     */
    enum class Tab { New, Inbox, Queue, Settings }

    sealed class Route {
        data class Session(val id: Int) : Route()
        data class Changes(val id: Int) : Route()
    }

    private val app = context.applicationContext
    private val prefs = app.getSharedPreferences("edencode", Context.MODE_PRIVATE)
    private val secure = SecureStore(app)
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    var macs by mutableStateOf(emptyList<Pairing>()); private set
    var current by mutableStateOf<Pairing?>(null); private set
    var backend by mutableStateOf<CodeBackend?>(null); private set
    var usingFixtures by mutableStateOf(false); private set

    var home by mutableStateOf(PhoneHome())
    var options by mutableStateOf(PhoneOptions())
    var usage by mutableStateOf<PhoneUsage?>(null)
    var todos by mutableStateOf(PhoneTodos(emptyList()))
    var problem by mutableStateOf<String?>(null)
    var switchedOff by mutableStateOf(false)
    var loaded by mutableStateOf(false)

    var tab by mutableStateOf(Tab.New)
    /** The glass drawer from the left: search, New session, every session, the Mac and Settings. */
    var drawerOpen by mutableStateOf(false)
    var path by mutableStateOf(emptyList<Route>())
    var sheetCard by mutableStateOf<PhoneCard?>(null)
    var showPairing by mutableStateOf(false)
    var search by mutableStateOf("")

    /** Settings, kept on this phone. */
    var speakReplies by mutableStateOf(prefs.getBoolean("speakReplies", false))
        private set
    var liveOn by mutableStateOf(prefs.getBoolean("liveActivities", true))
        private set

    /** This phone's Eden account token (the relay); null while signed out. */
    var accountToken: String?
        get() = secure.read("edencode.account.token")
        set(value) {
            secure.write("edencode.account.token", value)
            configureRoute()
        }

    private var polling: Job? = null
    private var lastPinOpened: Double
        get() = prefs.getLong("lastPinMs", 0L).toDouble()
        set(value) = prefs.edit().putLong("lastPinMs", value.toLong()).apply()

    val paired: Boolean get() = backend != null
    val deviceName: String get() = Build.MODEL ?: "Android phone"

    init {
        if (fixtures != null) {
            useFixtures(fixtures)
        } else {
            macs = MacStore.decode(secure.read(MacStore.ACCOUNT))
            select(MacStore.current(macs, prefs.getString("currentMac", null)))
        }
    }

    /** The debug fixtures stand in for a Mac (screenshots, the emulator without a Mac). */
    fun useFixtures(fixtures: Fixtures) {
        usingFixtures = true
        macs = fixtures.macs
        current = macs.firstOrNull()
        backend = fixtures.backend
        loaded = false
        path = emptyList()
        scope.launch { refreshAll() }
    }

    /** Forgets every paired Mac (debug: EDENCODEReset). */
    fun forgetAll() {
        macs = emptyList()
        secure.write(MacStore.ACCOUNT, null)
        select(null)
    }

    fun changeSpeakReplies(on: Boolean) {
        speakReplies = on
        prefs.edit().putBoolean("speakReplies", on).apply()
    }

    fun changeLiveOn(on: Boolean) {
        liveOn = on
        prefs.edit().putBoolean("liveActivities", on).apply()
        platform.homeChanged(home, home, current?.macLabel ?: "", liveOn, platform.inFront)
    }

    // ── Macs ──

    fun select(pairing: Pairing?) {
        current = pairing
        prefs.edit().putString("currentMac", pairing?.key).apply()
        backend = pairing?.let { LiveBackend(MacApi(it.baseURL, it.token, it.fingerprint)) }
        configureRoute()
        home = PhoneHome()
        options = PhoneOptions()
        usage = null
        todos = PhoneTodos(emptyList())
        loaded = false
        problem = null
        path = emptyList()
        if (pairing != null) scope.launch { refreshAll() }
    }

    /** The relay is for the Mac in use. */
    private fun configureRoute() {
        if (usingFixtures) return
        MacRoute.router?.configure(current?.baseURL, current?.macDeviceID)
    }

    fun added(pairing: Pairing) {
        macs = MacStore.adding(pairing, macs)
        secure.write(MacStore.ACCOUNT, MacStore.encode(macs))
        select(pairing)
        platform.registerPush(macs)
    }

    fun remove(pairing: Pairing) {
        val api = MacApi(pairing.baseURL, pairing.token, pairing.fingerprint)
        scope.launch {
            try {
                io { api.unregisterPush() }
            } catch (_: Exception) {
            }
        }
        macs = MacStore.removing(pairing, macs)
        secure.write(MacStore.ACCOUNT, MacStore.encode(macs))
        if (current?.let { Pairing.same(it, pairing) } == true) select(macs.firstOrNull())
    }

    /** A Firebase token, for every paired Mac (each sends this app's pushes on its own). */
    suspend fun registerPush(token: String) {
        for (mac in macs.filter { it.isPinned }) {
            try {
                io { MacApi(mac.baseURL, mac.token, mac.fingerprint).registerPush(token, "fcm", "com.askeden.edencode") }
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
            }
        }
    }

    // ── Reading ──

    suspend fun refreshAll() {
        refreshHome()
        val b = backend ?: return
        val o = scope.async { runCatching { io { b.options() } }.getOrNull() }
        val u = scope.async { runCatching { io { b.usage() } }.getOrNull() }
        val t = scope.async { runCatching { io { b.todos() } }.getOrNull() }
        o.await()?.let { options = it }
        u.await()?.let { usage = it }
        t.await()?.let { todos = it }
    }

    suspend fun refreshHome() {
        val b = backend ?: return
        try {
            val previous = if (loaded) home else null
            val found = io { b.home() }
            home = found
            loaded = true
            problem = null
            switchedOff = false
            openPinIfNew(found.pinned)
            platform.homeChanged(previous, found, current?.macLabel ?: "", liveOn, platform.inFront)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            loaded = true
            note(e)
        }
    }

    suspend fun refreshTodos() {
        val b = backend ?: return
        runCatching { io { b.todos() } }.getOrNull()?.let { todos = it }
    }

    suspend fun refreshUsage() {
        val b = backend ?: return
        runCatching { io { b.usage() } }.getOrNull()?.let { usage = it }
    }

    /** Every 5 s while the app is in front (docs/eden-code-phone.md), and at once on a push. */
    fun startPolling() {
        polling?.cancel()
        polling = scope.launch {
            while (isActive) {
                refreshHome()
                delay(5000)
            }
        }
    }

    fun stopPolling() {
        polling?.cancel()
        polling = null
    }

    fun note(error: Throwable) {
        if (error is MacError) {
            if (error is MacError.Rejected && error.message.contains("Hand off to phone")) {
                switchedOff = true
                problem = "Turn on Eden Code on your phone on the Mac: Eden Code › More › Hand off to phone."
                return
            }
            problem = error.description
        } else if (error !is CancellationException) {
            problem = error.message ?: error.toString()
        }
    }

    // ── Where to go ──

    /** The handoff's pin, when it's newer than the last one opened: opens once, as the page does. */
    private fun openPinIfNew(pinned: PhoneHome.Pinned?) {
        if (pinned == null || pinned.at <= lastPinOpened) return
        lastPinOpened = pinned.at
        open(session = pinned.id)
    }

    fun open(session: Int) {
        drawerOpen = false
        path = listOf(Route.Session(session))
    }

    fun openChanges(id: Int) {
        drawerOpen = false
        path = listOf(Route.Session(id), Route.Changes(id))
    }

    /** A page the drawer reaches (New, Inbox, Queue, Settings), with no session over it. */
    fun show(page: Tab) {
        drawerOpen = false
        path = emptyList()
        tab = page
    }

    /** The New page ("What should we build?"): the ✎ in a session's header and the drawer's New session. */
    fun newSession() = show(Tab.New)

    /**
     * A card to answer: in its session, where it waits as a glass card above the transcript (the
     * GAsk mockup); a card from no session we know rises over the screen instead.
     */
    fun showCard(card: PhoneCard) {
        val id = card.taskID
        if (id != null && home.sessions.any { it.id == id }) open(session = id) else sheetCard = card
    }

    fun push(route: Route) {
        path = path + route
    }

    /** Back: true when it went somewhere (else the system takes it). */
    fun back(): Boolean {
        when {
            sheetCard != null -> sheetCard = null
            showPairing -> showPairing = false
            drawerOpen -> drawerOpen = false
            path.isNotEmpty() -> path = path.dropLast(1)
            tab != Tab.New -> tab = Tab.New
            else -> return false
        }
        return true
    }

    /**
     * A notification tapped (a push, or one of this app's own): a handoff or a finished/failed
     * session opens its session; a card opens its sheet once the home view has it.
     */
    fun open(kind: String?, cardID: String?, taskID: Int?, handoff: Boolean) {
        scope.launch {
            refreshHome()
            when (kind) {
                "code_approval", "code_needs_you" -> {
                    val card = home.attention.firstOrNull { it.id == cardID || (taskID != null && it.taskID == taskID) }
                    if (card != null) showCard(card) else if (taskID != null) open(session = taskID)
                }
                else -> {
                    if (taskID != null) open(session = taskID)
                    if (handoff) home.pinned?.let { lastPinOpened = maxOf(lastPinOpened, it.at) }
                }
            }
        }
    }

    /** edencode://session/5, edencode://changes/5, edencode://inbox, edencode://queue, edencode://new, edencode://sessions (the drawer) */
    fun open(url: String) {
        val uri = try {
            java.net.URI(url)
        } catch (_: Exception) {
            return
        }
        if (uri.scheme?.lowercase() != "edencode") return
        val parts = (listOf(uri.host ?: "") + (uri.path ?: "").split("/")).filter { it.isNotEmpty() }
        when (parts.firstOrNull()) {
            "session" -> parts.getOrNull(1)?.toIntOrNull()?.let { open(session = it) }
            "changes" -> parts.getOrNull(1)?.toIntOrNull()?.let { openChanges(it) }
            "inbox" -> show(Tab.Inbox)
            "queue" -> show(Tab.Queue)
            "settings" -> show(Tab.Settings)
            "new" -> newSession()
            "sessions" -> drawerOpen = true
            else -> {}
        }
    }

    // ── Doing ──

    /** Answers a card (biometrics first for a risky yes, as the Mac asks Touch ID). False when not confirmed or not taken. */
    suspend fun answer(card: PhoneCard, choice: ApprovalChoice, feedback: String? = null): Boolean {
        if (card.macOnly && !choice.isNegative) return false
        if (card.needsBiometrics(choice) && !platform.confirmOwner("Allow this on your Mac")) return false
        val b = backend ?: return false
        return try {
            val ok = io { b.answer(card.id, choice.id, feedback) }
            refreshHome()
            ok.ok
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            note(e)
            false
        }
    }

    /** Null when it started (and opens its session), else what went wrong. */
    suspend fun startTodo(card: PhoneTodoCard): String? {
        val b = backend ?: return null
        return try {
            val ok = io { b.startTodo(card.id) }
            refreshTodos()
            ok.id?.let { open(session = it) }
            null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            (e as? MacError)?.message ?: e.message
        }
    }

    suspend fun newSession(directory: String, prompt: String, mode: String, model: String?, isolated: Boolean): String? {
        val b = backend ?: return "Pair a Mac first."
        return try {
            val ok = io { b.newSession(directory, prompt, mode, model, isolated) }
            ok.id?.let { open(session = it) }
            scope.launch { refreshHome() }
            null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            MacError.describe(e)
        }
    }

    suspend fun unpin() {
        val b = backend ?: return
        runCatching { io { b.unpin() } }
        refreshHome()
    }
}
