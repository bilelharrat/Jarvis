"""Chinese (Simplified Mandarin) as a second language: wake word, stop, yes and no, the
instant commands, listening and speaking settings, numbers, markets, weather, the
backend's own strings, and English left exactly as it was."""

import ast
import inspect
import re
from collections import Counter
from pathlib import Path

import pytest

from jarvis import lang, markets, research, ui, wake
from jarvis.speech import split_sentences as english_split
from jarvis.voicecode import voice_answer as english_voice_answer

SRC = Path(lang.__file__).parent


# ── the setting ──


@pytest.mark.parametrize(
    ("value", "code"),
    [
        ("zh", "zh"),
        ("ZH-cn", "zh"),
        (" zh ", "zh"),
        ("zh-Hans", "zh"),
        ("中文", "zh"),
        ("Chinese", "zh"),
        ("Mandarin", "zh"),
        ("普通话", "zh"),
        ("en", "en"),
        ("English", "en"),
        ("en-GB", "en"),
        ("fr", None),
        ("", None),
        (None, None),
        (3, None),
        (["zh"], None),
    ],
)
def test_clean_language(value, code):
    assert lang.clean_language(value) == code


def test_languages_for_settings():
    assert lang.LANGUAGES == {"en": "English", "zh": "中文"}
    assert lang.DEFAULT_LANGUAGE == "en"
    assert lang.languages_payload() == [
        {"id": "en", "name": "English"},
        {"id": "zh", "name": "中文"},
    ]
    assert lang.is_zh("中文") and not lang.is_zh("en") and not lang.is_zh(None)


# ── Traditional to Simplified ──


def test_the_traditional_table_is_clean():
    pairs = lang._T2S_LIST
    assert all(len(p) == 2 and p[0] != p[1] for p in pairs), [p for p in pairs if len(p) != 2]
    assert not [k for k, n in Counter(p[0] for p in pairs).items() if n > 1]  # no duplicates
    keys = {p[0] for p in pairs}
    assert not [p for p in pairs if p[1] in keys]  # no chains: converting twice changes nothing
    assert len(pairs) > 600


def test_to_simplified():
    assert lang.to_simplified("我們正在看著這個網頁") == "我们正在看着这个网页"
    assert lang.to_simplified("賈維斯，打開瀏覽器") == "贾维斯，打开浏览器"
    assert lang.to_simplified("甚麼時候開會？乾淨嗎？瞭解。") == "什么时候开会？干净吗？了解。"
    assert lang.to_simplified("滾動到頁面頂部") == "滚动到页面顶部"
    assert lang.to_simplified("听著") == "听着"  # half-converted text is fixed too
    # The same characters in their Simplified use are left alone.
    assert lang.to_simplified("著名的乾隆") == "著名的乾隆"
    assert lang.to_simplified("已经是简体了，English stays.") == "已经是简体了，English stays."
    assert lang.to_simplified("") == "" and lang.to_simplified(None) == ""
    # Full-width letters and digits, as some Chinese input writes them.
    assert lang.to_simplified("ＪＡＲＶＩＳ，下跌０．７７％") == "JARVIS，下跌0.77%"
    assert lang.find_wake_zh("ｊａｒｖｉｓ，打开浏览器") == (True, "打开浏览器")
    assert lang.spoken_numbers_zh(lang.to_simplified("下跌０．７７％")) == "下跌百分之零点七七"


def test_simplified_is_a_fixed_point():
    text = "國際新聞：標普500指數下跌，黃金價格上漲。設定、瀏覽器、手勢控制、關閉。"
    once = lang.to_simplified(text)
    assert lang.to_simplified(once) == once
    assert once == "国际新闻：标普500指数下跌，黄金价格上涨。设定、浏览器、手势控制、关闭。"


def test_words_and_cjk():
    assert lang.has_cjk("打开 browser") and not lang.has_cjk("open the browser")
    assert not lang.has_cjk("") and not lang.has_cjk(None)
    assert lang.words_zh("打开 Jarvis Code 3次") == ["打", "开", "jarvis", "code", "3", "次"]
    assert lang.words("打开浏览器", "zh") == list("打开浏览器")
    assert lang.words("open the browser", "en") == wake.words("open the browser")


# ── the wake word ──


@pytest.mark.parametrize(
    ("said", "command"),
    [
        ("贾维斯，今天天气怎么样？", "今天天气怎么样"),
        ("今天天气怎么样，贾维斯？", "今天天气怎么样"),
        ("贾维斯", ""),
        ("贾维斯。", ""),
        ("嘿贾维斯", ""),
        ("嘿，贾维斯", ""),
        ("喂 贾维斯", ""),
        ("你好，贾维斯。打开浏览器", "打开浏览器"),
        ("哈喽贾维斯，现在几点", "现在几点"),
        ("好的贾维斯，关灯", "关灯"),
        ("加维斯，放点音乐", "放点音乐"),
        ("贾维思，放点音乐", "放点音乐"),
        ("杰维斯，放点音乐", "放点音乐"),
        ("嘉维斯，放点音乐", "放点音乐"),
        ("佳维斯，放点音乐", "放点音乐"),
        ("賈維斯，打開瀏覽器", "打开浏览器"),  # Traditional, as Whisper sometimes writes it
        ("Jarvis，打开浏览器", "打开浏览器"),
        ("JARVIS 打开浏览器", "打开浏览器"),
        ("嘿 Travis，打开浏览器", "打开浏览器"),  # a greeted mishearing, as in English
        ("贾维斯贾维斯，打开浏览器", "打开浏览器"),
        ("贾维斯，打开贾维斯代码", "打开贾维斯代码"),
        ("把音乐关了贾维斯", "把音乐关了"),
        ("我说贾维斯，关灯", "我说，关灯"),
        ("贾维斯你好", "你好"),
        # The panel's name after the wake word stays whole, as wake.find_wake keeps it.
        ("贾维斯，Jarvis Code 做完了吗？", "Jarvis Code 做完了吗"),
        ("嘿贾维斯，贾维斯代码好了没有", "贾维斯代码好了没有"),
        ("Jarvis，Jarvis Code 在跑吗", "Jarvis Code 在跑吗"),
    ],
)
def test_wakes_in_mandarin(said, command):
    assert lang.find_wake_zh(said) == (True, command)
    assert lang.find_wake(said, "zh") == (True, command)


@pytest.mark.parametrize(
    "said",
    [
        "今天天气怎么样",
        "贾维斯代码完成了",  # Jarvis Code, the panel: its own heads-up, never a wake word
        "Jarvis Code 在项目里完成了",
        "打开贾维斯代码",
        "参加维斯塔的发布会",  # 加维斯 inside 参加维斯塔
        "大家维斯",
        "我们去拉斯维加斯吧",
        "Travis来了",
        "贾维",
        "",
    ],
)
def test_similar_words_do_not_wake(said):
    assert lang.find_wake_zh(said) == (False, "")


ENGLISH_SAID = [
    "Jarvis, what's on my calendar?",
    "hey jarvis play some music",
    "Jarvis.",
    "What's the weather, Jarvis?",
    "Okay Jarvis turn it up",
    "hey Jarvis",
    "what time is it",
    "Jarim Vis, remind me to call Sam at 9.",
    "What's the weather like today, Jaren Vist?",
    "Jari ves,",
    "Jervis play music",
    "Travis is coming over",
    "Hey Travis, turn the lights off.",
    "Jarvis Code finished in bsh-research-center.",
    "Stop.",
    "okay stop",
    "stop the music in the kitchen and turn off the lights",
    "yes please",
    "Sure, actually no",
    "hold on",
    "",
]


@pytest.mark.parametrize("said", ENGLISH_SAID)
def test_english_is_untouched_in_both_modes(said):
    for mode in ("en", "zh"):
        assert lang.find_wake(said, mode) == wake.find_wake(said)
        assert lang.is_stop(said, mode) == wake.is_stop(said)
        assert lang.yes_no(said, mode) == wake.yes_no(said)


def test_speakable_safely_never_says_the_wake_word():
    assert lang.speakable_safely_zh("贾维斯代码在项目里完成了") == "编程助手在项目里完成了"
    assert lang.speakable_safely_zh("要启动 Jarvis Code 吗？") == "要启动 编程助手 吗？"
    assert lang.speakable_safely_zh("我是J.A.R.V.I.S.，你好") == "我是助手，你好"
    assert lang.speakable_safely_zh("嘉维斯说好") == "助手说好"
    assert lang.speakable_safely_zh("Jarvis says hi") == "助手 says hi"
    for text in ("贾维斯", "加维斯来了", "賈維斯", "Hey Jarvis", "Jervis 你好"):
        spoken = lang.speakable_safely_zh(text)
        assert spoken is not None and not lang.find_wake_zh(spoken)[0], text


# ── stop, yes and no ──


@pytest.mark.parametrize(
    "said",
    ["停", "停！", "停下来吧", "停止", "暂停", "别说了", "不要说了", "安静", "安静点儿", "闭嘴吧你",
     "你闭嘴", "够了够了", "等一下", "等一下再说", "等等", "稍等", "打住", "算了", "取消", "嘘",
     "好了，停下", "别说了好吗", "停停停"],
)  # fmt: skip
def test_mandarin_stops(said):
    assert lang.is_stop_zh(said), said
    assert lang.is_stop(said, "zh")


@pytest.mark.parametrize(
    "said",
    ["停车场在哪", "停车", "停电了", "取消订单", "暂停音乐", "等等我", "好了好了", "今天天气怎么样",
     "我不想停下来因为这首歌很好听", ""],
)  # fmt: skip
def test_not_mandarin_stops(said):
    assert not lang.is_stop_zh(said), said


@pytest.mark.parametrize(
    "said",
    ["好", "好的", "好啊", "好吧", "行", "可以", "可以的", "是", "是的", "对", "对的", "没错", "确认",
     "确定", "发送", "发", "发吧", "发出去", "没问题", "当然可以", "没意见", "好的，谢谢", "那就发吧",
     "嗯，好的", "不错，发吧", "OK，发吧", "贾维斯，好的", "好的，发吧，谢谢", "我不介意",
     "没有问题", "没什么问题", "没啥问题", "没毛病", "yes，发吧", "Jarvis，OK"],
)  # fmt: skip
def test_mandarin_yes(said):
    assert lang.yes_no_zh(said) is True, said


@pytest.mark.parametrize(
    "said",
    ["不", "不要", "不行", "不用", "不用了", "别", "别发", "先别", "先别发", "取消", "算了", "没有",
     "好，先别发", "发送，不对，先别发", "可以，不要发", "不，等一下", "no，别发", "暂时不要",
     "还是不要了", "好久不见",  # a stray 不 is a no: a no only keeps a thing from happening
     # Said twice or three times: a no, not an A-not-A question ("要不要" in "不要不要").
     "不不不", "不，不，不", "不不", "不要不要", "不用不用", "不行不行", "不对不对", "不是不是",
     "没有没有",
     # A no first, then a question tag: still a no (the no is checked before the question).
     "不要发，好吗？", "别发，行吗", "不用了，好不好", "不发了，可以吗"],
)  # fmt: skip
def test_mandarin_no_and_a_no_anywhere_wins(said):
    assert lang.yes_no_zh(said) is False, said


