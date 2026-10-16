package com.askeden.edencode.model

import org.json.JSONArray
import org.json.JSONObject
import java.util.Locale

// What the Mac's /api/code/phone/… calls answer (docs/eden-code-phone.md), one for one with the
// iPhone app's EdenCode/Model/PhoneModels.swift and read as leniently (Json.kt).

/** companion_api.session_status. */
enum class CodeStatus(val raw: String) {
    Working("working"), NeedsYou("needs_you"), Done("done"), Failed("failed"), Idle("idle"), Resting("resting"), Unknown("");

    /** Working, or waiting on the owner: worth the ongoing notification. */
    val isLive: Boolean get() = this == Working || this == NeedsYou

    val label: String
        get() = when (this) {
            Working -> "Working"
            NeedsYou -> "Needs you"
            Done -> "Done"
            Failed -> "Failed"
            Idle -> "Idle"
            Resting -> "Resting"
            Unknown -> "—"
        }

    companion object {
        fun of(raw: String?): CodeStatus = entries.firstOrNull { it.raw.isNotEmpty() && it.raw == raw?.lowercase() } ?: Unknown
    }
}

data class ApprovalChoice(val id: String, val label: String) {
    /** "Deny", "Don't send", "Not now": the answer that says no. */
    val isNegative: Boolean
        get() {
            val id = id.lowercase()
            if (id in setOf("deny", "no", "cancel", "reject", "never", "stop")) return true
            val label = label.lowercase().replace('’', '\'')
            if (label == "no") return true
            return listOf("deny", "don't", "do not", "not now", "cancel", "never", "stop", "reject").any { label.startsWith(it) }
        }

    companion object {
        fun from(o: JSONObject): ApprovalChoice {
            val id = o.text("id")?.takeIf { it.isNotEmpty() } ?: throw Undecodable("choice without an id")
            return ApprovalChoice(id, o.text("label") ?: id.replaceFirstChar { it.titlecase(Locale.ROOT) })
        }
    }
}

data class ApprovalOption(val label: String, val description: String = "")

/** companion_api.public_approval. */
data class Approval(
    val id: String,
    val question: String,
    val detail: String = "",
    val choices: List<ApprovalChoice> = DEFAULT_CHOICES,
    val source: String = "jarvis",
    val taskID: Int? = null,
    val askKind: String = "",
    val multi: Boolean = false,
    val options: List<ApprovalOption> = emptyList(),
    val freeChoices: List<String> = emptyList(),
) {
    val isQuestion: Boolean get() = askKind == "question"

    companion object {
        val DEFAULT_CHOICES = listOf(ApprovalChoice("allow", "Allow"), ApprovalChoice("deny", "Not now"))

        fun from(o: JSONObject): Approval {
            val id = o.text("id")?.takeIf { it.isNotEmpty() } ?: throw Undecodable("approval without an id")
            val taskID = o.integer("task_id")
            val choices = o.list("choices", ApprovalChoice::from)
            return Approval(
                id = id,
                question = o.text("question") ?: "Eden needs your OK.",
                detail = o.text("detail") ?: "",
                choices = choices.ifEmpty { DEFAULT_CHOICES },
                // An older Mac doesn't say; a card tied to a session is Eden Code's.
                source = o.text("source")?.takeIf { it == "jarvis" || it == "code" } ?: if (taskID == null) "jarvis" else "code",
                taskID = taskID,
                askKind = o.text("ask_kind") ?: "",
                multi = o.flag("multi") ?: false,
                options = o.list("options") { ApprovalOption(it.text("label") ?: "", it.text("description") ?: "") },
                freeChoices = o.strings("free_choices"),
            )
        }
    }
}

