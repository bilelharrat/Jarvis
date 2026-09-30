"""Chinese (Simplified Mandarin) as JARVIS's second language.

The owner can pick 中文 in Settings and talk to JARVIS in Mandarin: it hears Chinese,
wakes on 贾维斯, understands 停, 好 and 不 and the instant commands ("往下滚动",
"打开浏览器"), answers in spoken Simplified Chinese, and reads numbers, the markets and
the weather the way a Mandarin speaker would. English stays exactly as it is.

Everything that depends on the language lives here, so the rest of JARVIS changes at one
seam per feature. Each English rule (wake.find_wake, research.parse, speech.split_sentences
and friends) has a Chinese twin below, and the language-aware entry points at the end
(find_wake(text, lang), parse_research(text, lang), …) call the English original for "en",
and in Chinese mode for anything said without a Chinese character in it, so English said
in Chinese mode still works. The Chinese instant-command parsers hand back the very same
research.Command and ui.Command objects as the English ones, so the hub acts on them
unchanged. Nothing is installed or downloaded: the Traditional characters Whisper writes
now and then are folded to Simplified with a compact table.
"""

from __future__ import annotations

import difflib
import math
import re
from typing import Any

from . import research, ui, wake

# ── the setting ──

LANGUAGES = {"en": "English", "zh": "中文"}
DEFAULT_LANGUAGE = "en"

_ALIASES = {
    "en": "en", "english": "en", "en-us": "en", "en-gb": "en", "en_us": "en", "en_gb": "en",
    "英文": "en", "英语": "en", "英語": "en",
    "zh": "zh", "zh-cn": "zh", "zh_cn": "zh", "zh-hans": "zh", "zh-hans-cn": "zh",
    "zh-sg": "zh", "zh-tw": "zh", "zh-hk": "zh", "zh-hant": "zh", "cmn": "zh",
    "chinese": "zh", "mandarin": "zh", "中文": "zh", "汉语": "zh", "漢語": "zh",
    "普通话": "zh", "普通話": "zh", "简体中文": "zh", "简体": "zh", "繁體中文": "zh",
}  # fmt: skip


def clean_language(value: Any) -> str | None:
    """A language setting as it's saved: "en" or "zh", or None for anything else (so
    Prefs keeps what it had, as it does for its other settings)."""
    if not isinstance(value, str):
        return None
    return _ALIASES.get(re.sub(r"\s+", "", value).lower())


def is_zh(lang: Any) -> bool:
    return clean_language(lang) == "zh"


# ── Chinese text basics ──

_CJK_CHARS = "\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff"
_CJK = re.compile(f"[{_CJK_CHARS}]")
_TOKEN = re.compile(f"[{_CJK_CHARS}]|[a-z0-9']+")


def has_cjk(text: str | None) -> bool:
    return bool(text) and _CJK.search(text) is not None


# Traditional -> Simplified, one pair per token, for the characters Whisper's Mandarin mode
# writes most (it drifts into Traditional now and then). Characters whose Traditional form
# is also an everyday Simplified one with another meaning (著 in 著名, 乾 in 乾隆, 瞭 in
# 瞭望, 鍊, 藉, 祇) are left alone here and fixed as phrases below.
_T2S_PAIRS = """
們们 個个 這这 來来 為为 爲为 會会 時时 國国 對对 沒没 麼么 學学 後后 裡里 裏里 還还 過过
點点 開开 樣样 當当 與与 經经 發发 髮发 現现 問问 關关 動动 種种 麵面 見见 長长 門门 間间
聽听 車车 電电 話话 語语 讓让 請请 謝谢 愛爱 覺觉 氣气 業业 東东 產产 從从 條条 萬万 無无
頭头 體体 實实 將将 帶带 幾几 應应 機机 兒儿 師师 歲岁 號号 務务 兩两 舊旧 醫医 藥药 樂乐
歡欢 難难 雙双 邊边 寶宝 華华 報报 場场 塊块 壞坏 聲声 處处 備备 夠够 夢梦 孫孙 寧宁 導导
屆届 層层 幣币 廣广 廳厅 庫库 張张 強强 彈弹 態态 總总 慶庆 憂忧 憶忆 懷怀 戰战 戲戏 擁拥
擇择 擊击 據据 擔担 擋挡 擺摆 攝摄 數数 斷断 於于 晝昼 曉晓 暫暂 書书 極极 構构 標标 樓楼
樹树 橋桥 檢检 權权 歐欧 歷历 曆历 殺杀 決决 況况 淚泪 淺浅 測测 溫温 準准 滅灭 滿满 漢汉
潔洁 濕湿 灣湾 災灾 烏乌 煙烟 熱热 燈灯 爐炉 爭争 爺爷 牆墙 狀状 獨独 獲获 獻献 環环 畫画
異异 療疗 盡尽 監监 盤盘 眾众 衆众 睏困 礦矿 確确 禮礼 禍祸 離离 穩稳 窮穷 競竞 筆笔 節节
範范 簡简 簽签 糧粮 級级 紅红 網网 羅罗 義义 習习 聖圣 聯联 聰聪 腦脑 膽胆 臉脸 臨临 興兴
舉举 艦舰 艱艰 藝艺 蘭兰 蘋苹 蟲虫 術术 衛卫 衝冲 補补 裝装 製制 複复 復复 豐丰 豬猪 貓猫
趕赶 趨趋 跡迹 踐践 蹤踪 躍跃 農农 進进 遊游 運运 達达 遠远 適适 遲迟 選选 遺遗 鄉乡 鄰邻
釋释 鐘钟 鍾钟 陽阳 陰阴 陸陆 隊队 階阶 際际 隨随 險险 隱隐 雖虽 雜杂 雞鸡 雲云 靈灵 靜静
響响 頁页 風风 飛飞 馬马 驗验 鬥斗 鬧闹 魚鱼 鳥鸟 麥麦 黃黄 黨党 齊齐 齒齿 龍龙 龜龟
說说 認认 識识 讀读 寫写 課课 試试 詞词 該该 誰谁 誤误 論论 設设 訊讯 記记 許许 訴诉 評评
詳详 談谈 調调 講讲 議议 證证 護护 譯译 變变 計计 訂订 討讨 訓训 託托 訪访 診诊 註注 詢询
詩诗 誠诚 誌志 誇夸 諾诺 謂谓 諸诸 諒谅 謀谋 謊谎 謹谨 譜谱 讚赞 誕诞 謎谜 譽誉 誦诵 諮咨
諷讽 譏讥 訝讶 訣诀 詐诈 詛诅 詠咏 誘诱
錢钱 錯错 銀银 鐵铁 鋼钢 鍵键 鎖锁 鏡镜 錄录 針针 釣钓 鈴铃 鋁铝 銷销 鋒锋 鍋锅 錶表 鑰钥
鑽钻 鎮镇 鏈链 銅铜 鉛铅 釘钉 鈕钮 錦锦 銳锐 錘锤 鑑鉴 鑒鉴 鈔钞 銜衔 鋸锯 錨锚 鍍镀 鎊镑
鏟铲 鐮镰 鑼锣 鑿凿 鋪铺 鍛锻 鑄铸 鉤钩 鉅巨
閉闭 聞闻 閱阅 闊阔 閃闪 閒闲 閑闲 閣阁 闖闯 闆板 閩闽 闡阐 閘闸 閨闺 閻阎 闢辟 閥阀
給给 結结 絕绝 統统 線线 綫线 練练 組组 細细 終终 紙纸 約约 紀纪 純纯 納纳 紛纷 織织 綠绿
維维 繼继 續续 績绩 緊紧 編编 緣缘 縮缩 繩绳 繞绕 繪绘 紹绍 紋纹 絡络 綜综 緒绪 縣县 纖纤
纜缆 係系 繫系 絲丝 綁绑 綱纲 緩缓 縱纵 纏缠 綿绵 紗纱 紐纽 紡纺 糾纠 紮扎 縫缝 絞绞 綻绽
緯纬 縛缚 繡绣 繭茧 繃绷
飯饭 飲饮 館馆 餓饿 餅饼 饅馒 餃饺 飽饱 飾饰 餘余 養养 餵喂 饒饶 飢饥 饑饥 餌饵 餡馅 饋馈
饞馋 嗎吗 媽妈 罵骂 騎骑 駕驾 驚惊 駛驶 騰腾 驅驱 騙骗 驢驴 駐驻 馳驰 驟骤 駁驳 駝驼 騷骚
驕骄 鮮鲜 鯨鲸 鯉鲤 鯊鲨 鴨鸭 鵝鹅 鳴鸣 鷹鹰 島岛 鴿鸽 鵬鹏 鶴鹤 鸚鹦 鮑鲍 魯鲁
輛辆 軟软 輕轻 較较 載载 輸输 轉转 輪轮 軍军 連连 軌轨 輔辅 轎轿 輯辑 輩辈 軀躯 輻辐 轄辖
轍辙 轟轰
貝贝 買买 賣卖 貴贵 費费 質质 購购 資资 賬账 財财 貨货 負负 貿贸 賽赛 贊赞 賞赏 賠赔 賺赚
賴赖 貸贷 賀贺 貼贴 賓宾 贈赠 賢贤 貪贪 貧贫 販贩 責责 敗败 則则 側侧 廁厕 貞贞 賊贼 賦赋
贏赢 贓赃 賤贱 貳贰
規规 視视 觀观 親亲 覽览 覓觅 觸触 題题 顏颜 願愿 類类 顧顾 須须 領领 頻频 預预 順顺 項项
頓顿 額额 顯显 顆颗 頂顶 碩硕 煩烦 頌颂 頰颊 頸颈 頹颓 顫颤 颱台 飄飘 颳刮
帳帐 漲涨 凍冻 陳陈 棟栋 麗丽 劇剧 劃划 劍剑 勁劲 勞劳 勢势 勵励 區区 協协 卻却 厲厉 參参
叢丛 員员 啟启 啓启 喪丧 單单 嚴严 圍围 園园 圖图 團团 糰团 堅坚 執执 壓压 壯壮 壺壶 壽寿
奪夺 奮奋 妝妆 婦妇 嬰婴 寬宽 審审 專专 尋寻 屬属 岡冈 嶺岭 巖岩 幫帮 幹干 廟庙 廠厂 弔吊
彎弯 徹彻 恆恒 惡恶 惱恼 慣惯 慘惨 慮虑 憑凭 憲宪 懶懒 戀恋 戶户 拋抛 挾挟 捨舍 掃扫 掛挂
採采 換换 揚扬 損损 搖摇 搶抢 攜携 撥拨 擴扩 擬拟 擠挤 攔拦 攤摊 敵敌 斃毙 斬斩 昇升 暈晕
曠旷 朧胧 枴拐 棄弃 榮荣 槍枪 橫横 檔档 櫃柜 欄栏 殘残 殼壳 毀毁 氫氢 洩泄 淒凄 渙涣 湯汤
溝沟 滬沪 漁渔 漸渐 潛潜 澤泽 濃浓 濟济 濱滨 瀏浏 瀾澜 灑洒 爛烂 牽牵 犧牺 猶犹 獎奖 獸兽
瑪玛 璽玺 畢毕 畝亩 疊叠 瘋疯 癢痒 皺皱 盜盗 盞盏 睜睁 瞞瞒 矯矫 硯砚 碼码 磚砖 礙碍 祕秘
禦御 稅税 稱称 竊窃 筍笋 築筑 籃篮 籠笼 罰罚 罷罢 羨羡 翹翘 聳耸 職职 肅肃 脅胁 腳脚 膚肤
膠胶 艙舱 莊庄 葉叶 蓋盖 蔣蒋 蔥葱 薦荐 薩萨 藍蓝 蘇苏 虛虚 蝦虾 蠟蜡 襯衬 豈岂 趙赵 踴踊
辦办 辭辞 邏逻 郵邮 鄭郑 醜丑 醬酱 釀酿 陣阵 雛雏 霧雾 骯肮 髒脏 臟脏 鬍胡 鹽盐 黴霉 臺台
檯台 隻只 儘尽 儲储 優优 償偿 價价 傳传 傷伤 傾倾 僅仅 億亿 儀仪 債债 偽伪 傑杰 傭佣 僕仆
僑侨 儉俭 兇凶 內内 冊册 凱凯 刪删 別别 剛刚 創创 劑剂 勝胜 勻匀 匯汇 彙汇 厭厌 臥卧 吳吴
呂吕 喚唤 嘆叹 歎叹 嘗尝 嚇吓 嚨咙 囑嘱 圓圆 塵尘 墊垫 墳坟 壇坛 夾夹 奧奥 娛娱 婁娄 寵宠
尷尴 屍尸 巒峦 帥帅 廢废 廚厨 彥彦 徑径 悅悦 惻恻 慚惭 憐怜 憤愤 懇恳 懲惩 懸悬 懼惧 撲扑
撐撑 擾扰 攪搅 敘叙 斂敛 暢畅 曬晒 朮术 棗枣 棧栈 楊杨 楓枫 槳桨 樁桩 橢椭 櫻樱 毆殴 滄沧
滯滞 潑泼 潤润 澀涩 濁浊 濾滤 瀉泻 瀋沈 瀟潇 灘滩 煉炼 燒烧 燙烫 燦灿 爍烁 狹狭 獵猎 獅狮
瘡疮 癒愈 癡痴 矚瞩 禱祷 禿秃 穀谷 窩窝 窯窑 竅窍 箏筝 籌筹 籤签 粵粤 糞粪 罈坛 腎肾 腫肿
膩腻 臍脐 臘腊 舖铺 艷艳 豔艳 茲兹 莖茎 萊莱 蓮莲 蔔卜 蘿萝 蕭萧 薑姜 藹蔼 蘆芦 蘊蕴 虜虏
虧亏 蛻蜕 蝕蚀 螞蚂 蠅蝇 蠶蚕 蠻蛮 衊蔑 褲裤 襖袄 豎竖 躉趸 辯辩 迴回 週周 遞递 遜逊 遙遥
邁迈 鄧邓 醃腌 陝陕 隕陨 隸隶 霽霁 韋韦 韌韧 韓韩 韻韵 鬆松 鬱郁 夥伙 傢家 僱雇 纔才 嚮向
徵征 佔占 並并 併并 捲卷 摺折 慾欲 淨净 甦苏 衹只 佈布 鹹咸 恥耻 鬢鬓 鹼碱 窪洼
賈贾 滾滚 揮挥 螢萤 瓊琼 簾帘 齡龄 脫脱 兌兑 煥焕 嶼屿 歸归 營营 爾尔 礎础 積积 貢贡 噴喷
襪袜
"""
_T2S_LIST = _T2S_PAIRS.split()
# Full-width Latin letters, digits and signs (ｊａｒｖｉｓ, ０．７７％) as plain ASCII.
_WIDE = [*range(0xFF10, 0xFF1A), *range(0xFF21, 0xFF3B), *range(0xFF41, 0xFF5B)]
_WIDTH = {chr(c): chr(c - 0xFEE0) for c in _WIDE} | {
    "％": "%", "＄": "$", "．": ".", "＋": "+", "－": "-", "＆": "&",
}  # fmt: skip
_T2S = str.maketrans({pair[0]: pair[1] for pair in _T2S_LIST} | _WIDTH)
# Words the table can't settle character by character (keys may be Traditional or mixed).
_T2S_PHRASES = {
    "甚麼": "什么", "看著": "看着", "聽著": "听着", "等著": "等着", "接著": "接着",
    "跟著": "跟着", "隨著": "随着", "沿著": "沿着", "意味著": "意味着", "睡著": "睡着",
    "拿著": "拿着", "說著": "说着", "想著": "想着", "活著": "活着", "穿著": "穿着",
    "帶著": "带着", "開著": "开着", "關著": "关着", "坐著": "坐着", "站著": "站着",
    "躺著": "躺着", "忙著": "忙着", "走著": "走着", "試著": "试着", "記著": "记着",
    "著急": "着急", "著火": "着火", "著涼": "着凉", "著陸": "着陆", "乾淨": "干净",
    "乾燥": "干燥", "餅乾": "饼干", "乾杯": "干杯", "乾脆": "干脆", "烘乾": "烘干",
    "曬乾": "晒干", "瞭解": "了解", "明瞭": "明了", "項鍊": "项链", "鍛鍊": "锻炼",
    "鍊條": "链条", "日圓": "日元",
}  # fmt: skip
_PHRASES_S = {key.translate(_T2S): value for key, value in _T2S_PHRASES.items()}
_PHRASE_RE = re.compile("|".join(map(re.escape, sorted(_PHRASES_S, key=len, reverse=True))))


def to_simplified(text: str | None) -> str:
    """Common Traditional characters folded to Simplified (Whisper mixes them in), and
    full-width letters and digits to plain ones."""
    if not text:
        return ""
    return _PHRASE_RE.sub(lambda m: _PHRASES_S[m.group()], text.translate(_T2S))


_PUNCT = "，。！？、；：,.!?;:“”‘’\"'…—–-~～()（）《》〈〉「」『』【】[]·•/\\|_*#@^`"
_PUNCT_ZH = "，。！？、；：“”‘’…（）《》〈〉「」『』【】"
_PUNCT_RE = re.compile("[\\s\u3000" + re.escape(_PUNCT) + "]+")
_EDGE = " \t\u3000,.!?;:-，。！？；：、…—~～"


def _squash(text: str | None) -> str:
    """Simplified, lowercase, no spaces or punctuation: how short commands are compared."""
    return _PUNCT_RE.sub("", to_simplified(text).lower().replace("’", "'"))


def words_zh(text: str | None) -> list[str]:
    """The units wake.words counts, for Chinese: each character, and Latin words and
    numbers whole ("打开 Jarvis" -> 打, 开, jarvis)."""
    return _TOKEN.findall(to_simplified(text).lower().replace("’", "'"))


def _prefix(text: str, options: tuple[str, ...]) -> str:
    """The longest option text starts with, or "" (options are sorted longest first)."""
    return next((o for o in options if text.startswith(o)), "")


def _named(name: str) -> str:
    """A name after a Chinese verb: a Latin one gets a space ("正在打开 Jarvis Code")."""
    return name if has_cjk(name[:1]) else f" {name}"


def _longest_first(*groups: tuple[str, ...]) -> tuple[str, ...]:
    return tuple(sorted({w for group in groups for w in group}, key=len, reverse=True))


def _consumes(text: str, vocab: tuple[str, ...]) -> bool:
    """Whether text is nothing but words from vocab (sorted longest first). Only ever
    asked of a short tail ("吧", "谢谢"): anything long is something else."""
    if len(text) > 40:
        return False
    while text:
        piece = _prefix(text, vocab)
        if not piece:
            return False
        text = text[len(piece) :]
    return True


def _strip_leads(text: str, leads: tuple[str, ...]) -> str:
    """Take filler words off the front, never all of it."""
    while True:
        lead = _prefix(text, leads)
        if not lead or len(lead) == len(text):
            return text
        text = text[len(lead) :]


# ── the wake word ──

