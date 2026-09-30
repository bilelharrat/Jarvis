"""Pictures with the owner's Google Gemini key (jarvis.imagegen): the brain's generate_image,
the picture's card in the window and its part of Settings.

Registers:
- the "pictures" tool server: generate_image (JARVIS's own words back: quiet);
- the words that ask for a picture (ASKED: "draw a…", "make me a picture of…", 画一张…);
- the setting image_model (prefs.features): the Gemini image model, gemini-2.5-flash-image
  unless the owner names another;
- window commands: pictures_state (-> pictures), image_open {id}, image_reveal {id} (only
  pictures made here), pictures_folder (shows the folder in Finder).
Each picture goes to the window as an "image_made" event: {id, name, path, mime, data, prompt}.

Cost policy: see jarvis.imagegen (Google's price, about 4 cents a picture with the default
model, only when the owner asks). At most imagegen.PER_DAY (50) a day: the "picture" purpose of
utility_model's daily counts, kept beside the settings so a restart doesn't reset it.
"""

from __future__ import annotations

import asyncio
from typing import Any

from claude_agent_sdk import create_sdk_mcp_server, tool

from .. import imagegen, lang, mac_tools, utility_model
from ..prefs import register_feature_pref
from ._asked import Asked

register_feature_pref("image_model", imagegen.DEFAULT_MODEL, imagegen.clean_model)
utility_model.register_purpose("picture", imagegen.PER_DAY)

# "Draw a fox in the snow", "make me a picture of…", "design a logo for…", "画一只猫",
# "帮我生成一张海报"; never "draw up the contract", "draw money" or 画好了吗.
ASKED = Asked(
    r"(?:draw|paint|sketch|illustrate)(?!\s+(?:up|out|on|from|in|down|back|off|attention"
    r"|conclusions?|money|cash|blood|straws|lots)\b)\s+\S"
    r"|(?:generate|make|create|design|render|imagine|produce|give)\s+(?:me\s+|us\s+)?"
    r"(?:a\s+|an\s+|some\s+|the\s+|another\s+|two\s+|three\s+|\d+\s+)?(?:[\w'-]+\s+){0,6}?"
    r"(?:pictures?|images?|illustrations?|drawings?|paintings?|sketch(?:es)?|logos?|icons?"
    r"|posters?|photos?|artworks?|wallpapers?|portraits?|cartoons?)\b",
    rf"{lang._NOT_DONE_ZH}(?:"
    r"画(?![面家廊展质风好完])(?:一|几|两)?(?:只|个|张|幅|条|朵|座|棵|位|群|片|些)?[^，,。]"
    r"|(?:生成|做|制作|设计|创作|来)(?:一|几|两)?(?:张|幅|个|些)?[^，,。]{0,20}?"
    r"(?:图|图片|图像|画|插画|插图|海报|照片|头像|壁纸|图标|标志|logo)"
    r")",
)

ZH = {
    "Make a picture with Google Gemini?": "要用 Google Gemini 画一张图吗？",
    "This description goes to Google, and the picture is billed to your Gemini key ({cost}).": "这段描述会发给 Google，图片费用记在你的 Gemini 密钥上（{cost}）。",
    "about 4 cents a picture": "每张大约 4 美分",
    "Google's price for {model}": "Google 对 {model} 的定价",
    "Say what the picture should show.": "请说说图片要画什么。",
    "There's no Google Gemini key: add one in Settings › Models to make pictures.": "没有 Google Gemini 密钥：请在“设置 › 模型”里添加一个，才能画图。",
    "That's {n} pictures today; try again tomorrow.": "今天已经画了 {n} 张图；明天再试吧。",
    "Google made no picture. Try describing it another way.": "Google 没有画出图片。换个方式描述试试。",
    "Google's picture came back damaged.": "Google 返回的图片损坏了。",
    "Google sent something that isn't a picture.": "Google 发来的不是图片。",
    "Google's picture is too big to show here.": "Google 返回的图片太大，这里显示不了。",
    "Google didn't answer in time.": "Google 没有及时回应。",
    "I couldn't reach Google. Check the internet connection.": "连不上 Google。请检查网络连接。",
    "Google didn't accept the key.": "Google 不接受这个密钥。",
    "Google has no image model called {model}.": "Google 没有叫 {model} 的图像模型。",
    "Google is limiting requests on this key right now; try again in a minute.": "Google 现在限制了这个密钥的请求；一分钟后再试。",
    "Made a picture": "画了一张图",
}
lang.add_texts(ZH)

PROMPT = (
    "\n- Pictures: generate_image makes a picture with Google's Gemini on the owner's own "
    "key when they ask for one (a drawing, an illustration, a logo idea): describe it fully "
    "in the prompt, and give an aspect ratio when it matters. It's saved in Documents › "
    "Jarvis › Images and shown on screen; say so briefly. Google charges about 4 cents a "
    "picture: say that the first time."
)


