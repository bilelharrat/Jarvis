"""What JARVIS writes in a chat in fixed sentences, with their Chinese. They join lang.py's
templates (lang.ZH_TEXTS) when this module loads, so say() is lang.tr: the English as
written, or its Chinese with the slots filled."""

from __future__ import annotations

from typing import Any

from .. import lang

PAIRED = (
    "Paired. What you send here now comes to me, and my answers come back here. "
    "Send {help} to see what I can do."
)
WRONG_CODE = "That code isn't right, or it expired. Make a new one in Settings on the Mac."
LOCKED = "Too many wrong codes. Wait ten minutes, then try again."
PRIVATE = "This is a private assistant."
PAIR_HOW = "To pair, send {pair} and the code shown in Settings on the Mac."
ALREADY = "You're already paired."
UNPAIRED = "This chat isn't paired with Jarvis any more."

HEARD = "Heard: “{text}”"
NO_VOICE = "I couldn't make out that voice note."
NO_STT = "I can't transcribe voice notes right now. Try typing it."
VOICE_LONG = "That voice note is too long: keep it under {minutes} minutes."
TOO_BIG = "{name} is too big: the most I take is {size}."
UNSUPPORTED = "I can read pictures, PDFs and text files, but not {name}."
NO_DOWNLOAD = "I couldn't get {name}. Try sending it again."
BUSY = "I'm still on your earlier requests. Send this again in a minute."
SLOW = "That's a lot at once: I'll read your messages again in a minute."
OFFLINE = (
    "You sent this at {time} while I was offline, so I didn't act on it. Send it again if "
    "you still want it."
)
DROPPED = "That didn't run: too many requests were waiting on the Mac, or it was taken back."
FAILED = "Something went wrong on the Mac. Try again."
LOOK = "Take a look at this."
FORWARDED = "Forwarded message"
STOPPED = "Stopped."
NEW = "Started a new conversation."
OK = "OK."

NEEDS_OK = "Needs your OK"
BECAUSE = "No, because…"
BECAUSE_PLAN = "Keep planning, because…"
INSTEAD = "What should I do instead?"
CHANGE_PLAN = "What should change in the plan?"
HINT = "Reply yes or no. To say no with a reason: no, because …"
HINT_QUESTION = "Reply with an option's number or name, or “skip”."
HINT_PURCHASE = "To confirm, reply exactly: confirm purchase. Reply no to cancel."
HINT_PLAN = "Reply “go” (it asks before edits) or “go with auto-edits”. To keep planning, reply “no” and say what to change."
CHOSE = "You chose: {label}."
CLOSED = "Closed."
GONE = "This one is already closed."

NO_SESSIONS = "No Jarvis Code sessions are open."
SESSIONS = "Jarvis Code sessions:"
SESSIONS_HOW = "Send one a message: {code} <number> <message>"
NO_SUCH_SESSION = "There's no Jarvis Code session “{name}”."
WHICH = "Which one? {names}"
SENT_TO_SESSION = "Sent to Jarvis Code #{id} in {folder}. I'll pass its answer on here."
NOT_QUEUED = "Not sent: that session already has messages waiting."
SESSION_SAYS = "Jarvis Code #{id} in {folder}"
# A session's state in a list, in each language (lone words: not lang's templates).
SESSION_STATES = {
    "en": {
        "working": "working",
        "waiting": "waiting for you",
        "done": "done",
        "stopped": "stopped",
        "failed": "failed",
    },
    "zh": {
        "working": "工作中",
        "waiting": "等你回复",
        "done": "完成",
        "stopped": "已停止",
        "failed": "失败",
    },
}

IDLE = "I'm free."
BUSY_NOW = "I'm working on a request."
SPEAKING = "I'm speaking on the Mac."
LISTENING = "I'm listening on the Mac."
NOW = "Now: {text}"
QUEUED = "Waiting after it: {n}."
OK_WAITING = "Waiting for your OK: {text}"
NEXT = "Next: {text}"

HELP = (
    "Write to me here as you would talk to me. Voice notes, photos, PDFs and text files work "
    "too.\n"
    "{c}stop: stop what I'm doing\n"
    "{c}status: what I'm up to\n"
    "{c}brief: the morning briefing\n"
    "{c}new: a new conversation\n"
    "{c}code: Jarvis Code sessions ({c}code <number> <message> sends one a message)\n"
    "{c}help: this list"
)
HELP_ANSWERS = "When I need your OK, reply yes or no here (or “no, because …”)."

SENT_FILE = "Sent {name}."

# Groups: answered only when the owner mentions JARVIS or replies to it.
GROUP_OFF = "I'm switched off in “{name}”. Turn me on for it in Settings › Chats on the Mac."
GROUP_DM_ONLY = "That works in your direct chat with me, not in a group."
GROUP_HELP = (
    "In a group I answer only you, when you mention me or reply to me, and everyone here "
    "sees my answer. {c}stop stops what I'm doing; everything else works in your direct "
    "chat with me."
)
GROUP_ASKED = "From “{name}”: {question}"
A_GROUP = "a group"

# Progress while a request runs.
WORKING = "Working on it…"
WRITING = "Writing the answer…"
STILL = "Still working: {step}"

TEXT_ONLY = "I can only read text here. Type it, please."