/** A session in the list: `{id, title, project, status, mode, mode_label, model, cost_usd, updated_at}`. */
data class PhoneSummary(
    val id: Int,
    val title: String,
    val project: String,
    val status: CodeStatus,
    val mode: String = "ask",
    val modeLabel: String = "Manual",
    val model: String = "",
    val costUSD: Double = 0.0,
    val updatedAt: Long? = null,
) {
    companion object {
        fun from(o: JSONObject): PhoneSummary {
            val id = o.integer("id") ?: throw Undecodable("session without an id")
            val project = o.text("project") ?: ""
            val mode = o.text("mode") ?: ""
            return PhoneSummary(
                id = id,
                title = o.text("title")?.takeIf { it.isNotBlank() } ?: project.ifEmpty { "Eden Code" },
                project = project,
                status = CodeStatus.of(o.text("status")),
                mode = mode,
                modeLabel = o.text("mode_label") ?: CodeModes.name(mode),
                model = o.text("model") ?: "",
                costUSD = o.number("cost_usd") ?: 0.0,
                updatedAt = o.date("updated_at"),
            )
        }
    }
}

/** A card that waits on the owner, and what the phone may do with it. */
data class PhoneCard(
    val approval: Approval,
    /** Only its "no" is taken from the phone (Touch ID on the Mac, a risky step's, a tap-only one). */
    val macOnly: Boolean = false,
    /** The owner's fingerprint or face before a yes (Face ID on the iPhone). */
    val faceID: Boolean = false,
    /** The tool it's for ("Bash", "Edit"…), when the Mac says. */
    val tool: String = "",
    /** The isolated copy's slug, for a Land or Discard card the phone put up. */
    val copy: String? = null,
) {
    val id: String get() = approval.id
    val taskID: Int? get() = approval.taskID

    /** The answers that say yes (every choice but the negative ones). */
    val yesChoices: List<ApprovalChoice> get() = approval.choices.filter { !it.isNegative }
    val noChoice: ApprovalChoice get() = approval.choices.firstOrNull { it.isNegative } ?: ApprovalChoice("deny", "Deny")

    /** A yes that allows from now on ("Always allow migrations in this project"). */
    fun isStanding(choice: ApprovalChoice): Boolean = "${choice.id} ${choice.label}".lowercase().contains("always")

    /** Biometrics before this answer. */
    fun needsBiometrics(choice: ApprovalChoice): Boolean = !choice.isNegative && (faceID || isStanding(choice))

    companion object {
        fun from(o: JSONObject): PhoneCard {
            val tool = o.text("tool") ?: ""
            return PhoneCard(
                approval = Approval.from(o),
                macOnly = o.flag("mac_only") ?: false,
                faceID = o.flag("face_id") ?: (tool == "Bash"),
                tool = tool,
                copy = o.text("copy")?.takeIf { it.isNotEmpty() },
            )
        }
    }
}

/** An Exterminator Mode run. */
data class PhoneRun(
    val id: String,
    val project: String,
    val state: String = "",
    val round: Int = 0,
    val rounds: Int = 0,
    val step: String = "",
    val spent: Double = 0.0,
    val spendCap: Double = 0.0,
    val taskID: Int? = null,
    val found: Int = 0,
    val fixed: Int = 0,
) {
    /** "Round 2 of 3 · fix · 4 found, 1 fixed · $1.50 of $10.00" */
    val line: String
        get() {
            val parts = mutableListOf<String>()
            if (rounds > 0) parts += "Round $round of $rounds"
            if (step.isNotEmpty()) parts += step
            parts += "$found found, $fixed fixed"
            if (spendCap > 0) parts += "${Money.text(spent)} of ${Money.text(spendCap)}"
            return parts.joinToString(" · ")
        }

    companion object {
        fun from(o: JSONObject) = PhoneRun(
            id = o.text("id") ?: java.util.UUID.randomUUID().toString(),
            project = o.text("project") ?: "",
            state = o.text("state") ?: "",
            round = o.integer("round") ?: 0,
            rounds = o.integer("rounds") ?: 0,
            step = o.text("step") ?: "",
            spent = o.number("spent") ?: 0.0,
            spendCap = o.number("spend_cap") ?: 0.0,
            taskID = o.integer("task_id"),
            found = o.integer("found") ?: 0,
            fixed = o.integer("fixed") ?: 0,
        )
    }
}

