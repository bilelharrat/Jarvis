package com.askeden.edencode

import com.askeden.edencode.model.PhoneComment
import com.askeden.edencode.net.CertificatePin
import com.askeden.edencode.net.LiveBackend
import com.askeden.edencode.net.MacAddress
import com.askeden.edencode.net.MacApi
import com.askeden.edencode.net.MacError
import com.askeden.edencode.net.MacRoute
import com.askeden.edencode.net.PairingLink
import com.askeden.edencode.net.Picture
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

/** The phone API client against a local HTTPS server with its own self-signed certificate, as the Mac's companion has. */
class ApiClientTest {
    private lateinit var server: MockWebServer
    private lateinit var cert: HeldCertificate
    private lateinit var fp: String
    private lateinit var base: String

    @Before fun setUp() {
        MacRoute.router = null
        cert = HeldCertificate.Builder().commonName("Eden").addSubjectAlternativeName("localhost").build()
        fp = CertificatePin.fingerprint(cert.certificate.encoded)
        server = MockWebServer()
        server.useHttps(HandshakeCertificates.Builder().heldCertificate(cert).build().sslSocketFactory(), false)
        server.start()
        base = "https://${server.hostName}:${server.port}"
    }

    @After fun tearDown() = server.shutdown()

    private fun backend(pin: String = fp) = LiveBackend(MacApi(base, "tok123", pin))
    private fun ok(body: String) = MockResponse().setResponseCode(200).setHeader("Content-Type", "application/json").setBody(body)

    @Test fun readsHomeWithTheBearerToken() {
        server.enqueue(ok("""{"sessions": [{"id": 5, "title": "Fix", "status": "working"}], "attention": [], "pinned": null, "exterminator": []}"""))
        val home = backend().home()
        assertEquals(5, home.sessions.single().id)
        val req = server.takeRequest()
        assertEquals("/api/code/phone/home", req.path)
        assertEquals("Bearer tok123", req.getHeader("Authorization"))
        assertEquals("GET", req.method)
    }

    @Test fun theLongPollAsksWithWhatItHas() {
        server.enqueue(ok("""{"id": 5, "next": 9, "seen": 4, "v": "abc", "entries": []}"""))
        val view = backend().session(5, after = 7, seen = 3, v = "x y", wait = 25)
        assertEquals(9, view.next)
        val url = server.takeRequest().requestUrl!!
        assertEquals("/api/code/phone/session", url.encodedPath)
        assertEquals("5", url.queryParameter("id"))
        assertEquals("7", url.queryParameter("after"))
        assertEquals("3", url.queryParameter("seen"))
        assertEquals("x y", url.queryParameter("v"))
        assertEquals("25", url.queryParameter("wait"))
    }

    @Test fun postsTheRightBodies() {
        repeat(8) { server.enqueue(ok("""{"ok": true, "said": "Done.", "id": 12, "steered": true}""")) }
        val b = backend()
        b.send(5, "hello")
        b.steer(5, "also this")
        b.answer("c1", "deny", "  do X instead ")
        b.answer("c2", "allow", "   ")
        assertEquals(12, b.newSession("site", "Fix it", "edits", null, true).id)
        b.hunk(5, listOf("h1", "h2"), "undo", "turn")
        b.comment(5, listOf(PhoneComment("a.js", 12, "o", "x".repeat(400), "why?")))
        b.startTodo("t1")
        fun body() = JSONObject(server.takeRequest().body.readUtf8())
        assertEquals("hello", body().getString("text"))
        assertEquals("also this", body().getString("text"))
        body().let { assertEquals("c1", it.getString("approval")); assertEquals("do X instead", it.getString("feedback")) }
        assertTrue(!body().has("feedback")) // blank feedback isn't sent
        body().let { assertEquals("site", it.getString("directory")); assertEquals("edits", it.getString("mode")); assertTrue(it.getBoolean("isolated")); assertTrue(!it.has("model")) }
        body().let { assertEquals(2, it.getJSONArray("hunks").length()); assertEquals("undo", it.getString("action")); assertEquals("turn", it.getString("view")) }
        body().getJSONArray("comments").getJSONObject(0).let { assertEquals(300, it.getString("excerpt").length); assertEquals("o", it.getString("side")) }
        assertEquals("t1", body().getString("card"))
    }

    @Test fun picturesGoThroughTheCompanionsSend() {
        server.enqueue(ok("""{"ok": true}"""))
        assertTrue(backend().send(5, "look", listOf(Picture("photo-1.jpg", "image/jpeg", byteArrayOf(1, 2, 3)))).ok)
        val req = server.takeRequest()
        assertEquals("/api/code/send", req.path)
        assertEquals("1", req.getHeader("x-jarvis-pictures"))
        val img = JSONObject(req.body.readUtf8()).getJSONArray("images").getJSONObject(0)
        assertEquals("AQID", img.getString("data"))
    }

