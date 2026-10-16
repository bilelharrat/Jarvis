package com.askeden.edencode.store

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.askeden.edencode.model.CodeModes
import com.askeden.edencode.model.CodeStatus
import com.askeden.edencode.model.PhoneEntry
import com.askeden.edencode.model.PhoneOK
import com.askeden.edencode.model.PhoneOptions
import com.askeden.edencode.model.PhoneReceipt
import com.askeden.edencode.model.PhoneView
import com.askeden.edencode.model.Transcript
import com.askeden.edencode.net.CodeBackend
import com.askeden.edencode.net.MacError
import com.askeden.edencode.net.Picture
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.runInterruptible

/** Runs a blocking backend call off the main thread; leaving the screen interrupts it. */
suspend fun <T> io(block: () -> T): T = runInterruptible(Dispatchers.IO) { block() }

/**
 * One session on screen (SessionModel.swift): the long poll while it shows (after/seen/v, at most
 * 25 s a wait; back off 1, 2, 4 … 30 s on errors), the entries keyed by i with `changed` replacing
 * in place, the streamed words, and what the composer does.
 */
class SessionModel(val id: Int, private val backend: CodeBackend) {
    var view by mutableStateOf(PhoneView(id))
        private set
    var entries by mutableStateOf(emptyList<PhoneEntry>())
        private set
    var receipts by mutableStateOf(emptyList<PhoneReceipt>())
        private set
    var problem by mutableStateOf<String?>(null)
    var said by mutableStateOf<String?>(null)
    var sending by mutableStateOf(false)
        private set
    var gone by mutableStateOf(false)
        private set

    private var loop: Job? = null

    val working: Boolean get() = view.status == CodeStatus.Working
    val title: String get() = view.title.ifEmpty { "Session $id" }
    val rows: List<Transcript.Row> get() = Transcript.rows(entries)
    val statusLine: String get() = Transcript.statusLine(view)
    /** The newest receipt (the Changes screen's card). */
    val latestReceipt: PhoneReceipt? get() = receipts.lastOrNull()

    fun apply(next: PhoneView) {
        entries = Transcript.merge(entries, next)
        view = next.copy(entries = emptyList(), changed = emptyList())
    }

    fun start(scope: CoroutineScope) {
        if (loop?.isActive == true) return
        loop = scope.launch { poll() }
        scope.launch { loadReceipts() }
    }

    fun stopWatching() {
        loop?.cancel()
        loop = null
    }

    private suspend fun CoroutineScope.poll() {
        var backoff = 1.0
        var first = true
        while (isActive) {
            try {
                val before = view
                val next = io { backend.session(id, before.next, before.seen, if (first) "" else before.v, if (first) 0 else 25) }
                val finished = before.status == CodeStatus.Working && next.status != CodeStatus.Working
                apply(next)
                problem = null
                backoff = 1.0
                first = false
                if (finished) loadReceipts()
                if (next.more) continue
            } catch (e: CancellationException) {
                throw e
            } catch (e: MacError.Gone) {
                gone = true
                problem = "This session isn’t on your Mac any more."
                return
            } catch (e: Exception) {
                if (!isActive) return
                problem = MacError.describe(e)
                delay((backoff * 1000).toLong())
                backoff = Transcript.backoff(backoff)
            }
        }
    }

    suspend fun loadReceipts() {
        try {
            receipts = io { backend.receipts(id) }.receipts
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
        }
    }

    /** Sends: into the running step when steer is true (and it's working), else queued as the Mac's composer queues it. */
    suspend fun send(raw: String, steer: Boolean, pictures: List<Picture> = emptyList()): Boolean {
        val text = raw.trim()
        if (text.isEmpty() && pictures.isEmpty()) return false
        sending = true
        return try {
            val ok: PhoneOK = when {
                pictures.isNotEmpty() -> io { backend.send(id, text, pictures) }
                steer && working -> io { backend.steer(id, text) }
                else -> io { backend.send(id, text) }
            }
            if (!ok.ok) problem = "Your Mac didn’t take that. Too many messages may be waiting."
            ok.ok
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            problem = MacError.describe(e)
            false
        } finally {
            sending = false
        }
    }

    suspend fun stop() {
        try {
            io { backend.stop(id) }
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
        }
    }

    suspend fun setMode(mode: String) = act {
        val ok = io { backend.setMode(id, mode) }
        said = ok.said.ifEmpty { null }
        if (ok.ok) view = view.copy(mode = mode, modeLabel = CodeModes.name(mode), modeShort = CodeModes.short(mode))
    }

    suspend fun setModel(model: PhoneOptions.Model) = act {
        val ok = io { backend.setModel(id, model.ref) }
        said = ok.said.ifEmpty { null }
        // Model Router keeps the session on its model until the next message routes it (the Mac's
        // next answer says where it went).
        if (ok.ok) view = view.copy(
            model = model.ref, modelLabel = model.name, router = model.router,
            routedLabel = if (model.router) (if (view.router) view.routedLabel else view.modelLabel) else "",
        )
    }

    suspend fun land() = act { said = io { backend.land(id) }.said }
    suspend fun discard() = act { said = io { backend.discard(id) }.said }

    private suspend fun act(block: suspend () -> Unit) {
        try {
            block()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            problem = MacError.describe(e)
        }
    }
}