/** GET /home. */
data class PhoneHome(
    val sessions: List<PhoneSummary> = emptyList(),
    val attention: List<PhoneCard> = emptyList(),
    val pinned: Pinned? = null,
    val exterminator: List<PhoneRun> = emptyList(),
) {
    /** `at` is epoch milliseconds. */
    data class Pinned(val id: Int, val title: String, val at: Double)

    /** Sessions by project, in the order their newest session comes. */
    val byProject: List<Pair<String, List<PhoneSummary>>>
        get() {
            val groups = LinkedHashMap<String, MutableList<PhoneSummary>>()
            for (s in sessions) groups.getOrPut(s.project.ifEmpty { "Other" }) { mutableListOf() }.add(s)
            return groups.map { it.key to it.value }
        }

    val needsYouCount: Int get() = maxOf(attention.size, sessions.count { it.status == CodeStatus.NeedsYou })

    companion object {
        fun from(o: JSONObject) = PhoneHome(
            sessions = o.list("sessions", PhoneSummary::from),
            attention = o.list("attention", PhoneCard::from),
            pinned = o.obj("pinned")?.let { p ->
                p.integer("id")?.let { Pinned(it, p.text("title") ?: "", p.number("at") ?: 0.0) }
            },
            exterminator = o.list("exterminator", PhoneRun::from),
        )
    }
}

/** GET /options. */
data class PhoneOptions(
    val models: List<Model> = emptyList(),
    val modes: List<Mode> = CodeModes.phone,
    val projects: List<Project> = emptyList(),
    val defaultModel: String = "",
    val defaultMode: String = "ask",
) {
    data class Model(val ref: String, val name: String, val group: String = "", val needsKey: Boolean = false)
    data class Mode(val id: String, val name: String)
    data class Project(val name: String, val branch: String = "", val running: Int = 0)

    fun modelName(ref: String): String = models.firstOrNull { it.ref == ref }?.name ?: ref

    companion object {
        fun from(o: JSONObject): PhoneOptions {
            val modes = o.list("modes") {
                val id = it.text("id")?.takeIf { s -> s.isNotEmpty() } ?: throw Undecodable("mode without an id")
                Mode(id, it.text("name") ?: CodeModes.name(id))
            }
            val defaults = o.obj("defaults")
            return PhoneOptions(
                models = o.list("models") {
                    val ref = it.text("ref")?.takeIf { s -> s.isNotEmpty() } ?: throw Undecodable("model without a ref")
                    Model(ref, it.text("name") ?: ref, it.text("group") ?: "", it.flag("needs_key") ?: false)
                },
                modes = modes.ifEmpty { CodeModes.phone },
                projects = o.list("projects") {
                    val name = it.text("name")?.takeIf { s -> s.isNotEmpty() } ?: throw Undecodable("project without a name")
                    Project(name, it.text("branch") ?: "", it.integer("running") ?: 0)
                },
                defaultModel = defaults?.text("model") ?: "",
                defaultMode = defaults?.text("mode") ?: "ask",
            )
        }
    }
}

/** The permission modes, as the Mac names them, and the two a phone may pick. */
object CodeModes {
    val phone = listOf(PhoneOptions.Mode("ask", "Manual"), PhoneOptions.Mode("edits", "Accept edits"))

    fun name(id: String): String = when (id) {
        "plan" -> "Plan"
        "ask" -> "Manual"
        "edits" -> "Accept edits"
        "smart" -> "Auto"
        "auto" -> "Bypass permissions"
        else -> id
    }
}

/** One transcript entry: `{i, role: user | assistant | tool | note, text, at}`. */
data class PhoneEntry(val i: Int, val role: Role, val text: String, val at: Long? = null) {
    enum class Role { User, Assistant, Tool, Note }

    /** A step's line: the Mac sums a step up as its first line ("Read share.js"). */
    val stepLine: String get() = text.lineSequence().firstOrNull()?.trim() ?: text

