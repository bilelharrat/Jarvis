"""Pictures, made with Gemini on the owner's own Google key (the one added in Settings › Models
as Google Gemini): the brain's generate_image saves each one in Documents › Jarvis › Images
and shows it on a card in the window (Open, Show in Finder).

The key: read from the Keychain only as the providers store hands it out (sealed with Google's
address), and sent only to Google: the Gemini API, or Vertex AI express mode for an "AQ." key,
the same two places JARVIS's Gemini relay sends it.

Asking first: making a picture sends its description to Google and spends money on the
owner's key. It goes ahead when the owner's own words this turn asked for a picture and the
turn hasn't read their private data or a web page; otherwise a card (said aloud) shows the
description first.

Cost policy: Google's price, not a Claude call. The default model, gemini-2.5-flash-image
("Nano Banana"), costs about 4 cents a picture ($30 per million output tokens, 1,290 tokens a
picture); the owner can name another image model in Settings (then it's that model's price).
At most PER_DAY pictures a day, counted across restarts (features.pictures, through
utility_model's daily counts). Nothing is made unless the owner (or JARVIS at their request)
asks.
"""

from __future__ import annotations

import base64
import contextlib
import hashlib
import json
import re
from datetime import datetime
from pathlib import Path
from typing import Any

import httpx

from .gemini_proxy import GEMINI_API, VERTEX_EXPRESS