class Pictures:
    def __init__(self, hub: Any) -> None:
        self.hub = hub
        # Documents › Jarvis › Images in the app; a test's own folder otherwise.
        folder = (
            imagegen.default_folder() if getattr(hub, "poll", False) else hub.feature_path("Images")
        )
        self.desk = imagegen.ImageDesk(folder)
        self.open = self._open  # tests put a stand-in here: never a real app in a test

    def _open(self, *args: str) -> None:
        self.hub._spawn(self.hub._quiet(mac_tools.run_command("open", *args)))

    def tr(self, text: str, **values: Any) -> str:
        return lang.tr(text, self.hub.language, **values)

    def model(self) -> str:
        return self.hub.prefs.feature("image_model") or imagegen.DEFAULT_MODEL

    async def _allowed(self, prompt: str) -> bool:
        """The owner's own words asked for a picture, in a turn that read nothing private or
        from the web: go ahead. Otherwise a card, said aloud, with the description."""
        reads = self.hub._gate_reads()
        tainted = reads["private"] or reads["web"] or not self.hub._turn_text
        if ASKED.by_owner(self.hub) and not tainted:
            return True
        detail = self.tr(
            "This description goes to Google, and the picture is billed to your Gemini key ({cost}).",
            cost=lang.translate(imagegen.cost_note(self.model()), self.hub.language),
        )
        return await self.hub._ask_user(
            self.tr("Make a picture with Google Gemini?"), f"{prompt}\n\n{detail}"
        )

    async def generate(self, prompt: str, aspect: str = "") -> tuple[str, bool]:
        prompt = " ".join(str(prompt or "").split())[: imagegen.MAX_PROMPT]
        if not prompt:
            return "Say what the picture should show.", True
        key = await asyncio.to_thread(self.hub.providers.key_of, "gemini")
        if not key:
            return (
                "There's no Google Gemini key: add one in Settings › Models to make pictures. "
                "Tell the owner.",
                True,
            )
        if not await self._allowed(prompt):
            return "The owner didn't want that picture made.", True
        try:  # counted before anything is sent: a cap that holds whatever Google answers
            utility_model.usage_for(self.hub).take("picture")
        except utility_model.OverBudget:
            return f"That's {imagegen.PER_DAY} pictures today; try again tomorrow.", True
        model = self.model()
        try:
            made = await self.desk.generate(key, prompt, model=model, aspect=aspect)
        except imagegen.ImageError as exc:
            return str(exc), True
        cost = imagegen.cost_note(model)
        self.hub.emit(
            "image_made",
            rid=self.hub._rid,
            prompt=prompt,
            cost=lang.translate(cost, self.hub.language),
            **{k: made[k] for k in ("id", "name", "path", "mime", "data")},
        )
        said = f" Gemini said: {made['text']}" if made["text"] else ""
        return (
            f"Made it: {made['name']}, saved in Documents › Jarvis › Images and shown on "
            f"screen. Google charges it to the owner's key: {cost}.{said}",
            False,
        )

    def build_tools(self) -> list:
        pictures = self

        @tool(
            "generate_image",
            "Make a picture with Google's Gemini (the owner's own key), when they ask for one. "
            "prompt: a full description of the picture; aspect_ratio: optional, one of "
            + ", ".join(imagegen.ASPECTS)
            + ". Saved in Documents › Jarvis › Images and shown on screen.",
            {
                "type": "object",
                "properties": {"prompt": {"type": "string"}, "aspect_ratio": {"type": "string"}},
                "required": ["prompt"],
            },
        )
        async def generate_image(args):
            text, error = await pictures.generate(
                str(args.get("prompt", "")), str(args.get("aspect_ratio", "") or "")
            )
            out: dict[str, Any] = {"content": [{"type": "text", "text": text}]}
            if error:
                out["is_error"] = True
            return out

        return [generate_image]

    def build_server(self):
        return create_sdk_mcp_server(name="pictures", version="0.1.0", tools=self.build_tools())

    # ── the window ──

    def state(self, _msg: dict[str, Any]) -> None:
        has_key = any(p.kind == "gemini" for p in self.hub.providers.providers.values())
        self.hub.emit(
            "pictures",
            key=has_key,
            model=self.model(),
            default_model=imagegen.DEFAULT_MODEL,
            folder=str(self.desk.folder),
            cost=lang.translate(imagegen.cost_note(self.model()), self.hub.language),
        )

    def open_image(self, msg: dict[str, Any]) -> None:
        path = self.desk.path_of(str(msg.get("id", "")))
        if path is not None:
            self.open(str(path))

    def reveal_image(self, msg: dict[str, Any]) -> None:
        path = self.desk.path_of(str(msg.get("id", "")))
        if path is not None:
            self.open("-R", str(path))

    def reveal_folder(self, _msg: dict[str, Any]) -> None:
        folder = self.desk.folder
        folder.mkdir(parents=True, exist_ok=True)
        self.open(str(folder))


def install(hub: Any) -> None:
    pictures = Pictures(hub)
    hub.pictures = pictures
    hub.register_server(
        "pictures",
        pictures.build_server,
        prompt=PROMPT,
        labels={"generate_image": "Made a picture"},
        quiet=("generate_image",),
    )
    hub.register_command("pictures_state", pictures.state)
    hub.register_command("image_open", pictures.open_image)
    hub.register_command("image_reveal", pictures.reveal_image)
    hub.register_command("pictures_folder", pictures.reveal_folder)
