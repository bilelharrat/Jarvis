package com.askeden.edencode.model

import org.json.JSONArray
import org.json.JSONObject
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter

// Forgiving reads for the Mac's API, as the iPhone app reads it (Shared/Decoding.swift): the Mac
// side is Python and evolves, so a field that goes missing, turns null or changes from a number
// to a string must not break the app, and a list item that doesn't decode is skipped.

/** Thrown by a decoder for an item that can't be read at all (an entry without its `i`). */
class Undecodable(message: String) : Exception(message)

private fun JSONObject.raw(key: String): Any? = if (!has(key) || isNull(key)) null else opt(key)

/** A string, or a number or bool written as one. */
fun JSONObject.text(key: String): String? = when (val v = raw(key)) {
    is String -> v
    is Boolean -> v.toString()
    is Int, is Long -> v.toString()
    is Number -> {
        val d = v.toDouble()
        if (d == Math.rint(d) && Math.abs(d) < 1e15) d.toLong().toString() else d.toString()
    }
    else -> null
}

fun JSONObject.number(key: String): Double? = when (val v = raw(key)) {
    is Boolean -> null
    is Number -> v.toDouble()
    is String -> v.trim().toDoubleOrNull()
    else -> null
}

/** A whole number from an int, a float that is one, or a numeric string; never overflows. */
fun JSONObject.integer(key: String): Int? {
    val v = raw(key)
    if (v is Int) return v
    if (v is Boolean) return null
    val d = number(key) ?: return null
    if (!d.isFinite() || Math.abs(d) >= 9e15) return null
    val whole = d.toLong()
    return if (whole in Int.MIN_VALUE..Int.MAX_VALUE) whole.toInt() else null
}

fun JSONObject.flag(key: String): Boolean? = when (val v = raw(key)) {
    is Boolean -> v
    is Int -> v != 0
    is Long -> v != 0L
    else -> null
}

fun JSONObject.obj(key: String): JSONObject? = raw(key) as? JSONObject

fun JSONObject.array(key: String): JSONArray? = raw(key) as? JSONArray

/** The items that decode; the ones that don't are skipped. */
fun <T> JSONObject.list(key: String, decode: (JSONObject) -> T): List<T> {
    val items = array(key) ?: return emptyList()
    val out = ArrayList<T>(items.length())
    for (n in 0 until items.length()) {
        val item = items.opt(n) as? JSONObject ?: continue
        try {
            out.add(decode(item))
        } catch (_: Undecodable) {
        } catch (_: RuntimeException) {
        }
    }
    return out
}

fun JSONObject.strings(key: String): List<String> {
    val items = array(key) ?: return emptyList()
    return (0 until items.length()).mapNotNull { items.opt(it) as? String }
}

/** A moment as epoch milliseconds: seconds or milliseconds, or ISO 8601 with or without a zone. */
fun JSONObject.date(key: String): Long? {
    number(key)?.let { return LooseDate.epoch(it) }
    val text = raw(key) as? String ?: return null
    return LooseDate.parse(text)
}

object LooseDate {
    /** Epoch seconds; a value that can only be milliseconds is read as such. */
    fun epoch(value: Double): Long? {
        if (!value.isFinite() || value <= 0) return null
        return if (value > 1e11) value.toLong() else (value * 1000).toLong()
    }

    fun parse(raw: String): Long? {
        val text = raw.trim()
        if (text.isEmpty()) return null
        if (text.all { it.isDigit() || it == '.' }) text.toDoubleOrNull()?.let { return epoch(it) }
        try {
            return OffsetDateTime.parse(text).toInstant().toEpochMilli()
        } catch (_: Exception) {
        }
        val plain = text.take(19)
        for (pattern in listOf("yyyy-MM-dd'T'HH:mm:ss", "yyyy-MM-dd'T'HH:mm")) {
            try {
                return LocalDateTime.parse(plain, DateTimeFormatter.ofPattern(pattern))
                    .atZone(ZoneId.systemDefault()).toInstant().toEpochMilli()
            } catch (_: Exception) {
            }
        }
        return try {
            LocalDate.parse(plain.take(10)).atStartOfDay(ZoneId.systemDefault()).toInstant().toEpochMilli()
        } catch (_: Exception) {
            null
        }
    }
}

/** JSON for a request body, leaving out the values that are null (JSONValue.object(dropping:)). */
fun body(vararg pairs: Pair<String, Any?>): JSONObject {
    val o = JSONObject()
    for ((k, v) in pairs) if (v != null) o.put(k, v)
    return o
}
