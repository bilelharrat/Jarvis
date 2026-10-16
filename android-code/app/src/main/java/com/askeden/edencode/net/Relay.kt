package com.askeden.edencode.net

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import java.io.IOException
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import kotlin.concurrent.thread

// The encrypted relay through askeden.com (JARVIS V1 src/jarvis/relay.py, the iPhone app's
// iOS/Account/RelayTunnel.swift), ported one for one: a listener on 127.0.0.1 turns each
// connection OkHttp makes into one relay stream to the Mac, a WebSocket to
// wss://askeden.com/api/relay/connect?to=<the Mac's device id>. The app then talks to
// https://127.0.0.1:<port> with the Mac's pinned fingerprint, so TLS runs end to end from this
// phone to the Mac's companion server: askeden.com carries ciphertext it can't read.

/** One end of a byte stream the tunnel copies (the loopback socket, or the relay WebSocket; fakes in tests). */
interface RelaySocket {
    /** The next bytes (at most 64 KiB), an empty array when there's nothing yet, or null once this end has closed. */
    fun receive(): ByteArray?
    fun send(data: ByteArray)
    /** Closes it, and ends any receive waiting on it. */
    fun close()
}

/** Copies bytes both ways between two sockets until either closes or fails, then closes both. */
object RelayPump {
    /** The largest frame askeden.com's relay carries. */
    const val MAX_FRAME = 64 * 1024

    /** Splits bytes into frames of at most [MAX_FRAME]. */
    fun frames(data: ByteArray): List<ByteArray> {
        if (data.size <= MAX_FRAME) return listOf(data)
        return (data.indices step MAX_FRAME).map { data.copyOfRange(it, minOf(it + MAX_FRAME, data.size)) }
    }

    /**
     * Blocks until the stream ends. Returns whether the far end (the Mac) ever sent anything: a
     * stream that ends without a byte from it never reached the Mac.
     */
    fun run(local: RelaySocket, upstream: RelaySocket): Boolean {
        val heard = AtomicBoolean(false)
        val done = Object()
        val finished = AtomicBoolean(false)
        fun finish() {
            if (finished.compareAndSet(false, true)) {
                local.close()
                upstream.close()
                synchronized(done) { done.notifyAll() }
            }
        }
        val a = thread(name = "relay-up", isDaemon = true) { copy(local, upstream, null); finish() }
        val b = thread(name = "relay-down", isDaemon = true) { copy(upstream, local, heard); finish() }
        synchronized(done) { while (!finished.get()) done.wait(1000) }
        a.join(2000)
        b.join(2000)
        return heard.get()
    }

    private fun copy(source: RelaySocket, sink: RelaySocket, heard: AtomicBoolean?) {
        while (true) {
            val data = try {
                source.receive()
            } catch (_: Exception) {
                null
            } ?: return
            if (data.isEmpty()) continue
            heard?.set(true)
            for (frame in frames(data)) {
                try {
                    sink.send(frame)
                } catch (_: Exception) {
                    return
                }
            }
        }
    }
}

/** A loopback connection from OkHttp. */
class SocketRelaySocket(private val socket: Socket) : RelaySocket {
    private val input = socket.getInputStream()
    private val output = socket.getOutputStream()
    private val buffer = ByteArray(RelayPump.MAX_FRAME)

    override fun receive(): ByteArray? {
        val n = input.read(buffer)
        return if (n < 0) null else buffer.copyOf(n)
    }

    override fun send(data: ByteArray) {
        output.write(data)
        output.flush()
    }

    override fun close() {
        try {
            socket.close()
        } catch (_: IOException) {
        }
    }
}

/** One relay stream: binary WebSocket frames are the raw bytes of one TCP connection. */
class WebSocketRelaySocket(client: OkHttpClient, request: Request) : RelaySocket {
    private val queue = LinkedBlockingQueue<ByteArray>()
    private val closed = AtomicBoolean(false)
    private val end = ByteArray(0)
    private val socket: WebSocket

    init {
        socket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                queue.put(bytes.toByteArray())
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                queue.put(text.toByteArray())
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null)
                ended()
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = ended()
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = ended()
        })
    }

    private fun ended() {
        if (closed.compareAndSet(false, true)) queue.put(end)
    }

    override fun receive(): ByteArray? {
        val next = queue.take()
        if (next === end) {
            queue.put(end) // every later receive ends too
            return null
        }
        return next
    }

    override fun send(data: ByteArray) {
        if (closed.get() || !socket.send(data.toByteString())) throw IOException("relay closed")
    }

    override fun close() {
        socket.close(1000, null)
        ended()
    }
}

/**
 * The phone's end of the relay: a listener on 127.0.0.1 (a random port; nothing off this phone
 * can connect) that turns each connection into one relay stream. [makeUpstream] is a new relay
 * stream, or null when signed out of the Eden account.
 */
class RelayTunnel(val macDeviceID: String, private val makeUpstream: () -> RelaySocket?, private val clock: () -> Long = System::currentTimeMillis) {
    private var server: ServerSocket? = null
    private val lastRefused = AtomicLong(0)
    private val lastHeard = AtomicLong(0)

    @get:Synchronized
    val port: Int?
        get() = server?.takeIf { !it.isClosed }?.localPort

    /** Starts listening (once); the port. */
    @Synchronized
    fun start(): Int {
        port?.let { return it }
        val listener = ServerSocket(0, 16, InetAddress.getByName("127.0.0.1"))
        server = listener
        thread(name = "relay-listen", isDaemon = true) {
            while (!listener.isClosed) {
                val socket = try {
                    listener.accept()
                } catch (_: IOException) {
                    break
                }
                accept(socket)
            }
        }
        return listener.localPort
    }

    @Synchronized
    fun stop() {
        try {
            server?.close()
        } catch (_: IOException) {
        }
        server = null
    }

    /** A stream ended in the last 30 s without a byte from the Mac, and none has worked since. */
    val refusedRecently: Boolean
        get() {
            val refused = lastRefused.get()
            if (refused == 0L || clock() - refused >= 30_000) return false
            return lastHeard.get() < refused
        }

    private fun accept(socket: Socket) {
        val local = SocketRelaySocket(socket)
        val upstream = makeUpstream()
        if (upstream == null) {
            local.close()
            return
        }
        thread(name = "relay-stream", isDaemon = true) { noteStream(RelayPump.run(local, upstream)) }
    }

    /** Public for tests: how one stream ended. */
    fun noteStream(heard: Boolean) {
        if (heard) lastHeard.set(clock()) else lastRefused.set(clock())
    }

    companion object {
        const val CONNECT_URL = "wss://askeden.com/api/relay/connect"

        /** The live tunnel to this Mac, on this phone's Eden account token. */
        fun live(macDeviceID: String, token: () -> String?): RelayTunnel {
            val client = OkHttpClient.Builder()
                .connectTimeout(15, TimeUnit.SECONDS)
                .readTimeout(0, TimeUnit.SECONDS)
                .pingInterval(20, TimeUnit.SECONDS)
                .build()
            return RelayTunnel(macDeviceID, {
                token()?.let { bearer ->
                    val request = Request.Builder()
                        .url("$CONNECT_URL?to=" + java.net.URLEncoder.encode(macDeviceID, "UTF-8"))
                        .header("Authorization", "Bearer $bearer")
                        .build()
                    WebSocketRelaySocket(client, request)
                }
            })
        }
    }
}
