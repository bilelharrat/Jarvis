"""Pictures with the owner's Google Gemini key (jarvis.imagegen, jarvis.features.pictures):
the request Google gets and what comes back, saved in the test's own folder; asked on a card
unless the owner's own words asked; capped a day across restarts; opened only by id. Google
is a fake (httpx.MockTransport): nothing leaves the Mac."""

import asyncio
import base64
import json

import httpx
import pytest
from conftest import FakeClient

from jarvis import brain, imagegen, lang, utility_model
from jarvis.features import pictures as pictures_feature
from jarvis.hub import Hub
from jarvis.imagegen import ImageDesk, ImageError

GOOGLE_KEY = "AIza" + "x" * 35
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
JPEG = b"\xff\xd8\xff\xe0" + b"\x01" * 64


def picture(data: bytes = PNG, mime: str = "image/png", words: str = "Here it is.") -> dict:
    parts = [{"text": words}] if words else []
    parts.append({"inlineData": {"mimeType": mime, "data": base64.b64encode(data).decode()}})
    return {"candidates": [{"content": {"parts": parts}}]}


class Google:
    """A fake Gemini API: each request kept, each answer from the script (the last repeats)."""

    def __init__(self, *answers: tuple[int, object]) -> None:
        self.answers = list(answers) or [(200, picture())]
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        status, body = self.answers[min(len(self.requests), len(self.answers)) - 1]
        if isinstance(body, bytes):
            return httpx.Response(status, content=body)
        return httpx.Response(status, json=body)

    def client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(transport=httpx.MockTransport(self))


# ── the desk ──


async def test_a_picture_is_asked_for_saved_and_handed_back(tmp_path):
    google = Google()
    desk = ImageDesk(tmp_path / "Images", google.client())
    made = await desk.generate(GOOGLE_KEY, "  a fox   in the snow ", aspect="16:9")
    [request] = google.requests
    assert str(request.url) == (
        "https://generativelanguage.googleapis.com/v1beta/models/"
        "gemini-2.5-flash-image:generateContent"
    )
    assert request.headers["x-goog-api-key"] == GOOGLE_KEY and "key=" not in str(request.url)
    body = json.loads(request.content)
    assert body["contents"] == [{"role": "user", "parts": [{"text": "a fox in the snow"}]}]
    assert body["generationConfig"] == {
        "responseModalities": ["TEXT", "IMAGE"],
        "imageConfig": {"aspectRatio": "16:9"},
    }
    saved = tmp_path / "Images" / made["name"]
    assert made["path"] == str(saved) and saved.read_bytes() == PNG
    assert made["name"].endswith(" a fox in the snow.png") and made["mime"] == "image/png"
    assert base64.b64decode(made["data"]) == PNG and made["text"] == "Here it is."
    assert desk.path_of(made["id"]) == saved and desk.path_of("nope") is None
    assert not list((tmp_path / "Images").glob(".*"))  # no half-written file left behind


async def test_names_stay_in_the_folder_and_never_overwrite(tmp_path):
    google = Google((200, picture(JPEG, "image/jpeg", words="")))
    desk = ImageDesk(tmp_path / "Images", google.client())
    one = await desk.generate(GOOGLE_KEY, "../../etc/passwd")
    two = await desk.generate(GOOGLE_KEY, "../../etc/passwd")
    for made in (one, two):
        assert (tmp_path / "Images" / made["name"]).is_file() and "/" not in made["name"]
        assert made["mime"] == "image/jpeg" and made["text"] == ""
    assert one["path"] != two["path"] and one["id"] != two["id"]
    unaspected = json.loads(google.requests[0].content)["generationConfig"]
    assert "imageConfig" not in unaspected  # no aspect given: Google's own


async def test_a_vertex_key_goes_to_vertex_first_and_a_refused_key_tries_the_other(tmp_path):
    google = Google((401, {"error": {"message": "API key not valid."}}), (200, picture()))
    desk = ImageDesk(tmp_path, google.client())
    await desk.generate("AQ." + "y" * 40, "a lighthouse")
    assert [r.url.host for r in google.requests] == [
        "aiplatform.googleapis.com",
        "generativelanguage.googleapis.com",
    ]
    refused = Google((403, {"error": {"message": "denied"}}))
    with pytest.raises(ImageError, match="didn't accept the key"):
        await ImageDesk(tmp_path, refused.client()).generate(GOOGLE_KEY, "a lighthouse")
    assert len(refused.requests) == 2  # both of Google's doors, then it gives up


