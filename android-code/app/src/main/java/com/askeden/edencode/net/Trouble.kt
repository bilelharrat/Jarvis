package com.askeden.edencode.net

import kotlinx.coroutines.CancellationException

/**
 * Why the Mac can't be read right now, in the owner's words, and the way out: try again (offline,
 * the Mac asleep) or pair again (the Mac forgot this phone, its certificate changed). One place
 * decides it so the drawer, the New page and a session all say the same thing.
 */
data class Trouble(val kind: Kind, val title: String, val message: String) {
    enum class Kind { Offline, MacAsleep, Unpaired, TurnedOff, Other }

    /** For the banner: "Title. Message". */
    val text: String get() = "$title. $message"

    /** Pairing again is the only fix when the Mac no longer trusts this phone (or this phone it). */
    val needsPairing: Boolean get() = kind == Kind.Unpaired

    companion object {
        /** Null for a cancelled request (leaving a screen), which is no trouble at all. */
        fun of(error: Throwable, online: Boolean): Trouble? {
            if (error is CancellationException) return null
            // No network at all says more than whatever the request failed with.
            if (!online) return Trouble(
                Kind.Offline, "You’re offline",
                "Eden Code needs Wi‑Fi or mobile data to reach your Mac. It tries again by itself when you’re back online.",
            )
            return when (error) {
                MacError.Unpaired, MacError.NotPinned, MacError.CertificateMismatch, MacError.FingerprintRefused ->
                    Trouble(Kind.Unpaired, "Pair this phone again", error.message ?: "")
                is MacError.Unreachable, MacError.TimedOut, MacError.ConnectionLost -> Trouble(
                    Kind.MacAsleep, "Can’t reach your Mac",
                    "It may be asleep, switched off or on another network. Wake it and check ‘Let my phone connect’ is on in Eden Secretary Settings, then try again.",
                )
                is MacError.Rejected -> if (error.message.contains("Open on my phone") || error.message.contains("Hand off to phone")) Trouble(
                    Kind.TurnedOff, "Turned off on the Mac",
                    "Turn on Eden Code on your phone on the Mac: Eden Code › More › Open on my phone.",
                ) else Trouble(Kind.Other, "Your Mac said no", error.message ?: "")
                is MacError -> Trouble(Kind.Other, "Something went wrong", error.message ?: "")
                else -> Trouble(Kind.Other, "Something went wrong", error.message ?: error.toString())
            }
        }
    }
}