# How Whisper's Mandarin mode writes "Jarvis". A first character that can end a common
# word doesn't count right after that word: "参加维斯塔的发布会" is about Vista.
_WAKE_FIRST = {
    "贾": "", "嘉": "", "加": "参增添更再附外追施强叠", "家": "大国专作全回人管商老农住东店行玩画科",
    "佳": "最绝欠上", "甲": "装指盔铠龟护", "杰": "豪英人俊", "捷": "快敏便大报告直",
}  # fmt: skip
_WAKE_ZH = re.compile(
    "|".join(
        (f"(?<![{before}])" if before else "") + f"{first}维[斯思丝司]"
        for first, before in _WAKE_FIRST.items()
    )
    + "|贾威斯"
)
WAKE_NAMES_ZH = ("贾维斯", "加维斯", "贾维思", "杰维斯", "嘉维斯", "佳维斯")
WAKE_HINT_ZH = "贾维斯"  # Whisper's hotword in Mandarin mode
GREETINGS_ZH = ("你好", "您好", "哈喽", "哈啰", "嘿", "喂", "嗨")
_LATIN_WORD = re.compile(r"[A-Za-z][A-Za-z'’]*")
_GREETING_ONLY = re.compile(r"(?:嘿|喂|你好|您好|哈喽|哈啰|嗨|hey|hi|hello|ok|okay|yo)")
# "Jarvis Code" (贾维斯代码), the coding panel: a name JARVIS says itself, never a wake word.
_PANEL_AFTER = re.compile(r"[ \t]*(?:代码|codes?(?![a-z]))", re.IGNORECASE)
_LEAD_WORDS = re.compile(
    r"^(?:(?:嘿|喂|你好|您好|哈喽|哈啰|嗨|嗯|hey|hi|hello|yo)[\s,，.。!！、]*"
    r"|(?:好的|好|那么|那|哎|诶|欸|okay|ok)(?:[\s,，.。!！、]+|$))+",
    re.IGNORECASE,
)
# The name said again in front of a command, but never the first word of the panel's name
# ("贾维斯，Jarvis Code 做完了吗" keeps "Jarvis Code").
_LEADING_NAMES = re.compile(
    rf"^(?:(?:{_WAKE_ZH.pattern}|jarvis)(?![ \t]*(?:代码|codes?(?![a-z])))[\s,，.。!！、]*)+",
    re.IGNORECASE,
)


def _latin_wakes(word: str, greeted: bool = False) -> bool:
    """A Latin word Whisper wrote for "Jarvis", judged by wake.find_wake itself."""
    return wake.find_wake(("hey " if greeted else "") + word)[0]


def _wake_spans(s: str) -> list[tuple[int, int]]:
    """Where the name is: Chinese forms, and Latin ones ("Jarvis", "Jari ves")."""
    spans = [(m.start(), m.end()) for m in _WAKE_ZH.finditer(s)]
    latin = list(_LATIN_WORD.finditer(s))
    for k, m in enumerate(latin):
        # Only a greeting and nothing else before it counts as greeted ("嘿 Travis").
        greeted = m.start() <= 12 and bool(_GREETING_ONLY.fullmatch(_squash(s[: m.start()])))
        if _latin_wakes(m.group(), greeted):
            spans.append((m.start(), m.end()))
        elif (
            k + 1 < len(latin)
            and m.group()[0] in "jgcJGC"  # a split name ("Jari ves") starts like the name
            and s[m.end() : latin[k + 1].start()].isspace()
            and _latin_wakes(m.group() + latin[k + 1].group())
        ):
            spans.append((m.start(), latin[k + 1].end()))
    return sorted(spans)


def _size(text: str) -> int:
    """Characters of Chinese plus Latin words: the length of a command."""
    return len(_TOKEN.findall(text.lower()))


def find_wake_zh(text: str) -> tuple[bool, str]:
    """(woke, command), like wake.find_wake, for Mandarin: "贾维斯，今天天气怎么样？" and
    "今天天气怎么样，贾维斯？" both wake it with the question as the command; "嘿贾维斯"
    wakes it with none. Without a Chinese character it is wake.find_wake exactly."""
    raw = (text or "").strip()
    if not has_cjk(raw):
        return wake.find_wake(raw)
    s = to_simplified(raw)
    for start, end in _wake_spans(s):
        if _PANEL_AFTER.match(s, end):
            continue  # "贾维斯代码完成了…": the panel's name, most likely its own voice
        before = _LEAD_WORDS.sub("", s[:start].strip(_EDGE)).strip(_EDGE)
        after = _LEADING_NAMES.sub("", s[end:].strip(_EDGE)).strip(_EDGE)
        if _size(after) >= 3 or not before:
            return True, after
        if not after:
            return True, before
        return True, f"{before}，{after}"
    return False, ""


_JARVIS_CODE = re.compile(rf"(?:jarvis|{_WAKE_ZH.pattern})[ \t]*(?:code|代码)", re.IGNORECASE)
_DOTTED_NAME = re.compile(r"(?<![A-Za-z])J\.?\s?A\.?\s?R\.?\s?V\.?\s?I\.?\s?S(?![A-Za-z])\.?")


def speakable_safely_zh(text: str) -> str | None:
    """hub.speakable_safely for Chinese: words to say aloud without the wake word (its
    own speaker saying 贾维斯 would wake it mid-sentence). None when that can't be helped."""
    spoken = _JARVIS_CODE.sub("编程助手", to_simplified(text))
    spoken = _DOTTED_NAME.sub("助手", spoken)
    spoken = _WAKE_ZH.sub("助手", spoken)
    spoken = _LATIN_WORD.sub(lambda m: "助手" if _latin_wakes(m.group()) else m.group(), spoken)
    return None if find_wake_zh(spoken)[0] else spoken


# ── stop, yes and no ──

STOP_PHRASES_ZH = _longest_first(
    ("停", "停下", "停下来", "停一下", "停止", "停停", "暂停", "别说了", "不要说了", "别讲了",
     "不要讲了", "不用说了", "别念了", "别读了", "安静", "安静点", "安静一点", "安静一下", "闭嘴",
     "够了", "等一下", "等一等", "等等", "稍等", "稍等一下", "等会", "等会儿", "打住", "算了",
     "取消", "嘘"),
)  # fmt: skip
_STOP_SOFT = _longest_first(
    ("好不好", "好吗", "行不行", "行吗", "可以吗", "谢谢", "拜托", "一下", "再说", "吧", "啊", "呀",
     "了", "啦", "嘛", "哦", "喔", "呢", "儿", "你", "先", "下"),
)  # fmt: skip
_STOP_LEADS = _longest_first(
    ("好了", "好的", "行了", "那个", "好", "行", "嗯", "哎", "唉", "诶", "欸", "喂", "哦", "噢", "啊",
     "请", "你", "okay", "ok"),
)  # fmt: skip


_STOP_REST = _longest_first(STOP_PHRASES_ZH, _STOP_SOFT)


def is_stop_zh(text: str) -> bool:
    """wake.is_stop for Mandarin: a short 停, 别说了, 安静点儿, 等一下再说. A stop word
    that starts something else ("停车场在哪", "取消订单", "暂停音乐") isn't one."""
    if not has_cjk(text):
        return wake.is_stop(text or "")
    s = _squash(text)
    if not s or len(s) > 12:
        return False
    s = _strip_leads(s, _STOP_LEADS)
    head = _prefix(s, STOP_PHRASES_ZH)
    return bool(head) and _consumes(s[len(head) :], _STOP_REST)


YES_ZH = _longest_first(
    ("好", "好的", "好啊", "好呀", "好吧", "好嘞", "行", "行啊", "行吧", "可以", "可以的", "可以啊",
     "可以呀", "当然可以", "是", "是的", "是啊", "对", "对的", "对啊", "没错", "确认", "确定", "同意",
     "允许", "批准", "发送", "发", "发吧", "发出去", "去吧", "继续", "执行", "运行", "当然", "没问题",
     "没有问题", "没什么问题", "没啥问题", "没毛病", "没意见", "不介意", "我不介意", "yes", "yeah",
     "yep", "yup", "sure", "okay", "ok"),
)  # fmt: skip
_YES_PLAN_ZH = _longest_first(
    YES_ZH,
    ("开始", "开始吧", "动手", "就这么办", "就这样办", "照做", "按计划来", "按计划执行", "走吧", "做吧",
     "干吧", "开干"),
)  # fmt: skip
# What may follow a yes and leave it a plain yes ("好的，发吧，谢谢").
_YES_TAIL = _longest_first(
    YES_ZH,
    ("谢谢你", "谢谢", "谢了", "麻烦了", "请", "吧", "啊", "呀", "了", "的", "啦", "嘞", "呢", "哈", "嗯",
     "哦", "就这样", "这样", "这次", "这一次", "一次", "现在", "马上", "立刻", "就", "please", "thanks",
     "thank", "you", "now"),
)  # fmt: skip
_PLAN_TAIL = _longest_first(_YES_TAIL, _YES_PLAN_ZH)
_ANSWER_FILLERS = _longest_first(
    ("那个", "那就", "那么", "不错", "嗯", "呃", "额", "哦", "噢", "啊", "哎", "唉", "诶", "欸", "那",
     "就"),
)  # fmt: skip
# Words with 不 or 没 in them that aren't a no. (Anything else with one is: a stray 不 in
# "好久不见" makes a no, and a no only ever keeps something from happening.)
_NOT_A_NO = ("不客气", "不好意思", "不用谢", "对不起", "差不多", "了不起", "不错", "不介意",
             "没有问题", "没什么问题", "没啥问题", "没问题", "不成问题", "没毛病", "不要紧", "没错",
             "没关系", "没事", "没意见")  # fmt: skip
# A question put as A-not-A ("好不好", "发没发"). Never inside a refusal said twice: the
# 要不要 in "不要不要" and the 不不 of "不不不" are a no.
_A_NOT_A = re.compile(
    r"(?<![不没])(?:([^不没])[不没]\1|可不可以|能不能|行不行|好不好|是不是|对不对|要不要|发不发|用不用)"
)
_NO_ZH = re.compile(r"不|别|没|甭|否|停|取消|算了|拒绝|放弃|撤销|免了")
_NO_LATIN = {"no", "nope", "nah", "cancel", "stop", "deny", "dont", "don't", "never", "abort"}
_HESITATE_ZH = re.compile(
    r"(?:让我|我|容我|先让我)?(?:想想|想一想|想一下|考虑一下|考虑考虑|看看|看一下|琢磨一下)(?:吧|啊|再说)?"
    r"|(?:等一下|等一等|等等|稍等|等会儿?|等我一下|一秒|慢着|且慢)(?:吧|啊)?"
    r"|我?(?:不确定|不太确定|不知道|不清楚|还没想好|没想好)(?:呢|啊)?"
    r"|嗯+|呃+|额+"
)
_WAITING_ZH = re.compile(
    r"等一下|等一等|等等|稍等|等会|等我一下|慢着|且慢|我想想|让我想想|考虑一下"
)
_ASKING_BACK = re.compile(r"[吗么]$|" + _A_NOT_A.pattern)
_QUESTION_WORDS_ZH = re.compile(
    r"什么|为什么|为啥|怎么|怎样|多久|多少|哪|谁|几(?:点|个|天|次|号|分钟|小时|秒)"
)


def _answer_core(text: str) -> str:
    """A spoken answer boiled down: Simplified, no punctuation, no wake word, no
    throat-clearing in front ("嗯，那就发吧" -> "发吧")."""
    t = _WAKE_ZH.sub(" ", to_simplified(text).lower().replace("’", "'"))
    t = re.sub(r"[a-z']+", lambda m: " " if _latin_wakes(m.group()) else m.group(), t)
    return _strip_leads(_squash(t), _ANSWER_FILLERS)


def _negated_zh(core: str, raw: str) -> bool:
    """A no anywhere: 不, 别, 没有, 取消, 算了… but not 没问题, 不错 or 好不好."""
    t = _A_NOT_A.sub("", core)
    for keep in _NOT_A_NO:
        t = t.replace(keep, "")
    latin = re.findall(r"[a-z']+", to_simplified(raw).lower().replace("’", "'"))
    return any(w in _NO_LATIN for w in latin) or bool(_NO_ZH.search(t))


def _asking_back(core: str, raw: str) -> bool:
    """A question, not an answer: a question mark, 吗 at the end, A-not-A ("好不好"), or
    a question word ("为什么要发", "这个命令会运行多久"). 没什么问题 isn't one."""
    if "?" in raw or "？" in raw:
        return True
    for keep in _NOT_A_NO:
        core = core.replace(keep, "")
    return bool(_ASKING_BACK.search(core) or _QUESTION_WORDS_ZH.search(core))


def _latin_words(raw: str) -> list[str]:
    """The Latin words said, without the wake word ("Jarvis, OK，发吧" -> ["ok"])."""
    words = re.findall(r"[a-z']+", to_simplified(raw).lower().replace("’", "'"))
    return [w for w in words if not _latin_wakes(w)]


def _yes_lead(core: str, raw: str, vocab: tuple[str, ...] = YES_ZH) -> int:
    """How much of the start is a yes (0 if none). A Latin yes counts only as a whole
    word: "OK，发吧" starts with one, "OKR 在哪" and "yesterday 的日志" don't. (The core
    has lost its spaces, so the words as said decide.)"""
    lead = _prefix(core, vocab)
    if lead and lead[-1].isascii():
        words = _latin_words(raw)
        if not words or words[0] != lead:
            return 0
    return len(lead)


def yes_no_zh(text: str) -> bool | None:
    """wake.yes_no for Mandarin: True, False, or None when unclear. A no anywhere wins,
    and before anything else ("好，先别发", "不要发，好吗？" and "不不不" are a no); a yes
    must lead and be all there is ("发现了一个问题" is not a yes); a question back
    ("可以吗？") or a moment to think ("我想想") answers nothing."""
    if not has_cjk(text):
        return wake.yes_no(text or "")
    core = _answer_core(text)
    if not core or len(core) > 12 or _HESITATE_ZH.fullmatch(core):
        return None
    if _negated_zh(core, text):
        return False
    if _asking_back(core, text) or _WAITING_ZH.search(core):
        return None
    lead = _yes_lead(core, text)
    return True if lead and _consumes(core[lead:], _YES_TAIL) else None


# Voice answers to approval cards (voicecode.voice_answer's contract, in Chinese).
# "Always" writes a lasting rule and "all edits" lasts the session: both need saying
# plainly, never as a question back ("始终允许？").
_ALWAYS_ZH = re.compile(
    r"(?:好的?|是的?|可以|行|对)?(?:始终|总是|一直|永远|以后都|以后一直)(?:允许|同意|可以|运行|执行|这样)(?:吧|了)?"
    r"|(?:好的?|可以|行)?(?:以后)?(?:不用|别|不要)再问(?:我)?了?(?:吧)?"
    r"|始终"
)
_ALL_EDITS_ZH = re.compile(
    r"(?:好的?|是的?|可以|行)?(?:允许|接受|同意)(?:所有|全部)的?(?:编辑|修改|改动)(?:吧)?"
    r"|自动接受(?:所有)?(?:编辑|修改|改动)?|自动(?:所有)?(?:编辑|修改|改动)|所有(?:编辑|修改)都允许"
)
_AUTO_EDITS_GO_ZH = re.compile(
    r"(?:好的?|可以|行|开始吧?|执行吧?)?(?:并且|然后|并)?"
    r"(?:自动接受(?:所有)?(?:编辑|修改|改动)?|自动(?:所有)?(?:编辑|修改|改动))(?:吧)?"
)
_KEEP_PLANNING_ZH = re.compile(
    r"(?:继续|再)(?:规划|计划|想想|完善)(?:一下)?(?:计划)?(?:吧)?"
    r"|(?:修改|改一下|调整|完善)(?:一下)?(?:这个)?计划(?:吧)?|计划(?:再|还要)?(?:改改|改一下|完善一下)"
)
_SKIP_ZH = re.compile(
    r"跳过(?:这个|这题|这个问题)?(?:吧)?|都不(?:要|选|是|行)?|哪个都不(?:要|选)?|两个都不(?:要|选)?|过吧?|pass|skip"
)
_NUMBER_ZH = "[一二三四五六1-6]"
# An option by its number, said as one: 第二个, 选项三, 方案二, 最后一个. On a yes-or-no
# card and a plan only these count: "我要一个" or "一号" is not option one (which is allow).
_CHOICE_EXPLICIT_ZH = re.compile(
    rf"(?:我)?(?:选|要|用|挑|就|选择|就选)?第(?P<n>{_NUMBER_ZH})(?:个|项|条|种|号)?(?:选项|方案)?(?:吧|的)?"
    rf"|(?:我)?(?:选|要|用|就选)?(?:选项|方案|选择)(?P<m>{_NUMBER_ZH})(?:吧)?"
    r"|(?:我)?(?:选|要|用|就选)?(?P<last>最后)(?:一个|一项|那个|一条|一种|的)?(?:吧)?"
)
# In answer to Claude Code's "which one?" a bare number will do too: 二, 选三, 2号.
_CHOICE_LOOSE_ZH = re.compile(
    rf"(?:我)?(?:选|要|用|挑|就|选择)?(?P<n>{_NUMBER_ZH})(?:个|项|条|种|号|个选项)?(?:吧|的)?"
)
_CHOICE_NUMBERS = {"一": 0, "二": 1, "三": 2, "四": 3, "五": 4, "六": 5}
# What may come before and after an option's name and leave it that option ("选 Postgres
# 吧", "SQLite 就行"). On a yes-or-no card, only a particle or a please ("允许吧").
_GLUE_BEFORE = _longest_first(
    ("我选", "就选", "选择", "选", "我用", "就用", "用", "那就", "那个", "这个", "就", "请"),
)  # fmt: skip
_GLUE_AFTER = _longest_first(
    ("就行", "就好", "就可以", "吧", "了", "啊", "呀", "的", "呢", "嘛", "哈", "谢谢", "please"),
)  # fmt: skip
_CARD_GLUE_BEFORE = _longest_first(("那就", "就", "请"))
_CARD_GLUE_AFTER = _longest_first(("吧", "啊", "呀", "嘛", "哈", "谢谢", "please"))
# A no and nothing more ("不要不要", "不，不"): no feedback to pass on.
_REFUSALS_ONLY = _longest_first(
    ("不要", "不用", "不行", "不对", "不是", "不了", "不", "别", "没有", "算了", "取消", "否", "no",
     "nope", "了", "吧", "啊", "呀"),
)  # fmt: skip
_BUT_ZH = ("但是", "不过", "可是", "只是", "而是")
_FEEDBACK_NO = re.compile(
    r"^(?:不要|不用|不行|不了|不是|不|算了|取消|没有|否|停|别了|no|nope)[\s，,。.！!、；;：:]+(.+)$",
    re.IGNORECASE | re.DOTALL,
)
_FEEDBACK_ORDER = re.compile(r"^(?:别|不要|先别|不用|不准|不许)\S")
_FEEDBACK_BUT = re.compile(r"(?:但是|不过|可是|只是|而是|其实)[，,\s]*(.+)$", re.DOTALL)
# Openers that sound like a yes but start something else when more follows: "对了，还有
# 一件事" (by the way), "是这样的，我想…" (the thing is).
_OPENERS_ZH = ("对了", "是这样")


def _choice_zh(core: str, loose: bool = False) -> int | None:
    """'第二个', '选项三', '最后一个' -> which option (-1 for the last); with loose (a
    question's options), a bare '二' or '选三' too."""
    m = _CHOICE_EXPLICIT_ZH.fullmatch(core)
    if m is None and loose:
        m = _CHOICE_LOOSE_ZH.fullmatch(core)
    if m is None:
        return None
    found = m.groupdict()
    if found.get("last"):
        return -1
    word = found.get("n") or found.get("m") or ""
    return int(word) - 1 if word.isdigit() else _CHOICE_NUMBERS[word]