    val stepFailed: Boolean
        get() {
            val lower = text.lowercase()
            return lower.contains("error") && (lower.contains("✗") || lower.startsWith("failed") || lower.contains(" failed"))
        }

    val stepRunning: Boolean get() = text.lowercase().contains("running…") || text.endsWith("…")

    companion object {
        fun from(o: JSONObject): PhoneEntry {
            val i = o.integer("i") ?: throw Undecodable("entry without i")
            val role = when ((o.text("role") ?: "").lowercase()) {
                "user" -> Role.User
                "assistant" -> Role.Assistant
                "tool" -> Role.Tool
                else -> Role.Note
            }
            return PhoneEntry(i, role, o.text("text") ?: "", o.date("at"))
        }
    }
}

/** GET /session: the live view of one session. */
data class PhoneView(
    val id: Int,
    val title: String = "",
    val project: String = "",
    val status: CodeStatus = CodeStatus.Unknown,
    val doing: String = "",
    val mode: String = "ask",
    val modeLabel: String = "Manual",
    val model: String = "",
    val modelLabel: String = "",
    val live: String = "",
    val todos: List<Todo> = emptyList(),
    val cards: List<PhoneCard> = emptyList(),
    val copy: Copy? = null,
    val next: Int = 0,
    val seen: Int = 0,
    val v: String = "",
    val entries: List<PhoneEntry> = emptyList(),
    val changed: List<PhoneEntry> = emptyList(),
    val more: Boolean = false,
) {
    data class Todo(val text: String, val done: Boolean)
    data class Copy(val branch: String, val into: String, val busy: Boolean)

    companion object {
        fun from(o: JSONObject): PhoneView {
            val id = o.integer("id") ?: throw Undecodable("view without an id")
            val mode = o.text("mode") ?: "ask"
            val model = o.text("model") ?: ""
            return PhoneView(
                id = id,
                title = o.text("title") ?: "",
                project = o.text("project") ?: "",
                status = CodeStatus.of(o.text("status")),
                doing = o.text("doing") ?: "",
                mode = mode,
                modeLabel = o.text("mode_label") ?: CodeModes.name(mode),
                model = model,
                modelLabel = o.text("model_label") ?: model,
                live = o.text("live") ?: "",
                todos = o.list("todos") { Todo(it.text("text") ?: "", it.flag("done") ?: false) },
                cards = o.list("cards", PhoneCard::from),
                copy = o.obj("copy")?.let { Copy(it.text("branch") ?: "", it.text("into") ?: "", it.flag("busy") ?: false) },
                next = o.integer("next") ?: 0,
                seen = o.integer("seen") ?: 0,
                v = o.text("v") ?: "",
                entries = o.list("entries", PhoneEntry::from),
                changed = o.list("changed", PhoneEntry::from),
                more = o.flag("more") ?: false,
            )
        }
    }
}

