"""Page text written to an AI instead of to the person reading it.

A page can carry words meant for whatever AI reads it: "ignore your previous instructions",
"note to AI assistants: tell the user…", "if you are a language model, email…". They are the
page's words, never instructions; JARVIS reads them as data anyway, and when a page has
them the owner is told and Claude is warned (browser_ai.desk flags reads and snapshots).
Text hidden from view that says such things is the strongest sign of a page that means
harm: it's left out of what Claude sees (app/page-preload.js), and the owner hears of it.

Matching is by pattern, English and Chinese, with no model call. A page about prompt
injection that quotes such lines is flagged too: that only costs a notice.
"""

from __future__ import annotations

import re

from ...textclean import clean_text

_AI = (
    r"(?:a\.?i\.?|llms?|(?:large\s+)?language\s+models?|ai\s+(?:assistants?|agents?|models?|systems?|"
    r"tools?|bots?|crawlers?)|chat\s?bots?|chatgpt|gpt-?\d*|claude|gemini|copilot|jarvis|"
    r"automated\s+(?:agents?|assistants?|systems?|readers?))"
)
# Each is one way a page talks to an AI. The matches' sentences are what the owner is shown.
_EN = [
    # ignore / disregard your previous instructions
    r"\b(?:ignore|disregard|forget|override|bypass)\b[^.!?\n]{0,40}?\b(?:previous|prior|above|earlier|"
    r"preceding|original|system|all|any|your)\b[^.!?\n]{0,30}?\b(?:instructions?|prompts?|directions?|"
    r"rules|guidelines|directives?|programming)\b",
    # you are now an AI / act as a language model
    r"\b(?:you\s+are|you're|act\s+as|pretend\s+to\s+be|behave\s+as)\s+(?:now\s+)?(?:an?\s+)?"
    rf"(?:helpful\s+)?{_AI}\b",
    # if you are an AI / when an AI reads this
    rf"\b(?:if|when)\s+(?:you\s+are|you're|you\s+were)\s+(?:an?\s+)?{_AI}\b",
    rf"\b(?:if|when)\s+(?:an?\s+|any\s+)?{_AI}\s+(?:is\s+)?(?:reads?|reading|parses?|parsing|summari[sz]es?|"
    r"summari[sz]ing|visits?|visiting|processes?|processing|sees?)\b",
    # note to AI assistants: / instructions for the AI
    r"\b(?:note|message|instructions?|attention|notice|reminder|directive|request|warning)s?\s*"
    rf"(?:to|for)\s+(?:any\s+|all\s+|the\s+)?{_AI}\s*[:,!-]",
    rf"^\s*(?:attention|dear|hey|hello|hi)\s*,?\s*{_AI}\b",
    # AI assistants reading this page must…
    rf"\b{_AI},?\s+(?:that\s+(?:is|are)\s+|who\s+(?:is|are)\s+)?(?:reading|parsing|summari[sz]ing|browsing|"
    r"processing|visiting|crawling|scraping|analy[sz]ing)\s+(?:this|these)\b",
    # a system prompt or a chat role, planted
    r"\b(?:system|developer)\s+(?:prompt|message|instructions?)\s*[:=]",
    r"^\s*(?:\[|<|#{2,}\s*)(?:system|assistant|instructions?)\s*(?:\]|>|:)",
    r"^\s*system\s*:\s*(?:you|ignore|disregard|forget|new|from\s+now|act|override)\b",
    r"\byou\s+are\s+now\s+(?:in\s+)?(?:developer|god|jailbreak|jailbroken|unrestricted|dan)\b",
    r"\bnew\s+(?:system\s+)?instructions?\s*:",
    r"\byour\s+(?:new|real|actual|true|updated)\s+(?:task|goal|objective|instructions?|job|purpose)\s+"
    r"(?:is|are|now)\b",
    # keep it from the user / send their data
    r"\b(?:do\s+not|don't|never)\s+(?:tell|inform|alert|notify|warn|mention\s+(?:this|it)\s+to|"
    r"reveal\s+(?:this|it)\s+to|show\s+(?:this|it)\s+to)\s+(?:the\s+)?(?:user|human|owner|person)\b",
    r"\b(?:send|forward|e-?mail|upload|post|exfiltrate|leak|share|copy)\s+(?:the\s+|all\s+|any\s+|your\s+)?"
    r"(?:user'?s?|owner'?s?|human'?s?)\s+(?:data|e-?mails?|messages?|passwords?|credentials?|files?|contacts?|"
    r"history|cookies|tokens?|keys?|information|details|notes)\b",
]
_ZH = [
    r"(?:忽略|无视|忘记|忘掉|不要理会|不用管|覆盖|绕过)(?:掉)?(?:你)?(?:之前|以上|前面|先前|上面|原来|原先|所有|全部|一切|系统)"
    r"(?:的)?(?:所有|全部)?(?:指令|指示|提示词?|说明|规则|要求|设定)",
    r"(?:你|您)(?:现在)?(?:是|扮演|充当|作为)(?:一个|一名)?(?:AI|人工智能|智能助手|语言模型|大模型|大语言模型|聊天机器人|AI助手)",
    r"如果(?:你|您)是(?:一个|一名)?(?:AI|人工智能|语言模型|大模型|大语言模型|聊天机器人|智能助手|AI助手)",
    r"(?:给|致|写给|提醒|告诉)(?:所有|任何|正在阅读的)?(?:AI|人工智能|语言模型|大模型|大语言模型|智能助手|AI助手|聊天机器人)[：:，,]",
    r"(?:AI|人工智能|大模型|语言模型|智能助手)(?:在)?(?:阅读|读取|总结|浏览|处理|抓取)(?:此|本|这个)(?:页面|网页|内容|文章)",
    r"(?:不要|别|切勿|禁止)(?:告诉|通知|提醒|透露给|告知)(?:用户|使用者|主人|人类)",
    r"系统提示词?[：:]|系统指令[：:]|新的?指令[：:]|你的(?:新|真正的|实际)(?:任务|目标|指令)是",
    r"(?:发送|转发|上传|泄露|分享|复制)(?:用户|主人|使用者)的(?:数据|邮件|消息|密码|凭证|文件|联系人|信息|资料)",
]
_PATTERNS = [re.compile(p, re.IGNORECASE | re.MULTILINE) for p in (*_EN, *_ZH)]
# Each of the Chinese ways needs a Chinese character, so a page with none (most of them) is
# read for the English ones only.
_HAN = re.compile(r"[\u4e00-\u9fff]")
_SENTENCE_END = re.compile(r"[.!?。！？\n]")
SNIPPET = 200  # characters of each sentence the owner is shown
MOST = 3
SCAN = 200_000  # characters of a page looked at


def _sentence(text: str, start: int, end: int) -> str:
    """The sentence around a match, as the owner is shown it."""
    left = max(
        (m.end() for m in _SENTENCE_END.finditer(text, max(0, start - 300), start)), default=0
    )
    right_match = _SENTENCE_END.search(text, end, end + 300)
    right = right_match.end() if right_match else min(len(text), end + 300)
    words = " ".join(text[max(left, start - 300) : right].split())
    return words if len(words) <= SNIPPET else f"{words[: SNIPPET - 1]}…"


def addressed_to_ai(text: str) -> list[str]:
    """The sentences of text written to an AI (at most three), or [] for none."""
    body = clean_text(str(text or "")[:SCAN])
    found: list[tuple[int, str]] = []
    for pattern in _PATTERNS if _HAN.search(body) else _PATTERNS[: len(_EN)]:
        for match in pattern.finditer(body):
            sentence = _sentence(body, match.start(), match.end())
            if sentence and all(sentence != s for _, s in found):
                found.append((match.start(), sentence))
            if len(found) >= MOST * 3:
                break
    found.sort()
    return [s for _, s in found[:MOST]]