def _label_score(core: str, lab: str, strict: bool) -> float:
    """How surely the answer is this label: 1 said exactly, 0.9 with only glue around it
    ("选 Postgres 吧"). Unless strict, also most of a long label ("编辑前先问我") or a
    long one with a character misheard. Never a label a sentence merely holds: "这个是
    生产环境" isn't 是, "谁允许你这么做的" isn't 允许, "yesterday" isn't Yes."""
    if core == lab:
        return 1.0
    short, long = sorted((len(core), len(lab)))
    if short < 2:
        return 0.0  # a one-character label (是, 否) or answer counts only said exactly
    if lab in core:
        before, _, after = core.partition(lab)
        glue_before = _CARD_GLUE_BEFORE if strict else _GLUE_BEFORE
        glue_after = _CARD_GLUE_AFTER if strict else _GLUE_AFTER
        if _consumes(before, glue_before) and _consumes(after, glue_after):
            return 0.9
    if strict:
        return 0.0
    if lab in core or core in lab:
        return 0.75 if short >= 4 and short / long >= 0.6 else 0.0
    if short < 4:
        return 0.0  # short words that look alike ("发送" and "发货") aren't the same word
    return difflib.SequenceMatcher(None, core, lab).ratio()


def _label_zh(core: str, labels: list[str], strict: bool = False) -> int | None:
    """The option whose label the answer is, all of it or (unless strict) most of it.
    strict is for a yes-or-no card, where the first label is permission: there only the
    label itself counts, alone or with glue around it. (A long answer is a request, not
    a label, and comparing it to each label would take a while.)"""
    if len(core) > 40:
        return None
    best, best_score = None, 0.0
    for i, label in enumerate(labels):
        lab = _squash(label)
        if not lab:
            continue
        score = _label_score(core, lab, strict)
        if score > best_score:
            best, best_score = i, score
    return best if best_score >= 0.6 else None


def _feedback_zh(text: str) -> str:
    """What to do instead, as the user said it: "不要，用 Makefile" -> "用 Makefile";
    "别跑迁移，只生成它" -> all of it; "好，但是别跑测试" -> "别跑测试"."""
    t = _LEADING_NAMES.sub("", to_simplified(text).strip()).strip()
    t = re.sub(r"^(?:嗯|呃|额|那个|哦|啊|好的|好)[\s，,。.、]*", "", t)
    if m := _FEEDBACK_NO.match(t):
        rest = m.group(1)
    elif _FEEDBACK_ORDER.match(t) and not _asking_back(_squash(t), t):
        rest = t if _size(t) >= 4 else ""  # an order, not a question ("不用再问了吗？")
    elif m := _FEEDBACK_BUT.search(t):
        rest = m.group(1)
    else:
        rest = ""
    rest = rest.strip(_EDGE)
    said = _squash(rest)
    if _size(rest) < 2 or _HESITATE_ZH.fullmatch(said) or _consumes(said, _REFUSALS_ONLY):
        return ""
    return rest


def _asked(approval: dict[str, Any], keys: tuple[str, ...] = ("question", "spoken")) -> list[str]:
    """What JARVIS asked, as the user may have heard it: the card's question and, when
    the hub passes it, what was said aloud ("spoken"), each as written (English or
    Chinese) and in Chinese; squashed."""
    said = [str(approval.get(key) or "") for key in keys]
    return [t for t in dict.fromkeys(_squash(x) for s in said if s for x in (s, translate(s))) if t]


def _echoes_question(core: str, asked: list[str]) -> bool:
    """A long stretch of what it asked: JARVIS's voice heard back, never a yes ("要把这条
    发给Ben吗" heard as "把这条发给Ben")."""
    return len(core) >= 4 and any(core in q for q in asked)


def _heard_back(core: str, approval: dict[str, Any]) -> bool:
    """Words from inside the question itself, maybe its own voice: never an option's
    name ("要发送这条消息吗" heard as "发送这条消息"). Only the question: what was said
    aloud may list the options, and saying one of those is an answer."""
    return len(core) >= 2 and any(core in q for q in _asked(approval, ("question",)))


def voice_answer_zh(text: str, approval: dict[str, Any]) -> tuple[str, str] | None:
    """voicecode.voice_answer for Mandarin, with its contract: (choice id, feedback);
    (HOLD, "") for a moment to think; (REASK, "") for an answer that doesn't fit; None
    when it isn't an answer. A no anywhere wins; "始终允许" and "允许所有编辑" must be
    said plainly (not asked back) and are never reached by a number or a no; an option's
    name counts only when that is what was said, never a word inside a sentence; and a
    purchase takes nothing but its deliberate phrase (确认购买). Without a Chinese
    character it is voicecode.voice_answer exactly. An approval may carry "spoken", what
    JARVIS said aloud with it, so its own words heard back aren't taken for an answer."""
    from .voicecode import voice_answer as english

    if not has_cjk(text):
        return english(text, approval)
    choices = approval.get("choices") or []
    ids = [c["id"] for c in choices]
    labels = [str(c.get("label", "")) for c in choices]
    core = _answer_core(text)
    if not core or not ids:
        return None
    kind = approval.get("ask_kind")
    if kind == "purchase":
        return _purchase_answer_zh(core, text, ids)
    if kind == "question":
        return _question_answer_zh(core, text, ids, labels)
    if kind == "plan":
        return _plan_answer_zh(core, text, approval, ids, labels)
    return _card_answer_zh(core, text, approval, ids, labels)


def _purchase_answer_zh(core: str, raw: str, ids: list[str]) -> tuple[str, str]:
    """Money: only the words 确认购买 (confirm purchase) buy; a no cancels; anything else,
    a plain 好 included, asks again."""
    from .voicecode import REASK

    try:
        from .transactions import is_confirm_phrase
    except ImportError:  # pragma: no cover - the purchases module isn't there: never buy
        return (ids[-1], "") if _negated_zh(core, raw) else (REASK, "")
    if is_confirm_phrase(raw):
        return (ids[0], "")
    return (ids[-1], "") if _negated_zh(core, raw) else (REASK, "")


def _card_answer_zh(
    core: str, raw: str, approval: dict[str, Any], ids: list[str], labels: list[str]
) -> tuple[str, str] | None:
    """A yes-or-no card: allow, deny, and maybe always or all edits."""
    from .tasks import ALLOW_EDITS, ALWAYS
    from .voicecode import HOLD, REASK

    if _HESITATE_ZH.fullmatch(core):
        return (HOLD, "")
    asking = _asking_back(core, raw)
    if ALWAYS in ids and not asking and _ALWAYS_ZH.fullmatch(core):
        return (ALWAYS, "")  # ahead of the no: "不用再问了" is "don't ask again"
    if ALLOW_EDITS in ids and not asking and _ALL_EDITS_ZH.fullmatch(core):
        return (ALLOW_EDITS, "")
    if _negated_zh(core, raw):
        return (ids[-1], _feedback_zh(raw))
    if _WAITING_ZH.search(core):
        return (HOLD, "")
    if asking:
        return None
    asked = _asked(approval)
    lead = _yes_lead(core, raw)
    if lead and not _echoes_question(core, asked):
        tail = core[lead:]
        if _consumes(tail, _YES_TAIL):
            return (ids[0], "")
        if tail.startswith(_BUT_ZH):  # "可以，但是用 make": a no with what to do instead
            return (ids[-1], _feedback_zh(raw))
        return None if core.startswith(_OPENERS_ZH) else (REASK, "")
    index = _choice_zh(core)
    if index is not None:
        index = len(ids) - 1 if index == -1 else index
        if index in (0, len(ids) - 1):
            return (ids[index], "")
        return (REASK, "")  # never "always" or "all edits" by number
    match = _label_zh(core, labels, strict=True)
    if match is not None and ids[match] not in (ALWAYS, ALLOW_EDITS):
        return None if _heard_back(core, approval) else (ids[match], "")
    return None


def _plan_answer_zh(
    core: str, raw: str, approval: dict[str, Any], ids: list[str], labels: list[str]
) -> tuple[str, str] | None:
    """A plan: go (asking before edits), go with auto-accepted edits, or keep planning."""
    from .tasks import PLAN_APPROVE, PLAN_APPROVE_EDITS, PLAN_KEEP
    from .voicecode import HOLD, REASK

    if _HESITATE_ZH.fullmatch(core):
        return (HOLD, "")
    if _negated_zh(core, raw):
        return (PLAN_KEEP, _feedback_zh(raw))
    if _WAITING_ZH.search(core):
        return (HOLD, "")
    if _asking_back(core, raw):
        return None
    if PLAN_APPROVE_EDITS in ids and _AUTO_EDITS_GO_ZH.fullmatch(core):
        return (PLAN_APPROVE_EDITS, "")
    if _KEEP_PLANNING_ZH.fullmatch(core):
        return (PLAN_KEEP, "")
    lead = _yes_lead(core, raw, _YES_PLAN_ZH)
    if lead and _consumes(core[lead:], _PLAN_TAIL):
        return (PLAN_APPROVE, "")  # a plain go: it still asks before each edit
    index = _choice_zh(core)
    if index is not None:
        chosen = ids[index] if -len(ids) <= index < len(ids) else ""
        return (chosen, "") if chosen in (PLAN_APPROVE, PLAN_KEEP) else (REASK, "")
    match = _label_zh(core, labels)
    if match is not None and ids[match] != PLAN_APPROVE_EDITS:
        return None if _heard_back(core, approval) else (ids[match], "")
    if lead and core.startswith(_OPENERS_ZH):
        return None
    return (REASK, "") if lead else None


def _question_answer_zh(
    core: str, raw: str, ids: list[str], labels: list[str]
) -> tuple[str, str] | None:
    """Claude Code's multiple-choice question: an option by number or name, or skip. A
    question back ("这样做是对的吗") is for Claude, not an answer."""
    from .voicecode import HOLD, REASK

    options = [i for i in ids if i != "skip"]
    if "skip" in ids and _SKIP_ZH.fullmatch(core):
        return ("skip", "")
    if _HESITATE_ZH.fullmatch(core) or _WAITING_ZH.search(core):
        return (HOLD, "")
    exact = [i for i, label in enumerate(labels) if _squash(label) == core]
    if exact:  # an option called "不需要" is an answer, not a no
        return (ids[exact[0]], "")
    if _asking_back(core, raw):
        return None
    if _negated_zh(core, raw):
        return (REASK, "")
    index = _choice_zh(core, loose=True)
    if index is not None:  # "最后一个" is the last option, not the unspoken Skip
        index = len(options) - 1 if index == -1 else index
        return (options[index], "") if 0 <= index < len(options) else (REASK, "")
    match = _label_zh(core, labels)
    if match is not None:
        return (ids[match], "")
    lead = _yes_lead(core, raw)
    if lead and core.startswith(_OPENERS_ZH):
        return None
    return (REASK, "") if lead else None  # "好" doesn't answer "which one?"


# ── hearing its own voice, and a finished request ──


def _echo_tokens(text: str) -> list[str]:
    s = to_simplified(text).lower()
    latin = [w for w in re.findall(r"[a-z']+", s) if len(w) > 2]
    runs = re.findall(f"[{_CJK_CHARS}]+", s)
    return latin + [run[i : i + 2] for run in runs for i in range(len(run) - 1)]


def is_echo_zh(heard: str, speaking: str, threshold: float = 0.6) -> bool:
    """wake.is_echo for Chinese: mostly two-character pieces of what it just said."""
    if not has_cjk(heard) and not has_cjk(speaking):
        return wake.is_echo(heard, speaking, threshold)
    tokens = _echo_tokens(heard)
    if not tokens or not speaking:
        return False
    said = set(_echo_tokens(speaking))
    return sum(1 for t in tokens if t in said) / len(tokens) >= threshold


# What an unfinished Chinese request tends to stop on ("帮我查一下明天的…").
_TRAILING_ZH = _longest_first(
    ("的", "和", "跟", "与", "还有", "然后", "就是", "那个", "这个", "因为", "所以", "但是", "可是", "如果",
     "要是", "把", "给", "在", "从", "到", "对", "关于", "比如", "或者", "还是", "以及", "而且", "并且",
     "帮我", "请", "嗯", "呃", "额", "我想", "我要", "是", "让"),
)  # fmt: skip


def sounds_finished_zh(text: str) -> bool:
    """listen.sounds_finished for Chinese: ends like a sentence, has at least two
    characters, and a statement doesn't stop on a word that promises more. A question
    that ends in ？ is taken as asked."""
    if not has_cjk(text):
        from .listen import sounds_finished as english

        return english(text or "")
    t = to_simplified(text).strip()
    if not t or t.endswith(("...", "…", ",", "，", "、", "-", "—")):
        return False
    if not t.endswith(("。", "？", "！", ".", "?", "!")):
        return False
    core = t.rstrip("。？！.?! ")
    if len(_CJK.findall(core)) < 2:
        return False
    if t.endswith(("？", "?")):
        return True
    return not core.endswith(_TRAILING_ZH)


# ── instant commands ──

_COMMAND_LEADS = _longest_first(
    ("麻烦你", "麻烦", "请你", "请", "帮我", "帮忙", "给我", "你能不能", "能不能", "可不可以", "你可以",
     "可以", "你能", "能否", "那个", "那就", "然后", "现在", "好的", "好", "嗯", "哦", "喂", "嘿", "那",
     "再", "就", "先", "快点", "赶紧", "马上", "你"),
)  # fmt: skip
_COMMAND_TAILS = _longest_first(
    ("好不好", "好吗", "可以吗", "行吗", "行不行", "谢谢你", "谢谢", "一下下", "一下", "吧", "啊", "呀",
     "呢", "嘛", "哦", "了", "吗", "啦"),
)  # fmt: skip
_COMMAND_PUNCT = re.compile(
    r"[，。！？、；：,!?;:“”\"‘’…—~～()（）【】《》「」『』]+|(?<!\d)\.|\.(?!\d)"
)


def _command_zh(text: str) -> str:
    """A short command boiled down: Simplified, lowercase, no punctuation or wake word,
    no politeness around it, spaces only between Latin words ("请帮我往下滚动一下吧" ->
    "往下滚动"; "点击 Generate memo" -> "点击generate memo")."""
    s = _COMMAND_PUNCT.sub(" ", to_simplified(text).lower().replace("’", "'"))
    s = re.sub(r"\s+", " ", s).strip()
    s = re.sub(f"(?<=[{_CJK_CHARS}]) | (?=[{_CJK_CHARS}])", "", s)
    s = _LEADING_NAMES.sub("", s).strip()
    while True:
        before = s
        s = _strip_leads(s, _COMMAND_LEADS)
        tail = next((t for t in _COMMAND_TAILS if s.endswith(t) and len(s) > len(t)), "")
        if tail:
            s = s[: -len(tail)]
        if s == before:
            return s.strip()


_SCROLL_VERB = r"(?:滚动|翻页|翻动|滑动|移动|卷动|滚|翻|滑|拉|移|走)"
_AMOUNTS_ZH = {
    "一点点": 0.4, "一点儿": 0.4, "一点": 0.4, "一些": 0.4, "一丁点": 0.4, "一小段": 0.4, "少许": 0.4,
    "很多": 2.5, "好多": 2.5, "一大段": 2.5, "一大截": 2.5, "多一点": 1, "多点": 1, "多些": 1,
    "一页": 1, "一屏": 1, "一整页": 1, "两页": 2, "二页": 2, "两屏": 2, "三页": 3, "三屏": 3,
}  # fmt: skip
_SCROLL_ZH = re.compile(
    rf"(?P<pre>稍微|稍稍|多)?(?:(?:向|往|朝)(?P<d1>下|上)|(?P<d2>下|上)(?={_SCROLL_VERB}))"
    rf"(?P<mid>稍微|多)?{_SCROLL_VERB}?"
    rf"(?P<amt>{'|'.join(sorted(_AMOUNTS_ZH, key=len, reverse=True))})?"
)
_MORE_DOWN_ZH = {
    "继续", "继续往下", "继续滚动", "继续翻", "接着往下", "接着看", "更多", "下一页", "下页", "翻页",
    "往下翻页", "向下翻页", "滚动", "下拉",
}  # fmt: skip
_MORE_UP_ZH = {"上一页", "上页", "往上翻页", "向上翻页"}
_TOP_ZH = ("顶部", "最顶部", "顶端", "最顶端", "最上面", "最上方", "最上边", "最顶上", "开头", "最前面",
           "页首", "顶")  # fmt: skip
_BOTTOM_ZH = ("底部", "最底部", "底端", "最底端", "最下面", "最下方", "最下边", "最底下", "结尾", "末尾",
              "最后面", "最后", "页尾", "底")  # fmt: skip
_EDGE_ZH = re.compile(
    r"(?:回|返回|滚动?|跳转?|拉|翻|移动?|去|直接|一直|快速)?(?:到|至)?(?:页面|网页|这页)?的?"
    rf"(?P<w>{'|'.join(sorted(_TOP_ZH + _BOTTOM_ZH, key=len, reverse=True))})"
)
_BACK_ZH = re.compile(
    r"(?:返回|后退|回退|退回|回去|往回|倒回去?)(?:到)?(?:上一页|上一个页面|上个页面|前一页|之前的页面|上一步)?"
    r"|上一个页面|上个页面|前一页"
)
_FORWARD_ZH = re.compile(r"(?:前进|向前|往前进)(?:一页|到下一个页面)?|下一个页面")
_ZOOM_TARGET = r"(?:把)?(?:字体?|文字|页面|网页|屏幕|它|这个|界面)?"
_ZOOM_SOME = r"(?:一点点?|一些|点|些)?"
_ZOOM_IN_ZH = re.compile(
    rf"{_ZOOM_TARGET}(?:(?:放大|调大|变大|弄大){_ZOOM_SOME}|大(?:一点点?|一些|点|些))"
)
_ZOOM_OUT_ZH = re.compile(
    rf"{_ZOOM_TARGET}(?:(?:缩小|调小|变小|弄小){_ZOOM_SOME}|小(?:一点点?|一些|点|些))"
)
_ZOOM_RESET_ZH = re.compile(
    r"(?:恢复|重置|还原)(?:缩放|(?:默认|原始|原来|正常)的?大小|到?正常大小|原样)"
    r"|缩放(?:恢复|还原|重置)(?:正常)?|(?:原始|正常|默认)大小"
)
_RESEARCH_NAMES = r"(?:研究中心|bsh研究中心|bsh ?research center|研究|市场|市场明细|市场概览|这个页面|页面|它|这个)"
_CLOSE_RESEARCH_ZH = re.compile(
    rf"(?:关闭|关掉|关上|退出|离开|隐藏|收起){_RESEARCH_NAMES}?|把{_RESEARCH_NAMES}?关(?:掉|上|闭)?"
)
_OPEN_PAGE_ZH = re.compile(
    r"(?:打开|开启|显示|给我看|看看|看一下|去|转到|跳到|跳转到|切换到|切到|进入|前往|带我去|导航到|调出|回到)(?P<page>.+)"
)
_CLICK_ZH = re.compile(
    r"(?:点击|点一下|点下|单击|按一下|按下|按|选择|选中|点)(?:一下)?(?:那个|这个)?(?P<text>.+?)"
    r"(?:按钮|链接|标签|选项卡|选项)?"
)
# The Research Center's pages by their Chinese names -> paths (research.PAGES in English).
PAGES_ZH = {
    "市场": "/markets", "市场明细": "/markets", "市场概览": "/markets", "市场分解": "/markets",
    "行情": "/markets", "市场雷达": "/market-radar", "雷达": "/market-radar", "市场台": "/market-radar",
    "脉搏": "/weekly-summary", "每周脉搏": "/weekly-summary", "每周摘要": "/weekly-summary",
    "每周总结": "/weekly-summary", "周报": "/weekly-summary", "新闻": "/news-desk",
    "新闻台": "/news-desk", "新闻中心": "/news-desk", "头条": "/news-desk", "头条新闻": "/news-desk",
    "主页": "/", "首页": "/", "仪表盘": "/", "仪表板": "/", "研究台": "/research-desk",
    "研究桌": "/research-desk", "研究工作台": "/research-desk", "报告": "/reports",
    "研究报告": "/reports", "备忘录": "/reports", "投资备忘录": "/reports", "追踪": "/tracking",
    "跟踪": "/tracking", "关注列表": "/tracking", "观察列表": "/tracking", "自选股": "/tracking",
    "消息": "/messages", "交易员统计": "/trader-stats", "交易统计": "/trader-stats",
    "股票研究": "/stock-research", "个股研究": "/stock-research", "资料库": "/source-library",
    "来源库": "/source-library", "来源": "/source-library", "文献库": "/source-library",
    "创新实验室": "/innovation-lab", "实验室": "/innovation-lab",
    "市场脉搏": "/innovation-lab/market-pulse", "证据矩阵": "/innovation-lab/evidence-matrix",
    "假设实验室": "/innovation-lab/hypothesis-lab", "霍尔木兹": "/innovation-lab/hormuz",
    "霍尔木兹海峡": "/innovation-lab/hormuz", "帮助": "/help", "设置": "/settings", "设定": "/settings",
}  # fmt: skip