/** GET /changes: the Changes pane's payload (code_hunks.payload). */
data class PhoneChanges(
    val id: Int,
    val view: String = "session",
    val git: Boolean = true,
    val files: List<File> = emptyList(),
    val totalFiles: Int = files.size,
    val totalHunks: Int = files.sumOf { it.hunks.size },
) {
    data class Hunk(
        val id: String,
        val n: Int,
        val newStart: Int = 1,
        val oldStart: Int = 1,
        val header: String = "",
        val lines: List<Line>,
        val kept: Boolean = false,
        val cut: Int = 0,
    )

    /** One line of a hunk, with its number in the file (new for kept and added, old for removed): where a comment goes. */
    data class Line(val index: Int, val kind: Kind, val text: String, val number: Int) {
        enum class Kind { Added, Removed, Context }

        companion object {
            fun number(raw: List<List<String>>, oldStart: Int, newStart: Int): List<Line> {
                var old = oldStart
                var new = newStart
                val out = mutableListOf<Line>()
                raw.forEachIndexed { index, pair ->
                    val tag = pair.firstOrNull() ?: return@forEachIndexed
                    val text = if (pair.size > 1) pair[1] else ""
                    when (tag) {
                        "+" -> { out += Line(index, Kind.Added, text, new); new++ }
                        "-" -> { out += Line(index, Kind.Removed, text, old); old++ }
                        "\\" -> {}
                        else -> { out += Line(index, Kind.Context, text, new); old++; new++ }
                    }
                }
                return out
            }
        }
    }

    data class File(
        val path: String,
        val status: String = "M",
        val added: Int,
        val removed: Int,
        val hunks: List<Hunk>,
        val binary: Boolean = false,
        val sensitive: Boolean = false,
        val omitted: Boolean = false,
    )

    /** Every hunk not yet kept: what Undo all puts back. */
    val unkeptHunks: List<String> get() = files.flatMap { it.hunks }.filter { !it.kept }.map { it.id }

    companion object {
        private fun pairs(a: JSONArray?): List<List<String>> {
            if (a == null) return emptyList()
            return (0 until a.length()).mapNotNull { n ->
                val pair = a.opt(n) as? JSONArray ?: return@mapNotNull null
                (0 until pair.length()).map { pair.opt(it)?.toString() ?: "" }
            }
        }

        fun hunk(o: JSONObject): Hunk {
            val id = o.text("id")?.takeIf { it.isNotEmpty() } ?: throw Undecodable("hunk without an id")
            val oldStart = o.integer("old_start") ?: 1
            val newStart = o.integer("new_start") ?: 1
            return Hunk(
                id = id, n = o.integer("n") ?: 0, newStart = newStart, oldStart = oldStart, header = o.text("header") ?: "",
                lines = Line.number(pairs(o.array("lines")), oldStart, newStart), kept = o.flag("kept") ?: false,
                cut = o.integer("cut") ?: 0,
            )
        }

        fun from(o: JSONObject): PhoneChanges {
            val files = o.list("files") {
                val path = it.text("path")?.takeIf { s -> s.isNotEmpty() } ?: throw Undecodable("file without a path")
                File(
                    path = path, status = it.text("status") ?: "", added = it.integer("added") ?: 0, removed = it.integer("removed") ?: 0,
                    hunks = it.list("hunks", ::hunk), binary = it.flag("binary") ?: false, sensitive = it.flag("sensitive") ?: false,
                    omitted = it.flag("omitted") ?: false,
                )
            }
            val totals = o.obj("totals")
            return PhoneChanges(
                id = o.integer("id") ?: 0, view = o.text("view") ?: "session", git = o.flag("git") ?: true, files = files,
                totalFiles = totals?.integer("files") ?: files.size,
                totalHunks = totals?.integer("hunks") ?: files.sumOf { it.hunks.size },
            )
        }
    }
}

/** POST /hunk's answer. */
data class PhoneHunkResult(val ok: Boolean, val said: String, val changes: PhoneChanges?) {
    companion object {
        fun from(o: JSONObject) = PhoneHunkResult(o.flag("ok") ?: false, o.text("said") ?: "", o.obj("changes")?.let(PhoneChanges::from))
    }
}

/** A line comment, as the window's Changes pane sends them. `side` is "o" for a removed line. */
data class PhoneComment(val path: String, val line: Int, val side: String?, val excerpt: String, val text: String) {
    fun json(): JSONObject = body("path" to path, "line" to line, "side" to side, "excerpt" to excerpt.take(300), "text" to text)
}

