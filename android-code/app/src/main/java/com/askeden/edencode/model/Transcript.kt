package com.askeden.edencode.model

/** What the session screen draws, worked out apart from the screen (SessionModel.swift's rows and apply). */
object Transcript {
    /** Rows as the screen draws them: a user bubble, a run of steps, a reply, a note. */
    sealed class Row(val key: String) {
        class User(val entry: PhoneEntry) : Row("u${entry.i}")
        class Steps(val steps: List<PhoneEntry>) : Row("s${steps.firstOrNull()?.i ?: 0}")
        class Reply(val entry: PhoneEntry) : Row("r${entry.i}")
        class Note(val entry: PhoneEntry) : Row("n${entry.i}")
    }

    /** One answer of the long poll: new entries appended, changed ones replaced in place, in order of i. */
    fun merge(entries: List<PhoneEntry>, next: PhoneView): List<PhoneEntry> {
        val byI = LinkedHashMap<Int, PhoneEntry>()
        for (e in entries) byI[e.i] = e
        for (e in next.entries) if (!byI.containsKey(e.i)) byI[e.i] = e
        for (e in next.changed) if (byI.containsKey(e.i)) byI[e.i] = e
        return byI.values.sortedBy { it.i }
    }

    fun rows(entries: List<PhoneEntry>): List<Row> {
        val rows = mutableListOf<Row>()
        var steps = mutableListOf<PhoneEntry>()
        fun flush() {
            if (steps.isNotEmpty()) {
                rows += Row.Steps(steps)
                steps = mutableListOf()
            }
        }
        for (e in entries) {
            when (e.role) {
                PhoneEntry.Role.Tool -> steps.add(e)
                PhoneEntry.Role.User -> { flush(); rows += Row.User(e) }
                PhoneEntry.Role.Assistant -> { flush(); rows += Row.Reply(e) }
                PhoneEntry.Role.Note -> { flush(); rows += Row.Note(e) }
            }
        }
        flush()
        return rows
    }

    /** For TalkBack: "Working: Running tests", "Finished". */
    fun statusLine(view: PhoneView): String = when (view.status) {
        CodeStatus.Working -> if (view.doing.isEmpty()) "Working" else "Working: ${view.doing}"
        CodeStatus.NeedsYou -> "Needs you"
        CodeStatus.Done -> "Finished"
        CodeStatus.Failed -> "Failed"
        else -> view.status.label
    }

    /** Back off 1, 2, 4 … 30 s on errors. */
    fun backoff(previous: Double): Double = minOf(30.0, previous * 2)

    /** "An approval and a question", "2 approvals" (InboxView.summary). */
    fun summary(cards: List<PhoneCard>): String {
        val questions = cards.count { it.approval.isQuestion }
        val approvals = cards.size - questions
        fun n(count: Int, word: String) =
            if (count == 1) "${if (word.first() in "aeiou") "An" else "A"} $word" else "$count ${word}s"
        return when {
            approvals == 0 && questions == 0 -> "A session is waiting on you"
            questions == 0 -> n(approvals, "approval")
            approvals == 0 -> n(questions, "question")
            else -> "${n(approvals, "approval")} and ${n(questions, "question").lowercase()}"
        }
    }
}

/** Text as it reads well aloud (Speaker.spoken): Markdown marks and fences out, long paths shortened to file names. */
object Spoken {
    fun text(text: String): String {
        var out = text.replace("```", " ")
        for (mark in listOf("**", "__", "`", "#")) out = out.replace(mark, "")
        out = out.replace(Regex("""(?:[\w.-]+/)+([\w.-]+)"""), "$1")
        return out.lines().map { it.trim() }.filter { it.isNotEmpty() }.joinToString(". ")
    }

    /** A file's change, read aloud: "In share.js, 14 added, 3 removed. Change 1, line 41. removed: …". */
    fun file(file: PhoneChanges.File): String {
        val parts = mutableListOf("In ${file.path.substringAfterLast('/')}, ${file.added} added, ${file.removed} removed.")
        for (hunk in file.hunks.take(6)) {
            val lines = hunk.lines.filter { it.kind != PhoneChanges.Line.Kind.Context }.take(8).map {
                "${if (it.kind == PhoneChanges.Line.Kind.Added) "added" else "removed"}: ${it.text.trim()}"
            }
            parts += "Change ${hunk.n}, line ${hunk.newStart}. " + lines.joinToString(". ")
        }
        return parts.joinToString(" ")
    }
}