def _scroll_amount(m: re.Match[str]) -> float:
    said = (m.group("pre") or "") + (m.group("mid") or "")
    if m.group("amt"):
        value = _AMOUNTS_ZH[m.group("amt")]
        return 1 if "多" in said and value == 0.4 else value  # "多滚一点": more, not less
    return 0.4 if "稍" in said else 1


def _zoom_way(t: str) -> str | None:
    if _ZOOM_RESET_ZH.fullmatch(t):
        return "reset"
    if _ZOOM_IN_ZH.fullmatch(t):
        return "in"
    if _ZOOM_OUT_ZH.fullmatch(t):
        return "out"
    return None


def _page_zh(said: str) -> tuple[str, str | None]:
    """A page as said -> (its name, its path), or a None path for anything else."""
    key = re.sub(r"^(?:我的|我们的|那个|这个)", "", said.strip()).strip()
    trimmed = re.sub(r"的?(?:页面|页|板块|栏目|标签页|标签|界面|频道|部分)$", "", key) or key
    for name in (key, trimmed):
        if name in PAGES_ZH:
            return name, PAGES_ZH[name]
        if name and not has_cjk(name):
            path = research.page_path(name)  # English page names said in Chinese mode
            if path is not None:
                return name, path
    return key, None


def parse_research_zh(text: str) -> research.Command | None:
    """research.parse for Mandarin: 向下滚动, 往下翻两页, 回到顶部, 到底部, 返回, 前进,
    放大, 缩小, 关闭研究中心, 打开报告, 打开新闻, 点击 NVDA. Returns research.Command
    objects with the same action and args the English phrase gets (replies in Chinese).
    A company, a ticker search or a Chinese button label goes to Claude (None): the
    page's buttons are in English, so Claude matches them by meaning."""
    if not has_cjk(text):
        return research.parse(text or "")
    t = _command_zh(text)
    if not t or len(t) > 24:
        return None
    if t in _MORE_DOWN_ZH:
        return research.Command("scroll", {"direction": "down", "amount": 1})
    if t in _MORE_UP_ZH:
        return research.Command("scroll", {"direction": "up", "amount": 1})
    if m := _SCROLL_ZH.fullmatch(t):
        way = "down" if (m.group("d1") or m.group("d2")) == "下" else "up"
        return research.Command("scroll", {"direction": way, "amount": _scroll_amount(m)})
    if m := _EDGE_ZH.fullmatch(t):
        where = "top" if m.group("w") in _TOP_ZH else "bottom"
        return research.Command("scroll", {"direction": where})
    if _BACK_ZH.fullmatch(t):
        return research.Command("back", {}, "返回。")
    if _FORWARD_ZH.fullmatch(t):
        return research.Command("forward", {}, "前进。")
    if way := _zoom_way(t):
        return research.Command("zoom", {"direction": way})
    if _CLOSE_RESEARCH_ZH.fullmatch(t):
        return research.Command("close", {}, "已关闭研究中心。")
    if m := _OPEN_PAGE_ZH.fullmatch(t):
        name, path = _page_zh(m.group("page"))
        if path is None:
            return None  # a company, a ticker, something else: Claude works it out
        return research.Command("open", {"path": path}, f"正在打开{_named(name)}。", speak=False)
    if m := _CLICK_ZH.fullmatch(t):
        target = m.group("text").strip()
        if target and not has_cjk(target):
            return research.Command("click", {"text": target}, "")
    return None


# The window's panels and looks by their Chinese names (ui.PANELS and ui.LOOKS in English).
PANELS_ZH = {
    "贾维斯代码": "code", "jarvis代码": "code", "代码面板": "code", "编程面板": "code",
    "模拟器": "simulator", "ios模拟器": "simulator", "iphone模拟器": "simulator",
    "编程窗口": "code", "浏览器": "browser", "网页浏览器": "browser", "内置浏览器": "browser",
    "研究中心": "research", "bsh研究中心": "research", "市场明细": "research", "设置": "settings",
    "偏好设置": "settings", "设定": "settings", "第二大脑": "brain", "知识星系": "brain",
    "星系": "brain", "大脑": "brain", "知识库": "brain", "活动": "activity", "活动记录": "activity",
    "活动日志": "activity", "工具与账户": "accounts", "工具和账户": "accounts", "账户": "accounts",
    "账号": "accounts", "连接器": "accounts",
}  # fmt: skip
PANEL_NAMES_ZH = {
    "code": "Jarvis Code", "browser": "浏览器", "research": "研究中心", "settings": "设置",
    "brain": "第二大脑", "activity": "活动记录", "accounts": "工具与账户", "simulator": "iOS 模拟器",
}  # fmt: skip
LOOKS_ZH = {
    "光球": "orb", "环境光球": "orb", "球": "orb", "hud": "hud", "斯塔克hud": "hud",
    "钢铁侠hud": "hud", "抬头显示": "hud", "抬头显示器": "hud", "平视显示": "hud",
    "指挥中心": "console", "控制台": "console",
}  # fmt: skip
LOOK_NAMES_ZH = {"orb": "环境光球", "hud": "斯塔克 HUD", "console": "指挥中心"}
_UI_OPEN = r"(?:打开|开启|显示|调出|弹出|启动|进入|去|给我看|看看|带我去|拉起|展开|切换到|切到)"
_UI_CLOSE = r"(?:关闭|关掉|关上|隐藏|收起|退出|离开|关)"
_OPEN_PANEL_ZH = re.compile(rf"{_UI_OPEN}(?P<p>.+)|把(?P<q>.+?)(?:打开|开启|调出来?|显示出来?)")
_CLOSE_PANEL_ZH = re.compile(rf"{_UI_CLOSE}(?P<p>.+)|把(?P<q>.+?)(?:关掉|关闭|关上|关|隐藏|收起)")
_LOOK_UI_ZH = re.compile(
    r"(?:切换到|切换成|切换为|切到|换成|换到|换回|改成|改为|变成|使用|用|回到|切回|恢复成?)"
    r"(?P<look>.+?)(?:外观|视图|模式|布局|主题|设计|界面|样式|风格)?"
)
_HANDS_THING = r"(?:手势控制|手势追踪|手势跟踪|手势识别|手部控制|手部追踪|手势)(?:功能)?"
_HANDS_ZH = re.compile(
    rf"(?P<on>打开|开启|启用|开始|启动|开){_HANDS_THING}"
    rf"|(?P<off>关闭|关掉|停用|禁用|停止|结束|关){_HANDS_THING}"
    rf"|{_HANDS_THING}(?P<on2>打开|开启|启用|开)|{_HANDS_THING}(?P<off2>关闭|关掉|停用|关)"
)


def _panel_zh(said: str | None) -> str | None:
    key = re.sub(r"^(?:我的|那个|这个|的)", "", (said or "").strip()).strip()
    trimmed = re.sub(r"(?:面板|窗口|页面|界面|视图|窗格|屏幕|栏)$", "", key) or key
    for name in (key, trimmed):
        if name in PANELS_ZH:
            return PANELS_ZH[name]
        english = re.sub(r"^(?:the|my)\s+", "", name)
        found = ui.PANELS.get(english) or ui.PANELS.get(
            re.sub(r"\s+(?:panel|window|page|view|pane|screen)$", "", english)
        )
        if found:
            return found
    return None


def _look_zh(said: str) -> str | None:
    key = re.sub(r"^(?:那个|这个|the\s+)", "", said.strip()).strip()
    return LOOKS_ZH.get(key) or ui.LOOKS.get(key)


def parse_ui_zh(text: str) -> ui.Command | None:
    """ui.parse for Mandarin: 打开浏览器, 关闭浏览器, 打开贾维斯代码, 切换到HUD,
    切换到指挥中心, 打开设置, 打开手势控制, 关闭手势控制. Returns ui.Command objects with
    the same action, name and on as the English phrase gets (replies in Chinese)."""
    if not has_cjk(text):
        return ui.parse(text or "")
    t = _command_zh(text)
    if not t or len(t) > 20:
        return None
    if m := _HANDS_ZH.fullmatch(t):
        on = bool(m.group("on") or m.group("on2"))
        return ui.Command("hands", "", on, "手势控制已开启。" if on else "手势控制已关闭。")
    if m := _OPEN_PANEL_ZH.fullmatch(t):
        panel = _panel_zh(m.group("p") or m.group("q"))
        if panel:
            return ui.Command("panel", panel, True, f"正在打开{_named(PANEL_NAMES_ZH[panel])}。")
    if m := _CLOSE_PANEL_ZH.fullmatch(t):
        panel = _panel_zh(m.group("p") or m.group("q"))
        if panel:
            return ui.Command("panel", panel, False, f"已关闭{_named(PANEL_NAMES_ZH[panel])}。")
    if m := _LOOK_UI_ZH.fullmatch(t):
        look = _look_zh(m.group("look"))
        if look:
            return ui.Command("look", look, True, f"已切换到{LOOK_NAMES_ZH[look]}。")
    return None


_SHORTCUT_FILLERS = _longest_first(
    ("请", "帮我", "给我", "运行", "启动", "执行", "打开", "开启", "开始", "进入", "切换到", "快捷指令",
     "捷径", "场景", "我的", "现在"),
)  # fmt: skip


def _shortcut_key(text: str) -> str:
    s = _LEADING_NAMES.sub("", _squash(text))
    s = _strip_leads(s, _SHORTCUT_FILLERS)
    for tail in ("一下", "吧", "了"):
        if s.endswith(tail) and len(s) > len(tail):
            s = s[: -len(tail)]
    return s


def match_shortcut_zh(text: str, names: list[str]) -> str | None:
    """home.match_shortcut for Chinese: "运行电影模式" runs the shortcut 电影模式."""
    from .home import match_shortcut as english

    if not has_cjk(text):
        return english(text or "", names)
    said = _shortcut_key(text)
    if not said:
        return None
    hits = [name for name in names if _shortcut_key(name) == said]
    return hits[0] if len(hits) == 1 else None


ABOUT_SCREEN_ZH = re.compile(
    r"这个|那个|这些|那些|这里|屏幕|窗口|页面|标签页|错误|报错|警告|提示|对话框|弹窗|我在看|显示的|文档|"
    r"文章|邮件|图表|表格|代码|幻灯片|照片|图片|视频|写的什么|说的什么|写了什么|说了什么|读一下|总结一下"
)
# livecontext's topics in Chinese: which live data rides along with a request.
LIVE_TOPICS_ZH = {
    "weather": re.compile(
        r"天气|下雨|雨|雪|温度|几度|冷|热|暖和|凉|刮风|风|湿度|伞|外套|夹克|晴|阴|多云|预报|暴风|雷|外面"
    ),
    "calendar": re.compile(
        r"会议|开会|日程|日历|安排|约会|活动|下一个|接下来|有空|忙|议程|今天|几点.{0,4}会"
    ),
    "markets": re.compile(
        r"市场|股市|股票|美股|大盘|标普|纳斯达克|道琼斯|罗素|代码|持仓|投资组合|比特币|加密|收益率|国债|原油|"
        r"石油|黄金|vix|恐慌指数|涨|跌",
        re.IGNORECASE,
    ),
}


def about_screen_zh(text: str) -> bool:
    """screenwatch.about_screen for Chinese requests."""
    return bool(ABOUT_SCREEN_ZH.search(to_simplified(text)))


# ── listening ──

# faster-whisper models for Mandarin. English-only models (base.en, small.en) can't do it:
# given language "zh" they fall back to English. "small" is the smallest multilingual
# model that gets Mandarin characters reliably right; "base" is about three times cheaper
# (74M against 244M parameters) but mixes up homophones, 贾维斯 included.
ZH_WHISPER_MODEL = "small"
ZH_WHISPER_FAST_MODEL = "base"
# Steers Whisper to Simplified characters and full punctuation. (Not the name: a prompt
# with "Jarvis" in it made Whisper treat the name as already said and drop it.)
ZH_INITIAL_PROMPT = "以下是普通话的句子，使用简体中文。"
_ENGLISH_ONLY = re.compile(r"\.en$|^distil-", re.IGNORECASE)


def whisper_model(lang: str, configured: str = "base.en", override: str = "") -> str:
    """The speech model for a language: English keeps what's configured; Mandarin gets
    `override` if given, else a multilingual model (the configured one if it already is
    one, "medium" for medium.en, otherwise ZH_WHISPER_MODEL)."""
    if not is_zh(lang):
        return configured
    if override:
        return override
    if configured and not _ENGLISH_ONLY.search(configured):
        return configured
    sibling = re.sub(r"\.en$", "", configured or "", flags=re.IGNORECASE)
    return sibling if sibling in ("medium", "large", "large-v2", "large-v3") else ZH_WHISPER_MODEL


def transcribe_options(lang: str, hotwords: str = "") -> dict[str, Any]:
    """faster-whisper transcribe() arguments that depend on the language (the rest of
    listen.Transcriber's call stays as it is)."""
    if is_zh(lang):
        return {
            "language": "zh",
            "initial_prompt": ZH_INITIAL_PROMPT,
            "hotwords": hotwords or WAKE_HINT_ZH,
        }
    return {"language": "en", "hotwords": hotwords or "Jarvis"}


# What Whisper's Mandarin mode invents from silence and room noise (video-subtitle
# credits, mostly), and the prompt itself read back.
_HALLUCINATIONS_ZH = {
    "谢谢观看", "谢谢大家观看", "谢谢收看", "感谢观看", "感谢收看", "谢谢大家", "谢谢", "字幕", "中文字幕",
    "请订阅", "点赞订阅", "订阅", "下期再见", "我们下期再见", "嗯", "呃", "啊", "嗯嗯", "哦",
}  # fmt: skip
# Pieces of the credit lines it makes up. A transcript that is mostly these is one; a
# request that merely mentions a name in them isn't ("给 Amara 发消息", "心如明镜").
_HALLUCINATION_MARKS = (
    "字幕由", "字幕提供", "字幕制作", "字幕by", "索兰娅", "amaraorg", "社区提供", "明镜与点点",
    "点点栏目", "明镜需要您的支持", "欢迎订阅明镜", "请不吝点赞", "订阅转发", "打赏支持",
    "yoyotelevisionseriesexclusive", "yoyotelevision", "优优独播剧场", "独播剧场",
    "以下是普通话的句子", "使用简体中文",
)  # fmt: skip
_HALLUCINATION_RE = re.compile(
    "|".join(map(re.escape, sorted(_HALLUCINATION_MARKS, key=len, reverse=True)))
)


def is_hallucination_zh(text: str) -> bool:
    """What Whisper made up, not what was said: a known filler line, or a transcript
    that is more than half subtitle credits (or the prompt read back)."""
    if not has_cjk(text):
        from .listen import is_hallucination

        return is_hallucination(text or "")
    s = _squash(text)
    if s in _HALLUCINATIONS_ZH:
        return True
    credits = sum(len(m.group()) for m in _HALLUCINATION_RE.finditer(s))
    return credits * 2 > len(s)


def clean_transcript_zh(text: str) -> str:
    """A Mandarin transcript as JARVIS reads it: Simplified, no spaces between Chinese
    words, and "" for what Whisper made up."""
    t = to_simplified(text).strip()
    t = re.sub(f"(?<=[{_CJK_CHARS}{_PUNCT_ZH}])\\s+(?=[{_CJK_CHARS}{_PUNCT_ZH}])", "", t)
    return "" if is_hallucination_zh(t) else t


# ── speaking ──

ZH_MAC_VOICE = "Tingting"  # macOS's Mandarin voice (Daniel can't speak Chinese)
# hub.FILLERS in Chinese, in the same order.
FILLERS_ZH = ["稍等。", "这就办。", "我查一下。"]


def mac_voice(lang: str, english_voice: str = "Daniel") -> str:
    return ZH_MAC_VOICE if is_zh(lang) else english_voice


_STOPS_ZH = "。！？；：…"
_STOPS_EN = ".!?;:"
_CLOSERS = "”’」』）)]\"'》〉"
_CLAUSE_MARKS_ZH = "，；：—"


def _is_cjk_char(ch: str) -> bool:
    return bool(_CJK.match(ch))


def _units(text: str) -> int:
    """Length for "long enough to voice": a Chinese character counts double."""
    return len(text) + len(_CJK.findall(text))


def _join(a: str, b: str) -> str:
    """Two pieces of a reply back together: no space after Chinese, one after English."""
    if not a or not b:
        return a or b
    return a + b if _is_cjk_char(a[-1]) or a[-1] in _STOPS_ZH + _CLOSERS else f"{a} {b}"


_STOP_CHAR = re.compile(f"[{re.escape(_STOPS_ZH + _STOPS_EN)}]")
_SPACES = re.compile(r"\s*")


def _sentence_end(text: str, final: bool, start: int = 0) -> int | None:
    """Where the first whole sentence in text from start ends, or None. A Chinese stop
    (。！？；：…) ends one at once; an English one only before a space or Chinese, so
    "23.5" and "3:30" aren't cut. One more character must have arrived ("……", "。”"),
    unless final."""
    i, n = start, len(text)
    while (stop := _STOP_CHAR.search(text, i)) is not None:  # straight to the next stop
        i = stop.start()
        j = i + 1
        while j < n and text[j] in _STOPS_ZH + _STOPS_EN:
            j += 1
        while j < n and text[j] in _CLOSERS:
            j += 1
        if j == n:
            return j if final else None
        chinese = any(c in _STOPS_ZH for c in text[i:j])
        if chinese or text[j].isspace() or _is_cjk_char(text[j]):
            return j
        i = j
    return None