@pytest.mark.parametrize(
    "said",
    ["嗯", "嗯嗯", "我想想", "让我想想", "等一下", "好，等一下", "我不确定", "不知道", "可以吗？", "要不要发",
     "好不好", "是不是", "不错", "没事", "发现了一个问题", "行李在哪", "对面那家店", "是谁",
     "请帮我把这封邮件改得更正式一点然后再发", "",
     # Not a no, and not a clear yes either.
     "不成问题", "不要紧",
     # Questions back: A-not-A with 没, or a question word.
     "有没有问题", "发没发", "为什么要发", "发给谁", "几点发",
     # A Latin yes only as a whole word: OKR and yesterday aren't OK and yes.
     "OKR 在哪", "yesterday 的"],
)  # fmt: skip
def test_mandarin_unclear_answers_nothing(said):
    assert lang.yes_no_zh(said) is None, said


def test_yes_then_no_is_always_a_no():
    for yes in ("好", "好的", "可以", "行", "发吧", "确认", "没问题"):
        for no in ("不", "别发", "取消", "算了", "先别发"):
            assert lang.yes_no_zh(f"{yes}，{no}") is False, (yes, no)


# ── voice answers to approval cards ──

SEND = {
    "id": "a1",
    "question": "Send this to Ben?",
    "choices": [{"id": "allow", "label": "Send"}, {"id": "deny", "label": "Don't send"}],
}
CODE = {
    "id": "a2",
    "question": "Jarvis Code in jarvis wants to run a command",
    "task_id": 1,
    "tool": "Bash",
    "choices": [
        {"id": "allow", "label": "Yes"},
        {"id": "allow_edits", "label": "Yes, allow all edits this session"},
        {"id": "always", "label": "Yes, and don't ask again for npm commands in jarvis"},
        {"id": "deny", "label": "No, and tell Claude what to do differently"},
    ],
}
PLAN = {
    "id": "a3",
    "question": "Jarvis Code in jarvis has a plan",
    "ask_kind": "plan",
    "task_id": 1,
    "choices": [
        {"id": "plan_edits", "label": "Go, auto-accept edits"},
        {"id": "plan_ask", "label": "Go, ask before edits"},
        {"id": "plan_keep", "label": "Keep planning"},
    ],
}
QUESTION = {
    "id": "a4",
    "question": "Which database?",
    "ask_kind": "question",
    "task_id": 1,
    "choices": [
        {"id": "opt0", "label": "Postgres"},
        {"id": "opt1", "label": "不需要数据库"},
        {"id": "opt2", "label": "SQLite"},
        {"id": "skip", "label": "Skip"},
    ],
}


@pytest.mark.parametrize(
    ("approval", "said", "answer"),
    [
        (SEND, "好的", ("allow", "")),
        (SEND, "发吧", ("allow", "")),
        (SEND, "发送", ("allow", "")),
        (SEND, "好的，谢谢", ("allow", "")),
        (SEND, "贾维斯，发吧", ("allow", "")),
        (SEND, "好，先别发", ("deny", "")),
        (SEND, "不要，改成明天见", ("deny", "改成明天见")),
        (SEND, "可以，但是加上表情", ("deny", "加上表情")),
        (SEND, "等一下", ("hold", "")),
        (SEND, "我想想", ("hold", "")),
        (SEND, "嗯", ("hold", "")),
        (SEND, "发现了一个问题", ("reask", "")),
        (SEND, "第一个", ("allow", "")),
        (SEND, "第二个", ("deny", "")),
        (SEND, "可以吗？", None),
        (SEND, "今天天气怎么样", None),
        (CODE, "好", ("allow", "")),
        (CODE, "始终允许", ("always", "")),
        (CODE, "以后都允许", ("always", "")),
        (CODE, "不用再问了", ("always", "")),
        (CODE, "允许所有编辑", ("allow_edits", "")),
        (CODE, "第一个", ("allow", "")),
        (CODE, "第二个", ("reask", "")),  # never "all edits" by number
        (CODE, "第三个", ("reask", "")),  # never "always" by number
        (CODE, "最后一个", ("deny", "")),
        (CODE, "不", ("deny", "")),
        (CODE, "不，先写测试", ("deny", "先写测试")),
        (CODE, "别跑迁移，只生成它", ("deny", "别跑迁移，只生成它")),
        (CODE, "好，但是别跑测试", ("deny", "别跑测试")),
        (CODE, "不，始终允许", ("deny", "始终允许")),  # a no first: never "always"
        # "Always" and "all edits" asked back as a question grant nothing.
        (CODE, "始终允许？", None),
        (CODE, "以后都允许？", None),
        (CODE, "始终？", None),
        (CODE, "始终允许吗", None),
        (CODE, "允许所有编辑？", None),
        (CODE, "自动接受编辑？", None),
        (CODE, "不用再问了吗？", ("deny", "")),  # a question with a no in it: still a no
        (PLAN, "自动接受编辑？", None),
        # A refusal said over and over is a no, on a card and on a plan.
        (SEND, "不不不", ("deny", "")),
        (SEND, "不要不要", ("deny", "")),
        (PLAN, "不不不", ("plan_keep", "")),
        (PLAN, "不行不行", ("plan_keep", "")),
        # "No problem" in full is a yes, not a no.
        (SEND, "没有问题", ("allow", "")),
        (SEND, "没毛病", ("allow", "")),
        (PLAN, "没有问题", ("plan_ask", "")),
        (SEND, "不要紧", None),
        # A number only as an option: "我要一个" or "一号" is not option one.
        (SEND, "我要一个", None),
        (SEND, "要一个", None),
        (SEND, "用一个", None),
        (SEND, "就一个", None),
        (SEND, "一号", None),
        (CODE, "我要一个", None),
        (SEND, "选第一个", ("allow", "")),
        (SEND, "选项二", ("deny", "")),
        (PLAN, "我要一个", None),
        (QUESTION, "我选二", ("opt1", "")),  # a question's options: a bare number will do
        (QUESTION, "三", ("opt2", "")),
        # "By the way…" and "the thing is…" open something else.
        (CODE, "对了，还有一件事", None),
        (CODE, "是这样的，我想让你先写测试", None),
        (PLAN, "对了，我想问个问题", None),
        (CODE, "对了", ("allow", "")),  # said alone, it's "right"
        (PLAN, "开始吧", ("plan_ask", "")),
        (PLAN, "好", ("plan_ask", "")),
        (PLAN, "自动接受编辑", ("plan_edits", "")),
        (PLAN, "继续规划", ("plan_keep", "")),
        (PLAN, "修改一下计划", ("plan_keep", "")),
        (PLAN, "不，先把测试补上", ("plan_keep", "先把测试补上")),
        (PLAN, "第一个", ("reask", "")),  # never auto-edits by number
        (PLAN, "第二个", ("plan_ask", "")),
        (PLAN, "等一下", ("hold", "")),
        (QUESTION, "第一个", ("opt0", "")),
        (QUESTION, "选项三", ("opt2", "")),
        (QUESTION, "最后一个", ("opt2", "")),  # the last option, not the unspoken Skip
        (QUESTION, "不需要数据库", ("opt1", "")),  # an option's own name isn't a no
        (QUESTION, "跳过", ("skip", "")),
        (QUESTION, "都不要", ("skip", "")),
        (QUESTION, "等一下", ("hold", "")),
        (QUESTION, "好", ("reask", "")),  # a yes doesn't answer "which one?"
        (QUESTION, "不", ("reask", "")),
        (QUESTION, "第五个", ("reask", "")),
        (QUESTION, "用 SQLite 吧", ("opt2", "")),
        (QUESTION, "Postgres 数据库", ("opt0", "")),
        (QUESTION, "为什么不用 Postgres", None),  # a question for Claude, not an answer
    ],
)
def test_voice_answers_in_mandarin(approval, said, answer):
    assert lang.voice_answer_zh(said, approval) == answer
    assert lang.voice_answer(said, approval, "zh") == answer


def test_always_needs_the_choice_to_exist():
    assert lang.voice_answer_zh("始终允许", SEND) != ("always", "")
    assert lang.voice_answer_zh("允许所有编辑", SEND) != ("allow_edits", "")


def test_voice_answers_without_chinese_are_voicecode_s():
    for approval in (SEND, CODE, PLAN, QUESTION):
        for said in ("yes please", "no, use the Makefile", "option two", "hold on", "SQLite", ""):
            expected = english_voice_answer(said, approval)
            assert lang.voice_answer_zh(said, approval) == expected
            assert lang.voice_answer(said, approval, "en") == expected
            assert lang.voice_answer(said, approval, "zh") == expected


def test_no_choices_or_nothing_said():
    assert lang.voice_answer_zh("好的", {"question": "?", "choices": []}) is None
    assert lang.voice_answer_zh("，。", SEND) is None


# The cards as a Chinese user sees them: labels through lang.translate, as the hub shows
# them, and the options of a Claude Code question asked in Chinese.
def _choices(*pairs):
    return [{"id": i, "label": label} for i, label in pairs]


T = lang.translate
CODE_ZH = {
    **CODE,
    "choices": _choices(
        ("allow", T("Yes")),
        ("allow_edits", T("Yes, allow all edits this session")),
        ("always", T("Yes, and don't ask again for npm commands in jarvis")),
        ("deny", T("No, and tell Claude what to do differently")),
    ),
}
SEND_ZH = {**SEND, "choices": _choices(("allow", T("Send")), ("deny", T("Don't send")))}
GATE_ZH = {
    "id": "a5",
    "question": "Open example.com in your browser?",
    "choices": _choices(("allow", T("Allow")), ("deny", T("Not now"))),
}
SHORTCUT_ZH = {
    "id": "a6",
    "question": "Run the shortcut “Movie mode”?",
    "choices": _choices(("allow", T("Run")), ("always", T("Always")), ("deny", T("Not now"))),
}
QUESTION_ZH = {
    "id": "a7",
    "question": "要用生产数据库吗？",
    "ask_kind": "question",
    "task_id": 1,
    "choices": _choices(("opt0", "是"), ("opt1", "否"), ("skip", "Skip")),
}
SEND_EN = {**SEND}
CODE_EN = {**CODE, "choices": _choices(("allow", "Yes"), ("deny", "No, and tell Claude"))}


def test_the_chinese_cards_are_what_the_hub_shows():
    assert [c["label"] for c in CODE_ZH["choices"]][0] == "是"
    assert [c["label"] for c in SEND_ZH["choices"]] == ["发送", "不发送"]
    assert [c["label"] for c in GATE_ZH["choices"]] == ["允许", "暂不"]
    assert [c["label"] for c in SHORTCUT_ZH["choices"]] == ["运行", "始终", "暂不"]


