package com.askeden.edencode.net

import java.net.InetSocketAddress
import java.net.Socket

/**
 * How a request reaches the paired Mac (the iPhone app's MacRouter): straight to its address while
 * that answers, else, when this phone is signed in to the owner's Eden account and the Mac is linked
 * to it, through the encrypted relay. Whether the address answers is a quick TCP knock (1.5 s at
 * most), remembered for 30 seconds and forgotten whenever the network changes.
 */
class MacRouter(
    /** The account's device token on this phone, or null while signed out. */
    private val accountToken: () -> String?,
    private val knock: (String, Int) -> Boolean = { host, port -> probe(host, port, PROBE_TIMEOUT_MS) },
    private val makeTunnel: (String) -> RelayTunnel = { mac -> RelayTunnel.live(mac, accountToken) },
    private val clock: () -> Long = System::currentTimeMillis,
) {
    enum class Route { Direct, Relay }

    private data class Config(val direct: String?, val macDeviceID: String?, val signedIn: Boolean)

    private var config: Config? = null
    private val probes = HashMap<String, Pair<Long, Boolean>>()
    private var tunnel: RelayTunnel? = null

    /** The way the last request went, for the screen. */
    @Volatile
    var lastRoute: Route = Route.Direct
        private set

    @Synchronized
    fun configure(direct: String?, macDeviceID: String?) {
        val next = Config(direct, macDeviceID?.takeIf { it.isNotEmpty() }, accountToken() != null)
        if (next == config) return
        config = next
        if (tunnel?.macDeviceID != next.macDeviceID || !next.signedIn) {
            tunnel?.stop()
            tunnel = null
        }
    }

    @Synchronized
    fun networkChanged() {
        probes.clear()
    }

    /** Where a request meant for `direct` goes right now: `direct` itself, or the relay. */
    fun base(direct: String): String {
        val (mac, refused) = synchronized(this) {
            val c = config ?: return direct
            if (!c.signedIn || c.macDeviceID == null || !same(direct, c.direct)) return direct
            c.macDeviceID to (tunnel?.refusedRecently ?: false)
        }
        val route = decide(isReachable(direct), accountToken() != null, mac, refused)
        lastRoute = route
        if (route != Route.Relay) return direct
        return relayBase(mac) ?: direct.also { lastRoute = Route.Direct }
    }

    /** `direct` just couldn't be reached: the relay's address to try once more, or null. */
    fun directFailed(direct: String): String? {
        val mac = synchronized(this) {
            val c = config ?: return null
            if (!c.signedIn || c.macDeviceID == null || !same(direct, c.direct) || tunnel?.refusedRecently == true) return null
            probes[key(direct)] = clock() to false
            c.macDeviceID
        }
        lastRoute = Route.Relay
        return relayBase(mac)
    }

    /** A request through the relay broke before the Mac answered: true when nothing was delivered. */
    fun relayFailed(): Boolean {
        repeat(5) {
            if (synchronized(this) { tunnel?.refusedRecently } == true) {
                lastRoute = Route.Direct
                return true
            }
            Thread.sleep(100)
        }
        return false
    }

    private fun relayBase(mac: String): String? {
        val t = synchronized(this) { tunnel ?: makeTunnel(mac).also { tunnel = it } }
        val port = try {
            t.start()
        } catch (_: Exception) {
            return null
        }
        return "https://127.0.0.1:$port"
    }

    private fun isReachable(direct: String): Boolean {
        val k = key(direct)
        synchronized(this) {
            probes[k]?.let { (at, reachable) -> if (clock() - at < PROBE_LIFE_MS) return reachable }
        }
        val reachable = try {
            knock(MacAddress.host(direct), MacAddress.port(direct))
        } catch (_: Exception) {
            true
        }
        synchronized(this) { probes[k] = clock() to reachable }
        return reachable
    }

    companion object {
        const val PROBE_TIMEOUT_MS = 1500
        const val PROBE_LIFE_MS = 30_000L

        /** The whole decision (MacRouter.decide on the iPhone). */
        fun decide(directReachable: Boolean, signedIn: Boolean, macDeviceID: String?, relayRefused: Boolean): Route =
            if (directReachable || !signedIn || macDeviceID.isNullOrEmpty() || relayRefused) Route.Direct else Route.Relay

        fun key(url: String): String = "${MacAddress.host(url)}:${MacAddress.port(url)}"

        fun same(a: String, b: String?): Boolean = b != null && a.substringBefore("://") == b.substringBefore("://") && key(a) == key(b)

        /** A TCP knock on the Mac's address: true when it connects within the timeout. */
        fun probe(host: String, port: Int, timeoutMs: Int): Boolean = try {
            Socket().use { it.connect(InetSocketAddress(host, port), timeoutMs); true }
        } catch (_: Exception) {
            false
        }
    }
}
