"""Instant voice control of the whole Mac: what's heard as a command, and what it does
(with fakes: nothing here opens, clicks or types on the real Mac)."""

import pytest

from jarvis import system_voice
from jarvis.system_voice import Command, parse, spoken_keys

# The real one: conftest swaps the module's for a stand-in in every test.
from jarvis.system_voice import carry_out as real_carry_out  # noqa: I001


@pytest.mark.parametrize(
    ("said", "kind", "arg"),
    [
        ("open Safari", "open", "safari"),
        ("please launch the app Notes", "open", "notes"),
        ("switch to Mail", "focus", "mail"),
        ("go to Slack", "focus", "slack"),
        ("quit Spotify", "quit", "spotify"),
        ("hide Finder", "hide", "finder"),
        ("new tab", "keys", "cmd+t"),
        ("go back", "keys", "cmd+["),
        ("take a screenshot", "keys", "cmd+shift+3"),
        ("press command shift T", "keys", "cmd+shift+t"),
        ("hit escape", "keys", "escape"),
        ("press the up arrow", "keys", "up"),
        ("press command and two", "keys", "cmd+2"),
        ("scroll down", "scroll", "down"),
        ("scroll up a lot", "scroll", "up"),
        ("page down", "keys", "pagedown"),
        ("volume up", "volume", "up"),
        ("make it quieter", "volume", "down"),
        ("mute", "volume", "mute"),
        ("set the volume to 30", "volume", "set"),
        ("click", "point", "click"),
        ("double click here", "point", "double click"),
        ("click the Save button", "click", "save"),
        ("right click on Downloads", "click", "downloads"),
        ("type Hello there", "type", "Hello there"),
        ("mission control", "mission", ""),
    ],
)
def test_what_is_heard_as_a_command(said, kind, arg):
    command = parse(said)
    assert command is not None and (command.kind, command.arg) == (kind, arg)


@pytest.mark.parametrize(
    "said",
    [
        "show me the weather",  # a question, not the Weather app
        "write down that the meeting moved",  # a note for Claude, not keys
        "press the gas pedal",  # not keys
        "what's the weather like",
        "start voice coding",
        "",
    ],
)
def test_the_rest_goes_to_claude(said):
    assert parse(said) is None


def test_spoken_keys():
    assert spoken_keys("command option i") == "cmd+option+i"
    assert spoken_keys("control shift tab") == "ctrl+shift+tab"
    assert spoken_keys("f5") == "f5"
    assert spoken_keys("page down") == "pagedown"
    assert spoken_keys("banana") is None


class Fake:
    """The Mac, recorded."""

    def __init__(self, apps=("Safari", "Google Chrome", "Mail", "Notes"), click=None):
        self.apps = apps
        self.ran: list[tuple] = []
        self.keys: list[str] = []
        self.mouse: list[tuple] = []
        self.scrolls: list[tuple] = []
        self.typed: list[str] = []
        self.click = click or '{"found": true, "name": "save", "app": "TextEdit"}'

    async def run(self, *args, timeout=30):
        self.ran.append(args)
        if args[0] == "mdfind":
            return "\n".join(f"/Applications/{a}.app" for a in self.apps)
        if args[:3] == ("osascript", "-l", "JavaScript"):
            return self.click
        return ""

    def _post_keys(self, combo):
        self.keys.append(combo)

    def _post_scroll(self, dy, dx=0):
        self.scrolls.append((dy, dx))

    def _post_mouse(self, kind, x, y, button="left", clicks=1):
        self.mouse.append((kind, x, y, button, clicks))

    def _post_text(self, text):
        self.typed.append(text)

    def mouse_position(self):
        return (100.0, 200.0)


async def test_apps_open_by_their_spoken_names():
    mac = Fake()
    assert await real_carry_out(Command("open", "chrome"), mac.run, mac) == "Opening Google Chrome."
    assert ("open", "-a", "Google Chrome") in mac.ran
    assert await real_carry_out(Command("focus", "mail"), mac.run, mac) == "Switched to Mail."
    quit_ = await real_carry_out(Command("quit", "notes"), mac.run, mac)
    assert quit_ == "Quitting Notes." and 'tell application "Notes" to quit' in mac.ran[-1]


async def test_not_an_app_goes_to_claude():
    mac = Fake()
    assert await real_carry_out(Command("open", "the pod bay doors"), mac.run, mac) is None
    assert not [r for r in mac.ran if r[0] == "open"]


async def test_keys_scroll_type_and_clicks_where_the_pointer_is():
    mac = Fake()
    await real_carry_out(Command("keys", "cmd+t"), mac.run, mac)
    await real_carry_out(Command("scroll", "down", {"amount": 10}), mac.run, mac)
    await real_carry_out(Command("type", "Hello"), mac.run, mac)
    await real_carry_out(Command("point", "double click"), mac.run, mac)
    assert mac.keys == ["cmd+t"] and mac.scrolls == [(-10, 0)] and mac.typed == ["Hello"]
    assert mac.mouse == [("click", 100.0, 200.0, "left", 2)]


async def test_a_button_is_pressed_by_its_name():
    mac = Fake()
    assert await real_carry_out(Command("click", "save", {"how": "click"}), mac.run, mac) == "Done."
    assert mac.ran[-1][:3] == ("osascript", "-l", "JavaScript") and mac.ran[-1][-2:] == (
        "save",
        "click",
    )
    missing = Fake(click='{"found": false, "app": "TextEdit"}')
    reply = await real_carry_out(
        Command("click", "frobnicate", {"how": "click"}), missing.run, missing
    )
    assert reply == "I don't see “frobnicate” in TextEdit."
    right = Fake(click='{"found": true, "name": "downloads", "app": "Finder", "x": 40, "y": 60}')
    await real_carry_out(Command("click", "downloads", {"how": "right click"}), right.run, right)
    assert right.mouse == [("click", 40.0, 60.0, "right", 1)]


@pytest.mark.parametrize(
    "label", ["send", "Buy now", "delete", "Place order", "Sign out", "empty trash"]
)
async def test_sending_paying_and_deleting_stay_yours(label):
    mac = Fake()
    reply = await real_carry_out(Command("click", label.lower(), {"how": "click"}), mac.run, mac)
    assert reply.endswith("is one I leave for you to press.")
    assert not mac.ran and not mac.mouse


async def test_a_found_button_named_risky_is_left_alone():
    mac = Fake(click='{"found": true, "name": "send message", "app": "Messages", "x": 1, "y": 2}')
    reply = await real_carry_out(Command("click", "message", {"how": "click"}), mac.run, mac)
    assert reply == "“send message” is one I leave for you to press." and not mac.mouse


async def test_with_free_control_the_users_own_click_presses_anything():
    mac = Fake(click='{"found": true, "name": "send message", "app": "Messages", "x": 1, "y": 2}')
    reply = await real_carry_out(
        Command("click", "send", {"how": "click"}), mac.run, mac, free=True
    )
    assert reply == "Done." and mac.mouse == [("click", 1.0, 2.0, "left", 1)]


def test_the_stand_in_is_what_other_tests_get():
    assert system_voice.carry_out is not real_carry_out