def split_sentences_zh(
    buffer: str, final: bool = False, min_chars: int = 12
) -> tuple[list[str], str]:
    """speech.split_sentences for Chinese replies, with the same signature: whole
    sentences off the front of a streaming buffer, short ones held to join the next.
    A Chinese character counts double toward min_chars, so the hub's 4 and 12 mean about
    two and six characters. The buffer is read by position, never sliced per sentence:
    a long reply splits in linear time."""
    out: list[str] = []
    pos, pending = 0, ""
    while (end := _sentence_end(buffer, final, pos)) is not None:
        sentence = _join(pending, buffer[pos:end].strip())
        pos = _SPACES.match(buffer, end).end()
        if _units(sentence) < min_chars and pos < len(buffer):
            pending = sentence
            continue
        if sentence:
            out.append(sentence)
        pending = ""
    rest = buffer[pos:]
    if pending:
        # The tail keeps its trailing space: the next chunk may go on with another word
        # ("NVDA is " + "up today。"), and only the final flush trims.
        rest = _join(pending, rest.lstrip())
    if final and rest.strip():
        out.append(rest.strip())
        rest = ""
    return out, rest


def first_clause_zh(buffer: str, min_chars: int = 12) -> tuple[str, str] | None:
    """hub._FIRST_CLAUSE for Chinese: the reply's opening clause, to voice before its
    sentence is done ("我查了一下你的日程，" …), as (clause, rest), or None. A Chinese
    clause mark needs no space after it; an English one does ("7,684" stays whole)."""
    for i, ch in enumerate(buffer):
        if ch in _STOPS_ZH + ".!?":
            return None  # a sentence ended first: split_sentences_zh takes it
        nxt = buffer[i + 1] if i + 1 < len(buffer) else ""
        mark = ch in _CLAUSE_MARKS_ZH or (
            ch in ",;:" and bool(nxt) and (nxt.isspace() or _is_cjk_char(nxt))
        )
        if mark and nxt and _units(buffer[: i + 1].strip()) >= min_chars:
            return buffer[: i + 1].strip(), buffer[i + 1 :].lstrip()
    return None


# Each of these scans a run of spaces, brackets or lines once, from its start (never
# again from inside it): a reply with a long run of either stays linear.
_CODE_BLOCK = re.compile(r"```.*?```", re.DOTALL)
# [text](address), with one level of brackets in the address (Wikipedia's Foo_(bar)).
_LINK = re.compile(r"\[([^\[\]]+)\]\((?:[^()]|\([^()]*\))+\)")
_URL = re.compile(r"https?://[^\s，。！？、；：“”（）《》]+")
_BULLET = re.compile(r"^[ \t]*(?:[-*•][ \t]+|\d+[.)][ \t]+|\d+、)", re.MULTILINE)
_HEADING = re.compile(r"^[ \t]*#{1,6}[ \t]*", re.MULTILINE)
_LINE_BREAKS = re.compile(r"(?<![ \t\r\f\v])[ \t\r\f\v]*\n\s*")
_SPACE_BY_CJK = re.compile(
    f"(?<=[{_CJK_CHARS}，。！？])\\s+|(?<!\\s)\\s+(?=[{_CJK_CHARS}，。！？])"
)
# Markdown emphasis. A tilde before a number stays: it's a range ("3~5天") or "about"
# ("~5%"), which spoken_numbers_zh reads.
_EMPHASIS = re.compile(r"[*_`]+|[~～]+(?!\s*[+\-−]?\d)")
_CITATION = re.compile(r"(?<!\s)\s*\[(?:n?\d+(?:,\s*n?\d+)*)\]")


def clean_for_speech_zh(text: str) -> str:
    """speech.clean_for_speech for Chinese: no markdown, code or links read out, lines
    joined with 。, and numbers, money and percentages as Chinese words."""
    text = _CODE_BLOCK.sub("详细内容我放在屏幕上了。", text or "")
    text = _LINK.sub(r"\1", text)
    text = _URL.sub("屏幕上的链接", text)
    text = _CITATION.sub("", text)
    text = _HEADING.sub("", text)
    text = _BULLET.sub("", text)
    text = _EMPHASIS.sub("", text)
    text = _LINE_BREAKS.sub("。", text.strip())
    text = re.sub(r"([。！？!?.…；;：:，,、])。", r"\1", text)
    text = spoken_numbers_zh(to_simplified(text))
    text = _SPACE_BY_CJK.sub("", text)
    return re.sub(r"\s{2,}", " ", text).strip()


# ── numbers the Mandarin way ──

_DIGITS_ZH = "零一二三四五六七八九"
_GROUP_UNITS = ("", "万", "亿", "万亿")
CURRENCIES_ZH = {
    "USD": "美元", "EUR": "欧元", "GBP": "英镑", "JPY": "日元", "CNY": "元", "RMB": "元",
    "CAD": "加元", "AUD": "澳元", "HKD": "港元", "CHF": "瑞士法郎",
}  # fmt: skip


def _four_zh(n: int, first: bool) -> str:
    """0 < n < 10000 in Chinese. first: the number's leading group, where 10-19 are 十,
    十五 and a leading 2 in the hundreds is 两百."""
    out: list[str] = []
    zero = started = False
    for pos, unit in ((3, "千"), (2, "百"), (1, "十"), (0, "")):
        d = n // 10**pos % 10
        if d == 0:
            zero = started
            continue
        if zero:
            out.append("零")
            zero = False
        if d == 2 and (pos == 3 or (pos == 2 and first and not started)):
            word = "两"  # 两千, and 两百 at the front
        elif d == 1 and pos == 1 and first and not started:
            word = ""  # 十, 十五, 十万
        else:
            word = _DIGITS_ZH[d]
        out.append(word + unit)
        started = True
    return "".join(out)


def _int_zh(n: int, measure: bool = False) -> str:
    if n == 0:
        return "零"
    if n == 2 and measure:
        return "两"
    if n >= 10000 ** len(_GROUP_UNITS):
        return digits_zh(str(n))  # past 万亿: read it out digit by digit
    groups, rest = [], n
    while rest:
        groups.append(rest % 10000)
        rest //= 10000
    out, gap, low_zero = "", False, False
    for i in range(len(groups) - 1, -1, -1):
        g = groups[i]
        if g == 0:
            gap = bool(out)
            continue
        if out and (gap or low_zero or g < 1000):
            out += "零"  # 一万零五百, 一百万零五千, 一亿零五
        said = "两" if g == 2 and i > 0 else _four_zh(g, first=not out)
        out += said + _GROUP_UNITS[i]
        gap, low_zero = False, g % 10 == 0
    return out


def _number_text(value: Any) -> str | None:
    """A number as a plain "-1234.5" string (trailing zeros gone), or None."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if not math.isfinite(value):
            return None
        text = f"{value:.10f}"
    else:
        text = re.sub(r"[,\s]", "", str(value or "")).replace("−", "-").lstrip("+")
    if not re.fullmatch(r"-?\d+(?:\.\d+)?", text):
        return None
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return "0" if text in ("-0", "") else text


def number_zh(value: Any, measure: bool = False) -> str:
    """A number as a Mandarin speaker says it: 7684 -> 七千六百八十四, 0.77 -> 零点七七,
    10500 -> 一万零五百, 2 -> 二 (两 with measure=True: 两个, 两美元)."""
    text = _number_text(value)
    if text is None:
        return str(value)
    sign = "负" if text.startswith("-") else ""
    whole, _, frac = text.lstrip("-").partition(".")
    whole = whole.lstrip("0") or "0"
    if len(whole) > 16:  # past 万亿 it's read digit by digit, as _int_zh would, without
        out = digits_zh(whole)  # int(), which refuses more than 4,300 digits
    else:
        out = _int_zh(int(whole), measure=measure and not frac)
    if frac:
        out += "点" + "".join(_DIGITS_ZH[int(d)] for d in frac)
    return sign + out


def digits_zh(text: str) -> str:
    """Digit by digit, as years and phone numbers are read: 2026 -> 二零二六."""
    return "".join(_DIGITS_ZH[int(d)] if d.isdigit() else d for d in str(text))


def percent_zh(value: Any) -> str:
    """0.77 -> 百分之零点七七; -1.2 -> 负百分之一点二."""
    text = _number_text(value)
    if text is None:
        return f"{value}%"
    sign = "负" if text.startswith("-") else ""
    return f"{sign}百分之{number_zh(text.lstrip('-'))}"


def money_zh(value: Any, currency: str = "USD") -> str:
    """invoices.spoken_money for Chinese: 1234.5, "USD" -> 一千二百三十四点五美元."""
    code = str(currency or "USD").upper()
    return number_zh(value, measure=True) + CURRENCIES_ZH.get(code, code)


def _period_zh(hour: int, meridiem: str) -> str:
    """凌晨, 早上, 上午, 中午, 下午 or 晚上 for a 12-hour clock's AM or PM."""
    if not meridiem:
        return ""
    if meridiem.lower().startswith("p"):
        return "中午" if hour == 12 else "下午" if hour < 6 else "晚上"
    return "凌晨" if hour == 12 or hour < 5 else "早上" if hour < 9 else "上午"


def clock_zh(hour: int, minute: int = 0, meridiem: str = "", spoken: bool = True) -> str:
    """A time of day: (3, 30, "PM") -> 下午三点半 (下午3:30 unspoken); (14, 5) -> 十四点零五分."""
    period = _period_zh(hour, meridiem)
    if not spoken:
        return f"{period}{hour}:{minute:02d}" if minute else f"{period}{hour}点"
    h = "两" if hour == 2 else _int_zh(hour)
    if minute == 0:
        m = ""
    elif minute == 30:
        m = "半"
    else:
        m = ("零" if minute < 10 else "") + _int_zh(minute) + "分"
    return f"{period}{h}点{m}"


_NUM = r"\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?"
# The same below 10^21 (at most seven thousands groups), for a pattern that can fail after
# it: unbounded, a long run of "123,123,…" was read again from every group to its end.
_NUM_SHORT = r"\d{1,3}(?:,\d{3}){1,6}(?:\.\d+)?|\d+(?:\.\d+)?"
_MEASURES = (
    r"个|位|名|条|封|件|次|天|周|小时|分钟|秒钟?|年|岁|块|元|美元|欧元|英镑|日元|张|本|只|支|辆|台|部|家|"
    r"份|杯|瓶|公里|千米|英里|公斤|斤|米|倍|首|篇|项|笔|页|股|手|场|点钟|点(?!\d)|层|间|种|句|段|步|分"
)
_ISO_DATE = re.compile(r"(?<!\d)(\d{4})-(\d{1,2})-(\d{1,2})(?!\d)")
_YEAR_MONTH = re.compile(r"(?<![\d\-])(\d{4})-(0?[1-9]|1[0-2])(?![\d\-])")  # 2026-09
# Where a number may start: not inside a Latin word, a longer number or a dashed code
# (GPT-4, INV-2026-004). Chinese right before it is fine ("涨幅3-5%").
_NUMBER_START = r"(?<![A-Za-z0-9_.:\-−])"
# Nor inside a run of another script's digits (１２３, ٣٣٣): \d takes those too, and a range
# or a dashed code was otherwise tried from every one of them.
_DIGITS_START = rf"{_NUMBER_START}(?<!\d)"
# A range between two numbers: 3-5%, 3%-5%, 18~22°C, 3～5天, 10:00-11:00, 3 PM–4 PM,
# $10-20. A hyphen is one only between two numbers ("3-5", "3 - 5"): in "500 -0.77%" it
# is a minus sign. The first number takes at most seven groups, so "1,1,1,…" isn't read
# again from each digit to its end.
_RANGE = re.compile(
    rf"{_DIGITS_START}(?P<a>[$¥€£]?[-−]?\d+(?:[.,:]\d+){{0,6}})"
    r"(?P<unit>\s*(?:%|°\s*[CF]?|[AaPp]\.?[Mm]\.?(?![A-Za-z])))?"
    r"(?P<sep>\s*[~～–—]\s*|-|\s+-\s+)"
    r"(?P<b>[$¥€£]?[-−]?\d+(?:[.,:]\d+)*)(?P<pct>\s*%)?"
)
_DASHED = re.compile(_DIGITS_START + r"\d+(?:[-–]\d+)+(?![A-Za-z0-9_.])")  # 555-0100
# ~5%: about 5% ("约~5%" says 约 once).
_ABOUT = re.compile(r"(?<![A-Za-z0-9_.%°])(?:(约|大约)\s*)?[~～]\s*(?=[+\-−]?\d)")
_AMPM = re.compile(r"(?<!\d)(\d{1,2})(?::(\d{2}))?\s*([AaPp])\.?[Mm]\.?(?![A-Za-z])")
_CLOCK = re.compile(r"(?<![\d:])(\d{1,2}):(\d{2})(?![\d:])")
_YEAR = re.compile(r"(?<![\d.])(\d{4})(?=\s*(?:年|到\s*\d{4}\s*年))")
# A sign only where no number, % or ° comes right before it ("3-5%" is a range).
_PERCENT = re.compile(rf"(?<![\d%°])([+\-−]?)({_NUM_SHORT})\s*%")
_MONEY = re.compile(rf"([$¥€£])\s?({_NUM})\s*(万亿|亿|万)?")
_MONEY_SIGNS = {"$": "美元", "¥": "元", "€": "欧元", "£": "英镑"}
_TEMP = re.compile(r"(?<![\d%°])([+\-−]?\d+(?:\.\d+)?)\s*°\s*([CF])?")
_NEGATIVE_DEGREES = re.compile(_NUMBER_START + r"[-−](\d+(?:\.\d+)?)(?=\s*度)")  # -5度
_NEGATIVE = re.compile(_NUMBER_START + r"[-−](?=\d)")
_ORDINAL = re.compile(r"第\s*(\d+)")
_BIG = re.compile(r"(?<![\d.,])(\d+(?:\.\d+)?)\s*(万亿|亿|万|千)")
_MEASURED = re.compile(
    rf"(?<![\d.,])(\d{{1,3}}(?:,\d{{3}})+|\d+)(?=\s*(?:到\s*\d[\d,.]*\s*)?(?:{_MEASURES}))"
)
_PLAIN = re.compile(rf"(?<![A-Za-z0-9.\-_])({_NUM})(?![A-Za-z0-9_]|\.\d)")


def _degrees_zh(value: Any, fahrenheit: bool = False) -> str:
    text = _number_text(value)
    if text is None:
        return f"{value}度"
    body = number_zh(text.lstrip("-")) + "度"
    if text.startswith("-"):
        body = "零下" + body
    return "华氏" + body if fahrenheit else body


def _plain_zh(m: re.Match[str]) -> str:
    digits = m.group(1)
    whole = digits.split(".")[0]
    if "," not in digits and (len(whole) >= 9 or (len(whole) > 1 and whole.startswith("0"))):
        return digits_zh(digits)  # a phone number, an ID, "007"
    return number_zh(digits)


def _phone_like(a: str, b: str) -> bool:
    """Digit groups of a phone number (555-0100, 010-12345678, 555-1234), not a range."""
    if not (a.isdigit() and b.isdigit()):
        return False
    leading_zero = (len(a) > 1 and a[0] == "0") or (len(b) > 1 and b[0] == "0")
    return leading_zero or (len(a) == 3 and len(b) == 4) or len(b) >= 7


def _range_zh(m: re.Match[str]) -> str:
    """3-5% -> 3%到5%, 18~22°C -> 18到22°C, $10-20 -> $10到$20: the words come later."""
    a, unit, b, pct = m.group("a"), m.group("unit") or "", m.group("b"), m.group("pct") or ""
    if _phone_like(a, b) or re.match(r"\s*[-–]\s*\d", m.string[m.end() :]):
        return m.group()  # a phone number, or 1-2-3: not a range
    if pct and not unit:
        unit = "%"  # 3-5%: three to five percent
    if a[0] in "-−" and re.match(r"\s*(?:°|度)", m.string[m.end() :]):
        a = "零下" + a[1:]  # -5~3°C: 零下五到三度
    signs = "$¥€£"
    if a[0] in signs and b[0] not in signs:
        b = a[0] + b
    elif b[0] in signs and a[0] not in signs:
        a = b[0] + a
    return f"{a}{unit}到{b}{pct}"


def spoken_numbers_zh(text: str) -> str:
    """Numbers in a Chinese sentence as they're said: 下跌0.77% -> 下跌百分之零点七七,
    7,684点 -> 七千六百八十四点, $1.2万亿 -> 一点二万亿美元, 2026年 -> 二零二六年,
    下午3:30 -> 下午三点半, 2个 -> 两个, 第2 -> 第二, and ranges with 到: 3-5% ->
    百分之三到百分之五, 18~22°C -> 十八到二十二度. Digits inside Latin words (US10Y,
    GPT4, GPT-4) are left alone; a phone number is read digit by digit."""
    text = _ISO_DATE.sub(
        lambda m: (
            f"{digits_zh(m.group(1))}年{_int_zh(int(m.group(2)))}月{_int_zh(int(m.group(3)))}日"
        ),
        text or "",
    )
    text = _YEAR_MONTH.sub(lambda m: f"{digits_zh(m.group(1))}年{_int_zh(int(m.group(2)))}月", text)
    text = _RANGE.sub(_range_zh, text)
    text = _DASHED.sub(lambda m: digits_zh(m.group()), text)
    text = _ABOUT.sub(lambda m: m.group(1) or "约", text)
    text = _AMPM.sub(
        lambda m: clock_zh(int(m.group(1)), int(m.group(2) or 0), m.group(3) + "m"), text
    )
    text = _CLOCK.sub(lambda m: clock_zh(int(m.group(1)), int(m.group(2))), text)
    text = _YEAR.sub(lambda m: digits_zh(m.group(1)), text)
    text = _PERCENT.sub(
        lambda m: ("负" if m.group(1) in ("-", "−") else "") + percent_zh(m.group(2)), text
    )
    text = _MONEY.sub(
        lambda m: (
            number_zh(m.group(2), measure=True) + (m.group(3) or "") + _MONEY_SIGNS[m.group(1)]
        ),
        text,
    )
    text = _TEMP.sub(lambda m: _degrees_zh(m.group(1).replace("−", "-"), m.group(2) == "F"), text)
    text = _NEGATIVE_DEGREES.sub(lambda m: "零下" + number_zh(m.group(1)), text)
    text = _NEGATIVE.sub("负", text)
    text = _ORDINAL.sub(lambda m: "第" + number_zh(m.group(1)), text)
    text = _BIG.sub(lambda m: number_zh(m.group(1), measure=True) + m.group(2), text)
    text = _MEASURED.sub(lambda m: number_zh(m.group(1), measure=True), text)
    return _PLAIN.sub(_plain_zh, text)


# ── the markets and the weather ──

INDEX_NAMES_ZH = {
    "S&P 500": "标普500",
    "Nasdaq": "纳斯达克",
    "Dow": "道琼斯",
    "Russell 2000": "罗素2000",
}
MACRO_NAMES_ZH = {
    "10-yr": "十年期美债收益率",
    "VIX": "VIX恐慌指数",
    "Oil": "原油",
    "Gold": "黄金",
    "Bitcoin": "比特币",
}


def _pct(value: float) -> str:
    return f"{'+' if value >= 0 else '−'}{abs(value):.2f}%"


