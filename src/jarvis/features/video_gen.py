"""Videos with Google's Veo on the owner's Gemini key (jarvis.videogen): the brain's
generate_video, the card it asks on, the video's card in the window and its part of Settings.

Registers:
- the "video_gen" tool server: generate_video (JARVIS's own words back: quiet). It asks on a
  card every time (said aloud), with the description and the estimated price; once the
  owner says yes it starts Google's operation and returns at once, and a background task
  waits for the video, saves it in Documents › Jarvis › Videos, puts it on a card and gives
  a heads-up (or says why there's none);
- the setting video_model (prefs.features): the Veo model, veo-3.0-fast-generate-001 unless
  the owner names another;
- window commands: veo_state (-> videos), veo_open {id}, veo_reveal {id} (only videos made
  here; video_open is the video desk's own), veo_folder (shows the folder in Finder).
Each video goes to the window as a "video_made" event: {id, name, path, prompt, cost}.

Music: not made here. The Gemini API's music model (Lyria RealTime) is a live stream over a
WebSocket rather than a request with an answer, and no request-and-answer music endpoint for
a Gemini key could be confirmed; Lyria 2 is Vertex AI's (another key and API).

Cost policy: see jarvis.videogen (Google's price by the second, about $1.20 a video with the
default model, shown on the card as an estimate, only after the owner says yes). At most
videogen.PER_DAY (5) a day, the "video" purpose of utility_model's daily counts, kept beside
the settings so a restart doesn't reset it, and videogen.RUNNING at once.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from claude_agent_sdk import create_sdk_mcp_server, tool

from .. import lang, mac_tools, utility_model, videogen
from ..prefs import register_feature_pref
from ..proactive import Alert

log = logging.getLogger("jarvis")

register_feature_pref("video_model", videogen.DEFAULT_MODEL, videogen.clean_model)
utility_model.register_purpose("video", videogen.PER_DAY)

ZH = {
    "Make a video with Google Veo?": "要用 Google Veo 做一段视频吗？",
    "This description goes to Google, and the video is billed to your Gemini key: {cost}, an estimate (Google sets the price).": "这段描述会发给 Google，视频费用记在你的 Gemini 密钥上：{cost}，这是估算（价格由 Google 决定）。",
    "about ${usd} for {seconds} seconds": "{seconds} 秒大约 {usd} 美元",
    "Google's price for {model}, by the second": "Google 对 {model} 按秒计算的价格",
    "Say what the video should show.": "请说说视频要拍什么。",
    "There's no Google Gemini key: add one in Settings › Models to make videos.": "没有 Google Gemini 密钥：请在“设置 › 模型”里添加一个，才能做视频。",
    "That's {n} videos today; try again tomorrow.": "今天已经做了 {n} 段视频；明天再试吧。",
    "Two videos are being made already; wait for one to finish.": "已经有两段视频在制作中；请等其中一段做完。",
    "Your video is ready: {name}.": "你的视频做好了：{name}。",
    "No video this time: {why}": "这次没有做成视频：{why}",
    "Google made no video.": "Google 没有做出视频。",
    "Video": "视频",
    "Made a video": "做了一段视频",
    "Google answered, but didn't start a video.": "Google 回应了，但没有开始做视频。",
    "Google's answer about the video can't be read.": "Google 关于视频的回复读不懂。",
    "Google took too long to make the video, so I stopped waiting.": "Google 做视频太久了，我就不再等了。",
    "Google finished without a video. Try describing it another way.": "Google 做完了却没有视频。换个方式描述试试。",
    "Google's safety filters held the video back.": "Google 的安全过滤拦下了这段视频。",
    "Google gave an address for the video that isn't its own.": "Google 给的视频地址不是它自己的。",
    "Google didn't send the video in time.": "Google 没有及时发来视频。",
    "Google sent the video somewhere it can't be fetched.": "Google 把视频放在了取不到的地方。",
    "Google sent the video round too many addresses.": "Google 把视频转了太多次地址。",
    "Google's video is too big to keep.": "Google 的视频太大，存不下。",
    "Google sent something that isn't a video.": "Google 发来的不是视频。",
    "Google didn't answer in time.": "Google 没有及时回应。",
    "I couldn't reach Google. Check the internet connection.": "连不上 Google。请检查网络连接。",
    "Google didn't accept the key for videos (Veo needs a paid Gemini API key).": "Google 不接受这个密钥做视频（Veo 需要付费的 Gemini API 密钥）。",
    "Google has no video model called {model}.": "Google 没有叫 {model} 的视频模型。",
    "Google lost track of the video.": "Google 找不到这段视频了。",
    "Google is limiting video requests on this key right now; try again later.": "Google 现在限制了这个密钥的视频请求；稍后再试。",
    "Google couldn't make the video.": "Google 没能做出这段视频。",
    "Google wouldn't make that video.": "Google 不肯做这段视频。",
    "Google couldn't make the video: {why}": "Google 没能做出这段视频：{why}",
    "Google's safety filters held the video back: {why}": "Google 的安全过滤拦下了这段视频：{why}",
    "Google wouldn't make that video: {why}": "Google 不肯做这段视频：{why}",
    "Google couldn't hand over the video ({code}).": "Google 没能交出这段视频（{code}）。",
    "Google had a problem ({code}); try again shortly.": "Google 出了问题（{code}）；稍后再试。",
}
lang.add_texts(ZH)

PROMPT = (
    "\n- Videos: generate_video makes a short video (about 8 seconds) with Google's Veo on the "
    "owner's own Gemini key when they ask for one: describe it fully in the prompt (subject, "
    "action, style, camera, sound), and give aspect_ratio 16:9 or 9:16 when it matters. The "
    "owner says yes on a card that shows the estimated price first. Google takes a minute or "
    "more: it's saved in Documents › Jarvis › Videos and shown with a heads-up when ready, so "
    "say it's on its way, briefly. There's no music generation."
)


class Videos:
    def __init__(self, hub: Any) -> None:
        self.hub = hub
        folder = (
            videogen.default_folder() if getattr(hub, "poll", False) else hub.feature_path("Videos")
        )
        self.desk = videogen.VideoDesk(folder)
        self.running: set[asyncio.Task] = set()
        self.open = self._open  # tests put a stand-in here: never a real app in a test

    def _open(self, *args: str) -> None:
        self.hub._spawn(self.hub._quiet(mac_tools.run_command("open", *args)))

    def tr(self, text: str, **values: Any) -> str:
        return lang.tr(text, self.hub.language, **values)

    def model(self) -> str:
        return self.hub.prefs.feature("video_model") or videogen.DEFAULT_MODEL

    def cost(self, model: str) -> str:
        usd = videogen.estimate(model)
        if usd is None:
            return self.tr("Google's price for {model}, by the second", model=model)
        return self.tr(
            "about ${usd} for {seconds} seconds", usd=f"{usd:.2f}", seconds=videogen.DEFAULT_SECONDS
        )

    async def generate(self, prompt: str, aspect: str = "") -> tuple[str, bool]:
        hub = self.hub
        prompt = " ".join(str(prompt or "").split())[: videogen.MAX_PROMPT]
        if not prompt:
            return "Say what the video should show.", True
        key = await asyncio.to_thread(hub.providers.key_of, "gemini")
        if not key:
            return (
                "There's no Google Gemini key: add one in Settings › Models to make videos. "
                "Tell the owner.",
                True,
            )
        if len(self.running) >= videogen.RUNNING:
            return "Two videos are being made already; wait for one to finish.", True
        model = self.model()
        cost = self.cost(model)
        detail = self.tr(
            "This description goes to Google, and the video is billed to your Gemini key: "
            "{cost}, an estimate (Google sets the price).",
            cost=cost,
        )
        if not await hub._ask_user(
            self.tr("Make a video with Google Veo?"), f"{prompt}\n\n{detail}"
        ):
            return "The owner didn't want that video made.", True
        try:  # counted before anything is sent: a cap that holds whatever Google answers
            utility_model.usage_for(hub).take("video")
        except utility_model.OverBudget:
            return f"That's {videogen.PER_DAY} videos today; try again tomorrow.", True
        try:
            operation = await self.desk.start(key, prompt, model=model, aspect=aspect)
        except videogen.VideoError as exc:
            return str(exc), True
        task = hub._spawn(self._finish(key, operation, prompt, cost))
        self.running.add(task)
        task.add_done_callback(self.running.discard)
        return (
            f"Started: Google is making it now ({videogen.cost_note(model)}, an estimate). It "
            "takes a minute or more; it'll be saved in Documents › Jarvis › Videos and shown "
            "with a heads-up when it's ready.",
            False,
        )

    async def _finish(self, key: str, operation: str, prompt: str, cost: str) -> None:
        hub = self.hub
        try:
            done = await self.desk.wait(key, operation)
            uri = self.desk.video_uri(done)
            made = await self.desk.download(key, uri, prompt)
        except videogen.VideoError as exc:
            why = lang.translate(str(exc), hub.language) if lang.is_zh(hub.language) else str(exc)
            self._heads_up(
                f"video:{operation[-12:]}", self.tr("No video this time: {why}", why=why)
            )
            return
        except Exception:
            log.exception("videos: making one failed")
            self._heads_up(
                f"video:{operation[-12:]}",
                self.tr("No video this time: {why}", why=self.tr("Google made no video.")),
            )
            return
        hub.emit(
            "video_made", prompt=prompt, cost=cost, **{k: made[k] for k in ("id", "name", "path")}
        )
        self._heads_up(
            f"video:{made['id'][:12]}", self.tr("Your video is ready: {name}.", name=made["name"])
        )

    def _heads_up(self, key: str, text: str) -> None:
        self.hub.notify(
            Alert(key, "task", self.tr("Video"), text, note="a video JARVIS was asked to make")
        )

    def build_tools(self) -> list:
        videos = self

        @tool(
            "generate_video",
            "Make a short video (about 8 seconds) with Google's Veo on the owner's own Gemini "
            "key, when they ask for one. prompt: a full description (subject, action, style, "
            "camera, sound); aspect_ratio: optional, 16:9 or 9:16. The owner OKs the estimated "
            "price on a card first; the video arrives a minute or more later, saved in "
            "Documents › Jarvis › Videos.",
            {
                "type": "object",
                "properties": {"prompt": {"type": "string"}, "aspect_ratio": {"type": "string"}},
                "required": ["prompt"],
            },
        )
        async def generate_video(args):
            text, error = await videos.generate(
                str(args.get("prompt", "")), str(args.get("aspect_ratio", "") or "")
            )
            out: dict[str, Any] = {"content": [{"type": "text", "text": text}]}
            if error:
                out["is_error"] = True
            return out

        return [generate_video]

    def build_server(self):
        return create_sdk_mcp_server(name="video_gen", version="0.1.0", tools=self.build_tools())

    # ── the window ──

    def state(self, _msg: dict[str, Any]) -> None:
        has_key = any(p.kind == "gemini" for p in self.hub.providers.providers.values())
        self.hub.emit(
            "videos",
            key=has_key,
            model=self.model(),
            default_model=videogen.DEFAULT_MODEL,
            folder=str(self.desk.folder),
            cost=self.cost(self.model()),
            per_day=videogen.PER_DAY,
        )

    def open_video(self, msg: dict[str, Any]) -> None:
        path = self.desk.path_of(str(msg.get("id", "")))
        if path is not None:
            self.open(str(path))

    def reveal_video(self, msg: dict[str, Any]) -> None:
        path = self.desk.path_of(str(msg.get("id", "")))
        if path is not None:
            self.open("-R", str(path))

    def reveal_folder(self, _msg: dict[str, Any]) -> None:
        folder = self.desk.folder
        folder.mkdir(parents=True, exist_ok=True)
        self.open(str(folder))


def install(hub: Any) -> None:
    videos = Videos(hub)
    hub.videos = videos
    hub.register_server(
        "video_gen",
        videos.build_server,
        prompt=PROMPT,
        labels={"generate_video": "Made a video"},
        quiet=("generate_video",),
    )
    hub.register_command("veo_state", videos.state)
    hub.register_command("veo_open", videos.open_video)
    hub.register_command("veo_reveal", videos.reveal_video)
    hub.register_command("veo_folder", videos.reveal_folder)