@pytest.mark.parametrize(
    ("status", "body", "why"),
    [
        (404, {"error": {"message": "not found"}}, "no image model called gemini-2.5-flash-image"),
        (429, {"error": {"message": "quota"}}, "limiting requests"),
        (
            400,
            {"error": {"message": "It breaks the rules."}},
            "wouldn't make that picture: It breaks",
        ),
        (500, b"oops", r"a problem \(500\)"),
        (302, b"", r"a problem \(302\)"),  # never followed anywhere
        (200, b"not json", "not with a picture"),
        (
            200,
            {"candidates": [{"content": {"parts": [{"text": "I can't draw that."}]}}]},
            "made no picture: I can't draw that",
        ),
        (200, {"candidates": []}, "Try describing it another way"),
        (200, picture(b"<html>not a picture</html>"), "isn't a picture"),
        (
            200,
            {"candidates": [{"content": {"parts": [{"inlineData": {"data": "@@@"}}]}}]},
            "damaged",
        ),
    ],
)
async def test_what_google_says_comes_back_in_words(tmp_path, status, body, why):
    google = Google((status, body))
    with pytest.raises(ImageError, match=why):
        await ImageDesk(tmp_path / "Images", google.client()).generate(GOOGLE_KEY, "a boat")
    assert not (tmp_path / "Images").exists() or not any((tmp_path / "Images").iterdir())


async def test_too_big_nothing_to_draw_or_no_key_sends_nothing(tmp_path, monkeypatch):
    google = Google((200, picture(PNG + b"\x00" * 200)))
    desk = ImageDesk(tmp_path, google.client())
    monkeypatch.setattr(imagegen, "MAX_IMAGE", 100)
    with pytest.raises(ImageError, match="too big"):
        await desk.generate(GOOGLE_KEY, "a huge poster")
    google.requests.clear()
    with pytest.raises(ImageError, match="should show"):
        await desk.generate(GOOGLE_KEY, "   ")
    with pytest.raises(ImageError, match="no Google Gemini key"):
        await desk.generate("", "a cat")
    assert google.requests == []


async def test_a_network_failure_says_so(tmp_path):
    def down(request):
        raise httpx.ConnectError("no route", request=request)

    def slow(request):
        raise httpx.ReadTimeout("slow", request=request)

    for handler, why in ((down, "couldn't reach Google"), (slow, "didn't answer in time")):
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        with pytest.raises(ImageError, match=why):
            await ImageDesk(tmp_path, client).generate(GOOGLE_KEY, "a cat")


def test_model_names_and_what_they_cost():
    assert imagegen.clean_model(" gemini-3-pro-image-preview ") == "gemini-3-pro-image-preview"
    for bad in ("", "a", "../models", "gemini image", "x" * 90, None):
        assert imagegen.clean_model(bad) is None
    assert imagegen.cost_note(imagegen.DEFAULT_MODEL) == "about 4 cents a picture"
    assert imagegen.cost_note("gemini-3-pro-image-preview") == (
        "Google's price for gemini-3-pro-image-preview"
    )


# ── the feature ──


def make_hub(settings, quiet_speaker, isolated):
    return Hub(settings, client_factory=FakeClient, speaker=quiet_speaker, poll=False, **isolated)


@pytest.fixture
def hub(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated)
    hub.providers.add_provider("gemini", "", GOOGLE_KEY)
    hub.google = Google()
    hub.pictures.desk.client = hub.google.client()
    hub.opened = []
    hub.pictures.open = lambda *args: hub.opened.append(args)  # never a real app
    hub.events = []
    hub.emit = lambda kind, **data: hub.events.append((kind, data))
    return hub


async def call(hub, args, name="generate_image"):
    tools = {t.name: t for t in hub.pictures.build_tools()}
    return await tools[name].handler(args)


async def answer_card(hub, choice, cards):
    """Answer the card when it comes up (the key is read in a thread first: wait for it)."""
    for _ in range(3000):
        if hub.approvals:
            card = next(iter(hub.approvals.values()))
            cards.append(card)
            hub.resolve(card["id"], choice)
            return
        await asyncio.sleep(0.01)
    raise AssertionError("no card came up")


