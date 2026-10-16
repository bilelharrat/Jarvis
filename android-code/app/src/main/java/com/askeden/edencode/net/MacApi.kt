package com.askeden.edencode.net

import com.askeden.edencode.model.body
import com.askeden.edencode.model.text
import okhttp3.ConnectionSpec
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.IOException
import java.io.InterruptedIOException
import java.net.ConnectException
import java.net.NoRouteToHostException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.security.SecureRandom
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLException
import javax.net.ssl.X509TrustManager

/** The certificate presented isn't the pinned one (or this was a capture): the handshake stops here. */
class PinRefused(val presented: String?) : CertificateException("certificate not pinned")

/**
 * Answers the TLS server-trust check: with a pin, only that exact certificate (by the SHA-256 of
 * its DER bytes) is accepted; with none (capture), the presented one is noted and the connection
 * refused, so nothing is ever sent to a server not yet trusted. The host name isn't checked: the
 * pin is on the certificate alone, which is what lets the relay's 127.0.0.1 carry it.
 */
class PinTrustManager(private val pinned: String?) : X509TrustManager {
    @Volatile
    var presented: String? = null
        private set

    override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
        val leaf = chain?.firstOrNull() ?: throw PinRefused(null)
        val fp = CertificatePin.fingerprint(leaf.encoded)
        presented = fp
        if (!CertificatePin.accepts(fp, pinned)) throw PinRefused(fp)
    }

    override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) = throw CertificateException("no clients")
    override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
}

/** One OkHttp client per pinned certificate, so a connection trusted under one pin is never reused under another. */
object PinnedClients {
    private val clients = ConcurrentHashMap<String, OkHttpClient>()

    fun builder(trust: X509TrustManager): OkHttpClient.Builder {
        val context = SSLContext.getInstance("TLS")
        context.init(null, arrayOf(trust), SecureRandom())
        return OkHttpClient.Builder()
            .sslSocketFactory(context.socketFactory, trust)
            .hostnameVerifier { _, _ -> true }
            .connectionSpecs(listOf(ConnectionSpec.MODERN_TLS))
            .followRedirects(false)
            .retryOnConnectionFailure(false)
            .cache(null)
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.SECONDS)
            .callTimeout(180, TimeUnit.SECONDS)
    }

    fun forPin(fingerprint: String): OkHttpClient = clients.getOrPut(fingerprint) { builder(PinTrustManager(fingerprint)).build() }
}

/** The relay, for every request (null in tests and before the app sets it). */
object MacRoute {
    @Volatile
    var router: MacRouter? = null
}

/** The six-digit code's answer. */
data class PairResult(val token: String, val fingerprint: String?, val macName: String?)

/**
 * The Mac's companion API (jarvis.remote): HTTPS to a pinned self-signed certificate, bearer token,
 * JSON. Every call goes straight to the Mac, or through the relay when its address can't be reached.
 */
class MacApi(val baseURL: String, val token: String?, val fingerprint: String?) {
    private val pin: String? get() = fingerprint?.let(CertificatePin::normalize)

    /** Pairing: the six-digit code for this phone's own token, over the pinned connection. */
    fun pair(code: String, deviceName: String): PairResult {
        val fp = pin ?: throw MacError.NotPinned
        val reply = send(
            "api/pair",
            body = body("code" to code, "device_name" to deviceName, "name" to deviceName, "fingerprint" to fp, "platform" to "android").toString(),
            timeoutSeconds = 12, authorized = false, pairing = true,
        )
        val o = parse(reply)
        val token = o.text("token")?.takeIf { it.isNotEmpty() } ?: throw MacError.NotEden
        val echoed = o.text("fingerprint")?.let(CertificatePin::normalize)
        if (echoed != null && echoed != fp) throw MacError.FingerprintRefused
        return PairResult(token, echoed, o.text("mac_name")?.trim()?.takeIf { it.isNotEmpty() })
    }

    /** /api/state's `account.device_id`: which device the relay connects to, once the Mac is linked. */
    fun accountDeviceID(): String? {
        val o = get("api/state", timeoutSeconds = 8)
        return o.optJSONObject("account")?.text("device_id")?.trim()?.takeIf { it.isNotEmpty() }
    }

    /** environment: "fcm" for Firebase tokens (the Mac needs FCM sending for these: see README). */
    fun registerPush(token: String, environment: String, bundleID: String) {
        post("api/push/register", body("token" to token, "environment" to environment, "bundle_id" to bundleID, "platform" to "android"), 10)
    }

    fun unregisterPush() {
        post("api/push/unregister", JSONObject(), 6)
    }

    /** The window's own actions (the companion's /api/code/action: pr_draft, pr_open…). */
    fun codeAction(action: String, session: Int?, fields: JSONObject = JSONObject(), timeoutSeconds: Long = 45): JSONObject {
        fields.put("action", action)
        if (session != null) fields.put("id", session)
        return post("api/code/action", fields, timeoutSeconds)
    }

    /** A message with pictures, through /api/code/send (the phone API's send is text only). */
    fun codeSend(id: Int, text: String, pictures: List<Picture>): Boolean {
        val images = org.json.JSONArray()
        for (p in pictures) images.put(body("media_type" to p.mediaType, "data" to java.util.Base64.getEncoder().encodeToString(p.data), "name" to p.name))
        val reply = send(
            "api/code/send", body = body("id" to id, "text" to text, "images" to images).toString(),
            timeoutSeconds = if (pictures.isEmpty()) 15 else 120, headers = if (pictures.isEmpty()) emptyMap() else mapOf("x-jarvis-pictures" to "1"),
        )
        return parse(reply).optBoolean("ok", true)
    }