ZH: dict[str, str] = {
    PAIRED: "配对成功。你在这里发的消息会交给我，我的回复也会发回这里。发送 {help} 看看我能做什么。",
    WRONG_CODE: "验证码不对，或者已经过期。请在 Mac 的设置里重新生成。",
    LOCKED: "错误的验证码太多了。请等十分钟再试。",
    PRIVATE: "这是一个私人助理。",
    PAIR_HOW: "要配对，请发送 {pair} 加上 Mac 设置里显示的验证码。",
    ALREADY: "你已经配对好了。",
    UNPAIRED: "这个聊天已经和我解除配对了。",
    HEARD: "听到：“{text}”",
    NO_VOICE: "这条语音我没听清。",
    NO_STT: "现在没法转写语音，请改用文字。",
    VOICE_LONG: "这条语音太长了，请控制在{minutes}分钟以内。",
    TOO_BIG: "{name}太大了，我最多只能收{size}。",
    UNSUPPORTED: "我能读图片、PDF 和文本文件，但读不了{name}。",
    NO_DOWNLOAD: "没能收到{name}，请再发一次。",
    BUSY: "我还在处理你之前的请求，请过一分钟再发。",
    SLOW: "消息有点多，我一分钟后再接着看。",
    OFFLINE: "你在{time}发这条消息时我不在线，所以没有执行。如果还需要，请再发一次。",
    DROPPED: "没有执行：Mac 上排队的请求太多，或者被撤回了。",
    FAILED: "Mac 上出了点问题，请再试一次。",
    LOOK: "看看这个。",
    FORWARDED: "转发的消息",
    STOPPED: "已停止。",
    NEW: "已开始新的对话。",
    OK: "好的。",
    NEEDS_OK: "需要你确认",
    BECAUSE: "不行，因为……",
    BECAUSE_PLAN: "继续规划，因为……",
    INSTEAD: "那我应该怎么做？",
    CHANGE_PLAN: "计划要怎么改？",
    HINT: "回复“好”或“不”。想说明原因就回复：不，因为……",
    HINT_QUESTION: "回复选项的编号或名称，或者回复“跳过”。",
    HINT_PURCHASE: "确认的话，请原样回复：确认购买。回复“不”就取消。",
    HINT_PLAN: "回复“开始”（改动前会先问你）或“自动接受改动”。想继续规划就回复“不”，并说说要改什么。",
    CHOSE: "你选择了：{label}。",
    CLOSED: "已关闭。",
    GONE: "这个已经关闭了。",
    NO_SESSIONS: "现在没有打开的 Jarvis Code 会话。",  # as the voice supervisor says it
    SESSIONS: "Jarvis Code 会话：",
    SESSIONS_HOW: "给会话发消息：{code} <编号> <消息>",
    NO_SUCH_SESSION: "没有叫“{name}”的 Jarvis Code 会话。",
    WHICH: "哪一个？{names}",
    SENT_TO_SESSION: "已发给 {folder} 里的 Jarvis Code #{id}。它回复后我会转到这里。",
    NOT_QUEUED: "没有发送：这个会话已经有消息在排队了。",
    SESSION_SAYS: "{folder} 里的 Jarvis Code #{id}",
    IDLE: "我现在有空。",
    BUSY_NOW: "我正在处理一个请求。",
    SPEAKING: "我正在 Mac 上说话。",
    LISTENING: "我正在 Mac 上听。",
    NOW: "正在处理：{text}",
    QUEUED: "后面还有{n}个在排队。",
    OK_WAITING: "等你确认：{text}",
    NEXT: "接下来：{text}",
    HELP: (
        "像平时和我说话一样在这里写就行，语音、照片、PDF 和文本文件也可以。\n"
        "{c}stop：停下正在做的事\n"
        "{c}status：我在忙什么\n"
        "{c}brief：早间简报\n"
        "{c}new：开始新的对话\n"
        "{c}code：Jarvis Code 会话（{c}code <编号> <消息> 给会话发消息）\n"
        "{c}help：显示这份说明"
    ),
    HELP_ANSWERS: "需要你确认时，直接在这里回复“好”或“不”（也可以回复“不，因为……”）。",
    SENT_FILE: "已发送{name}。",
    GROUP_OFF: "我在“{name}”里是关闭的。请在 Mac 的设置 › 聊天里为它打开。",
    GROUP_DM_ONLY: "这个要在你和我的私聊里用，群里不行。",
    GROUP_HELP: (
        "在群里我只回复你，而且要你提到我或回复我的消息，群里所有人都能看到我的回答。"
        "{c}stop 可以停下我正在做的事，其他功能请在和我的私聊里用。"
    ),
    GROUP_ASKED: "来自“{name}”：{question}",
    A_GROUP: "一个群",
    WORKING: "正在处理…",
    WRITING: "正在写回答…",
    STILL: "还在处理：{step}",
    TEXT_ONLY: "这里我只能读文字，请打字发给我。",
}

for _english, _chinese in ZH.items():
    lang.ZH_TEXTS.setdefault(_english, _chinese)


def say(template: str, language: str, **values: Any) -> str:
    """A fixed sentence in the owner's language, its slots filled."""
    return lang.tr(template, language, **values)


def hint_for(card: dict[str, Any], language: str) -> str:
    """How to answer an approval card in words (a chat without buttons)."""
    kind = card.get("ask_kind")
    if kind == "purchase":
        return say(HINT_PURCHASE, language)
    if kind == "plan":
        return say(HINT_PLAN, language)
    if kind == "question":
        options = [
            f"{i + 1}. {c.get('label', '')}"
            for i, c in enumerate(card.get("choices") or [])
            if c.get("id") != "skip"
        ]
        return say(HINT_QUESTION, language) + "\n" + "\n".join(options)
    return say(HINT, language)


# What the turn gate names on a card when a request came with a picture or a file (hub.ask).
lang.VALUES_ZH.setdefault("the picture or file you sent", "你发来的图片或文件")
