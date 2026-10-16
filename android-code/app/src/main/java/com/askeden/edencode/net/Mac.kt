package com.askeden.edencode.net

import com.askeden.edencode.model.text
import org.json.JSONObject
import java.net.URI
import java.net.URLDecoder
import java.security.MessageDigest

/** What went wrong talking to the Mac, in words for the screen (the iPhone app's JarvisError). */
sealed class MacError(val title: String, override val message: String) : Exception(message) {
    /** No connection: the request never reached the Mac, so it's safe to send again later. */
    class Unreachable(detail: String = "") : MacError(
        "Can’t reach the Mac",
        "Is ‘Let my phone connect’ on in Eden Secretary Settings? Your phone and Mac need the same Wi‑Fi, or Tailscale on both.",
    )
    object ConnectionLost : MacError("The connection dropped", "Your Mac may still have got it. The conversation will show it if it did.")
    object Unpaired : MacError("Not paired", "Eden Secretary on your Mac doesn’t know this phone anymore. Pair it again.")
    class WrongCode(said: String) : MacError(
        if (said.contains("too many", ignoreCase = true)) "Too many tries" else "Wrong code",
        said.ifEmpty { "That code isn’t right, or it expired. Make a new one on the Mac." },
    )
    class Rejected(said: String) : MacError("The Mac said no", said)
    object Unavailable : MacError("Not available right now", "Eden Secretary can’t do that right now.")
    class Busy(said: String) : MacError("Eden Secretary is busy", said.ifEmpty { "Try again in a moment." })
    object TooBig : MacError("Too big to send", "Your Mac takes files up to 25 MB from here.")
    object TimedOut : MacError("Still working", "Eden Secretary is taking a while. The reply will show up here when it’s ready.")
    object NotEden : MacError(
        "That isn’t Eden Secretary",
        "Something answered at that address, but it isn’t the Eden Secretary companion. Check the address and port (usually 8765).",
    )
    object Unsupported : MacError("Not on this Mac yet", "Update Eden Secretary on your Mac to use this from your phone.")
    /** 404 with the Mac's reason: what it was about isn't on the Mac anymore. */
    class Gone(val said: String) : MacError("Not on your Mac anymore", "It may have been closed or deleted there.")
    class Server(val status: Int, said: String?) : MacError("The Mac had a problem", said ?: "HTTP $status")
    object InvalidAddress : MacError(
        "Check the address",
        "Enter the Mac’s address, like 192.168.1.20 or my-mac.local. The port is 8765 unless you changed it.",
    )
    object CertificateMismatch : MacError(
        "This isn’t your Mac",
        "The Mac at this address has a different certificate than the one this phone trusts. If you reset it on the Mac, pair again. Otherwise something may be in between: don’t pair on this network.",
    )
    object FingerprintRefused : MacError(
        "Fingerprints don’t match",
        "Your Mac’s certificate isn’t the one this phone saw, so something may be in between. Pair again on your home network.",
    )
    object NotEncrypted : MacError("No secure connection", "Couldn’t set up an encrypted connection. Make sure Eden Secretary on your Mac is up to date.")
    object NotPinned : MacError("Pair again", "Eden Secretary on your Mac now encrypts the connection. Pair again to trust it.")

    /** For a banner: "Title. Message". */
    val description: String
        get() = if (this is Unreachable) "Can’t reach the Mac — is ‘Let my phone connect’ on in Eden Secretary Settings?" else "$title. $message"

    /** The request never got to the Mac: it can go again without doing anything twice. */
    val neverDelivered: Boolean get() = this is Unreachable

    companion object {
        /** A status code and body to the body, or the error it means (JarvisAPI.check). */
        fun check(status: Int, body: String, pairing: Boolean = false): String {
            val said = try {
                JSONObject(body).text("error")
            } catch (_: Exception) {
                null
            }
            when (status) {
                in 200..299 -> return body
                401 -> throw Unpaired
                403 -> throw if (pairing) WrongCode(said ?: "") else Rejected(said ?: "The Mac didn’t allow that.")
                400 -> throw Rejected(said ?: "The Mac didn’t accept that.")
                404 -> {
                    if (pairing) throw NotEden
                    throw if (said != null) Gone(said) else Unsupported
                }
                409 -> throw if (pairing && said == "fingerprint") FingerprintRefused else Rejected(said ?: "The Mac didn’t accept that.")
                413 -> throw TooBig
                429 -> throw Busy(said ?: "")
                503 -> throw Unavailable
                else -> throw Server(status, said)
            }
        }

        fun describe(error: Throwable): String = (error as? MacError)?.description ?: (error.message ?: error.toString())
    }
}

/**
 * The Mac's companion server presents a self-signed certificate; this phone trusts it only by the
 * SHA-256 of its DER bytes (its fingerprint), pinned when pairing.
 */
object CertificatePin {
    fun fingerprint(der: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(der).joinToString("") { "%02x".format(it) }

    /** 64 lowercase hex characters, however it was written ("A1:B2:…"); null when it isn't one. */
    fun normalize(text: String): String? {
        val hex = text.lowercase().filter { it !in ": -" }
        return if (hex.length == 64 && hex.all { it in '0'..'9' || it in 'a'..'f' }) hex else null
    }

    /** "a1b2 c3d4 e5f6 0718": the first 16 hex characters in fours, as the Mac's Settings shows it. */
    fun short(fingerprint: String): String {
        val hex = normalize(fingerprint) ?: fingerprint.lowercase()
        return hex.take(16).chunked(4).joinToString(" ")
    }

    /** Trust only exactly the pinned certificate. No pin, no trust. */
    fun accepts(presented: String?, pinned: String?): Boolean {
        val a = presented?.let(::normalize) ?: return false
        val b = pinned?.let(::normalize) ?: return false
        return a == b
    }
}

/** Turns what someone types for the Mac into the companion's https base URL (Shared/MacAddress.swift). */
object MacAddress {
    const val DEFAULT_PORT = 8765

