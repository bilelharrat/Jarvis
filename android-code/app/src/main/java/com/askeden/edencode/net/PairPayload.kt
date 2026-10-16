package com.askeden.edencode.net

import java.net.URI
import java.net.URLDecoder

/**
 * The Mac's pairing QR code for the native apps (PairPayload.swift on the iPhone; the Mac builds
 * it in src/jarvis/features/code_phone_pair.py):
 *
 *     edencode://pair?v=1&code=<6 digits>&host=<mac .local name>&ip=<LAN IPv4, optional>
 *         &port=<companion port>&fp=<sha256 hex of the Mac's certificate>&name=<Mac name>
 *         &ts=<Tailscale host, optional>&relay=1 (optional)
 *
 * The companion's own jarvis-pair:// link is read too. Scanning pins the fingerprint from the
 * first byte (nothing to compare by eye) and pairs with the code. Cost policy: no model calls.
 */
data class PairPayload(
    val code: String,
    val host: String,
    val ip: String? = null,
    val port: Int = MacAddress.DEFAULT_PORT,
    val fingerprint: String,
    val macName: String? = null,
    val tailscale: String? = null,
    val relay: Boolean = false,
) {
    enum class Problem {
        /** Not a pairing code at all. */
        NotEdenCode,
        /** From a Mac newer than this app: update Eden Code. */
        NewerVersion,
        /** Ours, but something is missing or malformed. */
        Incomplete,
    }

    sealed class Parsed {
        data class Ok(val payload: PairPayload) : Parsed()
        data class Refused(val problem: Problem) : Parsed()
    }

    /** What to call the Mac while pairing. */
    val label: String get() = macName ?: host

    /**
     * Where to try, in order: the .local name, the LAN address, Tailscale. Each pinned to the same
     * fingerprint, so trying several never sends the code anywhere else.
     */
    val candidates: List<String>
        get() {
            val seen = mutableSetOf<String>()
            return listOfNotNull(host, ip, tailscale).filter { seen.add(it.lowercase()) }.mapNotNull { MacAddress.url(it, port) }
        }

    companion object {
        const val SCHEME = "edencode"
        const val VERSION = 1

        /** A scanned or opened code: Eden Code's own, or the companion's jarvis-pair link. */
        fun parse(raw: String): Parsed {
            val text = raw.trim()
            val lower = text.lowercase()
            if (lower.startsWith("${PairingLink.SCHEME}://")) {
                val link = PairingLink.parse(text) ?: return Parsed.Refused(Problem.Incomplete)
                return Parsed.Ok(PairPayload(link.code, MacAddress.host(link.baseURL), port = MacAddress.port(link.baseURL),
                    fingerprint = link.fingerprint, macName = link.macName))
            }
            if (!lower.startsWith("$SCHEME://")) return Parsed.Refused(Problem.NotEdenCode)
            val uri = try {
                URI(text)
            } catch (_: Exception) {
                return Parsed.Refused(Problem.NotEdenCode)
            }
            if (uri.host?.lowercase() != "pair") return Parsed.Refused(Problem.NotEdenCode)
            val items = (uri.rawQuery ?: "").split("&").mapNotNull { item ->
                val eq = item.indexOf('=')
                if (eq <= 0) null else item.substring(0, eq).lowercase() to item.substring(eq + 1)
            }
            fun value(name: String): String? {
                // A form encoder's "+" is a space; URLDecoder undoes it and the %-escapes.
                val raw = items.firstOrNull { it.first == name }?.second ?: return null
                val clean = try {
                    URLDecoder.decode(raw, "UTF-8").trim()
                } catch (_: IllegalArgumentException) {
                    return null
                }
                return clean.ifEmpty { null }
            }
            val version = value("v")?.toIntOrNull() ?: return Parsed.Refused(Problem.Incomplete)
            if (version > VERSION) return Parsed.Refused(Problem.NewerVersion)
            if (version < 1) return Parsed.Refused(Problem.Incomplete)
            val code = value("code")?.takeIf { c -> c.length == 6 && c.all { it in '0'..'9' } } ?: return Parsed.Refused(Problem.Incomplete)
            val host = value("host")?.let(::hostName) ?: return Parsed.Refused(Problem.Incomplete)
            val fp = value("fp")?.let(CertificatePin::normalize) ?: return Parsed.Refused(Problem.Incomplete)
            var port = MacAddress.DEFAULT_PORT
            value("port")?.let { text ->
                port = text.toIntOrNull()?.takeIf { it in 1..65535 } ?: return Parsed.Refused(Problem.Incomplete)
            }
            return Parsed.Ok(
                PairPayload(
                    code = code, host = host, ip = value("ip")?.let(::ipv4), port = port, fingerprint = fp,
                    macName = value("name")?.take(80), tailscale = value("ts")?.let(::hostName), relay = value("relay") == "1",
                ),
            )
        }

        /** A host name or IPv4 address, nothing that could carry a path, a user or a port. */
        fun hostName(text: String): String? {
            val host = text.removeSuffix(".")
            if (host.length !in 1..253) return null
            if (!host.all { it.code < 128 && (it.isLetterOrDigit() || it == '.' || it == '-') }) return null
            if (host.first() == '.' || host.first() == '-' || host.last() == '-') return null
            return host
        }

        fun ipv4(text: String): String? {
            val parts = text.split(".")
            if (parts.size != 4) return null
            if (!parts.all { p -> p.isNotEmpty() && p.length <= 3 && p.all { it in '0'..'9' } && p.toInt() <= 255 }) return null
            return text
        }

        /** What to tell the owner about a code that didn't parse. */
        fun message(problem: Problem): String = when (problem) {
            Problem.NotEdenCode -> "That isn’t an Eden Code pairing code. Use the one in Eden Code › On your phone on your Mac."
            Problem.NewerVersion -> "This code is from a newer Eden on your Mac. Update Eden Code, then scan again."
            Problem.Incomplete -> "That pairing code is incomplete. Click New code on your Mac and scan again."
        }

        /** Why pairing with a scanned code failed, in the owner's words (PairingView.scanProblem). */
        fun scanProblem(error: Throwable): String = when (error) {
            is MacError.WrongCode -> if (error.message.contains("too many", ignoreCase = true)) error.message
                else "That code was used or has expired. Click New code on your Mac and scan again."
            is MacError.Rejected -> "That code was used or has expired. Click New code on your Mac and scan again."
            MacError.CertificateMismatch, MacError.FingerprintRefused ->
                "Something other than your Mac answered at its address, so the code wasn’t sent. Check you’re on the same Wi-Fi and scan again."
            is MacError.Unreachable, MacError.TimedOut, MacError.ConnectionLost ->
                "Can’t reach your Mac. Use the same Wi-Fi, or turn on Tailscale or sign in to your Eden account, then scan again."
            else -> MacError.describe(error)
        }

        /** Whether the next address is worth a try: this one wasn't the Mac (or wasn't reachable). */
        fun tryNext(error: Throwable): Boolean = when (error) {
            is MacError.Unreachable, MacError.ConnectionLost, MacError.TimedOut, MacError.CertificateMismatch,
            MacError.FingerprintRefused, MacError.NotEncrypted, MacError.NotEden, MacError.Unsupported, MacError.InvalidAddress -> true
            is MacError -> false
            else -> error is java.io.IOException
        }

        /**
         * Pairs with a scanned code: its addresses in turn, each pinned to the code's fingerprint,
         * while one can't be reached or presents another certificate; a Mac that answers (a wrong
         * or expired code, say) ends it, so the code is never offered twice.
         */
        fun <T> pair(payload: PairPayload, attempt: (base: String, fingerprint: String, code: String) -> T): T {
            var last: Throwable = MacError.InvalidAddress
            for (base in payload.candidates) {
                try {
                    return attempt(base, payload.fingerprint, payload.code)
                } catch (e: Exception) {
                    last = e
                    if (!tryNext(e)) throw e
                }
            }
            throw last
        }
    }
}