async def test_the_owners_own_words_make_it_at_once(hub):
    hub._rid = "r7"
    hub._turn_text = "draw a fox in the snow"
    said = await call(
        hub, {"prompt": "A red fox in fresh snow, watercolour", "aspect_ratio": "4:3"}
    )
    text = said["content"][0]["text"]
    assert not said.get("is_error") and text.startswith("Made it: ")
    assert "about 4 cents a picture" in text and "Documents › Jarvis › Images" in text
    [(kind, made)] = [e for e in hub.events if e[0] == "image_made"]
    assert made["rid"] == "r7" and made["prompt"] == "A red fox in fresh snow, watercolour"
    assert made["mime"] == "image/png" and base64.b64decode(made["data"]) == PNG
    assert made["cost"] == "about 4 cents a picture"
    assert made["path"].startswith(str(hub.feature_path("Images")))  # never ~/Documents here
    assert not hub.approvals and len(hub.google.requests) == 1
    assert brain.result_kind("mcp__pictures__generate_image") == "none"


async def test_anything_else_asks_first_with_the_description_and_the_price(hub):
    cards = []
    hub._turn_text = "what's on my calendar?"  # a page, a mail or the model asked: not the owner
    refused, _ = await asyncio.gather(
        call(hub, {"prompt": "A logo for the owner's bank"}), answer_card(hub, "deny", cards)
    )
    assert refused.get("is_error") and "didn't want" in refused["content"][0]["text"]
    assert hub.google.requests == [] and not any(e[0] == "image_made" for e in hub.events)
    [card] = cards
    assert card["question"] == "Make a picture with Google Gemini?"
    assert card["detail"].startswith("A logo for the owner's bank\n\n")
    assert "about 4 cents a picture" in card["detail"]
    made, _ = await asyncio.gather(
        call(hub, {"prompt": "A lighthouse"}), answer_card(hub, "allow", cards)
    )
    assert not made.get("is_error") and len(hub.google.requests) == 1


async def test_after_private_reads_even_the_owners_words_ask(hub):
    cards = []
    hub._rid = "r1"
    hub._turn_text = "make me a picture of what's in my inbox"
    hub.note_tool_result("mcp__mac__list_emails")  # the description may carry the inbox out
    refused, _ = await asyncio.gather(
        call(hub, {"prompt": "Mail from Ann about the loan"}), answer_card(hub, "deny", cards)
    )
    assert refused.get("is_error") and len(cards) == 1 and hub.google.requests == []


async def test_in_chinese_the_owners_words_count_too(hub):
    hub.prefs.language = "zh"
    hub._turn_text = "帮我画一只猫"
    said = await call(hub, {"prompt": "A cat"})
    assert not said.get("is_error") and not hub.approvals
    hub.pictures.state({})
    assert hub.events[-1][1]["cost"] == "每张大约 4 美分"


async def test_no_key_no_picture_and_no_card(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated)
    google = Google()
    hub.pictures.desk.client = google.client()
    hub._turn_text = "draw a cat"
    said = await call(hub, {"prompt": "A cat"})
    assert said.get("is_error") and "no Google Gemini key" in said["content"][0]["text"]
    assert google.requests == [] and not hub.approvals
    events = []
    hub.emit = lambda kind, **data: events.append((kind, data))
    hub.pictures.state({})
    assert events[-1][1]["key"] is False


async def test_a_day_holds_so_many_even_across_a_restart(hub, settings, quiet_speaker, isolated):
    hub._turn_text = "draw a cat"
    usage = utility_model.usage_for(hub)
    usage.counts["picture"] = imagegen.PER_DAY - 1
    assert not (await call(hub, {"prompt": "A cat"})).get("is_error")
    over = await call(hub, {"prompt": "Another cat"})
    assert over.get("is_error") and "50 pictures today" in over["content"][0]["text"]
    assert len(hub.google.requests) == 1  # the one past the cap was never sent
    again = make_hub(settings, quiet_speaker, isolated)  # the app started again: same count
    again.pictures.desk.client = hub.google.client()
    again._turn_text = "draw a cat"
    assert "50 pictures today" in (await call(again, {"prompt": "A cat"}))["content"][0]["text"]
    assert len(hub.google.requests) == 1


async def test_another_model_is_used_and_its_price_is_googles(hub):
    hub.set_feature_prefs({"image_model": "not a model!"})  # refused: the default stays
    assert hub.pictures.model() == imagegen.DEFAULT_MODEL
    hub.set_feature_prefs({"image_model": "gemini-3-pro-image-preview"})
    hub._turn_text = "draw a cat"
    said = await call(hub, {"prompt": "A cat"})
    assert "/gemini-3-pro-image-preview:generateContent" in str(hub.google.requests[0].url)
    assert "Google's price for gemini-3-pro-image-preview" in said["content"][0]["text"]


