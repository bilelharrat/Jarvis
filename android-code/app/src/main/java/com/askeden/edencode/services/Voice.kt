package com.askeden.edencode.services

import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.askeden.edencode.model.Spoken
import java.util.Locale

/**
 * Dictation into the composer and spoken review (the iPhone app's Voice.swift): Android's
 * SpeechRecognizer, on the phone when it can, the words shown as they come and nothing sent until
 * the owner taps send; and TextToSpeech for a reply, a step list or a diff read aloud, code read as
 * words (Spoken).
 */
class Voice(context: Context) {
    private val app = context.applicationContext
    private val main = Handler(Looper.getMainLooper())

    var listening by mutableStateOf(false); private set
    var problem by mutableStateOf<String?>(null); private set
    /** The words heard so far this time. */
    var heard by mutableStateOf(""); private set
    /** What's being read (an id the screen chose), so its button shows Stop. */
    var speaking by mutableStateOf<String?>(null); private set

    /** Asks for the microphone; set by the activity. */
    var askMicrophone: (suspend () -> Boolean)? = null

    private var recognizer: SpeechRecognizer? = null
    private var tts: TextToSpeech? = null
    private var ttsReady = false
    private var pending: Pair<String, String>? = null

    suspend fun toggleDictation() {
        if (listening) stopDictation() else startDictation()
    }

    suspend fun startDictation() {
        problem = null
        heard = ""
        if (askMicrophone?.invoke() == false) {
            problem = "Turn on the microphone for Eden Code in Settings › Apps › Eden Code › Permissions."
            return
        }
        if (!SpeechRecognizer.isRecognitionAvailable(app)) {
            problem = "Dictation isn’t available right now."
            return
        }
        val onDevice = Build.VERSION.SDK_INT >= 31 && SpeechRecognizer.isOnDeviceRecognitionAvailable(app)
        val r = if (onDevice) SpeechRecognizer.createOnDeviceSpeechRecognizer(app) else SpeechRecognizer.createSpeechRecognizer(app)
        recognizer = r
        r.setRecognitionListener(object : RecognitionListener {
            override fun onReadyForSpeech(params: Bundle?) {}
            override fun onBeginningOfSpeech() {}
            override fun onRmsChanged(rmsdB: Float) {}
            override fun onBufferReceived(buffer: ByteArray?) {}
            override fun onEndOfSpeech() {}
            override fun onEvent(eventType: Int, params: Bundle?) {}
            override fun onError(error: Int) {
                if (error == SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS) {
                    problem = "Turn on the microphone for Eden Code in Settings › Apps › Eden Code › Permissions."
                } else if (error != SpeechRecognizer.ERROR_NO_MATCH && error != SpeechRecognizer.ERROR_SPEECH_TIMEOUT) {
                    problem = "Dictation stopped. Try again."
                }
                stopDictation()
            }

            override fun onResults(results: Bundle?) {
                words(results)?.let { heard = it }
                stopDictation()
            }

            override fun onPartialResults(partialResults: Bundle?) {
                words(partialResults)?.let { heard = it }
            }
        })
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault().toLanguageTag())
            if (Build.VERSION.SDK_INT >= 33) putExtra(RecognizerIntent.EXTRA_ENABLE_FORMATTING, RecognizerIntent.FORMATTING_OPTIMIZE_QUALITY)
        }
        try {
            r.startListening(intent)
            listening = true
        } catch (_: Exception) {
            problem = "Couldn’t start the microphone."
            stopDictation()
        }
    }

    private fun words(b: Bundle?): String? = b?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.takeIf { it.isNotBlank() }

    fun stopDictation() {
        val r = recognizer ?: run { listening = false; return }
        recognizer = null
        listening = false
        try {
            r.stopListening()
            r.destroy()
        } catch (_: Exception) {
        }
    }

    // ── Reading aloud ──

    fun toggle(text: String, id: String) {
        if (speaking == id) stopSpeaking() else speak(text, id)
    }

    fun speak(text: String, id: String) {
        stopSpeaking()
        speaking = id
        val engine = tts
        if (engine == null || !ttsReady) {
            pending = text to id
            if (engine == null) tts = TextToSpeech(app) { status ->
                ttsReady = status == TextToSpeech.SUCCESS
                main.post {
                    if (!ttsReady) {
                        speaking = null
                        return@post
                    }
                    tts?.language = Locale.getDefault()
                    tts?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                        override fun onStart(utteranceId: String?) {}
                        override fun onDone(utteranceId: String?) { main.post { if (speaking == utteranceId) speaking = null } }
                        @Deprecated("Deprecated in Java")
                        override fun onError(utteranceId: String?) { main.post { if (speaking == utteranceId) speaking = null } }
                    })
                    pending?.let { (t, i) -> pending = null; say(t, i) }
                }
            }
            return
        }
        say(text, id)
    }

    private fun say(text: String, id: String) {
        speaking = id
        tts?.speak(Spoken.text(text), TextToSpeech.QUEUE_FLUSH, null, id)
    }

    fun stopSpeaking() {
        pending = null
        tts?.stop()
        speaking = null
    }
}