    @Test fun errorsInTheOwnersWords() {
        server.enqueue(MockResponse().setResponseCode(401))
        server.enqueue(MockResponse().setResponseCode(404).setBody("""{"error": "no such session"}"""))
        server.enqueue(MockResponse().setResponseCode(404))
        server.enqueue(MockResponse().setResponseCode(403).setBody("""{"error": "Turn on Eden Code on your phone: Hand off to phone", "off": true}"""))
        server.enqueue(MockResponse().setResponseCode(429).setBody("""{"error": "Slow down."}"""))
        server.enqueue(ok("not json"))
        val b = backend()
        expect<MacError.Unpaired> { b.home() }
        expect<MacError.Gone> { b.session(1, 0, 0, "", 0) }
        expect<MacError.Unsupported> { b.usage() }
        val off = expect<MacError.Rejected> { b.home() }
        assertTrue(off.message.contains("Hand off to phone"))
        assertEquals("Slow down.", expect<MacError.Busy> { b.stop(5) }.message)
        expect<MacError.NotEden> { b.home() }
    }

    @Test fun anotherCertificateIsRefusedBeforeAnythingIsSent() {
        server.enqueue(ok("{}"))
        expect<MacError.CertificateMismatch> { backend("00".repeat(32)).home() }
        assertEquals(0, server.requestCount)
        expect<MacError.NotPinned> { LiveBackend(MacApi(base, "t", null)).home() }
    }

    @Test fun probeReadsTheFingerprintAndSendsNothing() {
        assertEquals(fp, MacApi.probeFingerprint(base))
        assertEquals(0, server.requestCount)
    }

    @Test fun pairingTradesTheCodeOverThePinnedConnection() {
        server.enqueue(ok("""{"token": "dev-token", "fingerprint": "$fp", "mac_name": "MacBook Air"}"""))
        val result = MacApi(base, null, fp).pair("123456", "Pixel (Eden Code)")
        assertEquals("dev-token", result.token)
        assertEquals("MacBook Air", result.macName)
        val req = server.takeRequest()
        assertNull(req.getHeader("Authorization"))
        val body = JSONObject(req.body.readUtf8())
        assertEquals("123456", body.getString("code"))
        assertEquals(fp, body.getString("fingerprint"))
        server.enqueue(MockResponse().setResponseCode(403).setBody("""{"error": "Too many tries. Make a new code."}"""))
        assertEquals("Too many tries", expect<MacError.WrongCode> { MacApi(base, null, fp).pair("000000", "x") }.title)
        server.enqueue(MockResponse().setResponseCode(409).setBody("""{"error": "fingerprint"}"""))
        expect<MacError.FingerprintRefused> { MacApi(base, null, fp).pair("000000", "x") }
    }

    @Test fun openPullRequestDraftsThenOpens() {
        server.enqueue(ok("""{"ok": true, "code_pr_draft": {"title": "Fix share", "body": "Why"}}"""))
        server.enqueue(ok("""{"ok": true, "said": ""}"""))
        assertEquals("Opened a draft pull request.", backend().openPullRequest(5).said)
        assertEquals("pr_draft", JSONObject(server.takeRequest().body.readUtf8()).getString("action"))
        JSONObject(server.takeRequest().body.readUtf8()).let { assertEquals("pr_open", it.getString("action")); assertTrue(it.getBoolean("draft")) }
    }

    @Test fun addressesAndPairingLinks() {
        assertEquals("https://192.168.1.20:8765", MacAddress.normalize("192.168.1.20"))
        assertEquals("https://mac.local:8766", MacAddress.normalize("http://mac.local:8766/path"))
        assertEquals("https://[fe80::1]:8765", MacAddress.normalize("[fe80::1]"))
        assertNull(MacAddress.normalize("ftp://x"))
        assertNull(MacAddress.normalize("a b"))
        assertNull(MacAddress.normalize("mac:99999"))
        val link = PairingLink.parse("jarvis-pair://mac.local:8765?code=123456&fp=${"AB:".repeat(31)}AB&name=My+Mac")!!
        assertEquals("123456", link.code)
        assertEquals("ab".repeat(32), link.fingerprint)
        assertEquals("My Mac", link.macName)
        assertNull(PairingLink.parse("jarvis-pair://mac.local?code=12345&fp=${"ab".repeat(32)}"))
        assertEquals("abab abab abab abab", CertificatePin.short("ab".repeat(32)))
        assertTrue(CertificatePin.accepts("AB".repeat(32), "ab".repeat(32)))
        assertTrue(!CertificatePin.accepts(null, "ab".repeat(32)))
    }

    private inline fun <reified E : Throwable> expect(block: () -> Unit): E {
        try {
            block()
        } catch (e: Throwable) {
            if (e is E) return e
            fail("expected ${E::class.simpleName}, got $e")
        }
        fail("expected ${E::class.simpleName}, got nothing")
        throw IllegalStateException()
    }
}