    fun normalize(raw: String): String? {
        var text = raw.trim()
        val lower = text.lowercase()
        when {
            lower.startsWith("http://") -> text = text.substring(7)
            lower.startsWith("https://") -> text = text.substring(8)
            text.contains("://") -> return null
        }
        text.indexOfFirst { it in "/?#" }.takeIf { it >= 0 }?.let { text = text.substring(0, it) }
        if (text.isEmpty() || text.any { it.isWhitespace() || it == '@' || it == '%' }) return null
        var host = text
        var port: Int? = null
        if (text.startsWith("[")) {
            val close = text.indexOf(']').takeIf { it > 0 } ?: return null
            host = text.substring(1, close)
            val rest = text.substring(close + 1)
            if (rest.startsWith(":")) port = rest.drop(1).toIntOrNull() ?: return null
            else if (rest.isNotEmpty()) return null
        } else if (text.count { it == ':' } == 1) {
            val parts = text.split(":")
            host = parts[0]
            port = parts[1].toIntOrNull() ?: return null
        }
        if (port != null && port !in 1..65535) return null
        return url(host, port ?: DEFAULT_PORT)
    }

    fun url(host: String, port: Int?): String? {
        val h = host.trim()
        if (h.isEmpty()) return null
        val hostPart = if (h.contains(":")) "[$h]" else h
        val s = "https://$hostPart${port?.let { ":$it" } ?: ""}"
        return try {
            if (URI(s).host == null) null else s
        } catch (_: Exception) {
            null
        }
    }

    fun host(base: String): String = URI(base).host.trim('[', ']')
    fun port(base: String): Int = URI(base).port.takeIf { it > 0 } ?: DEFAULT_PORT

    /** "192.168.1.20:8765", for showing to people. */
    fun display(base: String): String = base.removePrefix("https://").removePrefix("http://").trimEnd('/')
}

/** The Mac's pairing QR code: `jarvis-pair://<host>:<port>?code=<6 digits>&fp=<fingerprint>&name=<Mac name>`. */
data class PairingLink(val baseURL: String, val code: String, val fingerprint: String, val macName: String?) {
    val label: String get() = macName ?: MacAddress.display(baseURL)

    companion object {
        const val SCHEME = "jarvis-pair"

        fun parse(raw: String): PairingLink? {
            val text = raw.trim()
            if (!text.lowercase().startsWith("$SCHEME://")) return null
            val uri = try {
                URI(text)
            } catch (_: Exception) {
                return null
            }
            val host = uri.host?.trim('[', ']')?.takeIf { h -> h.isNotEmpty() && h.none { it.isWhitespace() || it == '@' } } ?: return null
            val items = (uri.rawQuery ?: "").split("&").mapNotNull {
                val eq = it.indexOf('=')
                if (eq <= 0) null else it.substring(0, eq).lowercase() to URLDecoder.decode(it.substring(eq + 1), "UTF-8").trim()
            }.toMap()
            val code = items["code"]?.takeIf { c -> c.length == 6 && c.all { it in '0'..'9' } } ?: return null
            val fp = items["fp"]?.let(CertificatePin::normalize) ?: return null
            val url = MacAddress.url(host, uri.port.takeIf { it > 0 } ?: MacAddress.DEFAULT_PORT) ?: return null
            val name = items["name"]?.trim()?.takeIf { it.isNotEmpty() }?.take(80)
            return PairingLink(url, code, fp, name)
        }
    }
}

/** One paired Mac: its address, this phone's own token for it, its pinned certificate, its account device. */
data class Pairing(
    val baseURL: String,
    val token: String,
    val macName: String? = null,
    val deviceName: String? = null,
    val pairedAt: Long = System.currentTimeMillis(),
    val fingerprint: String? = null,
    /** The Mac's device id in the owner's Eden account (from /api/state): what the relay connects to. */
    val macDeviceID: String? = null,
) {
    val address: String get() = MacAddress.display(baseURL)
    val macLabel: String get() = macName?.trim()?.takeIf { it.isNotEmpty() } ?: address
    val isPinned: Boolean get() = baseURL.startsWith("https://") && fingerprint?.let(CertificatePin::normalize) != null
    val shortFingerprint: String? get() = fingerprint?.let(CertificatePin::short)
    /** Its fingerprint, else its address: how it's told apart from the others. */
    val key: String get() = fingerprint?.let(CertificatePin::normalize) ?: baseURL

    fun json(): JSONObject = JSONObject().apply {
        put("baseURL", baseURL); put("token", token); put("pairedAt", pairedAt)
        macName?.let { put("macName", it) }; deviceName?.let { put("deviceName", it) }
        fingerprint?.let { put("fingerprint", it) }; macDeviceID?.let { put("macDeviceID", it) }
    }

    companion object {
        fun from(o: JSONObject): Pairing? {
            val base = o.text("baseURL") ?: return null
            val token = o.text("token") ?: return null
            return Pairing(base, token, o.text("macName"), o.text("deviceName"), o.optLong("pairedAt"), o.text("fingerprint"), o.text("macDeviceID"))
        }

        /** The same Mac: the same pinned certificate, else the same address. */
        fun same(a: Pairing, b: Pairing): Boolean {
            val fa = a.fingerprint?.let(CertificatePin::normalize)
            val fb = b.fingerprint?.let(CertificatePin::normalize)
            return if (fa != null && fb != null) fa == fb else a.baseURL == b.baseURL
        }
    }
}
