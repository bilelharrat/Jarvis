package com.askeden.edencode

import com.askeden.edencode.net.CertificatePin
import com.askeden.edencode.net.LiveBackend
import com.askeden.edencode.net.MacApi
import com.askeden.edencode.net.MacRoute
import com.askeden.edencode.net.MacRouter
import com.askeden.edencode.net.RelayPump
import com.askeden.edencode.net.RelaySocket
import com.askeden.edencode.net.RelayTunnel
import com.askeden.edencode.net.SocketRelaySocket
import com.askeden.edencode.net.WebSocketRelaySocket
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import okio.ByteString
import okio.ByteString.Companion.toByteString
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.net.Socket
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread

/** The relay's framing and the pinned TLS carried end to end through it (relay.py, RelayTunnel.swift). */
class RelayTest {
    private lateinit var mac: MockWebServer
    private lateinit var fp: String

    @Before fun setUp() {
        MacRoute.router = null
        val cert = HeldCertificate.Builder().commonName("Mac").addSubjectAlternativeName("macbook-air.local").build()
        fp = CertificatePin.fingerprint(cert.certificate.encoded)
        mac = MockWebServer()
        mac.useHttps(HandshakeCertificates.Builder().heldCertificate(cert).build().sslSocketFactory(), false)
        mac.start()
    }

    @After fun tearDown() {
        MacRoute.router = null
        mac.shutdown()
    }

    /** A socket that hands out what it's given and keeps what it's sent. */
    class Fake(vararg chunks: ByteArray, private val endAfter: Boolean = true) : RelaySocket {
        private val incoming = LinkedBlockingQueue<ByteArray>()
        val sent = mutableListOf<ByteArray>()
        @Volatile var closed = false
        private val end = ByteArray(0)

        init {
            chunks.forEach { incoming.put(it) }
            if (endAfter) incoming.put(end)
        }

        override fun receive(): ByteArray? {
            val next = incoming.poll(5, TimeUnit.SECONDS) ?: return null
            if (next === end || closed) return null
            return next
        }

        @Synchronized override fun send(data: ByteArray) { sent += data }
        override fun close() { closed = true; incoming.put(end) }
    }

    @Test fun framesAreNeverOver64KiB() {
        val big = ByteArray(150 * 1024) { (it % 251).toByte() }
        val frames = RelayPump.frames(big)
        assertEquals(listOf(65536, 65536, 22528), frames.map { it.size })
        assertTrue(frames.fold(ByteArray(0)) { a, b -> a + b }.contentEquals(big))
        assertEquals(1, RelayPump.frames(ByteArray(10)).size)
    }

    @Test fun pumpCopiesBothWaysThenClosesBoth() {
        val big = ByteArray(150 * 1024) { 7 }
        val local = Fake(big, byteArrayOf(1), endAfter = false)
        val upstream = Fake(byteArrayOf(9, 9), endAfter = false)
        // The Mac hangs up once it has everything (as a server does after its answer).
        thread(isDaemon = true) {
            while (synchronized(upstream) { upstream.sent.sumOf { it.size } } < 150 * 1024 + 1) Thread.sleep(5)
            upstream.close()
        }
        val heard = RelayPump.run(local, upstream)
        assertTrue(heard)
        assertTrue(upstream.sent.all { it.size <= RelayPump.MAX_FRAME })
        assertEquals(150 * 1024 + 1, upstream.sent.sumOf { it.size })
        assertEquals(listOf(2), local.sent.map { it.size })
        assertTrue(local.closed && upstream.closed)
    }

    @Test fun aStreamTheMacNeverAnsweredDeliveredNothing() {
        val local = Fake(byteArrayOf(1, 2, 3), endAfter = false)
        val upstream = Fake() // closes at once: the Mac isn't on the relay
        assertFalse(RelayPump.run(local, upstream))
        var now = 1_000_000L
        val tunnel = RelayTunnel("mac", { null }, clock = { now })
        tunnel.noteStream(false)
        assertTrue(tunnel.refusedRecently)
        now += 31_000
        assertFalse(tunnel.refusedRecently) // forgotten after 30 s
        tunnel.noteStream(false)
        now += 1
        tunnel.noteStream(true)
        assertFalse(tunnel.refusedRecently) // one that worked since clears it
    }

    @Test fun pinnedTlsRunsEndToEndThroughTheLoopbackTunnel() {
        mac.enqueue(MockResponse().setBody("""{"sessions": [{"id": 5, "title": "Fix", "status": "working"}]}"""))
        val tunnel = RelayTunnel("mac", { SocketRelaySocket(Socket(mac.hostName, mac.port)) })
        val port = tunnel.start()
        try {
            // The phone talks to 127.0.0.1 with the Mac's pin: the certificate is checked, never the host.
            val home = LiveBackend(MacApi("https://127.0.0.1:$port", "tok", fp)).home()
            assertEquals(5, home.sessions.single().id)
            assertEquals("Bearer tok", mac.takeRequest().getHeader("Authorization"))
        } finally {
            tunnel.stop()
        }
    }

