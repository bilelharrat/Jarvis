package com.askeden.edencode.net

import com.askeden.edencode.model.PhoneChanges
import com.askeden.edencode.model.PhoneComment
import com.askeden.edencode.model.PhoneHome
import com.askeden.edencode.model.PhoneHunkResult
import com.askeden.edencode.model.PhoneOK
import com.askeden.edencode.model.PhoneOptions
import com.askeden.edencode.model.PhoneReceipts
import com.askeden.edencode.model.PhoneTodos
import com.askeden.edencode.model.PhoneUsage
import com.askeden.edencode.model.PhoneView
import com.askeden.edencode.model.body
import com.askeden.edencode.model.text
import org.json.JSONArray
import org.json.JSONObject

/**
 * Everything Eden Code asks the Mac, as one interface (the iPhone app's CodeBackend): the live Mac
 * (pinned TLS, straight or through the relay) and the debug fixtures both answer it, so every
 * screen can be shown, and tested, without a Mac. Calls block: the app makes them off the main
 * thread (runInterruptible on Dispatchers.IO), so leaving a screen interrupts its long poll.
 */
interface CodeBackend {
    fun home(): PhoneHome
    fun options(): PhoneOptions
    /** The long poll (docs/eden-code-phone.md): answers at once when there is anything new. */
    fun session(id: Int, after: Int, seen: Long, v: String, wait: Int): PhoneView
    fun send(id: Int, text: String): PhoneOK
    /** A message with pictures: the companion's /api/code/send, which takes them. */
    fun send(id: Int, text: String, pictures: List<Picture>): PhoneOK
    fun steer(id: Int, text: String): PhoneOK
    fun stop(id: Int): PhoneOK
    fun answer(card: String, choice: String, feedback: String?): PhoneOK
    fun setMode(id: Int, mode: String): PhoneOK
    fun setModel(id: Int, ref: String): PhoneOK
    fun newSession(directory: String, prompt: String, mode: String, model: String?, isolated: Boolean?): PhoneOK
    fun land(id: Int): PhoneOK
    fun discard(id: Int): PhoneOK
    fun unpin(): PhoneOK
    fun changes(id: Int, view: String): PhoneChanges
    fun hunk(id: Int, hunks: List<String>, action: String, view: String): PhoneHunkResult
    fun comment(id: Int, comments: List<PhoneComment>): PhoneOK
    fun receipts(id: Int): PhoneReceipts
    fun todos(): PhoneTodos
    fun startTodo(card: String): PhoneOK
    fun usage(): PhoneUsage
    /** Writes the pull request's description, then opens it as a draft (/api/code/action pr_draft, pr_open). */
    fun openPullRequest(id: Int): PhoneOK
}

/** The Mac's /api/code/phone/… calls on the pinned companion connection. */
class LiveBackend(val api: MacApi) : CodeBackend {
    private fun get(path: String, query: Map<String, String> = emptyMap(), timeout: Long = 15) =
        api.get("api/code/phone/$path", query, timeout)

    private fun post(path: String, json: JSONObject, timeout: Long = 20) = api.post("api/code/phone/$path", json, timeout)

    private fun ok(path: String, json: JSONObject, timeout: Long = 20) = PhoneOK.from(post(path, json, timeout))

    override fun home() = PhoneHome.from(get("home"))
    override fun options() = PhoneOptions.from(get("options", timeout = 20))

    override fun session(id: Int, after: Int, seen: Long, v: String, wait: Int) = PhoneView.from(
        get("session", mapOf("id" to "$id", "after" to "$after", "seen" to "$seen", "v" to v, "wait" to "$wait"), wait + 15L),
    )

    override fun send(id: Int, text: String) = ok("send", body("id" to id, "text" to text))
    override fun send(id: Int, text: String, pictures: List<Picture>) = PhoneOK(api.codeSend(id, text, pictures))
    override fun steer(id: Int, text: String) = ok("steer", body("id" to id, "text" to text))
    override fun stop(id: Int) = ok("stop", body("id" to id))

    override fun answer(card: String, choice: String, feedback: String?) =
        ok("answer", body("approval" to card, "choice" to choice, "feedback" to feedback?.trim()?.takeIf { it.isNotEmpty() }))

    override fun setMode(id: Int, mode: String) = ok("mode", body("id" to id, "mode" to mode))
    override fun setModel(id: Int, ref: String) = ok("model", body("id" to id, "ref" to ref), 30)

    override fun newSession(directory: String, prompt: String, mode: String, model: String?, isolated: Boolean?) = ok(
        "new", body("directory" to directory, "prompt" to prompt, "mode" to mode, "model" to model?.takeIf { it.isNotEmpty() }, "isolated" to isolated), 60,
    )

    override fun land(id: Int) = ok("land", body("id" to id), 60)
    override fun discard(id: Int) = ok("discard", body("id" to id), 60)
    override fun unpin() = ok("unpin", JSONObject())
    override fun changes(id: Int, view: String) = PhoneChanges.from(get("changes", mapOf("id" to "$id", "view" to view), 30))

    override fun hunk(id: Int, hunks: List<String>, action: String, view: String) = PhoneHunkResult.from(
        post("hunk", body("id" to id, "hunks" to JSONArray(hunks), "action" to action, "view" to view), 45),
    )

    override fun comment(id: Int, comments: List<PhoneComment>) =
        ok("comments", body("id" to id, "comments" to JSONArray().apply { comments.forEach { put(it.json()) } }))

    override fun receipts(id: Int) = PhoneReceipts.from(get("receipts", mapOf("id" to "$id", "tail" to "5")))
    override fun todos() = PhoneTodos.from(get("todos"))
    override fun startTodo(card: String) = ok("todo_start", body("card" to card), 60)
    override fun usage() = PhoneUsage.from(get("usage"))

    override fun openPullRequest(id: Int): PhoneOK {
        val draft = api.codeAction("pr_draft", id, timeoutSeconds = 150)
        val found = draft.optJSONObject("code_pr_draft")
        val title = found?.text("title") ?: ""
        val text = found?.text("body") ?: ""
        val said = draft.text("said") ?: ""
        if (title.isEmpty()) return PhoneOK(false, said.ifEmpty { "Couldn’t write the pull request’s description." })
        val opened = api.codeAction("pr_open", id, body("title" to title, "body" to text, "draft" to true), 150)
        return PhoneOK(opened.optBoolean("ok", true), (opened.text("said") ?: "").ifEmpty { "Opened a draft pull request." })
    }
}