def headline_zh(indices: list[dict[str, Any]], watch: list[dict[str, Any]], status: str) -> str:
    """markets.headline in Chinese: the panel's line (digits kept, for reading)."""
    if not indices:
        return "现在没有市场数据。"
    spx = indices[0]
    moves = "，".join(
        f"{INDEX_NAMES_ZH.get(i['name'], i['name'])} {_pct(i['pct'])}" for i in indices[:3]
    )
    mood = "上涨" if spx["pct"] > 0.15 else "下跌" if spx["pct"] < -0.15 else "基本持平"
    when = "美股目前" if status == "open" else "美股收盘"  # before the open: yesterday's close
    line = f"{when}{mood}：{moves}。"
    if watch:
        best = max(watch, key=lambda q: q["pct"])
        worst = min(watch, key=lambda q: q["pct"])
        if best["pct"] > 0:
            line += f"自选股领涨：{best['symbol']} {_pct(best['pct'])}。"
        if worst["pct"] < 0 and worst is not best:
            line += f"领跌：{worst['symbol']} {_pct(worst['pct'])}。"
    return line


def _moves_spoken(line: str) -> str:
    return re.sub(
        r"\s*([+−\-])(\d+(?:\.\d+)?)%",
        lambda m: f"{'上涨' if m.group(1) == '+' else '下跌'}{percent_zh(m.group(2))}",
        line,
    )


def markets_spoken_zh(summary: dict[str, Any] | None) -> str:
    """markets.spoken in Chinese: the summary as JARVIS says it, numbers in words."""
    if not summary or not summary.get("indices"):
        return "我暂时拿不到市场数据。"
    line = headline_zh(
        summary["indices"], summary.get("watchlist") or [], summary.get("status", "closed")
    )
    parts = [spoken_numbers_zh(_moves_spoken(line))]
    macro = {m["name"]: m for m in summary.get("macro", [])}
    if "10-yr" in macro:
        rate = percent_zh(f"{macro['10-yr']['last']:.2f}")
        parts.append(f"十年期美债收益率为{rate}。")
    if "Bitcoin" in macro:
        btc = macro["Bitcoin"]
        price = number_zh(round(btc["last"]), measure=True)
        move = ("上涨" if btc["pct"] >= 0 else "下跌") + percent_zh(f"{abs(btc['pct']):.1f}")
        parts.append(f"比特币报{price}美元，{move}。")
    return "".join(parts)


# weather.CODES in Chinese.
CODES_ZH = {
    0: "晴", 1: "大致晴朗", 2: "局部多云", 3: "阴天", 45: "有雾", 48: "有雾", 51: "小毛毛雨", 53: "毛毛雨",
    55: "较强的毛毛雨", 61: "小雨", 63: "中雨", 65: "大雨", 66: "冻雨", 67: "冻雨", 71: "小雪", 73: "中雪",
    75: "大雪", 77: "米雪", 80: "阵雨", 81: "阵雨", 82: "强阵雨", 85: "阵雪", 86: "阵雪", 95: "雷阵雨",
    96: "雷阵雨伴有冰雹", 99: "雷阵雨伴有冰雹",
}  # fmt: skip


def weather_summary_zh(w: dict[str, Any] | None) -> str:
    """The sky in Chinese, from the WMO code, or from the English word (next_hours)."""
    if not w:
        return ""
    try:
        code = int(w["code"]) if w.get("code") is not None else None
    except (TypeError, ValueError):
        code = None
    if code in CODES_ZH:
        return CODES_ZH[code]
    from .weather import CODES

    english = str(w.get("summary") or "")
    return next((CODES_ZH[k] for k, v in CODES.items() if v == english and k in CODES_ZH), english)


def _place_zh(w: dict[str, Any]) -> str:
    city = str(w.get("city") or "").strip()
    if city in ("", "Here", "here"):
        return "这里"
    return f"{city} " if city[-1].isascii() else city  # "Berkeley 现在…"


def _temp(w: dict[str, Any], key: str, spoken: bool, source: dict[str, Any] | None = None) -> str:
    value = (source or w).get(key)
    unit = str(w.get("unit") or "°C")
    if spoken:
        return _degrees_zh(value, "F" in unit)
    return f"{value}{unit}"


def weather_line_zh(w: dict[str, Any] | None) -> str:
    """livecontext.weather_line in Chinese (digits kept, for reading)."""
    if not w or w.get("error") or w.get("temp") is None:
        return ""
    unit = w.get("unit", "")
    parts = [f"{w['temp']}{unit}，{weather_summary_zh(w)}"]
    if w.get("feels") is not None and w.get("feels") != w.get("temp"):
        parts.append(f"体感{w['feels']}{unit}")
    if w.get("high") is not None and w.get("low") is not None:
        parts.append(f"最高{w['high']}，最低{w['low']}")
    if w.get("rain_chance") is not None:
        parts.append(f"今天降雨概率{w['rain_chance']}%")
    hours = "、".join(
        f"{h['time']} {h['temp']}°" + (f"（降雨{h['rain']}%）" if h.get("rain") else "")
        for h in (w.get("next_hours") or [])[:4]
    )
    if hours:
        parts.append(f"接下来几小时：{hours}")
    t = w.get("tomorrow") or {}
    if t:
        parts.append(
            f"明天{weather_summary_zh(t)}，最高{t.get('high')}，最低{t.get('low')}，"
            f"降雨概率{t.get('rain_chance')}%"
        )
    return f"{_place_zh(w)}现在的天气：" + "；".join(p for p in parts if p)


def weather_spoken_zh(w: dict[str, Any] | None, tomorrow: bool = False) -> str:
    """The weather as JARVIS says it in Chinese: now, today's range and rain chance
    (and tomorrow's), every number in words."""
    if not w:
        return ""
    if w.get("error"):
        return translate(str(w["error"]))
    if w.get("temp") is None:
        return ""
    now = f"{_place_zh(w)}现在{_temp(w, 'temp', True)}，{weather_summary_zh(w)}"
    if w.get("feels") is not None and w.get("feels") != w.get("temp"):
        now += f"，体感{_temp(w, 'feels', True)}"
    text = now + "。"
    if w.get("high") is not None and w.get("low") is not None:
        today = f"今天最高{_temp(w, 'high', True)}，最低{_temp(w, 'low', True)}"
        if w.get("rain_chance") is not None:
            today += f"，降雨概率{percent_zh(w['rain_chance'])}"
        text += today + "。"
    t = w.get("tomorrow") or {}
    if tomorrow and t and t.get("high") is not None:
        text += (
            f"明天{weather_summary_zh(t)}，最高{_temp(w, 'high', True, t)}，"
            f"最低{_temp(w, 'low', True, t)}"
        )
        if t.get("rain_chance") is not None:
            text += f"，降雨概率{percent_zh(t['rain_chance'])}"
        text += "。"
    return text


# ── what JARVIS says itself ──