/** One turn's receipt (code_receipts): the proof card's parts the phone shows. */
data class PhoneReceipt(
    val i: Int,
    val text: String = "",
    val risk: String,
    val why: String,
    val fileCount: Int,
    val rows: List<Row>,
) {
    data class Row(val mark: Mark, val text: String) {
        enum class Mark { Good, Warn, Bad }
    }

    val riskLabel: String
        get() = when (risk) {
            "high" -> "High risk"
            "medium" -> "Medium risk"
            else -> "Low risk"
        }

    companion object {
        fun from(o: JSONObject): PhoneReceipt {
            val r = o.obj("receipt") ?: JSONObject()
            return PhoneReceipt(
                i = o.integer("i") ?: 0,
                text = o.text("text") ?: "",
                risk = r.text("risk") ?: "low",
                why = r.text("why") ?: "",
                fileCount = r.integer("file_count") ?: (r.array("files")?.length() ?: 0),
                rows = rows(r),
            )
        }

        private fun count(a: JSONArray?, test: (JSONObject) -> Boolean): Int =
            if (a == null) 0 else (0 until a.length()).count { (a.opt(it) as? JSONObject)?.let(test) == true }

        /** Tests, test integrity, the check, its own check, security, guardrails, assumptions, requirements. */
        fun rows(r: JSONObject): List<Row> {
            val rows = mutableListOf<Row>()
            val t = r.obj("tests")
            if (t != null) {
                val passed = t.integer("passed_count") ?: 0
                val failed = t.integer("failed_count") ?: 0
                rows += when (t.text("state") ?: "") {
                    "passed" -> Row(Row.Mark.Good, if (passed > 0) "$passed tests passed" else "Tests passed")
                    "failed" -> Row(Row.Mark.Bad, if (failed > 0) "$failed tests failed" else "Tests failed")
                    "stale" -> Row(Row.Mark.Warn, "Tests ran before its last edits")
                    "cancelled" -> Row(Row.Mark.Warn, "Tests didn’t finish")
                    "refused" -> Row(Row.Mark.Warn, "Tests not run")
                    else -> Row(Row.Mark.Warn, "Tests ran")
                }
            } else {
                rows += Row(Row.Mark.Warn, "No tests run")
            }
            val first = (r.obj("integrity")?.array("lines")?.opt(0) as? JSONObject)?.text("text")
            if (!first.isNullOrEmpty()) {
                val weakened = t?.flag("trusted") == false
                rows += Row(if (weakened) Row.Mark.Bad else Row.Mark.Good, first)
            }
            r.obj("check")?.let { check ->
                val problems = check.text("status") == "problems"
                rows += Row(if (problems) Row.Mark.Bad else Row.Mark.Good, if (problems) "Check found problems" else "Checked after the turn")
            }
            r.obj("selfcheck")?.let { own ->
                val verdict = own.text("verdict") ?: ""
                rows += Row(
                    when (verdict) { "pass" -> Row.Mark.Good; "fail" -> Row.Mark.Bad; else -> Row.Mark.Warn },
                    own.text("headline")?.takeIf { it.isNotEmpty() } ?: "Checked itself",
                )
            }
            r.obj("security")?.let { security ->
                val found = security.array("findings")?.length() ?: security.integer("found") ?: 0
                rows += Row(if (found == 0) Row.Mark.Good else Row.Mark.Bad, if (found == 0) "Security scan clean" else "$found security finding${if (found == 1) "" else "s"}")
            }
            r.array("guardrails")?.takeIf { it.length() > 0 }?.let { guards ->
                val blocked = count(guards) { it.text("action") == "blocked" }
                rows += Row(if (blocked > 0) Row.Mark.Warn else Row.Mark.Good, if (blocked > 0) "Guardrails blocked $blocked" else "Guardrails held")
            }
            r.array("assumptions")?.takeIf { it.length() > 0 }?.let { guessed ->
                val high = count(guessed) { it.text("risk") == "high" }
                val n = guessed.length()
                rows += Row(if (high > 0) Row.Mark.Bad else Row.Mark.Warn, "$n assumption${if (n == 1) "" else "s"}" + if (high > 0) " ($high high risk)" else "")
            }
            r.array("requirements")?.takeIf { it.length() > 0 }?.let { reqs ->
                val met = count(reqs) { it.text("status") == "met" }
                rows += Row(if (met == reqs.length()) Row.Mark.Good else Row.Mark.Warn, "Requirements met $met of ${reqs.length()}")
            }
            return rows
        }
    }
}

