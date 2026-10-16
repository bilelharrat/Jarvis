package com.askeden.edencode

import com.askeden.edencode.net.MacError
import com.askeden.edencode.net.PairPayload
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** Pairing by QR (the iPhone's PairPayloadTests): the payload parser and the addresses tried in turn. */
class PairPayloadTest {
    private val fp = "ab".repeat(32)

    private fun parse(text: String): PairPayload? = (PairPayload.parse(text) as? PairPayload.Parsed.Ok)?.payload
    private fun problem(text: String): PairPayload.Problem? = (PairPayload.parse(text) as? PairPayload.Parsed.Refused)?.problem

    @Test fun readsTheMacsPayloadExactlyAsItsBuilderWritesIt() {
        val p = parse(
            "edencode://pair?v=1&code=042917&host=Studio.local&ip=192.168.1.20&port=8765" +
                "&fp=$fp&name=Bilel%27s%20Mac%20Studio&ts=studio.tail1234.ts.net&relay=1",
        )!!
        assertEquals("042917", p.code)
        assertEquals("Studio.local", p.host)
        assertEquals("192.168.1.20", p.ip)
        assertEquals(8765, p.port)
        assertEquals(fp, p.fingerprint)
        assertEquals("Bilel's Mac Studio", p.macName)
        assertEquals("studio.tail1234.ts.net", p.tailscale)
        assertTrue(p.relay)
        assertEquals("Bilel's Mac Studio", p.label)
        assertEquals(listOf("https://Studio.local:8765", "https://192.168.1.20:8765", "https://studio.tail1234.ts.net:8765"), p.candidates)
    }

    @Test fun optionalPartsAnyOrderAndUnknownParameters() {
        val p = parse("EDENCODE://pair?fp=${fp.uppercase()}&code=000001&v=1&host=mac.local&port=9000&later=x")!!
        assertEquals(fp, p.fingerprint)
        assertNull(p.ip)
        assertNull(p.tailscale)
        assertNull(p.macName)
        assertFalse(p.relay)
        assertEquals("mac.local", p.label)
        assertEquals(listOf("https://mac.local:9000"), p.candidates)
        // A form encoder's "+" is a space; the host given twice is tried once.
        val plus = parse("edencode://pair?v=1&code=123456&host=10.0.0.7&ip=10.0.0.7&fp=$fp&name=Mac+Mini")!!
        assertEquals("Mac Mini", plus.macName)
        assertEquals(8765, plus.port)
        assertEquals(1, plus.candidates.size)
    }

    @Test fun refusesWhatTheFormatDoesntAllow() {
        val good = "v=1&code=123456&host=mac.local&port=8765&fp=$fp"
        assertEquals("123456", parse("edencode://pair?$good")?.code)
        assertEquals(PairPayload.Problem.NotEdenCode, problem("https://example.com/pair?$good"))
        assertEquals(PairPayload.Problem.NotEdenCode, problem("edencode://session/5"))
        assertEquals(PairPayload.Problem.NotEdenCode, problem("hello"))
        assertEquals(PairPayload.Problem.NewerVersion, problem("edencode://pair?v=2&code=123456&host=mac.local&fp=$fp"))
        for (bad in listOf(
            "code=123456&host=mac.local&fp=$fp", // no version
            "v=1&code=12345&host=mac.local&fp=$fp",
            "v=1&code=1234567&host=mac.local&fp=$fp",
            "v=1&code=12a456&host=mac.local&fp=$fp",
            "v=1&code=%EF%BC%91%EF%BC%92%EF%BC%93%EF%BC%94%EF%BC%95%EF%BC%96&host=mac.local&fp=$fp", // full-width digits
            "v=1&code=123456&fp=$fp", // no host
            "v=1&code=123456&host=evil%20host&fp=$fp",
            "v=1&code=123456&host=a%2Fb&fp=$fp",
            "v=1&code=123456&host=user%40mac.local&fp=$fp",
            "v=1&code=123456&host=mac.local&fp=abc",
            "v=1&code=123456&host=mac.local",
            "v=1&code=123456&host=mac.local&port=0&fp=$fp",
            "v=1&code=123456&host=mac.local&port=70000&fp=$fp",
        )) assertEquals(bad, PairPayload.Problem.Incomplete, problem("edencode://pair?$bad"))
        // A bad optional address is dropped, not trusted.
        val odd = parse("edencode://pair?$good&ip=999.1.1.1&ts=a%20b")!!
        assertNull(odd.ip)
        assertNull(odd.tailscale)
    }

    @Test fun theCompanionsOwnQrCodePairsToo() {
        val p = parse("jarvis-pair://studio.local:8766?code=654321&fp=$fp&name=Studio")!!
        assertEquals("654321", p.code)
        assertEquals(listOf("https://studio.local:8766"), p.candidates)
        assertEquals("Studio", p.macName)
        assertEquals(PairPayload.Problem.Incomplete, problem("jarvis-pair://studio.local?code=1&fp=$fp"))
    }

    @Test fun everyProblemHasWordsForTheOwner() {
        for (p in PairPayload.Problem.entries) assertTrue(PairPayload.message(p).isNotEmpty())
    }

    /** A camera's view of a code: pale wall, dark modules of [px] each, a quiet zone of 4. */
    private fun frame(dark: (Int, Int) -> Boolean, modules: Int, px: Int): Triple<ByteArray, Int, Int> {
        val n = (modules + 8) * px + 120
        val frame = ByteArray(n * n) { 0xEE.toByte() }
        val at = 60 + 4 * px
        for (y in 0 until modules) for (x in 0 until modules) if (dark(x, y)) {
            for (dy in 0 until px) for (dx in 0 until px) frame[(at + y * px + dy) * n + at + x * px + dx] = 0x10
        }
        return Triple(frame, n, n)
    }

    // The scanner's own decoding, on the Mac's own encoder's output (src/jarvis/qr.py, level M,
    // written to test resources from code_phone_pair's payload): it reads back to the payload.
    @Test fun aCameraFrameOfTheMacsOwnCodeReadsBack() {
        val lines = javaClass.classLoader!!.getResource("mac-pair-qr.txt")!!.readText().trim().lines()
        val text = lines.first()
        val rows = lines.drop(1)
        val (f, w, h) = frame({ x, y -> rows[y][x] == '1' }, rows.size, 9)
        val read = com.askeden.edencode.ui.QrDecode.text(com.askeden.edencode.ui.QrDecode.reader(), f, w, h)
        assertEquals(text, read)
        assertEquals("Bilel's Mac Studio", parse(read!!)!!.macName)
        // Nothing to read in a blank frame.
        assertNull(com.askeden.edencode.ui.QrDecode.text(com.askeden.edencode.ui.QrDecode.reader(), ByteArray(w * h) { 0x7F }, w, h))
    }

    @Test fun anotherEncodersCodeAtLevelMReadsBackToo() {
        val text = "edencode://pair?v=1&code=000001&host=mac.local&port=8765&fp=$fp&relay=1"
        val m = com.google.zxing.qrcode.encoder.Encoder.encode(text, com.google.zxing.qrcode.decoder.ErrorCorrectionLevel.M).matrix
        val (f, w, h) = frame({ x, y -> m.get(x, y).toInt() == 1 }, m.width, 8)
        assertEquals(text, com.askeden.edencode.ui.QrDecode.text(com.askeden.edencode.ui.QrDecode.reader(), f, w, h))
    }

    private val payload = PairPayload("123456", "mac.local", ip = "10.0.0.7", port = 8765, fingerprint = fp, macName = "Studio", tailscale = "studio.ts.net")

    @Test fun pairingTriesTheNextAddressOnlyWhileTheMacIsntThere() {
        val tried = mutableListOf<String>()
        val result = PairPayload.pair(payload) { base, pinned, code ->
            tried += base
            assertEquals(fp, pinned) // always the code's fingerprint
            assertEquals("123456", code)
            if (base.contains("mac.local")) throw MacError.Unreachable("no mDNS")
            base
        }
        assertEquals(listOf("https://mac.local:8765", "https://10.0.0.7:8765"), tried)
        assertEquals("https://10.0.0.7:8765", result)
    }

    @Test fun aMacThatAnswersEndsItSoTheCodeIsOfferedOnce() {
        var tried = 0
        try {
            PairPayload.pair(payload) { _, _, _ -> tried++; throw MacError.WrongCode("That code isn't right, or it expired.") }
            fail("paired with a wrong code")
        } catch (e: MacError) {
            assertEquals(1, tried)
            assertTrue(PairPayload.scanProblem(e).contains("New code"))
        }
        // Another certificate at every address: each skipped, the code never accepted.
        var mismatched = 0
        try {
            PairPayload.pair(payload) { _, _, _ -> mismatched++; throw MacError.CertificateMismatch }
            fail("paired past a certificate that isn't the Mac's")
        } catch (e: MacError) {
            assertEquals(3, mismatched)
            assertTrue(PairPayload.scanProblem(e).contains("wasn’t sent"))
        }
    }
}