# The strings the backend shows or says, in Chinese, keyed by the English. A key with
# {slots} is the English f-string's template: translate() recognizes the finished English
# sentence and fills the Chinese one; tr() takes the template and the values directly.
ZH_TEXTS: dict[str, str] = {
    # hub.TOOL_LABELS: the activity drawer.
    "Opened an app": "打开了一个应用",
    "Opened a web page": "打开了一个网页",
    "Arranged a window": "调整了窗口",
    "Quit an app": "退出了一个应用",
    "Checked the time and battery": "查看了时间和电量",
    "Controlled music": "控制了音乐",
    "Checked what's playing": "查看了正在播放的内容",
    "Changed the volume": "调整了音量",
    "Saved a note": "保存了一条备忘录",
    "Listed Shortcuts": "列出了快捷指令",
    "Ran a Shortcut": "运行了快捷指令",
    "Read your inbox": "读取了收件箱",
    "Drafted an email": "起草了一封邮件",
    "Checked your calendar": "查看了日历",
    "Found open times": "找到了空闲时段",
    "Added a calendar event": "添加了日历事件",
    "Changed a calendar event": "修改了日历事件",
    "Removed a calendar event": "删除了日历事件",
    "Started Jarvis Code": "启动了 Jarvis Code",
    "Started research": "开始了研究",
    "Checked background tasks": "查看了后台任务",
    "Messaged Jarvis Code": "给 Jarvis Code 发了消息",
    "Stopped Jarvis Code": "停止了 Jarvis Code",
    "Listed Jarvis Code sessions": "列出了 Jarvis Code 会话",
    "Resumed a Jarvis Code session": "恢复了一个 Jarvis Code 会话",
    "Opened a page in the browser": "在浏览器中打开了网页",
    "Read the browser page": "读取了浏览器页面",
    "Clicked in the browser": "在浏览器中点击了",
    "Typed in the browser": "在浏览器中输入了内容",
    "Scrolled the browser": "滚动了浏览器",
    "Went back in the browser": "浏览器后退了一页",
    "Looked at the browser page": "查看了浏览器页面",
    "Searched your second brain": "搜索了第二大脑",
    "Read a note": "读取了一条笔记",
    "Checked the second brain": "查看了第二大脑",
    "Switched models": "切换了模型",
    "Adjusted personality": "调整了个性",
    "Changed hands-free mode": "更改了免提模式",
    "Checked your location": "查看了你的位置",
    "Checked the weather": "查看了天气",
    "Checked traffic": "查看了路况",
    "Looked at your screen": "查看了你的屏幕",
    "Clicked": "点击了",
    "Pressed a button": "按下了按钮",
    "Typed": "输入了内容",
    "Pressed keys": "按了按键",
    "Scrolled": "滚动了",
    "Searched your files": "搜索了你的文件",
    "Read a file": "读取了一个文件",
    "Checked the browser": "查看了浏览器",
    "Searched the web": "搜索了网络",
    "Read a web page": "读取了一个网页",
    "Searched the research desk": "搜索了研究台",
    "Listed BSH companies": "列出了 BSH 的公司",
    "Opened a company profile": "打开了公司档案",
    "Checked the decision ledger": "查看了决策台账",
    "Checked the portfolio": "查看了投资组合",
    "Checked a signal score": "查看了信号评分",
    "Read a transcript": "读取了一份文字记录",
    "Read reference calls": "读取了背景调查通话",
    # hub.FILLERS
    "One moment.": "稍等。",
    "On it.": "这就办。",
    "Let me check.": "我查一下。",
    # hub: why a card asks, and the gates' questions
    "This request came from a routine or a shortcut, not from your own words, so I check before anything leaves the Mac.": "这个请求来自例行任务或快捷指令，不是你亲口说的，所以在任何内容离开这台 Mac 之前我会先确认。",
    "Earlier in this request: {seen}. An address or request like this can carry some of that out, so check it before you allow it.": "这个请求之前：{seen}。这样的网址或请求可能把其中一些内容带出去，允许之前请先核对。",
    "Earlier in this request: {seen}. Pages can hide instructions, and you didn't name this site yourself, so check it before you allow it.": "这个请求之前：{seen}。网页里可能藏着指令，而且这个网站不是你自己说的，允许之前请先核对。",
    "Start background research on this topic?": "要在后台研究这个主题吗？",
    "Research topic:\n“{topic}”\n\n{why}": "研究主题：\n“{topic}”\n\n{why}",
    "Can I start background research on the topic on your screen?": "我可以在后台研究屏幕上的这个主题吗？",
    "Open {site} in your browser?": "要在你的浏览器中打开 {site} 吗？",
    "Can I open {site} in your browser?": "我可以在你的浏览器中打开 {site} 吗？",
    "Open {site} in the built-in browser?": "要在内置浏览器中打开 {site} 吗？",
    "Can I open {site} in the built-in browser?": "我可以在内置浏览器中打开 {site} 吗？",
    "Fetch a page from {site}?": "要从 {site} 获取一个网页吗？",
    "Can I fetch a page from {site}?": "我可以从 {site} 获取一个网页吗？",
    # browser_gate: typing, pressing, scripts and uploads in the built-in browser
    "Type into {site} in the built-in browser?": "要在内置浏览器里往 {site} 输入内容吗？",
    "Can I type into {site} in the built-in browser?": "我可以在内置浏览器里往 {site} 输入内容吗？",
    "Use {site} in the built-in browser?": "要在内置浏览器里操作 {site} 吗？",
    "Can I use {site} in the built-in browser?": "我可以在内置浏览器里操作 {site} 吗？",
    "Run a script on {site} in the built-in browser?": "要在内置浏览器里对 {site} 运行脚本吗？",
    "Can I run a script on {site} in the built-in browser?": "我可以在内置浏览器里对 {site} 运行一段脚本吗？",
    "Upload a file to {site}?": "要把文件上传到 {site} 吗？",
    "Can I upload a file from your Mac to {site}?": "我可以把你 Mac 上的文件上传到 {site} 吗？",
    "Earlier in this request: {seen}. What I type or press there can carry some of that off the Mac, and you didn't name this site yourself, so check it before you allow it.": "这个请求之前：{seen}。我在那里输入或点按的内容可能把其中一些带出这台 Mac，而且这个网站不是你自己说的，允许之前请先核对。",
    "Earlier in this conversation: {seen}. What I type or press there can carry some of that off the Mac, and you didn't name this site yourself, so check it before you allow it.": "这次对话之前：{seen}。我在那里输入或点按的内容可能把其中一些带出这台 Mac，而且这个网站不是你自己说的，允许之前请先核对。",
    "Earlier in this request: {seen}. A script can send some of that to any site, so check it before you allow it.": "这个请求之前：{seen}。脚本可以把其中一些发送到任何网站，允许之前请先核对。",
    "Earlier in this conversation: {seen}. A script can send some of that to any site, so check it before you allow it.": "这次对话之前：{seen}。脚本可以把其中一些发送到任何网站，允许之前请先核对。",
    "Earlier in this request: {seen}. An address like this can carry some of that out, so check it before you allow it.": "这个请求之前：{seen}。这样的网址可能把其中一些带出去，允许之前请先核对。",
    "Earlier in this conversation: {seen}. An address like this can carry some of that out, so check it before you allow it.": "这次对话之前：{seen}。这样的网址可能把其中一些带出去，允许之前请先核对。",
    "A file from your Mac goes to this site with it, so check it before you allow it.": "你 Mac 上的文件会随之发送到这个网站，允许之前请先核对。",
    "You didn't ask for this in your own words (or name the project) just now.": "你刚才没有亲口提出这个请求（也没有说出项目名）。",
    "Start Jarvis Code in {folder}?": "要在 {folder} 中启动 Jarvis Code 吗？",
    "Can I start a coding session in {folder} for this?": "我可以为此在 {folder} 中开一个编程会话吗？",
    "Folder: {path}": "文件夹：{path}",
    "First request: {request}": "第一个请求：{request}",
    "Pass this request to Jarvis Code in {folder}?": "要把这个请求转给 {folder} 中的 Jarvis Code 吗？",
    "Can I pass a request to the coding session in {folder}?": "我可以把一个请求转给 {folder} 中的编程会话吗？",
    "To the session in {path}:": "发给 {path} 中的会话：",
    "Voice-code with Jarvis Code in {folder}?": "要在 {folder} 中用 Jarvis Code 语音编程吗？",
    "Can I switch you to voice coding in {folder} now?": "现在可以把你切换到 {folder} 的语音编程吗？",
    "Everything you say next goes to the session in {path}, until you say “exit code mode”.": "接下来你说的每句话都会发给 {path} 中的会话，直到你说“exit code mode”。",
    "Here's what I'd tell the coding session in {folder}: {text} Do you want this passed on?": "我会这样告诉 {folder} 中的编程会话：{text} 要转达吗？",
    "I'd like to give the coding session in {folder} a message. It's on your screen: do you want this passed on?": "我想给 {folder} 中的编程会话发一条消息。内容在你的屏幕上：要转达吗？",
    "You didn't ask to message this session in your own words just now.": "你刚才没有亲口要求给这个会话发消息。",
    "Send this to Jarvis Code in {folder}?": "要把这个发给 {folder} 中的 Jarvis Code 吗？",
    "To session {id} in {path}:": "发给 {path} 中的会话 {id}：",
    # hub: approval cards and what's said with them
    "Allow": "允许",
    "Not now": "暂不",
    "Send": "发送",
    "Don't send": "不发送",
    "Run": "运行",
    "Always": "始终",
    "I need your OK on screen.": "请在屏幕上确认一下。",
    "It's on your screen. Do you want it sent as it is?": "内容在你的屏幕上。要按原样发送吗？",
    "Let me use your mouse and keyboard for this request?": "这个请求可以让我用你的鼠标和键盘吗？",
    "I'll look at the screen, click and type until this request is done. Tap the orb or press Esc to stop me.": "我会看着屏幕点击和输入，直到完成这个请求。点一下光球或按 Esc 就能让我停下。",
    "Run the shortcut “{shortcut}”?": "要运行快捷指令“{shortcut}”吗？",
    "“Always” makes it instant: saying its name runs it straight away.": "选“始终”会让它变成即时指令：说出它的名字就直接运行。",
    "Click “{label}” in the browser?": "要在浏览器里点击“{label}”吗？",
    "The user said no. Don't click it.": "好的，没有点。",
    "Done.": "好了。",
    "The shortcut {shortcut} didn't work: {error}": "快捷指令{shortcut}没有成功：{error}",
    # hub: meeting notes
    "Already taking notes for {title}.": "已经在为{title}做记录了。",
    "I can't hear the room: the microphone isn't available.": "我听不到房间里的声音：麦克风用不了。",
    "Taking notes for {title}. Everything said is transcribed here on the Mac until the user says stop.": "正在为{title}做记录。在用户说停之前，所有对话都会在这台 Mac 上转写。",
    "No meeting notes were running.": "当前没有在做会议记录。",
    "Stopped. Too little was said to summarize; the transcript is saved.": "已停止。内容太少，没法总结；文字记录已保存。",
    "Stopped. The transcript is saved, but the write-up failed: {error}": "已停止。文字记录已保存，但整理纪要失败了：{error}",
    "Notes for {title} saved to the second brain: {decisions} decisions and {actions} action items, {minutes} minutes.": "{title}的记录已存入第二大脑：{decisions}项决定、{actions}项待办，时长{minutes}分钟。",
    "Notes for {title} saved to the second brain: {decisions} decisions and {actions} action items, {minutes} minutes. Offer to read the action items.": "{title}的记录已存入第二大脑：{decisions}项决定、{actions}项待办，时长{minutes}分钟。可以主动提出读一下待办事项。",
    "Meeting notes": "会议记录",
    "Routine · {routine}": "例行任务 · {routine}",
    "Morning briefing": "晨间简报",
    "What's this?": "这是什么？",
    # hub: errors and notices
    "Something went wrong: {error}": "出了点问题：{error}",
    "Claude stopped: {detail}": "Claude 停止了：{detail}",
    "I couldn't use the microphone: {error}": "我用不了麦克风：{error}",
    "Hands-free couldn't open the microphone: {error}": "免提模式打不开麦克风：{error}",
    "The terminal didn't start: {error}": "终端没能启动：{error}",
    "There are no past sessions in {folder}.": "{folder} 里没有过去的会话。",
    "I couldn't tell which. The latest are: {titles}.": "我分不清是哪一个。最近的几个是：{titles}。",
    "Back in {title}. What next?": "回到了{title}。接下来做什么？",
    "No file changes yet in this session.": "这个会话还没有改动任何文件。",
    "{n} file changed: {names}.": "{n}个文件有改动：{names}。",
    "{n} files changed: {names}.": "{n}个文件有改动：{names}。",
    "Which project? {projects}": "哪个项目？{projects}",
    "From the BSH desk": "来自 BSH 研究台",
    "Open the research center to see this record in full.": "打开研究中心可以查看这条记录的全文。",
    "The Research Center only opens in the J.A.R.V.I.S. app window.": "研究中心只能在 J.A.R.V.I.S. 应用窗口里打开。",
    "The Research Center didn't answer in time.": "研究中心没有及时响应。",
    "That didn't work.": "没有成功。",
    "The built-in browser is only in the J.A.R.V.I.S. app window.": "内置浏览器只在 J.A.R.V.I.S. 应用窗口里。",
    "The browser didn't answer in time.": "浏览器没有及时响应。",
    "No project folder.": "没有项目文件夹。",
    "(stopped after {seconds} seconds)": "（{seconds}秒后已停止）",
    "No market data right now.": "现在没有市场数据。",
    "I couldn't get market data just now.": "我暂时拿不到市场数据。",
    "Nothing to save yet": "还没有可保存的内容",
    "Conversation saved": "对话已保存",
    "{file} in Documents › Jarvis › Conversations": "{file}，位于 文稿 › Jarvis › Conversations",
    "Research ready": "研究完成",
    "Your research on {topic} is ready.": "你关于“{topic}”的研究已经完成了。",
    "Jarvis Code finished in {folder}.": "Jarvis Code 在 {folder} 中完成了。",
    "Jarvis Code stopped in {folder}.": "Jarvis Code 在 {folder} 中停下了。",
    "Jarvis Code finished in {folder}. {result}": "Jarvis Code 在 {folder} 中完成了。{result}",
    "Jarvis Code needs you": "Jarvis Code 需要你",
    "Jarvis Code in {folder} needs your OK to {verb}.": "{folder} 中的 Jarvis Code 需要你同意才能{verb}。",
    "{n} more heads-ups are on screen.": "还有{n}条提醒在屏幕上。",
    "Saved the transcript to {file}.": "对话记录已保存到 {file}。",
    "The J.A.R.V.I.S. window isn't open.": "J.A.R.V.I.S. 窗口没有打开。",
    "No location fix yet.": "还没有定位到位置。",
    "I don't have a location fix. Location Services may be off for J.A.R.V.I.S.": "我还没有定位。可能没有为 J.A.R.V.I.S. 打开定位服务。",
    "No weather: set a city in Settings or allow location.": "没有天气信息：请在设置里填写城市，或者允许定位。",
    "I need your location for that; allow Location Services for J.A.R.V.I.S.": "这需要你的位置；请为 J.A.R.V.I.S. 打开定位服务。",
    "I couldn't find that place.": "我找不到这个地方。",
    "Hands-free is on.": "免提模式已开启。",
    "Hands-free is off.": "免提模式已关闭。",
    "Switching to {model} from your next request.": "从你的下一个请求开始切换到 {model}。",
    # brain.describe_action: what the permission policy asks
    "Add “{title}” to your calendar at {start} for {minutes} minutes?": "要把“{title}”加到日历吗？时间 {start}，时长{minutes}分钟。",
    "Add “{title}” to your calendar at {start} for {minutes} minutes at {place}?": "要把“{title}”加到日历吗？时间 {start}，时长{minutes}分钟，地点：{place}。",
    "Remove “{title}”, {when}, from the {calendar} calendar?": "要从“{calendar}”日历删除“{title}”吗？时间：{when}。",
    "Remove the all-day “{title}”, {when}, from the {calendar} calendar?": "要从“{calendar}”日历删除全天日程“{title}”吗？日期：{when}。",
    "Change “{title}”, {when}, on the {calendar} calendar?": "要修改“{calendar}”日历中的“{title}”吗？时间：{when}。",
    "Title → “{title}”": "标题 → “{title}”",
    "Time → {when}": "时间 → {when}",
    "Length → {minutes} minutes": "时长 → {minutes}分钟",
    "Location → “{place}”": "地点 → “{place}”",
    "Clear the location": "清除地点",
    "It repeats: only this one changes.": "这是重复日程：只修改这一次。",
    "It repeats: this one and every later one change.": "这是重复日程：这一次和之后的都会修改。",
    "Others are in it ({people}): they'll see the change.": "还有其他人参加（{people}）：他们会看到改动。",
    "It's an invitation; your change may apply only to your copy.": "这是一封邀请；你的改动可能只对你这边生效。",
    "It repeats: only this one goes.": "这是重复日程：只删除这一次。",
    "It repeats: this one and every later one go.": "这是重复日程：这一次和之后的都会删除。",
    "Others are in it ({people}): they may be told it's cancelled.": "还有其他人参加（{people}）：他们可能会收到取消通知。",
    "It's {organizer}'s invitation: they may be told you declined.": "这是{organizer}发来的邀请：对方可能会收到你谢绝的通知。",
    "It's an invitation: its organizer may be told you declined.": "这是别人发来的邀请：组织者可能会收到你谢绝的通知。",
    "Quit {app}?": "要退出 {app} 吗？",
    "Start Jarvis Code in {folder} to: {task}?": "要在 {folder} 中启动 Jarvis Code 来做这件事吗：{task}？",
    "Reopen a past Jarvis Code session in {folder}?": "要重新打开 {folder} 中过去的 Jarvis Code 会话吗？",
    "Fetch {site}?": "要获取 {site} 吗？",
    "Start background research on: {topic}?": "要在后台研究这个主题吗：{topic}？",
    "Voice-code with Jarvis Code in {folder} and send it: {request}?": "要在 {folder} 中用 Jarvis Code 语音编程，并发送：{request}吗？",
    "Send Jarvis Code session {id} this: “{message}”?": "要把这句话发给 Jarvis Code 会话 {id} 吗：“{message}”？",
    "Allow {tool}?": "要允许 {tool} 吗？",
    # tasks.py: Jarvis Code's own cards
    "Jarvis Code in {folder} wants to {verb}": "{folder} 中的 Jarvis Code 想要{verb}",
    "Jarvis Code in {folder} has a plan": "{folder} 中的 Jarvis Code 做好了计划",
    "run a command": "运行一条命令",
    "read a page on {domain}": "读取 {domain} 上的网页",
    "use the browser": "使用浏览器",
    "type into {host}": "在 {host} 里输入内容",
    "open {host} in the browser": "在浏览器中打开 {host}",
    "click on {host}": "在 {host} 上点按",
    "use the iOS Simulator": "使用 iOS 模拟器",
    "edit a file": "编辑一个文件",
    "edit a file outside the project": "编辑项目之外的文件",
    "read outside the project": "读取项目之外的内容",
    "use {tool}": "使用 {tool}",
    "Yes": "是",
    "Yes, allow all edits this session": "是，本次会话允许所有编辑",
    "Yes, and don't ask again for {rule} commands in {folder}": "是，并且在 {folder} 中不再询问 {rule} 命令",
    "No, and tell Claude what to do differently": "否，并告诉 Claude 换个做法",
    "Go, auto-accept edits": "开始，自动接受编辑",
    "Go, ask before edits": "开始，编辑前先问我",
    "Keep planning": "继续规划",
    "Skip": "跳过",
    # research.py
    "Back.": "返回。",
    "Forward.": "前进。",
    "Closed the Research Center.": "已关闭研究中心。",
    "Opening {name}.": "正在打开{name}。",
    "Press “{label}” in the Research Center?": "要在研究中心里按“{label}”吗？",
    "The user said no. Don't press it.": "好的，没有按。",
    # ui.py
    "Closed {name}.": "已关闭{name}。",
    "Opened {name}.": "已打开{name}。",
    "Switched to {name}.": "已切换到{name}。",
    "Hand control on.": "手势控制已开启。",
    "Hand control off.": "手势控制已关闭。",
    # messaging.py
    "Send this to {person}?": "要把这条发给{person}吗？",
    "To {shown}:\n“{text}”": "发给 {shown}：\n“{text}”",
    "Here's your message to {person}. {text} Do you want this message sent?": "这是你发给{person}的消息：{text} 要发送这条消息吗？",
    "Email {person} about {subject}?": "要给{person}发一封关于“{subject}”的邮件吗？",
    "To {shown}\nSubject: {subject}\n\n{body}": "收件人：{shown}\n主题：{subject}\n\n{body}",
    "Here's your email to {person}, subject: {subject} {body} Do you want this email sent?": "这是你发给{person}的邮件，主题：{subject} {body} 要发送这封邮件吗？",
    "(no subject)": "（无主题）",
    "There's nothing to send.": "没有要发送的内容。",
    "The user said no. It wasn't sent.": "用户说了不，没有发送。",
    "Messages couldn't send it: {error}": "信息应用没能发送：{error}",
    "Sent to {person}.": "已发送给{person}。",
    "The email has no body.": "这封邮件没有正文。",
    "Mail couldn't send it: {error}": "邮件应用没能发送：{error}",
    "Emailed {person}.": "已给{person}发了邮件。",
    "No one by that name in Contacts.": "通讯录里没有叫这个名字的人。",
    "I couldn't search Contacts: {error}": "我没法搜索通讯录：{error}",
    "There's no one called {person} in Contacts. Ask for their number or address.": "通讯录里没有叫{person}的人。请问一下对方的号码或地址。",
    "Several people match {person}: {names}. Ask the user which one.": "有好几个人和{person}匹配：{names}。请问用户是哪一位。",
    "{person} has no email address in Contacts.": "通讯录里{person}没有邮箱地址。",
    "{person} has no phone number in Contacts.": "通讯录里{person}没有电话号码。",
    # invoices.py: the PDF, the Mail draft and the tools' answers
    "Invoice": "发票",
    "Issued": "开票日期",
    "Due": "到期日",
    "Billed to": "收票方",
    "Description": "项目",
    "Qty": "数量",
    "Rate": "单价",
    "Amount": "金额",
    "Subtotal": "小计",
    "Tax ({rate}%)": "税（{rate}%）",
    "Amount due": "应付金额",
    "Notes": "备注",
    "Payment": "付款方式",
    "Thank you for your business.": "感谢惠顾。",
    "Invoice {number}": "发票 {number}",
    "Invoice {number} from {business}": "来自{business}的发票 {number}",
    "Hello,": "你好，",
    "Please find attached invoice {number} for {amount}, due {due}.": "附件是发票 {number}，金额 {amount}，到期日 {due}。",
    "Thank you.": "谢谢。",
    "An invoice needs at least one line: a description, a quantity and a price.": "发票至少要有一行：项目、数量和价格。",
    "Each line needs a description, a quantity and a unit price.": "每一行都需要项目、数量和单价。",
    "I couldn't read the numbers on “{line}”.": "我看不懂“{line}”上的数字。",
    "The line “{line}” needs a quantity above zero and a price.": "“{line}”这一行需要大于零的数量和价格。",
    "Who is the invoice for?": "这张发票开给谁？",
    "The currency should be a three-letter code like USD.": "币种应该是像 USD 这样的三个字母代码。",
    "INV-{number} for {client}: {total}, due {due}. Saved as {file} in Documents › Jarvis › Invoices.": "INV-{number}，开给{client}：{total}，到期日 {due}。已保存为 文稿 › Jarvis › Invoices 中的 {file}。",
    "INV-{number} for {client}: {total}, due {due}. Saved as {file} in Documents › Jarvis › Invoices. (Your business details aren't set: add them in Settings › Invoices.)": "INV-{number}，开给{client}：{total}，到期日 {due}。已保存为 文稿 › Jarvis › Invoices 中的 {file}。（你的公司信息还没设置：请在 设置 › 发票 中填写。）",
    "I can't find that invoice's file.": "我找不到这张发票的文件。",
    "The recipient needs to be an email address.": "收件人需要是一个邮箱地址。",
    "The draft for {number} is open in Mail for you to check and send.": "{number} 的草稿已在邮件里打开，你检查后就可以发送。",
    "No invoices yet.": "还没有发票。",
    "I can't find that invoice.": "我找不到这张发票。",
    "INV-{number} is marked {status}.": "INV-{number} 已标记为{status}。",
    # proactive.py: heads-ups (card titles and what's said)
    "{title} starts in {n} minute.": "{title}还有{n}分钟开始。",
    "{title} starts in {n} minutes.": "{title}还有{n}分钟开始。",
    "You'll be a little late for {title}: it's {minutes} minutes to {place} with current traffic, and it starts at {time}.": "去{title}可能会晚一点：按现在的路况到{place}要{minutes}分钟，而它{time}就开始了。",
    "Time to leave for {title}. It's {minutes} minutes to {place} with current traffic, and it starts at {time}.": "该出发去{title}了。按现在的路况到{place}要{minutes}分钟，{time}开始。",
    "Leave for {title}": "出发去{title}",
    "Battery at 5%": "电量5%",
    "Battery's at {pct} percent. Plug in soon or I'll be taking an unscheduled nap.": "电量只剩百分之{pct}了。快插上电源，不然我就要意外打个盹了。",
    "Battery low": "电量低",
    "Battery's down to {pct} percent.": "电量降到百分之{pct}了。",
    "Rain on the way": "快下雨了",
    "Rain's likely around {time}, {rain} percent chance. Might want an umbrella.": "{time}左右可能下雨，降雨概率百分之{rain}。最好带把伞。",
    "Email from {sender}": "{sender}的邮件",
    "Email from {sender}: {subject}.": "{sender}发来邮件：{subject}。",
    # Instant Mac commands (last: the specific phrases above win over these patterns)
    "Opening {app}.": "正在打开{app}。",
    "Quitting {app}.": "正在退出{app}。",
    "Hid {app}.": "已隐藏{app}。",
    "Switched to {app}.": "已切换到{app}。",
    "Welcome home.": "欢迎回家。",
    "Welcome home, {name}.": "欢迎回家，{name}。",
    "Mission Control.": "调度中心。",
    "Scrolled.": "已滚动。",
    "Louder.": "调大了。",
    "Quieter.": "调小了。",
    "Muted.": "已静音。",
    "Sound's back.": "声音恢复了。",
    "Volume {level}%.": "音量{level}%。",
    "Clicked.": "已点击。",
    "Typed.": "已输入。",
    "“{label}” is one I leave for you to press.": "“{label}”这个要你自己来按。",
    # hands_guard: the Mac's own mouse and keyboard, before a press that pays or sends
    "“{label}” buys, books or pays for something. I only do that in the built-in browser, where you confirm it first, so press this one yourself.": "“{label}”会买东西、预订或付款。这种事我只在内置浏览器里做，而且要你先确认，所以这个请你自己按。",
    "Okay, I left it.": "好的，我没有按。",
    "Send this in {app}?": "要在 {app} 里发送这个吗？",
    "Post this in {app}?": "要在 {app} 里发布这个吗？",
    "Publish this in {app}?": "要在 {app} 里发表这个吗？",
    "Delete this in {app}?": "要在 {app} 里删除这个吗？",
    "Submit this in {app}?": "要在 {app} 里提交这个吗？",
    "Can I press {verb} in {app}?": "我可以在 {app} 里按“{verb}”吗？",
    "Here's your message in {app}: {text} Do you want it sent?": "这是你在 {app} 里的消息：{text} 要发送吗？",
    "I don't see “{label}” in {app}.": "我在{app}里没看到“{label}”。",
    "I couldn't look for “{label}” on the screen. Is Accessibility allowed?": "我没法在屏幕上查找“{label}”。辅助功能权限打开了吗？",
    "Controlled the Mac": "操控了 Mac",
}
# Words that turn up inside the sentences above (panel and look names, reasons…).
VALUES_ZH = {
    "Jarvis Code": "Jarvis Code",
    "the iOS Simulator": "iOS 模拟器",
    "the browser": "浏览器",
    "the Research Center": "研究中心",
    "this page": "这个页面",
    "Settings": "设置",
    "the second brain": "第二大脑",
    "the activity log": "活动记录",
    "Tools & Accounts": "工具与账户",
    "the Ambient Orb": "环境光球",
    "the Stark HUD": "斯塔克 HUD",
    "the Command Center": "指挥中心",
    "an unusual web address": "一个不常见的网址",
    "this assistant's own project": "这个助手自己的项目",
    "(none yet)": "（暂无）",
    "paid": "已付款",
    "open": "未付款",
    "their Mac": "这台 Mac",
    "Here": "这里",
    "Meeting": "会议",
    "outside content": "外部内容",
    "private content": "私人内容",
    "a picture of your screen": "你屏幕的截图",
    "recent heads-ups": "最近的提醒",
    "your calendar": "你的日历",
}
# The only slots whose English filler may be one of JARVIS's own words, and which words:
# a panel's or look's name, the default meeting title, an invoice's status, a card's
# stand-ins. Everything else in a slot (a person, a shortcut, a routine, a title, a file,
# what someone said or a service answered) is copied exactly, so a card never renames
# who or what it is about: "Send this to Meeting?" is 要把这条发给Meeting吗？.
_SLOT_WORDS: dict[str, frozenset[str]] = {
    "name": frozenset({*ui.PANEL_NAMES.values(), *ui.LOOK_NAMES.values()}),
    "title": frozenset({"Meeting"}),
    "status": frozenset({"paid", "open"}),
    "folder": frozenset({"this assistant's own project"}),
    "site": frozenset({"an unusual web address", "this page"}),
    "request": frozenset({"(none yet)"}),
}
_NESTED_SLOTS = {"why", "seen", "verb"}  # themselves one of the sentences above
_NUMERIC_SLOTS = {"n", "seconds", "minutes", "decisions", "actions", "pct", "rain", "id", "rate"}
_WORD_SLOTS = {"number", "due", "domain"}  # one token: INV-2026-004, 2026-10-29, example.com
# Slots that may run over several lines (a message, an email's body, what Claude or a
# service answered). The rest stay on their line: "Folder: {path}" never swallows the
# "First request: …" line under it.
_MULTILINE_SLOTS = {"text", "body", "message", "result", "detail", "error", "request", "task",
                    "topic", "why"}  # fmt: skip
_SLOT = re.compile(r"\{(\w+)\}")
# Past this length a text is only matched paragraph by paragraph: sentences with several
# open slots can take a regex long to rule out, and nothing JARVIS writes is this long.
_TEMPLATE_MAX = 1200
# And past this many characters of one text (a long email's body), what's left passes
# through as it is: it is someone's own words anyway. Each try costs a little more than
# its length, so twenty thousand empty lines can't make a long one either.
_TEMPLATE_BUDGET = 2000
_TRY_COST = 20
_TIME_VALUE = re.compile(r"(\d{1,2})(?::(\d{2}))?\s*([AaPp][Mm])")


def _template_pattern(template: str) -> re.Pattern[str]:
    parts = _SLOT.split(template)
    pattern = ""
    for i, part in enumerate(parts):
        if i % 2 == 0:
            pattern += re.escape(part)
            continue
        last = i == len(parts) - 2 and not parts[-1]
        if part in _NUMERIC_SLOTS:
            body = r"[\d.,]+"
        elif part in _WORD_SLOTS:
            body = r"\S+" if last else r"\S+?"
        else:
            body = "." if part in _MULTILINE_SLOTS else r"[^\n]"
            body += "+" if last else "+?"
        pattern += f"(?P<{part}>{body})"
    return re.compile(pattern, re.DOTALL)


def _ends(template: str) -> tuple[str, str]:
    """The words before a template's first slot and after its last: a text that doesn't
    start and end with them can't be that sentence, whatever is in between."""
    parts = _SLOT.split(template)
    return parts[0], parts[-1]