@pytest.mark.parametrize(
    ("approval", "said"),
    [
        # A sentence holding a label's word isn't that label: none of these approve.
        (CODE_ZH, "这个是生产环境"),
        (CODE_ZH, "还是先备份一下"),
        (CODE_ZH, "要是出错了怎么办"),
        (CODE_ZH, "我觉得这是个坏主意"),
        (CODE_ZH, "可是这样会删掉数据"),
        (CODE_ZH, "先解释一下这是干嘛的"),
        (CODE_ZH, "这是什么命令"),
        (GATE_ZH, "谁允许你这么做的"),
        (GATE_ZH, "谁允许"),
        (SEND_ZH, "把发送的内容改一下"),
        (SEND_ZH, "谁发送"),
        (SEND_ZH, "为什么要发送"),
        (SHORTCUT_ZH, "这个命令会运行多久"),
        (SHORTCUT_ZH, "运行多久"),
        # English labels inside longer Latin words.
        (CODE_EN, "把 yesterday 的日志删掉"),
        (CODE_EN, "yesterday 的日志"),
        (SEND_EN, "把 sender 改成我"),
        (SEND_EN, "sender 是谁"),
        (SHORTCUT_ZH, "rerun 一下"),
        # Claude Code's own yes/no options, asked in Chinese.
        (QUESTION_ZH, "这样做是对的吗"),
        (QUESTION_ZH, "这样做是对的"),
        (QUESTION_ZH, "是不是生产环境"),
        (QUESTION_ZH, "我觉得是否可以换个方法"),
    ],
)
def test_a_sentence_holding_a_label_is_not_that_answer(approval, said):
    answer = lang.voice_answer_zh(said, approval)
    assert answer is None or answer[0] == "reask", (said, answer)
    assert lang.voice_answer(said, approval, "zh") == answer


@pytest.mark.parametrize(
    ("approval", "said", "answer"),
    [
        (CODE_ZH, "是", ("allow", "")),
        (CODE_ZH, "是的", ("allow", "")),
        (CODE_ZH, "否", ("deny", "")),
        (CODE_ZH, "始终允许", ("always", "")),
        (GATE_ZH, "允许", ("allow", "")),
        (GATE_ZH, "允许吧", ("allow", "")),
        (GATE_ZH, "暂不", ("deny", "")),
        (SEND_ZH, "发送", ("allow", "")),
        (SEND_ZH, "不发送", ("deny", "")),
        (SHORTCUT_ZH, "运行", ("allow", "")),
        (SHORTCUT_ZH, "始终", ("always", "")),
        (SHORTCUT_ZH, "暂不", ("deny", "")),
        (SEND_EN, "send 吧", ("allow", "")),  # the English label, said in Chinese
        (CODE_EN, "yes 吧", ("allow", "")),
        (QUESTION_ZH, "是", ("opt0", "")),
        (QUESTION_ZH, "否", ("opt1", "")),
        (QUESTION_ZH, "是的", ("reask", "")),  # one character counts only said exactly
        (QUESTION_ZH, "第二个", ("opt1", "")),
    ],
)
def test_the_chinese_cards_still_answer_by_voice(approval, said, answer):
    assert lang.voice_answer_zh(said, approval) == answer


def test_no_sentence_around_a_label_approves():
    # Any label on a card, with real words (not glue) on either side, never approves.
    import random

    rng = random.Random(3)
    fronts = ["这个", "我觉得", "还", "要", "谁", "把", "可", "先", "他说", "为了"]
    backs = ["生产环境", "的内容改一下", "多久", "了没有", "错了", "有风险", "的人", "之前"]
    for approval in (CODE_ZH, SEND_ZH, GATE_ZH, SHORTCUT_ZH, SEND_EN, CODE_EN):
        allow = approval["choices"][0]["label"]
        for _ in range(40):
            said = rng.choice(fronts) + allow + rng.choice([*backs, ""])
            answer = lang.voice_answer_zh(said, approval)
            assert answer is None or answer[0] not in ("allow", "always", "allow_edits"), said


def test_its_own_question_heard_back_is_not_an_answer():
    spoken = T("Here's your message to Ben. See you at 3 Do you want this message sent?")
    assert spoken.endswith("要发送这条消息吗？")
    heard_back = {**SEND_ZH, "spoken": spoken}
    for said in ("要发送这条消息", "发送这条消息", "这是你发给Ben的消息"):
        assert lang.voice_answer_zh(said, heard_back) is None, said
    # The card's question in Chinese, even when the card holds it in English.
    assert lang.voice_answer_zh("把这条发给Ben", SEND_ZH) is None
    # A plain answer still counts.
    assert lang.voice_answer_zh("发送", heard_back) == ("allow", "")
    assert lang.voice_answer_zh("好的", heard_back) == ("allow", "")
    # A label that opens the question itself is maybe its own voice (as "open" is for
    # "Open example.com?" in English): a yes word still answers.
    open_zh = {
        "question": "要打开 example.com 吗？",
        "choices": _choices(("allow", "打开"), ("deny", "暂不")),
    }
    assert lang.voice_answer_zh("打开", open_zh) is None
    assert lang.voice_answer_zh("好", open_zh) == ("allow", "")
    # What was said aloud may list the options: naming one is still an answer.
    plan = {
        **PLAN,
        "choices": [{"id": c["id"], "label": T(c["label"])} for c in PLAN["choices"]],
        "spoken": "计划好了。可以说：开始，编辑前先问我；开始，自动接受编辑；或者继续规划。",
    }
    assert lang.voice_answer_zh("编辑前先问我", plan) == ("plan_ask", "")
    assert lang.voice_answer_zh("继续规划", plan) == ("plan_keep", "")


PURCHASE = {
    "ask_kind": "purchase",
    "question": "Buy 2 tickets from Example Shop for $42.00?",
    "choices": _choices(("allow", "Confirm purchase"), ("deny", "Cancel")),
}


def test_a_purchase_takes_only_its_phrase():
    purchase = PURCHASE
    assert lang.voice_answer_zh("确认购买", purchase) == ("allow", "")
    assert lang.voice_answer_zh("好的，确认购买", purchase) == ("allow", "")
    for said in ("好", "好的", "是", "买吧", "发送", "第一个", "允许", "确认"):
        assert lang.voice_answer_zh(said, purchase) == ("reask", ""), said
    for said in ("不要", "取消", "不不不", "别买了"):
        assert lang.voice_answer_zh(said, purchase) == ("deny", ""), said
    assert lang.voice_answer_zh("confirm purchase", purchase) == ("allow", "")
    assert lang.voice_answer("好的", purchase, "zh") == ("reask", "")


# ── its own voice, and a finished request ──


def test_echo_of_its_own_chinese():
    said = "今天天气很好，最高二十二度。"
    assert lang.is_echo_zh("今天天气很好", said)
    assert lang.is_echo("最高二十二度", said, "zh")
    assert not lang.is_echo_zh("打开浏览器", said)
    assert not lang.is_echo_zh("好", "好的")  # one character proves nothing
    assert not lang.is_echo_zh("今天天气很好", "")
    reply = "You have a design review at two."
    assert lang.is_echo_zh("design review at two", reply) == wake.is_echo(
        "design review at two", reply
    )


@pytest.mark.parametrize(
    ("said", "finished"),
    [
        ("今天天气怎么样？", True),
        ("打开浏览器。", True),
        ("给我讲个笑话。", True),
        ("这是谁的？", True),  # asked as a question, it's done
        ("帮我查一下明天的。", False),
        ("我想问一下…", False),
        ("好的，然后，", False),
        ("嗯。", False),
        ("明天会下雨吗", False),  # no full stop yet
        ("", False),
    ],
)
def test_sounds_finished_in_mandarin(said, finished):
    assert lang.sounds_finished_zh(said) is finished
    assert lang.sounds_finished(said, "zh") is finished


def test_sounds_finished_in_english_is_listen_s():
    from jarvis.listen import sounds_finished

    for said in ("What's the weather like?", "What's the weather in", "Open the browser."):
        assert lang.sounds_finished_zh(said) == sounds_finished(said)
        assert lang.sounds_finished(said, "en") == sounds_finished(said)


# ── instant commands: the Research Center ──

RESEARCH_PAIRS = [
    ("向下滚动", "scroll down"),
    ("往下", "down"),
    ("往下滚一点", "scroll down a bit"),
    ("稍微往下", "scroll down a bit"),
    ("往下滚很多", "go down a lot"),
    ("往下翻两页", "scroll down two pages"),
    ("下一页", "page down"),
    ("继续", "keep going"),
    ("更多", "more"),
    ("上一页", "page up"),
    ("向上滚动", "scroll up"),
    ("往上一点", "scroll up a bit"),
    ("回到顶部", "back to top"),
    ("返回顶部", "go to the top"),
    ("到底部", "scroll to the bottom of the page"),
    ("滚到最下面", "scroll to the bottom of the page"),
    ("返回", "go back"),
    ("后退", "go back"),
    ("返回上一页", "previous page"),
    ("前进", "forward"),
    ("放大", "zoom in"),
    ("字大一点", "make it bigger"),
    ("缩小", "zoom out"),
    ("小一点", "smaller"),
    ("恢复缩放", "reset zoom"),
    ("关闭研究中心", "close the research center"),
    ("关闭", "close"),
    ("把它关掉", "close it"),
    ("打开报告", "open reports"),
    ("打开新闻", "show me the news"),
    ("去研究台", "take me to the research desk"),
    ("打开追踪页面", "please go to tracking"),
    ("打开首页", "open home"),
    ("打开 news desk", "open the news desk"),
    ("点击NVDA", "tap on NVDA"),
    ("点击 earnings", "click earnings"),
    ("点击 Generate memo 按钮", "press the generate memo button"),
    ("请帮我往下滚动一下吧", "scroll down"),
    ("贾维斯，往下滚", "scroll down"),
    ("打開報告", "open reports"),
]


@pytest.mark.parametrize(("said", "english"), RESEARCH_PAIRS)
def test_research_commands_match_the_english(said, english):
    zh, en = lang.parse_research_zh(said), research.parse(english)
    assert zh is not None and en is not None, (said, english)
    assert isinstance(zh, research.Command)
    assert (zh.action, zh.args, zh.speak) == (en.action, en.args, en.speak)
    assert zh.reply == "" or lang.has_cjk(zh.reply)
    assert lang.parse_research(said, "zh") == zh


def test_research_replies_are_chinese():
    assert lang.parse_research_zh("返回").reply == "返回。"
    assert lang.parse_research_zh("关闭研究中心").reply == "已关闭研究中心。"
    assert lang.parse_research_zh("打开报告").reply == "正在打开报告。"
    assert lang.parse_research_zh("打开reports").reply == "正在打开 reports。"


@pytest.mark.parametrize(
    "said",
    [
        "打开英伟达",  # a company: Claude looks it up
        "点击财报",  # the page's buttons are English: Claude matches the meaning
        "打开浏览器",  # the window's panel, not a page
        "关闭浏览器",
        "今天天气怎么样",
        "这张图说明了什么",
        "把第三季度的收入和去年同期比较一下然后告诉我结论",
        "",
    ],
)
def test_other_research_requests_go_to_claude(said):
    assert lang.parse_research_zh(said) is None


RESEARCH_ENGLISH = [
    "scroll down",
    "Down.",
    "scroll up a bit",
    "go down a lot",
    "page up",
    "back to top",
    "go back",
    "okay, back",
    "zoom in",
    "reset zoom",
    "close",
    "open reports",
    "show me the news",
    "click earnings",
    "tap on NVDA",
    "open nvidia",
    "what does this chart say",
    "going back",
    "",
]