    @Test fun throughAWebSocketRelayLikeAskedensWithBigAnswers() {
        val biggest = AtomicInteger(0)
        val auth = LinkedBlockingQueue<String>()
        val relay = MockWebServer()
        relay.dispatcher = object : okhttp3.mockwebserver.Dispatcher() {
            override fun dispatch(request: okhttp3.mockwebserver.RecordedRequest): MockResponse {
                auth.put("${request.getHeader("Authorization")} ${request.requestUrl?.queryParameter("to")}")
                // askeden.com's end: bytes to and from the Mac's companion, as relay.py copies them.
                return MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
                    lateinit var toMac: Socket
                    override fun onOpen(webSocket: WebSocket, response: Response) {
                        toMac = Socket(mac.hostName, mac.port)
                        thread(isDaemon = true) {
                            val buf = ByteArray(RelayPump.MAX_FRAME)
                            val input = toMac.getInputStream()
                            while (true) {
                                val n = try { input.read(buf) } catch (_: Exception) { -1 }
                                if (n < 0) break
                                webSocket.send(buf.copyOf(n).toByteString())
                            }
                            webSocket.close(1000, null)
                        }
                    }

                    override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                        biggest.accumulateAndGet(bytes.size) { a, b -> maxOf(a, b) }
                        toMac.getOutputStream().write(bytes.toByteArray())
                    }

                    override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { toMac.close() }
                })
            }
        }
        relay.start()
        val text = "x".repeat(200_000)
        mac.enqueue(MockResponse().setBody("""{"ok": true, "said": "$text"}"""))
        val client = OkHttpClient()
        val tunnel = RelayTunnel("mac-device-1", {
            WebSocketRelaySocket(client, Request.Builder().url("ws://${relay.hostName}:${relay.port}/api/relay/connect?to=mac-device-1").header("Authorization", "Bearer acct").build())
        })
        val port = tunnel.start()
        try {
            val said = LiveBackend(MacApi("https://127.0.0.1:$port", "tok", fp)).send(5, "y".repeat(100_000)).said
            assertEquals(200_000, said.length)
            assertEquals("Bearer acct mac-device-1", auth.poll(5, TimeUnit.SECONDS))
            assertTrue(biggest.get() in 1..RelayPump.MAX_FRAME)
            assertEquals(100_000 + 18, mac.takeRequest().bodySize.toInt())
        } finally {
            tunnel.stop()
            relay.shutdown()
        }
    }

    @Test fun theRouteDecision() {
        assertEquals(MacRouter.Route.Direct, MacRouter.decide(true, true, "m", false))
        assertEquals(MacRouter.Route.Relay, MacRouter.decide(false, true, "m", false))
        assertEquals(MacRouter.Route.Direct, MacRouter.decide(false, false, "m", false))
        assertEquals(MacRouter.Route.Direct, MacRouter.decide(false, true, null, false))
        assertEquals(MacRouter.Route.Direct, MacRouter.decide(false, true, "m", true))
    }

    @Test fun theRouterUsesTheRelayOnlyWhenTheMacCantBeReached() {
        var reachable = false
        var token: String? = "acct"
        var knocks = 0
        val router = MacRouter({ token }, knock = { _, _ -> knocks++; reachable }, makeTunnel = { RelayTunnel(it, { null }) })
        val direct = "https://macbook-air.local:8765"
        router.configure(direct, "mac-device-1")
        val relayed = router.base(direct)
        assertTrue(relayed.startsWith("https://127.0.0.1:"))
        assertEquals(MacRouter.Route.Relay, router.lastRoute)
        router.base(direct)
        assertEquals(1, knocks) // the knock is remembered for 30 s
        router.networkChanged()
        reachable = true
        assertEquals(direct, router.base(direct))
        assertEquals("https://other.local:8765", router.base("https://other.local:8765")) // another Mac: straight there
        token = null
        router.configure(direct, "mac-device-1")
        reachable = false
        router.networkChanged()
        assertEquals(direct, router.base(direct)) // signed out: never the relay
    }

    @Test fun anUnreachableMacIsTriedOnceMoreThroughTheRelay() {
        mac.enqueue(MockResponse().setBody("""{"sessions": []}"""))
        val router = MacRouter({ "acct" }, knock = { _, _ -> true }, makeTunnel = { RelayTunnel(it, { SocketRelaySocket(Socket(mac.hostName, mac.port)) }) })
        // An address nothing answers on (the knock lied: it's away from home).
        val direct = "https://127.0.0.1:1"
        router.configure(direct, "mac-device-1")
        MacRoute.router = router
        assertEquals(0, LiveBackend(MacApi(direct, "tok", fp)).home().sessions.size)
        assertEquals(MacRouter.Route.Relay, router.lastRoute)
    }
}
