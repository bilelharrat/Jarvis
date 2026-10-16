package com.askeden.edencode.store

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import com.askeden.edencode.net.MacApi
import com.askeden.edencode.net.MacAddress
import com.askeden.edencode.net.MacError
import com.askeden.edencode.net.CertificatePin
import com.askeden.edencode.net.Pairing
import org.json.JSONArray
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Secrets kept on this phone only (the iPhone's Keychain): sealed with an AES key that lives in the
 * Android Keystore and never leaves it, the sealed bytes in the app's private preferences, left out
 * of backups (backup_rules.xml).
 */
class SecureStore(context: Context) {
    private val prefs = context.getSharedPreferences("edencode.secure", Context.MODE_PRIVATE)

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .build(),
        )
        return gen.generateKey()
    }

    fun read(name: String): String? {
        val sealed = prefs.getString(name, null) ?: return null
        return try {
            val raw = Base64.decode(sealed, Base64.NO_WRAP)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, raw, 0, 12))
            String(cipher.doFinal(raw, 12, raw.size - 12), Charsets.UTF_8)
        } catch (_: Exception) {
            null
        }
    }

    fun write(name: String, value: String?) {
        if (value == null) {
            prefs.edit().remove(name).apply()
            return
        }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val sealed = cipher.iv + cipher.doFinal(value.toByteArray(Charsets.UTF_8))
        prefs.edit().putString(name, Base64.encodeToString(sealed, Base64.NO_WRAP)).apply()
    }

    companion object {
        private const val ALIAS = "edencode.secrets.v1"
    }
}

/**
 * The Macs this phone's Eden Code is paired with, each with its own device token, and the one in
 * use (EdenCode/Model/MacStore.swift). A Mac paired again (the same certificate) replaces its old pairing.
 */
object MacStore {
    const val ACCOUNT = "edencode.macs.v1"
    const val MOST = 8

    fun decode(json: String?): List<Pairing> {
        if (json.isNullOrEmpty()) return emptyList()
        return try {
            val a = JSONArray(json)
            (0 until a.length()).mapNotNull { a.optJSONObject(it)?.let(Pairing::from) }
        } catch (_: Exception) {
            emptyList()
        }
    }

    fun encode(macs: List<Pairing>): String = JSONArray().apply { macs.take(MOST).forEach { put(it.json()) } }.toString()

    fun adding(pairing: Pairing, to: List<Pairing>): List<Pairing> {
        val list = to.toMutableList()
        val index = list.indexOfFirst { Pairing.same(it, pairing) }
        if (index >= 0) list[index] = pairing else list.add(pairing)
        return list.takeLast(MOST)
    }

    fun removing(pairing: Pairing, from: List<Pairing>): List<Pairing> = from.filter { !Pairing.same(it, pairing) }

    fun current(macs: List<Pairing>, currentID: String?): Pairing? = macs.firstOrNull { it.key == currentID } ?: macs.firstOrNull()

    /** Step one: the Mac's address and its certificate's fingerprint (trust on first use: nothing is sent). */
    fun probe(address: String): Pair<String, String> {
        val base = MacAddress.normalize(address) ?: throw MacError.InvalidAddress
        val fp = MacApi.probeFingerprint(base)
        return base to (CertificatePin.normalize(fp) ?: fp)
    }

    /** Step two: the six-digit code for this app's own token, over the pinned connection. */
    fun pair(base: String, fingerprint: String, code: String, deviceName: String): Pairing {
        val result = MacApi(base, null, fingerprint).pair(code, deviceName)
        var pairing = Pairing(base, result.token, result.macName, deviceName, System.currentTimeMillis(), fingerprint)
        try {
            pairing = pairing.copy(macDeviceID = MacApi(base, result.token, fingerprint).accountDeviceID())
        } catch (_: Exception) {
        }
        return pairing
    }
}