_TEMPLATES = sorted(
    ((key, _template_pattern(key), *_ends(key)) for key in ZH_TEXTS if _SLOT.search(key)),
    key=lambda item: len(_SLOT.sub("", item[0])),
    reverse=True,
)
# The templates as the modules write them ("Send this to {name}?"), for tr(): here their
# person, shortcut, routine or business is a slot of its own, copied as it is.
_OWN_NAMES = re.compile(r"\{(person|shortcut|routine|business)\}")
_TEMPLATE_ALIASES = {
    _OWN_NAMES.sub("{name}", key): (key, m.group(1))
    for key in ZH_TEXTS
    if (m := _OWN_NAMES.search(key))
}


def _slot_value(name: str, value: str, depth: int, budget: list[int]) -> str:
    if name in _NESTED_SLOTS:
        if depth >= 2:
            return value
        return "；".join(_translate(part, depth + 1, budget) for part in value.split("; "))
    if name == "time" and (m := _TIME_VALUE.fullmatch(value.strip())):
        return clock_zh(int(m.group(1)), int(m.group(2) or 0), m.group(3), spoken=False)
    if value in _SLOT_WORDS.get(name, ()):
        return VALUES_ZH.get(value, value)
    return value


def _translate(text: str, depth: int, budget: list[int]) -> str:
    # Lone words ("open", "the browser") and lowercase fragments ("use {tool}") are only
    # ever translated inside a sentence that's known to hold them.
    hit = ZH_TEXTS.get(text) or (VALUES_ZH.get(text) if depth else None)
    if hit is not None:
        return hit
    core = text.strip()
    if core != text:
        return text.replace(core, _translate(core, depth, budget), 1) if core else text
    if len(text) + _TRY_COST <= min(_TEMPLATE_MAX, budget[0]):
        budget[0] -= len(text) + _TRY_COST
        for key, pattern, head, tail in _TEMPLATES:
            if depth == 0 and key[:1].islower():
                continue
            if not (text.startswith(head) and text.endswith(tail)):
                continue
            if m := pattern.fullmatch(text):
                values = {k: _slot_value(k, v, depth, budget) for k, v in m.groupdict().items()}
                return ZH_TEXTS[key].format(**values)
    for sep in ("\n\n", "\n"):
        if sep in text:
            return sep.join(_translate(part, depth, budget) for part in text.split(sep))
    return text


def translate(text: str, lang: str = "zh") -> str:
    """A string the backend made, in the user's language: the Chinese of a known English
    sentence (its {slots} filled from the English: panel names translated, people's and
    things' names and the user's words kept exactly), a card's detail paragraph by
    paragraph, and anything unknown unchanged. English, or lang "en", passes straight
    through. Only the first _TEMPLATE_BUDGET characters are matched against the
    sentences, so a long text costs no more than a short one."""
    if not text or not is_zh(lang):
        return text
    return _translate(text, 0, [_TEMPLATE_BUDGET])


def tr(template: str, lang: str = "zh", **values: Any) -> str:
    """Format an English template (a ZH_TEXTS key, or the module's own spelling of one:
    "Send this to {name}?") in the user's language:
    tr("Opening {name}.", "zh", name="the browser") -> 正在打开浏览器。"""
    key, own = (template, "") if template in ZH_TEXTS else _TEMPLATE_ALIASES.get(template, ("", ""))
    if is_zh(lang) and key:
        if own:  # the module's {name} is this template's {person}, {shortcut}, …
            values = {own if k == "name" else k: v for k, v in values.items()}
        budget = [_TEMPLATE_BUDGET]
        filled = {k: _slot_value(k, str(v), 0, budget) for k, v in values.items()}
        return ZH_TEXTS[key].format(**filled)
    return template.format(**values) if values else template


def add_texts(texts: dict[str, str]) -> None:
    """A feature module's own sentences in Chinese (jarvis.features), added when it imports:
    translate() and tr() know them from then on, as they know ZH_TEXTS's."""
    ZH_TEXTS.update(texts)
    _TEMPLATES[:] = sorted(
        ((key, _template_pattern(key), *_ends(key)) for key in ZH_TEXTS if _SLOT.search(key)),
        key=lambda item: len(_SLOT.sub("", item[0])),
        reverse=True,
    )
    _TEMPLATE_ALIASES.update(
        {
            _OWN_NAMES.sub("{name}", key): (key, m.group(1))
            for key in texts
            if (m := _OWN_NAMES.search(key))
        }
    )


# ── the system prompt ──

# prefs.PERSONAS in Chinese: display names for Settings, and descriptions that set the
# register for Chinese replies.
ZH_PERSONAS = {
    "jarvis": (
        "贾维斯",
        "一位沉稳的英式管家型人工智能：彬彬有礼、一丝不苟、处变不惊，带着不动声色的冷幽默。"
        "偶尔来一句含蓄的调侃或意味深长的反话，从不耍宝。忠诚可靠，总比你快一步，暗自觉得这一切挺有意思。",
    ),
    "tars": (
        "塔斯",
        "一台直来直去、面无表情的机器：句子简短，实话实说，冷不丁冒出一句干巴巴的俏皮话。偶尔会报出自己的参数设置。",
    ),
    "friday": (
        "星期五",
        "热情、机灵、随和，带着一点爱尔兰式的亲切：乐观向上，爱鼓励人，偶尔轻轻打趣你。",
    ),
}


def persona_for_prompt(key: str, lang: str) -> tuple[str, str]:
    """(name, description) for brain.system_prompt's "You are {name}" and Personality
    lines. In Chinese the name stays the English one (the prompt never puts 贾维斯, the
    wake word, in Claude's mouth) and the description is the Chinese one."""
    from .prefs import PERSONAS

    name, description = PERSONAS.get(key, PERSONAS["jarvis"])
    if is_zh(lang):
        return name, ZH_PERSONAS.get(key, ZH_PERSONAS["jarvis"])[1]
    return name, description


def personas_payload(lang: str) -> list[dict[str, str]]:
    """Hub.prefs_payload's "personas", with Chinese names in Chinese mode."""
    from .prefs import PERSONAS

    return [
        {"id": k, "name": ZH_PERSONAS[k][0] if is_zh(lang) and k in ZH_PERSONAS else v[0]}
        for k, v in PERSONAS.items()
    ]


def languages_payload() -> list[dict[str, str]]:
    """For Settings' language choice: [{"id": "en", "name": "English"}, {"id": "zh", …}]."""
    return [{"id": k, "name": v} for k, v in LANGUAGES.items()]


def reply_instruction(lang: str) -> str:
    """What brain.system_prompt adds (as `extra`) when the user chose Chinese; "" for
    English."""
    if not is_zh(lang):
        return ""
    return (
        "\n\nLanguage: the user has chosen Chinese (中文). From now on:"
        "\n- Reply in natural spoken Simplified Chinese (普通话, 简体字), whatever language "
        "the request, tool results, pages or emails are in. Switch to English only when the "
        "user asks you to."
        "\n- Keep names, tickers, product names, file and folder names, code and commands "
        "exactly as they are (NVDA, Jarvis Code, bsh-research-center). Well-known names may "
        "take their usual Chinese form (标普500, 纳斯达克, 英伟达); people's names you aren't "
        "sure of stay as written."
        "\n- Numbers the way a Mandarin speaker says them. Write digits with Chinese units "
        "and the app reads them aloud properly: 1.2万亿美元 (not 1.2 trillion dollars), "
        "3.5亿, 2万, 7,684点, 下跌0.77%, 9月29日, 下午3点半. Use 两 before a measure word "
        "(两个, 两点, 两千)."
        "\n- Short spoken sentences, one idea each, ending in 。？or！: speech starts at each "
        "full stop. No markdown, lists, emoji or raw URLs."
        "\n- Never say 贾维斯 or Jarvis: it's the wake word and would wake you. Refer to "
        "yourself as 我."
        "\n- When you need a yes or no, ask a short, direct question the user can answer "
        "with 好 or 不用."
        "\n- Your persona, humor and every rule above still apply; make the wit natural "
        "Chinese, not translated English."
        "\n- Tool inputs stay the way the tools expect them (English page names, tickers, "
        "paths); search in whichever language will find more."
    )


# ── did the user ask for it in their own words? (hub.FEATURE_ASKED and friends) ──

# Lead-ins before a request. Each is taken whole and never given back ((?>…) and *+), so
# a clause of "你能不能" said forty times is read in one pass, not tried in 2^n splits.
_ASK_LEAD_ZH = (
    r"(?:(?>好的|好|那么|那|嗯|哦|喂|嘿|请|麻烦|帮我|帮忙|能不能|能否|可不可以|可以|我想让你|"
    r"我要你|我希望你|我需要你|从现在开始|以后|贾维斯|jarvis|你)[，,\s]*+)*+"
)
_CLAUSE_BREAK_ZH = re.compile(r"[。！？；;!?\n]+|然后|接着|还有|并且|而且|同时|另外|顺便|但是|不过")
# A clause that ends as a question or a report ("…了吗", "…了没有") asks for nothing; a
# polite tag ("好吗", "可以吗") still does.
_NOT_DONE_ZH = r"(?!.*(?:(?<![好行以])吗|么|呢|了没有?|过没有?|没有)$)"
# Nor one that asks where, when or how ("会议记录在哪里", "忘记密码了怎么办").
_NOT_ASKING_ZH = r"(?!.*(?:在哪|哪里|哪儿|什么时候|几点|为什么|怎么|是什么|写好了|做好了))"
# Words that make the verb a report of the past ("忘记我的密码了") or a question.
_NOT_PAST_ZH = r"(?![^，,。]*(?:了|过|吗|么|呢|怎么))"


def _asks_zh(pattern: str) -> re.Pattern[str]:
    return re.compile(_ASK_LEAD_ZH + "(?:" + pattern + ")", re.IGNORECASE)


FEATURE_ASKED_ZH = {
    "remember": _asks_zh(
        rf"{_NOT_DONE_ZH}(?:记住|记着|记下来?|记一下|记好|牢记|(?<=帮我)记|(?<=帮忙)记|别忘了"
        r"|不要忘了|别忘记|不要忘记)(?!了|吗|没|么)[：:，,\s]*\S"
    ),
    # 忘掉这件事, 忘记我的生日, 把那条忘掉, 删除所有记忆; never 忘记我的密码了 (I forgot).
    "forget": _asks_zh(
        rf"{_NOT_ASKING_ZH}(?:"
        rf"(?:忘掉|忘记){_NOT_PAST_ZH}[：:，,\s]*"
        r"(?:这个|那个|这件事|这条|那条|关于|我的|所有|全部|一切|刚才|我说的|你知道的|你记得的)"
        rf"|把[^，,。]{{1,12}}?(?:忘掉|忘记){_NOT_PAST_ZH}"
        rf"|(?:删掉|删除|清除|抹掉|移除|清空){_NOT_PAST_ZH}"
        r"[^，,。]{0,8}?(?:记忆|事实|你记住的|你记得的|你知道的)"
        r"|(?:别再|不要再|不用再)记(?:住|着)?(?!吗|么)"
        r")"
    ),
    # 做会议记录, 开始录音, 录下这次会议, 会议模式; never 打开笔记 (open my notes) or
    # 会议记录在哪里.
    "start_meeting": _asks_zh(
        rf"{_NOT_DONE_ZH}{_NOT_ASKING_ZH}(?:"
        r"(?:开始|帮我|给我)?(?:做|记|写)(?:个|一下|些|一份)?(?:会议)?(?:笔记|记录|纪要)"
        r"|(?:开始|开启|进入)(?:会议)?(?:记录|录音|转写|笔记|纪要|模式)"
        r"|(?:打开|切换到)会议模式"
        r"|会议模式(?:吧)?$"
        r"|(?:录下|记录|转写)(?:一下)?(?:这次|这个|我们的|今天的)?"
        r"(?:会议|通话|讨论|对话|谈话|面试|课|例会|站会)"
        r")"
    ),
    "delete_routine": _asks_zh(
        rf"{_NOT_DONE_ZH}(?:"
        r"(?:删除|删掉|取消|去掉|移除|撤销)掉?[^，,。]{0,8}?(?:例行任务|例行|定时任务|计划任务|自动任务|提醒|简报)"
        r"|把[^，,。]{0,8}?(?:例行任务|例行|定时任务|计划任务|自动任务|提醒|简报)(?:删掉|删除|去掉|取消)"
        r")"
    ),
    "pause_routine": _asks_zh(
        rf"{_NOT_DONE_ZH}(?:"
        r"(?:暂停|停止|停掉|恢复|重新开启|重新启用|开启|启用|停用|关闭|关掉|打开|跳过)[^，,。]{0,8}?"
        r"(?:例行任务|例行|定时任务|计划任务|自动任务|提醒|简报)"
        r"|把?[^，,。]{0,8}?(?:例行任务|定时任务|提醒|简报)先?(?:暂停|停一下|关掉|关闭|打开|开启|恢复)"
        r")"
    ),
}
# hands_guard: a send, post, delete or submit pressed with the mouse and keyboard, in a
# messaging or mail app (hub.FEATURE_ASKED's hands_* in English). 发出去, 回复她, 跟安说…,
# 把那条删掉; never 发送了吗.
SEND_ASKED_ZH = {
    "hands_send": _asks_zh(
        rf"{_NOT_DONE_ZH}(?:按|点|点击|按下)?(?:一下)?(?:发送|发出去|发过去|发给|回复|回一下|回个"
        r"|发(?:个|条|一条)?(?:消息|信息|微信|短信|邮件)|告诉(?!我)|跟[^，,。]{1,10}?说"
        r"|给[^，,。]{1,10}?发)"
    ),
    "hands_post": _asks_zh(rf"{_NOT_DONE_ZH}(?:按|点|点击)?(?:一下)?(?:发布|发帖|发表|发到)"),
    "hands_publish": _asks_zh(rf"{_NOT_DONE_ZH}(?:按|点|点击)?(?:一下)?(?:发布|发表)"),
    "hands_delete": _asks_zh(
        rf"{_NOT_DONE_ZH}(?:按|点|点击)?(?:一下)?(?:删除|删掉|撤回"
        r"|把[^，,。]{1,12}?(?:删掉|删除|删了|撤回))"
    ),
    "hands_submit": _asks_zh(rf"{_NOT_DONE_ZH}(?:按|点|点击)?(?:一下)?(?:提交|发送)"),
}
# Coding as something to do now, not a noun: "编程语言哪个最好学" asks for nothing.
_CODING_ZH = r"(?:写代码|编程|写程序|敲代码|改代码)(?!语言|课|题|书|的|是|能力|水平|经验|工作|比赛|很|太|真|比|吗|么)"
# "我们来写代码", "进入编程模式", "打开 Jarvis Code", "和我一起改这个项目".
CODE_ASKED_ZH = _asks_zh(
    rf"(?:我们|咱们|我想|我要|我想要|让我们|来|一起|开始|现在)(?:一起)?来?(?:用语音)?{_CODING_ZH}"
    r"|(?:用语音|语音)(?:编程|写代码)(?!语言|课|题|书|的|是)"
    rf"|(?:进入|开始|启动|切换到|回到|继续)(?:语音)?{_CODING_ZH}(?:模式)?"
    r"|(?:进入|打开|开启|启动|切换到|回到)(?:语音)?(?:编程|代码)模式"
    r"|(?:代码|编程)模式(?:吧)?$"
    r"|(?:打开|启动|开启|开)\s*(?:一个)?\s*(?:jarvis\s*code|claude\s*code|贾维斯代码)"
    r"|(?:和|跟)(?:我|你)一起(?:做|改|写|弄|搞)"
)
# A coding session by name, taken whole (never "Claude" out of "Claude Code 是什么").
_SESSION_ZH = (
    r"(?>jarvis\s*code|claude(?:\s*code)?|编程会话|代码会话|编程助手|那个会话|这个会话"
    r"|会话\s*\d+|任务\s*\d+|第\s*\d+\s*个会话)"
)
# "告诉 Jarvis Code…", "跟会话2说…", "给 Claude Code 发…"; never "对 Claude Code 你怎么看"
# or "跟 Claude Code 比" (跟, 对 and 给 need a verb of saying after the name).
MESSAGE_ASKED_ZH = _asks_zh(
    rf"(?:告诉|让|叫|通知|转告|提醒|回复|回答|问问?)(?:一下)?\s*{_SESSION_ZH}(?!\s*(?:的|是))"
    rf"|(?:跟|对|给|和)\s*{_SESSION_ZH}\s*(?:说|讲|发|转告|留言|回复|交代)"
)


def user_asked_zh(pattern: re.Pattern[str], text: str) -> bool:
    """hub.user_asked for Chinese: a clause of what the user said opens with the request
    ("好的，记住我喜欢咖啡"), not merely mentions it somewhere."""
    clauses = _CLAUSE_BREAK_ZH.split(to_simplified(text))
    return any(pattern.match(c.strip(" \t:：-—")) for c in clauses)


# ── language-aware entry points (what the hub calls) ──
# Each takes the language setting last; "en" is the English original, untouched.


def find_wake(text: str, lang: str = "en") -> tuple[bool, str]:
    return find_wake_zh(text) if is_zh(lang) else wake.find_wake(text)


def is_stop(text: str, lang: str = "en") -> bool:
    return is_stop_zh(text) if is_zh(lang) else wake.is_stop(text)


def yes_no(text: str, lang: str = "en") -> bool | None:
    return yes_no_zh(text) if is_zh(lang) else wake.yes_no(text)


def words(text: str, lang: str = "en") -> list[str]:
    return words_zh(text) if is_zh(lang) else wake.words(text)


def is_echo(heard: str, speaking: str, lang: str = "en", threshold: float = 0.6) -> bool:
    if is_zh(lang):
        return is_echo_zh(heard, speaking, threshold)
    return wake.is_echo(heard, speaking, threshold)


def sounds_finished(text: str, lang: str = "en") -> bool:
    if is_zh(lang):
        return sounds_finished_zh(text)
    from .listen import sounds_finished as english

    return english(text)


def parse_research(text: str, lang: str = "en") -> research.Command | None:
    return parse_research_zh(text) if is_zh(lang) else research.parse(text)


def parse_ui(text: str, lang: str = "en") -> ui.Command | None:
    return parse_ui_zh(text) if is_zh(lang) else ui.parse(text)


def split_sentences(
    buffer: str, final: bool = False, min_chars: int = 12, lang: str = "en"
) -> tuple[list[str], str]:
    if is_zh(lang):
        return split_sentences_zh(buffer, final, min_chars)
    from .speech import split_sentences as english

    return english(buffer, final, min_chars)


def clean_for_speech(text: str, lang: str = "en") -> str:
    if is_zh(lang):
        return clean_for_speech_zh(text)
    from .speech import clean_for_speech as english

    return english(text)


def voice_answer(text: str, approval: dict[str, Any], lang: str = "en") -> tuple[str, str] | None:
    if is_zh(lang):
        return voice_answer_zh(text, approval)
    from .voicecode import voice_answer as english

    return english(text, approval)


def match_shortcut(text: str, names: list[str], lang: str = "en") -> str | None:
    if is_zh(lang):
        return match_shortcut_zh(text, names)
    from .home import match_shortcut as english

    return english(text, names)


def clean_transcript(text: str, lang: str = "en") -> str:
    """A finished transcript: "" for a hallucination; in Chinese also Simplified."""
    if is_zh(lang):
        return clean_transcript_zh(text)
    from .listen import is_hallucination

    return "" if is_hallucination(text) else text


def about_screen(text: str, lang: str = "en") -> bool:
    from .screenwatch import about_screen as english

    return english(text) or (is_zh(lang) and about_screen_zh(text))