@pytest.mark.parametrize("said", RESEARCH_ENGLISH)
def test_english_research_commands_are_untouched(said):
    assert lang.parse_research_zh(said) == research.parse(said)
    assert lang.parse_research(said, "en") == research.parse(said)
    assert lang.parse_research(said, "zh") == research.parse(said)


# ── instant commands: the window ──

UI_PAIRS = [
    ("打开浏览器", "open the browser"),
    ("关闭浏览器", "close the browser"),
    ("把浏览器关掉", "close the browser"),
    ("打开贾维斯代码", "open Jarvis Code"),
    ("打开 Jarvis Code", "open Jarvis Code"),
    ("切换到黑曜石", "switch to the obsidian look"),
    ("切换到指挥中心", "change to the command center look"),
    ("切换到光球", "go back to the orb"),
    ("用黑曜石模式", "switch to the obsidian look"),
    ("打开设置", "open settings"),
    ("显示第二大脑", "open the second brain"),
    ("关掉活动记录", "hide the activity log"),
    ("打开工具和账户", "open tools and accounts"),
    ("打开研究中心", "show me the research center"),
    ("打开手势控制", "turn on hand control"),
    ("关闭手势控制", "stop hand tracking"),
    ("手势控制关", "hands off"),
    ("打開瀏覽器", "open the browser"),
    ("贾维斯，打开浏览器吧", "open the browser"),
    ("切换到白色模式", "switch to white mode"),
    ("浅色模式", "light mode"),
    ("深色模式", "use the dark theme"),
]


@pytest.mark.parametrize(("said", "english"), UI_PAIRS)
def test_window_commands_match_the_english(said, english):
    zh, en = lang.parse_ui_zh(said), ui.parse(english)
    assert zh is not None and en is not None, (said, english)
    assert isinstance(zh, ui.Command)
    assert (zh.action, zh.name, zh.on) == (en.action, en.name, en.on)
    assert lang.has_cjk(zh.reply)
    assert lang.parse_ui(said, "zh") == zh


def test_window_replies_are_chinese():
    assert lang.parse_ui_zh("打开浏览器").reply == "正在打开浏览器。"
    assert lang.parse_ui_zh("关闭浏览器").reply == "已关闭浏览器。"
    assert lang.parse_ui_zh("打开贾维斯代码").reply == "正在打开 Jarvis Code。"
    assert lang.parse_ui_zh("切换到黑曜石").reply == "已切换到黑曜石。"
    assert lang.parse_ui_zh("打开手势控制").reply == "手势控制已开启。"
    assert lang.parse_ui_zh("关闭手势控制").reply == "手势控制已关闭。"


@pytest.mark.parametrize(
    "said",
    [
        "打开Safari",
        "打开代码",
        "关闭",
        "关灯",
        "切换到另一个",
        "今天天气怎么样",
        "我们来写代码",
        "",
    ],
)
def test_not_window_commands(said):
    assert lang.parse_ui_zh(said) is None


@pytest.mark.parametrize(
    "said",
    ["open Jarvis Code", "close the browser", "switch to obsidian", "turn on hand control",
     "hands off", "open safari", "close", "let's code in jarvis", ""],
)  # fmt: skip
def test_english_window_commands_are_untouched(said):
    assert lang.parse_ui_zh(said) == ui.parse(said)
    assert lang.parse_ui(said, "en") == ui.parse(said)


def test_the_english_tables_are_not_touched():
    for table in (research.PAGES, ui.PANELS, ui.LOOKS, ui.PANEL_NAMES, ui.LOOK_NAMES):
        assert not any(lang.has_cjk(k) or lang.has_cjk(str(v)) for k, v in table.items())
    assert not any(lang.has_cjk(w) for w in wake.WAKE_WORDS)
    assert set(lang.PANEL_NAMES_ZH) == set(ui.PANEL_NAMES)
    assert set(lang.LOOK_NAMES_ZH) == set(ui.LOOK_NAMES)
    assert set(lang.PANELS_ZH.values()) == set(ui.PANEL_NAMES)
    assert set(lang.PAGES_ZH.values()) <= set(research.PAGES.values())


def test_instant_shortcuts_by_their_chinese_names():
    names = ["电影模式", "Movie Mode", "打开客厅灯", "晚安"]
    assert lang.match_shortcut_zh("运行电影模式", names) == "电影模式"
    assert lang.match_shortcut_zh("电影模式", names) == "电影模式"
    assert lang.match_shortcut_zh("客厅灯", names) == "打开客厅灯"
    assert lang.match_shortcut_zh("晚安吧", names) == "晚安"
    assert lang.match_shortcut_zh("运行 movie mode", names) == "Movie Mode"
    assert lang.match_shortcut_zh("关灯", names) is None
    assert lang.match_shortcut_zh("电影", names) is None
    assert lang.match_shortcut_zh("晚安", ["晚安", "晚安吧"]) is None  # two match: ask Claude
    from jarvis.home import match_shortcut

    assert lang.match_shortcut_zh("movie mode", names) == match_shortcut("movie mode", names)
    assert lang.match_shortcut("movie mode", names, "en") == match_shortcut("movie mode", names)


def test_about_the_screen_and_live_topics():
    assert lang.about_screen_zh("这个报错是什么意思")
    assert lang.about_screen_zh("帮我总结一下这篇文章")
    assert not lang.about_screen_zh("明天几点开会")
    assert lang.about_screen("what does this error mean", "en")
    assert lang.about_screen("这个报错是什么意思", "zh")
    assert not lang.about_screen("这个报错是什么意思", "en")
    topics = lang.LIVE_TOPICS_ZH
    assert topics["weather"].search("明天会下雨吗") and topics["weather"].search("外面冷不冷")
    assert topics["calendar"].search("下一个会议是几点")
    assert topics["markets"].search("美股今天怎么样") and topics["markets"].search("比特币多少钱")
    assert not topics["markets"].search("给我讲个笑话")


# ── listening ──


def test_whisper_models():
    assert lang.whisper_model("en", "base.en") == "base.en"  # English unchanged
    assert lang.whisper_model("zh", "base.en") == lang.ZH_WHISPER_MODEL == "small"
    assert lang.whisper_model("zh", "tiny.en") == "small"
    assert lang.whisper_model("zh", "small.en") == "small"
    assert lang.whisper_model("zh", "medium.en") == "medium"
    assert lang.whisper_model("zh", "distil-large-v3") == "small"  # English-only too
    assert lang.whisper_model("zh", "large-v3") == "large-v3"  # already multilingual
    assert lang.whisper_model("zh", "") == "small"
    assert lang.whisper_model("zh", "base.en", override="base") == lang.ZH_WHISPER_FAST_MODEL


def test_transcribe_options():
    # English: never the wake word as a hotword (Whisper then dropped it from the start of
    # a request); learned words stay.
    assert lang.transcribe_options("en") == {"language": "en"}
    assert lang.transcribe_options("en", "Jarvis") == {"language": "en"}
    assert lang.transcribe_options("en", "useState") == {"language": "en", "hotwords": "useState"}
    assert lang.transcribe_options("en", "Jarvis Okin Hormuz") == {
        "language": "en",
        "hotwords": "Okin Hormuz",
    }
    zh = lang.transcribe_options("zh")
    assert zh == {"language": "zh", "initial_prompt": lang.ZH_INITIAL_PROMPT, "hotwords": "贾维斯"}
    assert "简体" in zh["initial_prompt"] and "贾维斯" not in zh["initial_prompt"]
    assert lang.transcribe_options("zh", "useState")["hotwords"] == "useState"


@pytest.mark.parametrize(
    "heard",
    ["谢谢观看", "谢谢收看", "请不吝点赞 订阅 转发 打赏支持明镜与点点栏目", "字幕由Amara.org社区提供",
     "以下是普通话的句子，使用简体中文。", "嗯", "謝謝觀看", "Thank you.", "you"],
)  # fmt: skip
def test_what_whisper_makes_up(heard):
    assert lang.is_hallucination_zh(heard)
    assert lang.clean_transcript_zh(heard) == ""
    assert lang.clean_transcript(heard, "zh") == ""


@pytest.mark.parametrize(
    "heard",
    ["优优独播剧场——YoYo Television Series Exclusive", "明镜需要您的支持 欢迎订阅明镜", "字幕by索兰娅",
     "中文字幕", "谢谢大家观看"],
)  # fmt: skip
def test_more_credit_lines_whisper_makes_up(heard):
    assert lang.is_hallucination_zh(heard), heard


@pytest.mark.parametrize(
    "said",
    ["贾维斯，给 Amara 发消息说我晚点到", "贾维斯，打电话给Amara", "心如明镜的人", "这个字幕由谁做的",
     "字幕由谁提供", "打开 YoYo 的网站", "帮我订阅这个频道"],
)  # fmt: skip
def test_a_request_naming_a_credit_word_is_kept(said):
    assert not lang.is_hallucination_zh(said), said
    assert lang.clean_transcript_zh(said) == said


def test_clean_transcripts():
    assert lang.clean_transcript_zh(" 贾 维 斯 ，打 开 瀏覽器 ") == "贾维斯，打开浏览器"
    assert lang.clean_transcript_zh("开 Jarvis Code") == "开 Jarvis Code"
    assert not lang.is_hallucination_zh("打开浏览器")
    assert lang.clean_transcript("What's the weather?", "en") == "What's the weather?"
    assert lang.clean_transcript("Thank you.", "en") == ""


# ── speaking ──


def test_voice_and_fillers():
    assert lang.mac_voice("zh") == lang.ZH_MAC_VOICE == "Tingting"
    assert lang.mac_voice("en", "Daniel") == "Daniel"
    assert all(lang.has_cjk(f) and f.endswith("。") for f in lang.FILLERS_ZH)
    fillers = _hub_constant("FILLERS")
    assert len(lang.FILLERS_ZH) == len(fillers)
    assert [lang.translate(f) for f in fillers] == lang.FILLERS_ZH


def test_split_sentences_has_the_english_signature():
    zh, en = inspect.signature(lang.split_sentences_zh), inspect.signature(english_split)
    assert [(p.name, p.default) for p in zh.parameters.values()] == [
        (p.name, p.default) for p in en.parameters.values()
    ]