data class PhoneReceipts(val receipts: List<PhoneReceipt>) {
    companion object {
        fun from(o: JSONObject) = PhoneReceipts(o.list("receipts", PhoneReceipt::from))
    }
}

/** GET /todos: a to-do card. */
data class PhoneTodoCard(
    val id: String,
    val project: String,
    val title: String,
    val prompt: String = "",
    val model: String = "",
    val mode: String = "",
    val state: String = "todo",
    val taskID: Int? = null,
    val untrusted: Boolean = false,
) {
    val waiting: Boolean get() = state == "todo" || state == "failed"
    /** Auto and Bypass start on the Mac only. */
    val startsOnMacOnly: Boolean get() = mode == "auto" || mode == "smart"

    val stateLabel: String
        get() = when (state) {
            "todo" -> "To do"
            "queued" -> "Queued"
            "running" -> "Running"
            "started" -> "Started"
            "done" -> "Done"
            "failed" -> "Failed"
            else -> state.replaceFirstChar { it.titlecase(Locale.ROOT) }
        }

    companion object {
        fun from(o: JSONObject): PhoneTodoCard {
            val id = o.text("id")?.takeIf { it.isNotEmpty() } ?: throw Undecodable("card without an id")
            return PhoneTodoCard(
                id, o.text("project") ?: "", o.text("title") ?: "", o.text("prompt") ?: "", o.text("model") ?: "",
                o.text("mode") ?: "", o.text("state") ?: "todo", o.integer("task_id"), o.flag("untrusted") ?: false,
            )
        }
    }
}

data class PhoneTodos(val cards: List<PhoneTodoCard>) {
    val byProject: List<Pair<String, List<PhoneTodoCard>>>
        get() {
            val groups = LinkedHashMap<String, MutableList<PhoneTodoCard>>()
            for (c in cards) groups.getOrPut(c.project) { mutableListOf() }.add(c)
            return groups.map { it.key to it.value }
        }

    companion object {
        fun from(o: JSONObject) = PhoneTodos(o.list("cards", PhoneTodoCard::from))
    }
}

/** GET /usage: the glance. */
data class PhoneUsage(
    val today: Double = 0.0,
    val dayCap: Double = 0.0,
    val recent: List<Day> = emptyList(),
    val windows: List<Window> = emptyList(),
) {
    data class Day(val day: String, val total: Double)

    data class Window(val kind: String, val percent: Double?) {
        val label: String
            get() = when (kind) {
                "five_hour" -> "5-hour limit"
                "seven_day", "weekly" -> "Weekly limit"
                "seven_day_opus" -> "Weekly (Opus)"
                else -> kind.replace('_', ' ').split(' ').joinToString(" ") { w -> w.replaceFirstChar { it.titlecase(Locale.ROOT) } }
            }
    }

    val fiveHour: Window? get() = windows.firstOrNull { it.kind == "five_hour" } ?: windows.firstOrNull()
    val week: Double get() = recent.sumOf { it.total }

    companion object {
        fun from(o: JSONObject) = PhoneUsage(
            today = o.number("today") ?: 0.0,
            dayCap = o.number("day_cap") ?: 0.0,
            recent = o.list("recent") { Day(it.text("day") ?: "", it.number("total") ?: 0.0) },
            windows = o.list("windows") {
                Window(it.text("kind") ?: "", it.number("percent") ?: it.number("utilization")?.let { u -> if (u <= 1) u * 100 else u })
            },
        )
    }
}

/** `{ok, said?, id?, steered?}` answers. */
data class PhoneOK(val ok: Boolean, val said: String = "", val id: Int? = null, val steered: Boolean = false) {
    companion object {
        fun from(o: JSONObject) = PhoneOK(o.flag("ok") ?: true, o.text("said") ?: "", o.integer("id"), o.flag("steered") ?: false)
    }
}

object Money {
    fun text(dollars: Double): String =
        if (dollars >= 100) String.format(Locale.US, "$%.0f", dollars) else String.format(Locale.US, "$%.2f", dollars)
}