    fun get(path: String, query: Map<String, String> = emptyMap(), timeoutSeconds: Long = 15): JSONObject =
        parse(send(path, query = query, timeoutSeconds = timeoutSeconds))

    fun post(path: String, json: JSONObject, timeoutSeconds: Long = 20): JSONObject =
        parse(send(path, body = json.toString(), timeoutSeconds = timeoutSeconds))

    /** The plumbing: straight to the Mac, or through the relay when its address can't be reached. */
    fun send(
        path: String,
        query: Map<String, String> = emptyMap(),
        body: String? = null,
        timeoutSeconds: Long,
        authorized: Boolean = true,
        pairing: Boolean = false,
        headers: Map<String, String> = emptyMap(),
    ): String {
        if (!baseURL.startsWith("https://")) throw MacError.NotPinned
        val fp = pin ?: throw MacError.NotPinned
        val router = MacRoute.router
        val base = router?.base(baseURL) ?: baseURL
        val attempt = { b: String -> perform(path, b, b != baseURL, fp, query, body, timeoutSeconds, authorized, pairing, headers) }
        return try {
            attempt(base)
        } catch (e: MacError) {
            if (!e.neverDelivered || base != baseURL || router == null) throw e
            // Never got there, so it's safe to send once more, through the relay.
            val relay = router.directFailed(baseURL) ?: throw e
            attempt(relay)
        }
    }

    private fun perform(
        path: String, base: String, relayed: Boolean, fp: String, query: Map<String, String>, body: String?,
        timeoutSeconds: Long, authorized: Boolean, pairing: Boolean, headers: Map<String, String>,
    ): String {
        val url = try {
            (base.trimEnd('/') + "/" + path).toHttpUrl().newBuilder().apply {
                for ((k, v) in query.toSortedMap()) addQueryParameter(k, v)
            }.build()
        } catch (_: IllegalArgumentException) {
            throw MacError.InvalidAddress
        }
        val request = Request.Builder().url(url).header("Accept", "application/json").apply {
            if (body != null) post(body.toRequestBody("application/json".toMediaType()))
            if (authorized && token != null) header("Authorization", "Bearer $token")
            for ((k, v) in headers) header(k, v)
        }.build()
        val client = PinnedClients.forPin(fp).newBuilder().callTimeout(timeoutSeconds, TimeUnit.SECONDS).build()
        try {
            client.newCall(request).execute().use { response ->
                val text = response.body?.string() ?: ""
                return MacError.check(response.code, text, pairing)
            }
        } catch (e: IOException) {
            val mapped = map(e)
            // Through the relay, a stream that broke before the Mac said anything never delivered it.
            if (relayed && mapped !is MacError.CertificateMismatch && mayBeRelayRefusal(mapped) && MacRoute.router?.relayFailed() == true) {
                throw MacError.Unreachable("Your Mac isn’t connected to the Eden Secretary relay right now.")
            }
            throw mapped
        }
    }

    private fun mayBeRelayRefusal(e: MacError) = e is MacError.ConnectionLost || e is MacError.NotEncrypted || e is MacError.Unreachable

    private fun parse(text: String): JSONObject = try {
        JSONObject(text)
    } catch (_: Exception) {
        throw MacError.NotEden
    }

    companion object {
        /** OkHttp's errors in the app's words; a refused certificate is the pin's own exception. */
        fun map(e: IOException): MacError {
            var cause: Throwable? = e
            while (cause != null) {
                if (cause is PinRefused) return MacError.CertificateMismatch
                cause = cause.cause
            }
            return when (e) {
                is SocketTimeoutException -> MacError.TimedOut
                is InterruptedIOException -> if (e.message?.contains("timeout", true) == true) MacError.TimedOut else MacError.ConnectionLost
                is UnknownHostException, is ConnectException, is NoRouteToHostException -> MacError.Unreachable(e.message ?: "")
                is SSLException -> MacError.NotEncrypted
                else -> MacError.ConnectionLost
            }
        }

        /**
         * Trust on first use: connect, read the certificate the Mac presents, and hang up before
         * sending anything. Returns its fingerprint for the owner to compare with the Mac's Settings.
         */
        fun probeFingerprint(base: String): String {
            if (!base.startsWith("https://")) throw MacError.NotEncrypted
            val capture = PinTrustManager(null)
            val client = PinnedClients.builder(capture).callTimeout(15, TimeUnit.SECONDS).connectTimeout(8, TimeUnit.SECONDS).build()
            val request = Request.Builder().url(base.trimEnd('/') + "/api/state").build()
            try {
                client.newCall(request).execute().close()
            } catch (e: IOException) {
                capture.presented?.let { return it }
                val mapped = map(e)
                throw if (mapped is MacError.CertificateMismatch) MacError.NotEncrypted else mapped
            } finally {
                client.connectionPool.evictAll()
            }
            // An answer without our check can't be TLS to a self-signed server.
            throw MacError.NotEncrypted
        }
    }
}

/** A picture sent with a message (JPEG, at most 8 MB), as the Mac's composer takes them. */
class Picture(val name: String, val mediaType: String, val data: ByteArray)