@pytest.mark.parametrize(
    ("buffer", "final", "min_chars", "result"),
    [
        ("今天天气很好。明天", False, 12, (["今天天气很好。"], "明天")),
        ("好的。今天", False, 4, (["好的。"], "今天")),
        ("好的。今天", False, 12, ([], "好的。今天")),  # too short: waits to join the next
        ("价格是23.5美元。", False, 12, ([], "价格是23.5美元。")),  # may continue
        ("价格是23.5美元。", True, 12, (["价格是23.5美元。"], "")),
        ("会议在3:30开始。然后", False, 4, (["会议在3:30开始。"], "然后")),
        ("真的吗？！太好了", False, 4, (["真的吗？！"], "太好了")),
        ("他说：“好的。”然后", False, 12, (["他说：“好的。”"], "然后")),
        ("结果如下……", False, 4, ([], "结果如下……")),  # maybe more dots coming
        ("结果如下……然后", False, 4, (["结果如下……"], "然后")),
        ("NVDA is up. 英伟达上涨了。", False, 12, ([], "NVDA is up. 英伟达上涨了。")),
        ("NVDA is up. 英伟达上涨了。", True, 12, (["NVDA is up. 英伟达上涨了。"], "")),
        ("好的", True, 12, (["好的"], "")),
        ("", True, 12, ([], "")),
    ],
)
def test_split_sentences_in_chinese(buffer, final, min_chars, result):
    assert lang.split_sentences_zh(buffer, final, min_chars) == result
    assert lang.split_sentences(buffer, final, min_chars, "zh") == result


def test_streaming_a_chinese_reply():
    reply = "我查了一下你的日程。明天上午十点有一个设计评审，下午两点去看牙医。要我提醒你吗？"
    spoken, buffer = [], ""
    for i in range(0, len(reply), 3):  # arrives a few characters at a time
        buffer += reply[i : i + 3]
        done, buffer = lang.split_sentences_zh(buffer, min_chars=12)
        spoken += done
    done, buffer = lang.split_sentences_zh(buffer, final=True)
    spoken += done
    assert "".join(spoken) == reply and buffer == ""
    assert spoken == [
        "我查了一下你的日程。",
        "明天上午十点有一个设计评审，下午两点去看牙医。",
        "要我提醒你吗？",
    ]


def _stream(chunks, min_chars=12):
    spoken, buffer = [], ""
    for chunk in chunks:
        buffer += chunk
        done, buffer = lang.split_sentences_zh(buffer, min_chars=min_chars)
        spoken += done
    return spoken + lang.split_sentences_zh(buffer, final=True, min_chars=min_chars)[0]


@pytest.mark.parametrize(
    ("chunks", "sentences"),
    [
        # A short sentence waits for the next; the English word split across chunks
        # keeps its space.
        (["好的。", "NVDA is ", "up today。"], ["好的。NVDA is up today。"]),
        (["明白。Apple ", "Watch 已经发货了。"], ["明白。Apple Watch 已经发货了。"]),
        (["好的。", "NVDA ", "is up. ", "英伟达上涨了。"], ["好的。NVDA is up.", "英伟达上涨了。"]),
        (["我查了一下。", "The ", "Fed ", "meets today。"], ["我查了一下。The Fed meets today。"]),
    ],
)
def test_streaming_keeps_the_spaces_between_words(chunks, sentences):
    assert _stream(chunks) == sentences


@pytest.mark.parametrize(
    "case",
    [
        ("It is 23.", False, 12),
        ("It is 23.5 degrees. Then rain", False, 12),
        ("See you at 3:30 tomorrow. Bye", False, 12),
        ("The capital is Canberra. It", False, 12),
        ("It is 23.", True, 12),
    ],
)
def test_english_splitting_is_untouched(case):
    assert lang.split_sentences(*case, lang="en") == english_split(*case)


def test_first_clause():
    assert lang.first_clause_zh("我查了一下你的日程，明天上午") == (
        "我查了一下你的日程，",
        "明天上午",
    )
    assert lang.first_clause_zh("好的，明天") is None  # too short to be worth it
    assert lang.first_clause_zh("我查了一下你的日程，") is None  # wait for what follows
    assert lang.first_clause_zh("标普500收于7,684点") is None  # "7," isn't a clause
    assert lang.first_clause_zh("我查了一下。你的日程，明天") is None  # a sentence ended first


def test_clean_for_speech_in_chinese():
    text = (
        "# 今日\n- **标普500**下跌0.77%\n- 详情见[文档](https://x.y/z)\n```\nrm -rf /\n```\n"
        "访问 https://example.com，然后再说"
    )
    spoken = lang.clean_for_speech_zh(text)
    assert spoken == (
        "今日。标普五百下跌百分之零点七七。详情见文档。详细内容我放在屏幕上了。访问屏幕上的链接，然后再说"
    )
    assert "rm -rf" not in spoken and "http" not in spoken
    assert lang.clean_for_speech("1、打开浏览器\n2、看新闻", "zh") == "打开浏览器。看新闻"
    from jarvis.speech import clean_for_speech

    english = "# Today\n- **Standup** at 9\n\nSee [the doc](https://x.y/z)."
    assert lang.clean_for_speech(english, "en") == clean_for_speech(english)


def test_a_link_with_brackets_in_its_address_is_said_as_its_text():
    link = "见[维基](https://en.wikipedia.org/wiki/Foo_(bar))。"
    assert lang.clean_for_speech_zh(link) == "见维基。"  # was "见[维基](屏幕上的链接。"


def test_a_long_reply_splits_in_linear_time():
    import time

    # Read by position, stop to stop: sliced again after every sentence, 2 MB took 8 s.
    reply = ("今天天气很好，我们去公园散步。明天要开会，记得带报告。" * 80_000)[:2_000_000]
    started = time.perf_counter()
    sentences, rest = lang.split_sentences_zh(reply, final=True)
    assert time.perf_counter() - started < 2.0  # about 0.3 s here
    assert "".join(sentences) == reply and rest == ""
    assert sentences[:2] == ["今天天气很好，我们去公园散步。", "明天要开会，记得带报告。"]


# ── numbers the Mandarin way ──


@pytest.mark.parametrize(
    ("number", "said"),
    [
        (0, "零"), (2, "二"), (10, "十"), (12, "十二"), (15, "十五"), (20, "二十"), (22, "二十二"),
        (100, "一百"), (110, "一百一十"), (200, "两百"), (1000, "一千"), (1002, "一千零二"),
        (1005, "一千零五"), (1050, "一千零五十"), (1200, "一千二百"), (2000, "两千"), (2200, "两千二百"),
        (7684, "七千六百八十四"), (10000, "一万"), (10010, "一万零一十"), (10500, "一万零五百"),
        (12000, "一万两千"), (15000, "一万五千"), (20000, "两万"), (22000, "两万两千"),
        (65432, "六万五千四百三十二"), (100000, "十万"), (100500, "十万零五百"), (105000, "十万零五千"),
        (150000, "十五万"), (220000, "二十二万"), (1000000, "一百万"), (1005000, "一百万零五千"),
        (1050000, "一百零五万"), (2000000, "两百万"), (100000000, "一亿"), (100000005, "一亿零五"),
        (123456789, "一亿两千三百四十五万六千七百八十九"), (200000000, "两亿"),
    ],
)  # fmt: skip
def test_whole_numbers(number, said):
    assert lang.number_zh(number) == said


def test_numbers_of_every_kind():
    assert lang.number_zh(2, measure=True) == "两"
    assert lang.number_zh(12, measure=True) == "十二"
    assert lang.number_zh("0.77") == lang.number_zh(0.77) == "零点七七"
    assert lang.number_zh("7,684") == "七千六百八十四"
    assert lang.number_zh(-3.5) == "负三点五"
    assert lang.number_zh("−1.2") == "负一点二"
    assert lang.number_zh("0.80") == "零点八"
    assert lang.number_zh(7684.0) == "七千六百八十四"
    assert lang.number_zh(2.5, measure=True) == "二点五"
    assert lang.number_zh(10**20) == "一" + "零" * 20  # past 万亿: digit by digit
    assert lang.number_zh("abc") == "abc" and lang.number_zh(True) == "True"
    assert lang.number_zh(float("nan")) == "nan"
    assert lang.digits_zh("2026") == "二零二六"
    assert lang.percent_zh(0.77) == "百分之零点七七"
    assert lang.percent_zh("-1.2") == "负百分之一点二"
    assert lang.money_zh(1234.5) == "一千二百三十四点五美元"
    assert lang.money_zh(2) == "两美元"
    assert lang.money_zh(99.99, "CNY") == "九十九点九九元"
    assert lang.money_zh(3, "eur") == "三欧元"
    assert lang.clock_zh(3, 30, "PM") == "下午三点半"
    assert lang.clock_zh(2, 0) == "两点"
    assert lang.clock_zh(14, 5) == "十四点零五分"
    assert lang.clock_zh(9, 0, "AM") == "上午九点"
    assert lang.clock_zh(7, 15, "am") == "早上七点十五分"
    assert lang.clock_zh(12, 0, "PM") == "中午十二点"
    assert lang.clock_zh(8, 0, "PM") == "晚上八点"
    assert lang.clock_zh(3, 30, "PM", spoken=False) == "下午3:30"


@pytest.mark.parametrize(
    ("text", "said"),
    [
        ("下跌0.77%", "下跌百分之零点七七"),
        ("标普500 7,684点", "标普五百 七千六百八十四点"),
        ("$1.2万亿", "一点二万亿美元"),
        ("$65,432", "六万五千四百三十二美元"),
        ("$2万", "两万美元"),
        ("2026年9月29日", "二零二六年九月二十九日"),
        ("2026-09-29", "二零二六年九月二十九日"),
        ("下午3:30开会", "下午三点半开会"),
        ("3:30 PM", "下午三点半"),
        ("9 AM", "上午九点"),
        ("12:05", "十二点零五分"),
        ("2个人", "两个人"),
        ("2点钟", "两点钟"),
        ("第2个", "第二个"),
        ("2万", "两万"),
        ("20万", "二十万"),
        ("1.5亿", "一点五亿"),
        ("气温22°C", "气温二十二度"),
        ("-5°C", "零下五度"),
        ("72°F", "华氏七十二度"),
        ("罗素2000", "罗素两千"),
        ("价格是23.5美元", "价格是二十三点五美元"),
        ("增长+5%", "增长百分之五"),
        ("电话13800138000", "电话一三八零零一三八零零零"),
        ("代号007", "代号零零七"),
        ("US10Y 收益率", "US10Y 收益率"),  # digits inside a ticker stay
        ("GPT-4", "GPT-4"),
        ("版本1.2.3", "版本1.2.3"),
        ("没有数字", "没有数字"),
        # Ranges: the dash or tilde is 到, never a minus sign.
        ("预计涨幅3-5%", "预计涨幅百分之三到百分之五"),
        ("涨幅在3%-5%之间", "涨幅在百分之三到百分之五之间"),
        ("3%~5%", "百分之三到百分之五"),
        ("气温18-22°C", "气温十八到二十二度"),
        ("18°C~22°C", "十八度到二十二度"),
        ("-5~3°C", "零下五到三度"),
        ("大约需要3～5天", "大约需要三到五天"),
        ("3 - 5天", "三到五天"),
        ("2-3天", "两到三天"),
        ("1-2个", "一到两个"),
        ("第3-5章", "第三到五章"),
        ("3-5万", "三到五万"),
        ("$10-20", "十美元到二十美元"),
        ("会议10:00-11:00", "会议十点到十一点"),
        ("3:30 PM–4:30 PM", "下午三点半到下午四点半"),
        ("2020-2025年", "二零二零到二零二五年"),
        ("7,684-7,700点", "七千六百八十四到七千七百点"),
        ("2026-09", "二零二六年九月"),
        # A minus sign where nothing comes before it.
        ("标普500 -0.77%", "标普五百 负百分之零点七七"),
        ("涨跌-3%", "涨跌负百分之三"),
        ("气温-5度", "气温零下五度"),
        ("温度 -5", "温度 负五"),
        ("~5%", "约百分之五"),
        ("约~5%", "约百分之五"),
        # A phone number's groups aren't a range: digit by digit.
        ("电话555-0100", "电话五五五-零一零零"),
        ("138-0013-8000", "一三八-零零一三-八零零零"),
        ("555-1234", "五五五-一二三四"),
        ("COVID-19", "COVID-19"),
        ("INV-2026-004", "INV-2026-004"),
    ],
)
def test_spoken_numbers(text, said):
    assert lang.spoken_numbers_zh(text) == said


