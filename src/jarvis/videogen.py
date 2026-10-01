"""Videos, made with Google's Veo on the owner's own Gemini key (the one added in Settings ›
Models as Google Gemini): the brain's generate_video starts one, and when Google has made it
it's saved in Documents › Jarvis › Videos and shown on a card (Open, Show in Finder).

Google's long-running operation, as the Gemini API documents it for Veo:
- POST {GEMINI_API}/{model}:predictLongRunning with {"instances": [{"prompt": …}],
  "parameters": {"aspectRatio": …}} starts it; the answer names the operation
  ({"name": "models/<model>/operations/<id>"});
- GET https://generativelanguage.googleapis.com/v1beta/<name> tells how it's going, until
  {"done": true} with either "error" or "response": {"generateVideoResponse":
  {"generatedSamples": [{"video": {"uri": …}}]}} (a sample the safety filters took out is
  counted in raiMediaFilteredCount, with the reasons);
- GET <uri> with the key gives the video (an MP4), by way of a redirect to Google's storage.

The key: read from the Keychain only as the providers store hands it out, and sent only to
generativelanguage.googleapis.com over HTTPS. A redirect is followed by hand, without the key
(httpx would carry a custom header to the next host), and only to an https address. Vertex
AI keys ("AQ.") aren't used here: Vertex's Veo has another operation API.

Cost policy: Google's price, not a Claude call. Veo is billed by the second of video made;
each start costs about DEFAULT_SECONDS × the model's price a second (PRICES: Google's list
prices when this was written, shown on the card as an estimate). Every video is asked for on a
card first, with that estimate, whatever the owner said. At most PER_DAY a day (counted across
restarts, through utility_model's daily counts) and RUNNING at once; nothing is made unless
the owner (or JARVIS at their request) asks and says yes on the card.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import re
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import httpx

from .gemini_proxy import GEMINI_API

API_HOST = "generativelanguage.googleapis.com"
API_ROOT = f"https://{API_HOST}/v1beta"
DEFAULT_MODEL = "veo-3.0-fast-generate-001"
DEFAULT_SECONDS = 8  # Veo's clip when no length is asked for
# Google's list price per second of video, in US dollars (an estimate: Google sets it).
PRICES = {
    "veo-3.0-fast-generate-001": 0.15,
    "veo-3.0-generate-001": 0.40,
    "veo-3.1-fast-generate-preview": 0.15,
    "veo-3.1-generate-preview": 0.40,
    "veo-2.0-generate-001": 0.35,
}
PER_DAY = 5
RUNNING = 2
MAX_PROMPT = 2000
MAX_VIDEO = 300 * 1024 * 1024  # bytes of one video kept
POLL_EVERY = 10.0  # seconds between asking Google how it's going
GIVE_UP_AFTER = 15 * 60.0  # seconds: an operation still not done then is left
ASPECTS = ("16:9", "9:16")
_MODEL = re.compile(r"veo-[A-Za-z0-9._-]{2,80}")
_OPERATION = re.compile(r"models/[A-Za-z0-9._-]+/operations/[A-Za-z0-9._-]+")


def default_folder() -> Path:
    return Path.home() / "Documents" / "Jarvis" / "Videos"


def clean_model(value: Any) -> str | None:
    text = str(value or "").strip()
    return text if _MODEL.fullmatch(text) else None


def estimate(model: str, seconds: int = DEFAULT_SECONDS) -> float | None:
    """What a video should cost in dollars (None when the model's price isn't known)."""
    price = PRICES.get(model)
    return None if price is None else round(price * seconds, 2)


def cost_note(model: str) -> str:
    """The estimate in words for the card and the brain."""
    usd = estimate(model)
    if usd is None:
        return f"Google's price for {model}, by the second"
    return f"about ${usd:.2f} for {DEFAULT_SECONDS} seconds"


class VideoError(Exception):
    """Why no video was made, in words to say."""


def _said(body: bytes) -> str:
    try:
        data = json.loads(body)
    except (ValueError, RecursionError):
        return ""
    error = data.get("error") if isinstance(data, dict) else None
    message = error.get("message") if isinstance(error, dict) else ""
    return " ".join(str(message or "").split())[:200]


def _is_mp4(head: bytes) -> bool:
    return len(head) >= 12 and head[4:8] == b"ftyp"


def _ours(url: str) -> bool:
    """Whether the key may go to this address: Google's Gemini API, over HTTPS."""
    parsed = urlparse(url)
    return parsed.scheme == "https" and parsed.hostname == API_HOST and not parsed.username