DEFAULT_MODEL = "gemini-2.5-flash-image"
COST_NOTE = "about 4 cents a picture"
PER_DAY = 50
MAX_PROMPT = 2000
# Bytes of one picture: it reaches the window as base64 in one event, well inside the 32 MB a
# window may have waiting (hub.WINDOW_BYTES). Gemini's are about 1-2 MB.
MAX_IMAGE = 12 * 1024 * 1024
ASPECTS = ("1:1", "3:2", "2:3", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9")
_MODEL = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{2,80}")
_KINDS = {
    b"\x89PNG": ("image/png", ".png"),
    b"\xff\xd8\xff": ("image/jpeg", ".jpg"),
    b"RIFF": ("image/webp", ".webp"),
}


def default_folder() -> Path:
    return Path.home() / "Documents" / "Jarvis" / "Images"


def clean_model(value: Any) -> str | None:
    text = str(value or "").strip()
    return text if _MODEL.fullmatch(text) else None


def cost_note(model: str) -> str:
    """What a picture costs, in words: known for the default model only."""
    return COST_NOTE if model == DEFAULT_MODEL else f"Google's price for {model}"


class ImageError(Exception):
    """Why no picture was made, in words to say."""


def _kind(data: bytes) -> tuple[str, str] | None:
    for magic, kind in _KINDS.items():
        if data.startswith(magic):
            return kind
    return None


def _said(body: bytes) -> str:
    try:
        data = json.loads(body)
    except (ValueError, RecursionError):
        return ""
    error = data.get("error") if isinstance(data, dict) else None
    message = error.get("message") if isinstance(error, dict) else ""
    return " ".join(str(message or "").split())[:200]


class ImageDesk:
    def __init__(self, folder: Path, client: httpx.AsyncClient | None = None) -> None:
        self.folder = folder
        self.client = client  # tests give one; the app makes one per picture
        self.made: dict[str, Path] = {}  # what the window may open: the pictures made here

    def _urls(self, key: str, model: str) -> list[str]:
        gemini = f"{GEMINI_API}/{model}:generateContent"
        vertex = f"{VERTEX_EXPRESS}/{model}:generateContent"
        return [vertex, gemini] if key.startswith("AQ.") else [gemini, vertex]

    async def generate(
        self,
        key: str,
        prompt: str,
        *,
        model: str = DEFAULT_MODEL,
        aspect: str = "",
        source: tuple[bytes, str] | None = None,
    ) -> dict[str, Any]:
        """One picture: {"id", "path", "name", "mime", "data" (base64), "text"}. ImageError
        (in words to say) when Google made none. source: a picture to change ((bytes, its
        media type)); then prompt says how."""
        prompt = " ".join(str(prompt or "").split())[:MAX_PROMPT]
        if not prompt:
            raise ImageError("Say what the picture should show.")
        if not key:
            raise ImageError(
                "There's no Google Gemini key: add one in Settings › Models to make pictures."
            )
        parts: list[dict[str, Any]] = [{"text": prompt}]
        if source is not None:
            raw_in, mime_in = source
            if len(raw_in) > MAX_IMAGE or _kind(raw_in) is None:
                raise ImageError("That picture can't be edited: it's too big or not a picture.")
            parts.insert(
                0, {"inlineData": {"mimeType": mime_in, "data": base64.b64encode(raw_in).decode()}}
            )
        body: dict[str, Any] = {
            "contents": [{"role": "user", "parts": parts}],
            "generationConfig": {"responseModalities": ["TEXT", "IMAGE"]},
        }
        if aspect in ASPECTS:
            body["generationConfig"]["imageConfig"] = {"aspectRatio": aspect}
        own = self.client is None
        client = self.client or httpx.AsyncClient(
            timeout=httpx.Timeout(120, connect=15), follow_redirects=False
        )
        try:
            data = await self._ask(client, key, model, body)
        finally:
            if own:
                await client.aclose()
        picture, words = None, []
        for candidate in (data.get("candidates") or [])[:1]:
            for part in (candidate.get("content") or {}).get("parts") or []:
                inline = part.get("inlineData") or part.get("inline_data")
                if isinstance(inline, dict) and inline.get("data") and picture is None:
                    picture = inline
                elif part.get("text") and not part.get("thought"):
                    words.append(str(part["text"]))
        if picture is None:
            why = " ".join(" ".join(words).split())[:200]
            raise ImageError(
                "Google made no picture"
                + (f": {why}" if why else ". Try describing it another way.")
            )
        try:
            raw = base64.b64decode(picture["data"], validate=True)
        except (ValueError, TypeError):
            raise ImageError("Google's picture came back damaged.") from None
        kind = _kind(raw)
        if kind is None:
            raise ImageError("Google sent something that isn't a picture.")
        if len(raw) > MAX_IMAGE:
            raise ImageError("Google's picture is too big to show here.")
        path = self._save(prompt, raw, kind[1])
        ident = hashlib.sha256(str(path).encode()).hexdigest()[:16]
        self.made[ident] = path
        return {
            "id": ident,
            "path": str(path),
            "name": path.name,
            "mime": kind[0],
            "data": base64.b64encode(raw).decode(),
            "text": " ".join(" ".join(words).split())[:300],
        }

    async def _ask(
        self, client: httpx.AsyncClient, key: str, model: str, body: dict[str, Any]
    ) -> dict[str, Any]:
        last = ""
        for url in self._urls(key, model):
            try:
                response = await client.post(
                    url,
                    json=body,
                    headers={"x-goog-api-key": key, "Content-Type": "application/json"},
                )
            except httpx.TimeoutException:
                raise ImageError("Google didn't answer in time.") from None
            except httpx.HTTPError:
                raise ImageError(
                    "I couldn't reach Google. Check the internet connection."
                ) from None
            if response.status_code == 200:
                try:
                    data = response.json()
                except ValueError:
                    raise ImageError("Google answered, but not with a picture.") from None
                return data if isinstance(data, dict) else {}
            said = _said(response.content)
            if response.status_code in (401, 403) or "API key not valid" in said:
                last = "Google didn't accept the key."
                continue  # the other endpoint may take this kind of key
            if response.status_code == 404:
                last = f"Google has no image model called {model}."
                continue
            if response.status_code == 429:
                raise ImageError(
                    "Google is limiting requests on this key right now; try again in a minute."
                )
            if response.status_code == 400:
                raise ImageError(
                    "Google wouldn't make that picture" + (f": {said}" if said else ".")
                )
            raise ImageError(f"Google had a problem ({response.status_code}); try again shortly.")
        raise ImageError(last or "Google made no picture.")

    def _save(self, prompt: str, raw: bytes, suffix: str) -> Path:
        self.folder.mkdir(parents=True, exist_ok=True)
        slug = re.sub(r"[^A-Za-z0-9 ]+", "", prompt).strip()[:50] or "Picture"
        stamp = datetime.now().strftime("%Y-%m-%d %H%M%S")
        path = self.folder / f"{stamp} {slug}{suffix}"
        n = 2
        while path.exists():
            path = self.folder / f"{stamp} {slug} {n}{suffix}"
            n += 1
        tmp = path.with_name(f".{path.name}.part")
        tmp.write_bytes(raw)
        with contextlib.suppress(OSError):
            tmp.chmod(0o644)
        tmp.replace(path)
        return path

    def path_of(self, ident: str) -> Path | None:
        path = self.made.get(str(ident or ""))
        return path if path is not None and path.is_file() else None