@pytest.mark.parametrize(
    ("text", "said"),
    [
        # The tilde of a range survives the markdown clean-up.
        ("预计涨幅3~5%", "预计涨幅百分之三到百分之五"),
        ("明天气温18~22°C", "明天气温十八到二十二度"),
        ("大约需要3~5天", "大约需要三到五天"),
        ("会议10:00~11:00", "会议十点到十一点"),
        ("大概~5%的增长", "大概约百分之五的增长"),
        ("好的~", "好的"),
        ("~~删掉~~", "删掉"),
    ],
)
def test_ranges_survive_clean_for_speech(text, said):
    assert lang.clean_for_speech_zh(text) == said


def test_a_number_past_the_int_limit_is_read_digit_by_digit():
    # int() refuses more than 4,300 digits: the ValueError cost the hub a second model turn.
    digits = "7" * 4400
    for text in (
        f"第{digits}号。",
        f"{digits}%",
        f"{digits}个",
        f"${digits}",
        f"{digits}万",
        f"{digits}°C",
        f"-{digits}度",
        "7" + ",777" * 1500 + "。",
    ):
        assert "七七七七" in lang.clean_for_speech_zh(f"结果是{text}"), text[-8:]
    assert lang.number_zh("1" * 5000) == "一" * 5000
    assert lang.number_zh("12345678901234567890") == "一二三四五六七八九零一二三四五六七八九零"
    assert lang.number_zh("0005") == "五" and lang.number_zh("10500") == "一万零五百"
    assert lang.spoken_numbers_zh("第2名，第0005号") == "第二名，第五号"


def test_digit_runs_in_any_script_are_read_in_linear_time():
    import time

    # \d takes every script's digits (\uff17 full-width, \u0663 Arabic-Indic): a range or a
    # dashed code was tried again from each digit of such a run, and a percentage from
    # each group of "123,123,…" (3 to 33 s each before).
    for run in ("\uff17" * 16_000, "\u0663" * 16_000, "1," * 8000, "12," * 5000, "123," * 4000):
        started = time.perf_counter()
        lang.spoken_numbers_zh(f"编号{run}。")
        assert time.perf_counter() - started < 0.3, run[:6]  # 0.05 s at most here
    # Ranges and comma lists read as before.
    assert lang.spoken_numbers_zh("1,234-5,678") == "一千二百三十四到五千六百七十八"
    assert lang.spoken_numbers_zh("1,2,3,4,5,6,7,8-9") == "一,二,三,四,五,六,七,八到九"
    assert lang.spoken_numbers_zh("气温1,-5度") == "气温一,零下五度"
    assert lang.spoken_numbers_zh("\uff11\uff12\uff13-\uff14\uff15\uff16") == (
        "一百二十三到四百五十六"
    )


# ── the markets and the weather ──

QUOTES = {
    "FormattedQuoteResult": {
        "FormattedQuote": [
            {"symbol": ".SPX", "code": 0, "last": "7,683.69", "change_pct": "-0.77%"},
            {"symbol": "US10Y", "code": 0, "last": "5.234%", "change_pct": "-0.15%"},
            {"symbol": "NVDA", "code": 0, "last": "228.86", "change_pct": "+1.68%"},
            {"symbol": "META", "code": 0, "last": "715.62", "change_pct": "-4.79%"},
            {"symbol": "BTC.CM=", "code": 0, "last": "65,432.10", "change_pct": "+1.23%"},
        ]
    }
}


def _market():
    q = markets.parse_quotes(QUOTES)
    spx = {**q[".SPX"], "name": "S&P 500"}
    ndx = {"symbol": ".IXIC", "name": "Nasdaq", "pct": 0.8, "last": 1.0}
    return q, spx, ndx


def test_market_headline_in_chinese():
    q, spx, ndx = _market()
    assert lang.headline_zh([spx, ndx], [q["NVDA"], q["META"]], "open") == (
        "美股目前下跌：标普500 −0.77%，纳斯达克 +0.80%。自选股领涨：NVDA +1.68%。领跌：META −4.79%。"
    )
    assert lang.headline_zh([spx], [], "closed") == "美股收盘下跌：标普500 −0.77%。"
    flat = {**spx, "pct": 0.05}
    assert lang.headline_zh([flat], [], "pre") == "美股收盘基本持平：标普500 +0.05%。"
    assert lang.headline_zh([], [], "open") == "现在没有市场数据。"
    # The English headline is what it always was.
    assert markets.headline([spx], [q["NVDA"], q["META"]], "open") == (
        "Stocks are down: S&P 500 −0.77%. Leading your list: NVDA +1.68%. Lagging: META −4.79%."
    )


def test_market_summary_as_spoken_in_chinese():
    q, spx, ndx = _market()
    summary = {
        "indices": [spx, ndx],
        "watchlist": [q["NVDA"], q["META"]],
        "status": "open",
        "macro": [{**q["US10Y"], "name": "10-yr"}, {**q["BTC.CM="], "name": "Bitcoin"}],
    }
    said = lang.markets_spoken_zh(summary)
    assert said == (
        "美股目前下跌：标普五百下跌百分之零点七七，纳斯达克上涨百分之零点八。"
        "自选股领涨：NVDA上涨百分之一点六八。领跌：META下跌百分之四点七九。"
        "十年期美债收益率为百分之五点二三。比特币报六万五千四百三十二美元，上涨百分之一点二。"
    )
    assert not re.search(r"\d", said.replace("NVDA", "").replace("META", ""))
    assert (
        lang.markets_spoken_zh(None)
        == lang.markets_spoken_zh({"indices": []})
        == "我暂时拿不到市场数据。"
    )
    assert lang.markets_spoken_zh({"indices": [spx]}).startswith("美股收盘下跌")


WEATHER = {
    "city": "Berkeley",
    "temp": 18,
    "feels": 16,
    "unit": "°C",
    "code": 2,
    "summary": "partly cloudy",
    "high": 22,
    "low": 12,
    "rain_chance": 10,
    "tomorrow": {"high": 20, "low": 13, "rain_chance": 70, "summary": "light rain"},
    "next_hours": [
        {"time": "15:00", "temp": 18, "rain": 0, "summary": "partly cloudy"},
        {"time": "16:00", "temp": 17, "rain": 40, "summary": "light rain"},
    ],
}


def test_weather_words():
    from jarvis.weather import CODES

    assert set(lang.CODES_ZH) == set(CODES)
    assert all(lang.has_cjk(v) for v in lang.CODES_ZH.values())
    assert lang.weather_summary_zh(WEATHER) == "局部多云"
    assert lang.weather_summary_zh({"summary": "light rain"}) == "小雨"  # from the English word
    assert lang.weather_summary_zh({"summary": "volcanic ash"}) == "volcanic ash"
    assert lang.weather_summary_zh(None) == ""


def test_weather_line_and_speech():
    assert lang.weather_line_zh(WEATHER) == (
        "Berkeley 现在的天气：18°C，局部多云；体感16°C；最高22，最低12；今天降雨概率10%；"
        "接下来几小时：15:00 18°、16:00 17°（降雨40%）；明天小雨，最高20，最低13，降雨概率70%"
    )
    assert lang.weather_spoken_zh(WEATHER) == (
        "Berkeley 现在十八度，局部多云，体感十六度。今天最高二十二度，最低十二度，降雨概率百分之十。"
    )
    assert lang.weather_spoken_zh(WEATHER, tomorrow=True).endswith(
        "明天小雨，最高二十度，最低十三度，降雨概率百分之七十。"
    )
    cold = {"city": "Here", "temp": -3, "feels": -3, "unit": "°F", "code": 71, "high": 2, "low": -8}
    assert (
        lang.weather_spoken_zh(cold)
        == "这里现在华氏零下三度，小雪。今天最高华氏二度，最低华氏零下八度。"
    )
    assert lang.weather_spoken_zh({"error": "I couldn't find that place."}) == "我找不到这个地方。"
    assert lang.weather_spoken_zh(None) == lang.weather_line_zh(None) == ""
    assert lang.weather_line_zh({"error": "x"}) == ""


# ── what JARVIS says itself ──

_SLOT = re.compile(r"\{(\w+)\}")


def test_every_translation_keeps_its_slots():
    for english, chinese in lang.ZH_TEXTS.items():
        assert Counter(_SLOT.findall(english)) == Counter(_SLOT.findall(chinese)), english
        assert lang.has_cjk(chinese) or chinese == english or not lang.has_cjk(english), english


def test_translations_never_say_the_wake_word():
    for chinese in [*lang.ZH_TEXTS.values(), *lang.VALUES_ZH.values(), *lang.FILLERS_ZH]:
        if "›" in chinese:
            continue  # a folder path on a card ("文稿 › Jarvis › …"), never said aloud
        sample = _SLOT.sub("X", chinese)
        assert not lang.find_wake_zh(sample)[0], chinese
    for reply in [c.reply for c in map(lang.parse_ui_zh, [p for p, _ in UI_PAIRS]) if c]:
        assert not lang.find_wake_zh(reply)[0], reply


def test_every_tool_label_and_window_name_is_covered():
    for label in _hub_constant("TOOL_LABELS").values():
        assert lang.translate(label) != label, label
    for name in [*ui.PANEL_NAMES.values(), *ui.LOOK_NAMES.values()]:
        assert name in lang.VALUES_ZH, name