async def test_the_window_opens_only_pictures_made_here(hub):
    hub._turn_text = "draw a cat"
    await call(hub, {"prompt": "A cat"})
    made = next(data for kind, data in hub.events if kind == "image_made")
    await hub._handle({"type": "image_open", "id": made["id"]})
    await hub._handle({"type": "image_reveal", "id": made["id"]})
    await hub._handle({"type": "image_open", "id": "../../etc"})
    await hub._handle({"type": "image_reveal", "path": "/etc/passwd"})
    assert hub.opened == [(made["path"],), ("-R", made["path"])]
    await hub._handle({"type": "pictures_folder"})
    assert hub.opened[-1] == (str(hub.feature_path("Images")),)
    await hub._handle({"type": "pictures_state"})
    kind, state = hub.events[-1]
    assert kind == "pictures" and state["key"] is True and state["model"] == imagegen.DEFAULT_MODEL
    assert state["default_model"] == imagegen.DEFAULT_MODEL and state["folder"].endswith("Images")


# ── words ──


@pytest.mark.parametrize(
    ("said", "language", "asked"),
    [
        ("draw a fox in the snow", "en", True),
        ("make me a picture of a castle", "en", True),
        ("could you design a logo for my bakery", "en", True),
        ("generate three images of a red car", "en", True),
        ("paint me a sunset over the sea", "en", True),
        ("draw up the contract", "en", False),
        ("show me pictures of Paris", "en", False),
        ("what's in this picture", "en", False),
        ("make a note of that", "en", False),
        ("画一只猫", "zh", True),
        ("帮我生成一张海报", "zh", True),
        ("设计一个图标", "zh", True),
        ("画好了吗", "zh", False),
        ("你画了什么呢", "zh", False),
        ("画面很好看", "zh", False),
        ("画一只猫", "en", False),  # Chinese words count when Chinese is the language
    ],
)
def test_the_words_that_ask_for_a_picture(said, language, asked):
    assert pictures_feature.ASKED.said(said, language) is asked


def test_its_chinese():
    for english, chinese in pictures_feature.ZH.items():
        assert lang.translate(english, "zh") == chinese or "{" in english, english
    assert (
        lang.translate("Google's price for gemini-x-image", "zh")
        == "Google 对 gemini-x-image 的定价"
    )


# ── editing a picture ──


async def test_a_picture_is_edited_from_the_one_sent_with_the_request(hub):
    hub._turn_text = "remove the background from this photo"
    hub.last_pictures = [{"media_type": "image/jpeg", "data": base64.b64encode(JPEG).decode()}]
    said = await call(
        hub, {"instruction": "Remove the background", "image": "attached"}, "edit_image"
    )
    assert not said.get("is_error") and said["content"][0]["text"].startswith("Edited it: ")
    [request] = hub.google.requests
    parts = json.loads(request.content)["contents"][0]["parts"]
    assert parts[0]["inlineData"] == {
        "mimeType": "image/jpeg",
        "data": base64.b64encode(JPEG).decode(),
    }
    assert parts[1] == {"text": "Remove the background"}
    assert [e for e in hub.events if e[0] == "image_made"]


async def test_editing_needs_a_picture_and_stays_in_the_home_folder(hub, tmp_path):
    hub._turn_text = "edit this picture"
    hub.last_pictures = []
    said = await call(hub, {"instruction": "Make it brighter"}, "edit_image")
    assert said["is_error"] and "No picture came with a request" in said["content"][0]["text"]
    outside = await call(hub, {"instruction": "x", "image": "/etc/hosts"}, "edit_image")
    assert outside["is_error"] and "home folder" in outside["content"][0]["text"]
    assert hub.google.requests == []


async def test_the_last_picture_made_here_can_be_edited(hub):
    hub._turn_text = "draw a fox, then make the picture night-time"
    await call(hub, {"prompt": "A fox"})
    said = await call(hub, {"instruction": "Make it night", "image": "last"}, "edit_image")
    assert not said.get("is_error")
    parts = json.loads(hub.google.requests[-1].content)["contents"][0]["parts"]
    assert base64.b64decode(parts[0]["inlineData"]["data"]) == PNG


async def test_not_a_picture_isnt_sent(tmp_path):
    desk = ImageDesk(tmp_path / "Images", Google().client())
    with pytest.raises(ImageError, match="can't be edited"):
        await desk.generate(GOOGLE_KEY, "brighter", source=(b"not a picture", "image/png"))