class VideoDesk:
    def __init__(self, folder: Path, client: httpx.AsyncClient | None = None) -> None:
        self.folder = folder
        self.client = client  # tests give one; the app makes one per call
        self.made: dict[str, Path] = {}  # what the window may open: the videos made here
        self.poll_every = POLL_EVERY
        self.give_up_after = GIVE_UP_AFTER

    def _client(self) -> tuple[httpx.AsyncClient, bool]:
        if self.client is not None:
            return self.client, False
        timeout = httpx.Timeout(120, connect=15)
        return httpx.AsyncClient(timeout=timeout, follow_redirects=False), True

    async def start(self, key: str, prompt: str, *, model: str, aspect: str = "") -> str:
        """Start one: the operation's name. VideoError (in words to say) when Google won't."""
        prompt = " ".join(str(prompt or "").split())[:MAX_PROMPT]
        if not prompt:
            raise VideoError("Say what the video should show.")
        if not key:
            raise VideoError(
                "There's no Google Gemini key: add one in Settings › Models to make videos."
            )
        body: dict[str, Any] = {"instances": [{"prompt": prompt}]}
        if aspect in ASPECTS:
            body["parameters"] = {"aspectRatio": aspect}
        url = f"{GEMINI_API}/{model}:predictLongRunning"
        response = await self._send("POST", url, key, json=body, model=model)
        try:
            data = response.json()
        except ValueError:
            raise VideoError("Google answered, but didn't start a video.") from None
        name = data.get("name") if isinstance(data, dict) else None
        if not isinstance(name, str) or not _OPERATION.fullmatch(name):
            raise VideoError("Google answered, but didn't start a video.")
        return name

    async def check(self, key: str, operation: str) -> dict[str, Any] | None:
        """How it's going: None while it runs, the operation once it's done."""
        if not _OPERATION.fullmatch(operation):
            raise VideoError("That isn't one of Google's video operations.")
        response = await self._send("GET", f"{API_ROOT}/{operation}", key)
        try:
            data = response.json()
        except ValueError:
            raise VideoError("Google's answer about the video can't be read.") from None
        if not isinstance(data, dict):
            raise VideoError("Google's answer about the video can't be read.")
        return data if data.get("done") is True else None

    async def wait(self, key: str, operation: str) -> dict[str, Any]:
        """Ask every poll_every seconds until it's done (VideoError after give_up_after)."""
        loop = asyncio.get_running_loop()
        began = loop.time()
        while True:
            done = await self.check(key, operation)
            if done is not None:
                return done
            if loop.time() - began >= self.give_up_after:
                raise VideoError("Google took too long to make the video, so I stopped waiting.")
            await asyncio.sleep(self.poll_every)

    @staticmethod
    def video_uri(done: dict[str, Any]) -> str:
        """The finished operation's video address; VideoError with why when there's none."""
        error = done.get("error")
        if isinstance(error, dict):
            message = " ".join(str(error.get("message") or "").split())[:200]
            raise VideoError(
                "Google couldn't make the video" + (f": {message}" if message else ".")
            )
        response = done.get("response") if isinstance(done.get("response"), dict) else {}
        made = response.get("generateVideoResponse")
        made = made if isinstance(made, dict) else {}
        for sample in made.get("generatedSamples") or []:
            video = sample.get("video") if isinstance(sample, dict) else None
            uri = video.get("uri") if isinstance(video, dict) else None
            if isinstance(uri, str) and uri:
                return uri
        if made.get("raiMediaFilteredCount"):
            reasons = made.get("raiMediaFilteredReasons") or []
            why = " ".join(str(reasons[0]).split())[:200] if reasons else ""
            raise VideoError(
                "Google's safety filters held the video back" + (f": {why}" if why else ".")
            )
        raise VideoError("Google finished without a video. Try describing it another way.")

    async def download(self, key: str, uri: str, prompt: str) -> dict[str, Any]:
        """Fetch the video and save it: {"id", "path", "name", "size"}."""
        if not _ours(uri):
            raise VideoError("Google gave an address for the video that isn't its own.")
        client, own = self._client()
        try:
            url, headers = uri, {"x-goog-api-key": key}
            for _hop in range(5):
                request = client.build_request("GET", url, headers=headers)
                try:
                    response = await client.send(request, stream=True)
                except httpx.TimeoutException:
                    raise VideoError("Google didn't send the video in time.") from None
                except httpx.HTTPError:
                    raise VideoError(
                        "I couldn't reach Google. Check the internet connection."
                    ) from None
                try:
                    if response.status_code in (301, 302, 303, 307, 308):
                        target = response.headers.get("location", "")
                        url = str(httpx.URL(url).join(target)) if target else ""
                        if urlparse(url).scheme != "https":
                            raise VideoError("Google sent the video somewhere it can't be fetched.")
                        headers = {"x-goog-api-key": key} if _ours(url) else {}
                        continue
                    if response.status_code != 200:
                        raise VideoError(
                            f"Google couldn't hand over the video ({response.status_code})."
                        )
                    return await self._save(response, prompt)
                finally:
                    await response.aclose()
            raise VideoError("Google sent the video round too many addresses.")
        finally:
            if own:
                await client.aclose()

    async def _save(self, response: httpx.Response, prompt: str) -> dict[str, Any]:
        self.folder.mkdir(parents=True, exist_ok=True)
        path = self._free_path(prompt)
        tmp = path.with_name(f".{path.name}.part")
        size, head = 0, b""
        try:
            with tmp.open("wb") as out:
                async for chunk in response.aiter_bytes():
                    size += len(chunk)
                    if size > MAX_VIDEO:
                        raise VideoError("Google's video is too big to keep.")
                    if len(head) < 12:
                        head += chunk[: 12 - len(head)]
                    out.write(chunk)
            if not _is_mp4(head):
                raise VideoError("Google sent something that isn't a video.")
            with contextlib.suppress(OSError):
                tmp.chmod(0o644)
            tmp.replace(path)
        except BaseException:
            with contextlib.suppress(OSError):
                tmp.unlink()
            raise
        ident = uuid.uuid4().hex
        self.made[ident] = path
        return {"id": ident, "path": str(path), "name": path.name, "size": size}

    def _free_path(self, prompt: str) -> Path:
        slug = re.sub(r"[^A-Za-z0-9 ]+", "", prompt).strip()[:50] or "Video"
        stamp = datetime.now().strftime("%Y-%m-%d %H%M%S")
        path = self.folder / f"{stamp} {slug}.mp4"
        n = 2
        while path.exists():
            path = self.folder / f"{stamp} {slug} {n}.mp4"
            n += 1
        return path

    async def _send(
        self, method: str, url: str, key: str, model: str = "", **kw: Any
    ) -> httpx.Response:
        if not _ours(url):  # never: every address here is the API's own
            raise VideoError("That isn't Google's address.")
        client, own = self._client()
        try:
            try:
                response = await client.request(
                    method,
                    url,
                    headers={"x-goog-api-key": key, "Content-Type": "application/json"},
                    **kw,
                )
            except httpx.TimeoutException:
                raise VideoError("Google didn't answer in time.") from None
            except httpx.HTTPError:
                raise VideoError(
                    "I couldn't reach Google. Check the internet connection."
                ) from None
        finally:
            if own:
                await client.aclose()
        if response.status_code == 200:
            return response
        said = _said(response.content)
        if response.status_code in (401, 403) or "API key not valid" in said:
            raise VideoError(
                "Google didn't accept the key for videos (Veo needs a paid Gemini API key)."
            )
        if response.status_code == 404:
            raise VideoError(
                f"Google has no video model called {model}."
                if model
                else "Google lost track of the video."
            )
        if response.status_code == 429:
            raise VideoError(
                "Google is limiting video requests on this key right now; try again later."
            )
        if response.status_code == 400:
            raise VideoError("Google wouldn't make that video" + (f": {said}" if said else "."))
        raise VideoError(f"Google had a problem ({response.status_code}); try again shortly.")

    def path_of(self, ident: str) -> Path | None:
        path = self.made.get(str(ident or ""))
        return path if path is not None and path.is_file() else None