@pytest.mark.parametrize(
    ("english", "chinese"),
    [
        ("Opening the browser.", "正在打开浏览器。"),
        ("Closed the activity log.", "已关闭活动记录。"),
        ("Switched to Obsidian.", "已切换到黑曜石。"),
        ("Hand control on.", "手势控制已开启。"),
        ("Back.", "返回。"),
        ("Closed the Research Center.", "已关闭研究中心。"),
        ("Allow", "允许"),
        ("Not now", "暂不"),
        ("I need your OK on screen.", "请在屏幕上确认一下。"),
        ("Send this to Ben?", "要把这条发给Ben吗？"),
        ("Open example.com in your browser?", "要在你的浏览器中打开 example.com 吗？"),
        ("Run the shortcut “Movie mode”?", "要运行快捷指令“Movie mode”吗？"),
        ("Standup starts in 5 minutes.", "Standup还有5分钟开始。"),
        ("Standup starts in 1 minute.", "Standup还有1分钟开始。"),
        (
            "Time to leave for Dentist. It's 25 minutes to Main St with current traffic, "
            "and it starts at 3:30 PM.",
            "该出发去Dentist了。按现在的路况到Main St要25分钟，下午3:30开始。",
        ),
        (
            "Rain's likely around 14:00, 70 percent chance. Might want an umbrella.",
            "14:00左右可能下雨，降雨概率百分之70。最好带把伞。",
        ),
        (
            "Jarvis Code in jarvis wants to run a command",
            "jarvis 中的 Jarvis Code 想要运行一条命令",
        ),
        (
            "Jarvis Code in jarvis needs your OK to edit a file.",
            "jarvis 中的 Jarvis Code 需要你同意才能编辑一个文件。",
        ),
        (
            "Jarvis Code finished in bsh-research-center. Added the tests.",
            "Jarvis Code 在 bsh-research-center 中完成了。Added the tests.",
        ),
        ("Jarvis Code finished in jarvis.", "Jarvis Code 在 jarvis 中完成了。"),
        ("INV-2026-004 is marked paid.", "INV-2026-004 已标记为已付款。"),
        ("3 files changed: a.py, b.py, c.py.", "3个文件有改动：a.py, b.py, c.py。"),
        (
            "Notes for Meeting saved to the second brain: 2 decisions and 3 action items, 45 minutes.",
            "会议的记录已存入第二大脑：2项决定、3项待办，时长45分钟。",
        ),
        ("Press “Generate memo” in the Research Center?", "要在研究中心里按“Generate memo”吗？"),
        ("Something went wrong: timeout", "出了点问题：timeout"),
        ("Quit Safari?", "要退出 Safari 吗？"),
        (
            "Add “Lunch” to your calendar at 2026-09-30 12:00 for 60 minutes at Café Rouge?",
            "要把“Lunch”加到日历吗？时间 2026-09-30 12:00，时长60分钟，地点：Café Rouge。",
        ),
        (
            "Start Jarvis Code in jarvis to: add a test for the parser?",
            "要在 jarvis 中启动 Jarvis Code 来做这件事吗：add a test for the parser？",
        ),
        (
            "Send Jarvis Code session 2 this: “use pnpm”?",
            "要把这句话发给 Jarvis Code 会话 2 吗：“use pnpm”？",
        ),
    ],
)
def test_translate(english, chinese):
    assert lang.translate(english) == chinese
    assert lang.translate(english, "en") == english  # English passes straight through


def test_translate_cards_paragraph_by_paragraph():
    detail = (
        "https://example.com/x?q=1\n\nEarlier in this request: Read your inbox; Searched the web. "
        "An address or request like this can carry some of that out, so check it before you "
        "allow it."
    )
    assert lang.translate(detail) == (
        "https://example.com/x?q=1\n\n这个请求之前：读取了收件箱；搜索了网络。"
        "这样的网址或请求可能把其中一些内容带出去，允许之前请先核对。"
    )
    nested = (
        "Research topic:\n“quantum batteries”\n\nEarlier in this request: a picture of your "
        "screen. Pages can hide instructions, and you didn't name this site yourself, so check "
        "it before you allow it."
    )
    assert lang.translate(nested) == (
        "研究主题：\n“quantum batteries”\n\n这个请求之前：你屏幕的截图。"
        "网页里可能藏着指令，而且这个网站不是你自己说的，允许之前请先核对。"
    )


def test_the_users_own_words_are_never_translated():
    # A message that happens to read like one of JARVIS's own lines still goes out as
    # written: the card and the read-back show exactly what will be sent.
    assert lang.translate("Here's your message to Ben. Done. Do you want this message sent?") == (
        "这是你发给Ben的消息：Done. 要发送这条消息吗？"
    )
    assert lang.translate("To Ben (+1 555 0100):\n“Allow”") == "发给 Ben (+1 555 0100)：\n“Allow”"
    email = "To Ann <ann@example.com>\nSubject: Not now\n\nThe browser didn't answer in time."
    assert lang.translate(email) == (
        "收件人：Ann <ann@example.com>\n主题：Not now\n\nThe browser didn't answer in time."
    )
    assert lang.translate("Email Ann about Back.?") == "要给Ann发一封关于“Back.”的邮件吗？"


def test_translate_leaves_the_unknown_alone():
    for text in ("Something completely unknown.", "open", "the browser", "use something weird", ""):
        assert lang.translate(text) == text
    assert lang.translate("  Done.  ") == "  好了。  "
    assert lang.translate(None) is None


def test_tr_formats_templates():
    assert lang.tr("Opening {name}.", "zh", name="the browser") == "正在打开浏览器。"
    assert lang.tr("Opening {name}.", "en", name="the browser") == "Opening the browser."
    # A person is never renamed, even one called like a panel.
    assert lang.tr("Send this to {person}?", "zh", person="Settings") == "要把这条发给Settings吗？"
    assert lang.tr("Here's your message to {person}. {text} Do you want this message sent?", "zh",
                   person="Ben", text="Done.") == "这是你发给Ben的消息：Done. 要发送这条消息吗？"  # fmt: skip
    # The template as messaging.py spells it works too, its {name} kept as it is.
    assert lang.tr("Send this to {name}?", "zh", name="Settings") == "要把这条发给Settings吗？"
    assert lang.tr("Send this to {name}?", "en", name="Settings") == "Send this to Settings?"
    assert (
        lang.tr("Run the shortcut “{name}”?", "zh", name="Meeting") == "要运行快捷指令“Meeting”吗？"
    )
    assert lang.tr("Routine · {name}", "zh", name="Here") == "例行任务 · Here"
    assert lang.tr("Invoice {number} from {name}", "zh", number="INV-7", name="Settings") == (
        "来自Settings的发票 INV-7"
    )
    assert lang.tr("Done.", "zh") == "好了。" and lang.tr("Done.", "en") == "Done."
    assert lang.tr("Not a known template {x}", "zh", x=1) == "Not a known template 1"


@pytest.mark.parametrize(
    ("english", "chinese"),
    [
        # People, shortcuts, routines and calendar titles are never translated, whatever
        # English word they happen to be.
        ("Send this to Meeting?", "要把这条发给Meeting吗？"),
        ("Sent to Here.", "已发送给Here。"),
        ("Emailed Settings.", "已给Settings发了邮件。"),
        ("Email Invoice about Q3?", "要给Invoice发一封关于“Q3”的邮件吗？"),
        ("There's no one called Paid in Contacts. Ask for their number or address.",
         "通讯录里没有叫Paid的人。请问一下对方的号码或地址。"),
        ("Run the shortcut “Settings”?", "要运行快捷指令“Settings”吗？"),
        ("The shortcut Here didn't work: timeout", "快捷指令Here没有成功：timeout"),
        ("Settings starts in 5 minutes.", "Settings还有5分钟开始。"),
        ("Back in Done.. What next?", "回到了Done.。接下来做什么？"),
        # JARVIS's own stand-ins in a slot are translated.
        ("Already taking notes for Meeting.", "已经在为会议做记录了。"),
        ("Start Jarvis Code in this assistant's own project?",
         "要在 这个助手自己的项目 中启动 Jarvis Code 吗？"),
        ("Open an unusual web address in your browser?", "要在你的浏览器中打开 一个不常见的网址 吗？"),
        ("INV-7 is marked open.", "INV-7 已标记为未付款。"),
        # A one-line slot stays on its line: the next line is its own sentence.
        ("Folder: /Users/me/jarvis\nFirst request: (none yet)",
         "文件夹：/Users/me/jarvis\n第一个请求：（暂无）"),
        ("Folder: /x\nFirst request: add a test", "文件夹：/x\n第一个请求：add a test"),
    ],
)  # fmt: skip
def test_names_stay_as_they_are(english, chinese):
    assert lang.translate(english) == chinese


def test_slot_words_are_translated():
    for words in lang._SLOT_WORDS.values():
        assert all(w in lang.VALUES_ZH for w in words), words
    assert set(lang._SLOT_WORDS["name"]) == {*ui.PANEL_NAMES.values(), *ui.LOOK_NAMES.values()}


# ── the system prompt ──


def test_personas_in_chinese():
    from jarvis.prefs import PERSONAS

    assert set(lang.ZH_PERSONAS) == set(PERSONAS)
    assert all(
        lang.has_cjk(name) and lang.has_cjk(desc) for name, desc in lang.ZH_PERSONAS.values()
    )
    name, persona = lang.persona_for_prompt("jarvis", "zh")
    assert name == "JARVIS" and persona == lang.ZH_PERSONAS["jarvis"][1]  # never 贾维斯 in a prompt
    assert lang.persona_for_prompt("tars", "en") == PERSONAS["tars"]
    assert lang.persona_for_prompt("nobody", "zh")[0] == "JARVIS"
    assert lang.personas_payload("zh")[0] == {"id": "jarvis", "name": "贾维斯"}
    assert lang.personas_payload("en") == [{"id": k, "name": v[0]} for k, v in PERSONAS.items()]


def test_reply_instruction():
    assert lang.reply_instruction("en") == "" and lang.reply_instruction("fr") == ""
    text = lang.reply_instruction("zh")
    assert text.startswith("\n\nLanguage:")
    for needle in ("Simplified Chinese", "简体", "贾维斯", "0.77%", "两", "NVDA", "No markdown"):
        assert needle in text, needle


# ── did the user ask for it in their own words? ──


@pytest.mark.parametrize(
    ("feature", "said", "asked"),
    [
        ("remember", "记住我喜欢咖啡", True),
        ("remember", "好的，记住我的生日是5月1日", True),
        ("remember", "帮我记住明天交报告", True),
        ("remember", "你记住了吗", False),
        ("remember", "记住了", False),
        ("remember", "别记住这个", False),
        ("remember", "我刚开完会，帮我记住明天交报告", False),  # a clause must open with it
        ("forget", "忘掉这件事", True),
        ("forget", "忘记我的生日", True),
        ("forget", "删除所有记忆", True),
        ("forget", "我忘记了", False),
        ("forget", "忘了关灯", False),
        ("start_meeting", "做会议记录", True),
        ("start_meeting", "开始录音", True),
        ("start_meeting", "帮我做个笔记", True),
        ("start_meeting", "录下这次会议", True),
        ("start_meeting", "会议几点开始", False),
        ("delete_routine", "删除早上的简报", True),
        ("delete_routine", "把提醒删掉", True),
        ("delete_routine", "简报说了什么", False),
        ("pause_routine", "暂停晨间简报", True),
        ("pause_routine", "把晨间简报暂停", True),
        ("pause_routine", "今天的简报很好", False),
        ("remember", "今天天气不错。然后记住我明天出差", True),
        ("remember", "帮我记明天交报告", True),  # 帮我 is a lead-in, and 帮我记 the verb
        ("remember", "麻烦你帮我记住车停在B2", True),
        ("remember", "记住这个好吗", True),  # a polite tag still asks
        ("remember", "记住我明天出差了吗", False),
        # Forgetting: a report ("I forgot…") or a question isn't a request.
        ("forget", "把那条忘掉", True),
        ("forget", "别再记着我的地址", True),
        ("forget", "忘记我的密码了怎么办", False),
        ("forget", "忘记关于那个会的事了", False),
        ("forget", "忘记我的邮箱密码了", False),
        ("forget", "忘掉过去", False),
        ("forget", "删掉记忆了吗", False),
        # Meeting notes: never "open my notes" or a question about the notes.
        ("start_meeting", "会议模式", True),
        ("start_meeting", "进入会议模式", True),
        ("start_meeting", "打开笔记", False),
        ("start_meeting", "打开记录", False),
        ("start_meeting", "打开录音", False),
        ("start_meeting", "会议记录在哪里", False),
        ("start_meeting", "会议纪要写好了吗", False),
        ("start_meeting", "做会议记录了吗", False),
        ("start_meeting", "会议记录", False),
        ("delete_routine", "删除提醒了吗", False),
        ("pause_routine", "暂停简报了没有", False),
    ],
)
def test_feature_asked(feature, said, asked):
    assert lang.user_asked_zh(lang.FEATURE_ASKED_ZH[feature], said) is asked


def test_feature_names_match_the_hub():
    assert set(lang.FEATURE_ASKED_ZH) == set(_hub_dict_keys("FEATURE_ASKED"))


@pytest.mark.parametrize(
    ("pattern", "said", "asked"),
    [
        ("code", "我们来写代码", True),
        ("code", "进入编程模式", True),
        ("code", "打开 Jarvis Code", True),
        ("code", "和我一起改这个项目", True),
        ("code", "贾维斯，我们来编程吧", True),
        ("code", "代码写得怎么样", False),
        ("code", "开始编程", True),
        ("code", "编程模式", True),
        ("code", "我要改代码", True),
        # Coding as a noun, or learning it, isn't a request to voice-code.
        ("code", "编程语言哪个最好学", False),
        ("code", "编程课几点开始", False),
        ("code", "我想学编程", False),
        ("code", "我们编程比赛输了", False),
        ("message", "告诉 Jarvis Code 用 pnpm", True),
        ("message", "跟会话2说先跑测试", True),
        ("message", "让编程会话停下", True),
        ("message", "告诉我天气", False),
        ("message", "给 Claude Code 发条消息", True),
        ("message", "问问 Claude Code 进度怎么样", True),
        # 对, 跟 and 给 are "about" and "compared with" unless a verb of saying follows.
        ("message", "对 Claude Code 你怎么看", False),
        ("message", "跟 Claude Code 比哪个好", False),
        ("message", "给 Claude Code 的评价", False),
        ("message", "请问 Claude Code 是什么", False),
        ("message", "叫 Claude Code 的那个工具", False),
    ],
)
def test_code_and_message_asked(pattern, said, asked):
    compiled = lang.CODE_ASKED_ZH if pattern == "code" else lang.MESSAGE_ASKED_ZH
    assert lang.user_asked_zh(compiled, said) is asked


def test_ask_patterns_stay_fast_on_repetition():
    # The lead-ins used to be splittable two ways (麻烦你 = 麻烦 + 你): repeated, a clause
    # took 2^n tries to rule out, on the hub's event loop.
    import random
    import time

    patterns = [*lang.FEATURE_ASKED_ZH.values(), lang.CODE_ASKED_ZH, lang.MESSAGE_ASKED_ZH]
    leads = [
        "你能不能",
        "麻烦你",
        "好的",
        "那么",
        "可不可以",
        "帮我",
        "你",
        "贾维斯，",
        "jarvis ",
        "请",
    ]
    texts = [unit * 40 + "吃饭" for unit in leads]
    rng = random.Random(5)
    texts += ["".join(rng.choice(leads) for _ in range(60)) + "吃饭" for _ in range(20)]
    started = time.perf_counter()
    for text in texts:
        for pattern in patterns:
            assert not lang.user_asked_zh(pattern, text)
    assert time.perf_counter() - started < 0.5
    # Leads in front of a real request still work.
    assert lang.user_asked_zh(lang.FEATURE_ASKED_ZH["remember"], "你能不能" * 5 + "记住我喜欢茶")


# ── robustness ──

_NOISE = list(
    "贾维斯加嘉停不别好是对发送取消算了往下上滚翻页顶底返回放大缩小关闭打开点击设置浏览器代码手势"
    "，。！？、；：…“”（）0123456789.,:;!?%$°CF -—\n賈維開關滾ｊ０％"
) + ["Jarvis", "Travis", "hey", "OK", "no", "yes", "stop", "PM", "万", "亿", "个", "第"]


def _noise(rng, most: int) -> str:
    return "".join(rng.choice(_NOISE) for _ in range(rng.randint(0, most)))


def test_nothing_raises_on_noise():
    import random

    rng = random.Random(7)
    for _ in range(150):
        text = _noise(rng, 40)
        lang.find_wake_zh(text)
        lang.is_stop_zh(text)
        lang.yes_no_zh(text)
        lang.parse_research_zh(text)
        lang.parse_ui_zh(text)
        lang.speakable_safely_zh(text)
        lang.sounds_finished_zh(text)
        lang.first_clause_zh(text)
        lang.clean_for_speech_zh(text)
        lang.translate(text)
        lang.clean_transcript_zh(text)
        lang.match_shortcut_zh(text, ["电影模式", "Movie Mode"])
        lang.number_zh(text)
        lang.spoken_numbers_zh(text)
        lang.is_hallucination_zh(text)
        for pattern in (*lang.FEATURE_ASKED_ZH.values(), lang.CODE_ASKED_ZH, lang.MESSAGE_ASKED_ZH):
            lang.user_asked_zh(pattern, text)
        for approval in (SEND, CODE, PLAN, QUESTION, CODE_ZH, SEND_ZH, GATE_ZH, SHORTCUT_ZH,
                         QUESTION_ZH, PURCHASE):  # fmt: skip
            answer = lang.voice_answer_zh(text, approval)
            if approval is PURCHASE and answer is not None and answer[0] == "allow":
                assert "确认购买" in text.replace(" ", ""), text  # only the phrase buys


def test_properties_hold_on_noise():
    import random

    rng = random.Random(11)
    for _ in range(300):
        text = _noise(rng, 60)
        once = lang.to_simplified(text)
        assert lang.to_simplified(once) == once
        spoken = lang.speakable_safely_zh(text)
        assert spoken is None or not lang.find_wake_zh(spoken)[0], text
        # Splitting loses and reorders nothing, streamed in pieces or all at once, and
        # never glues two words into one (or cuts one in two).
        whole, rest = lang.split_sentences_zh(text, final=True)
        assert rest.strip() == "" and "".join("".join(whole).split()) == "".join(text.split())
        assert _latin_words(" ".join(whole)) == _latin_words(text), text
        buffer, streamed = "", []
        for k in range(0, len(text), 3):
            buffer += text[k : k + 3]
            done, buffer = lang.split_sentences_zh(buffer)
            streamed += done
        streamed += lang.split_sentences_zh(buffer, final=True)[0]
        assert "".join("".join(streamed).split()) == "".join(text.split()), text
        assert _latin_words(" ".join(streamed)) == _latin_words(text), text


def _latin_words(text: str) -> list[str]:
    """Latin words and numbers in order, as the voice would say them."""
    return re.findall(r"[A-Za-z0-9]+", text)


def test_long_and_hostile_input_stays_fast():
    import time

    crafted = "Here's your email to " + ", subject:  " * 98
    cases = [
        (lang.find_wake_zh, "你好 " + "word " * 3000),  # was quadratic in the Latin words
        (lang.translate, "Here's your email to " + "a, subject: b " * 40 + "x " * 250),
        (lang.translate, "INV-" + "1 for a: " * 130),
        (lang.translate, "x" * 50_000),  # past the template limit: paragraphs only
        # A long card detail of crafted paragraphs: only the first few characters are
        # matched against the sentences, the rest passes through.
        (lang.translate, "To Ann <a@x.com>\nSubject: hi\n\n" + "\n\n".join([crafted] * 100)),
        (lang.translate, "\n\n".join([crafted + " Do you want this email sent?"] * 100)),
        (lang.translate, "\n".join(["Here's your message to " + "a. " * 380] * 100)),
        (lang.spoken_numbers_zh, "价格是1,234.56美元，" * 2000),
        (lang.split_sentences_zh, "没有标点" * 5000),
        (lang.yes_no_zh, "好" * 5000),
        (lang.spoken_numbers_zh, "涨幅3-5%，气温18~22°C，电话555-0100，" * 1000),
        (lang.spoken_numbers_zh, "1" + " " * 20_000 + "-"),
        (lang.spoken_numbers_zh, "-".join(["12"] * 5000)),
        (lang.clean_for_speech_zh, "3~" * 10_000),
        (lambda t: lang.voice_answer_zh(t, CODE_ZH), "嗯 " + " ".join(["jarvis", "okr"] * 800)),
        (lambda t: lang.voice_answer_zh(t, SEND_ZH), "发送" * 5000),
        (lang.is_hallucination_zh, "字幕由" * 5000),
        # Long runs of spaces, lines or brackets are scanned once, not from every position.
        (lang.spoken_numbers_zh, "好" + " " * 20_000 + "x"),
        (lang.spoken_numbers_zh, "约" + " " * 20_000),
        (lang.clean_for_speech_zh, "好" + " " * 20_000 + "x"),
        (lang.clean_for_speech_zh, "好" + "\n" * 20_000 + "x"),
        (lang.clean_for_speech_zh, " \n" * 10_000),
        (lang.clean_for_speech_zh, " " * 20_000 + "[x"),
        (lang.clean_for_speech_zh, "[" * 20_000),
        (lang.clean_for_speech_zh, "[a](" * 5000),
        (lang.translate, "好" + "\n" * 20_000 + "x"),
    ]
    for fn, text in cases:
        started = time.perf_counter()
        fn(text)
        assert time.perf_counter() - started < 0.5, (fn.__name__, text[:30])


def test_speech_clean_up_reads_the_same():
    # The linear rewrites of the clean-up keep what it says.
    text = "结果 [1] 很好 [2,3]。\r\n第二行  \n\n  第三行 abc  def\n见[文档](https://x.y/z)"
    assert lang.clean_for_speech_zh(text) == "结果很好。第二行。第三行abc def。见文档"
    assert lang.clean_for_speech_zh("  # 标题\n  - 第一项\n  1. 第二项") == "标题。第一项。第二项"


# ── helpers ──


def _hub_assignment(name: str) -> ast.expr:
    """The value assigned to a module-level name in hub.py, read without importing it
    (other work is under way there)."""
    try:
        tree = ast.parse((SRC / "hub.py").read_text())
    except SyntaxError:  # pragma: no cover - hub.py mid-edit
        pytest.skip("hub.py doesn't parse right now")
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(
            isinstance(t, ast.Name) and t.id == name for t in node.targets
        ):
            return node.value
    pytest.skip(f"hub.py has no {name}")  # pragma: no cover


def _hub_dict_keys(name: str) -> list[str]:
    value = _hub_assignment(name)
    assert isinstance(value, ast.Dict)
    return [ast.literal_eval(k) for k in value.keys if k is not None]


def _hub_constant(name: str):
    """A literal constant from hub.py: FILLERS, TOOL_LABELS."""
    return ast.literal_eval(_hub_assignment(name))
