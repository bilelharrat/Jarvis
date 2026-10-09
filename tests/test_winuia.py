"""Reading and pressing a Windows app (winuia.py), against a made-up window tree standing in for
UI Automation: the outline a screen reader's user would hear, how a name is matched, and what
is pressed and how. (The real thing is exercised on a Windows desktop by the Windows workflow.)"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from jarvis import winuia

NAME, TYPE, OFFSCREEN, ENABLED, FOCUS, AUTOID, HELP, PID, VALUE, TOGGLE, SELECTED, EXPAND = (
    winuia.P_NAME, winuia.P_TYPE, winuia.P_OFFSCREEN, winuia.P_ENABLED, winuia.P_FOCUS, winuia.P_AUTOID,
    winuia.P_HELP, winuia.P_PID, winuia.P_VALUE, winuia.P_TOGGLE, winuia.P_SELECTED, winuia.P_EXPAND,
)  # fmt: skip
BUTTON, EDIT, MENUBAR, MENUITEM, STATUSBAR, TEXT, WINDOW, LIST, LISTITEM, CHECKBOX, PANE = (
    50000, 50004, 50010, 50011, 50017, 50020, 50032, 50008, 50007, 50002, 50033,
)  # fmt: skip
DOCUMENT = 50030


class El:
    """A stand-in for a cached IUIAutomationElement."""

    def __init__(self, kind, name="", kids=(), props=None, rect=(10, 20, 110, 60), invokable=True):
        self.props = {TYPE: kind, NAME: name, PID: 4242, **(props or {}), "invokable": invokable}
        for pattern, available in (
            (TOGGLE, winuia.A_TOGGLE),
            (SELECTED, winuia.A_SELECTION),
            (EXPAND, winuia.A_EXPAND),
            (VALUE, winuia.A_VALUE),
        ):
            if pattern in self.props:
                self.props[available] = True
        self.kids = list(kids)
        self.CachedBoundingRectangle = SimpleNamespace(
            left=rect[0], top=rect[1], right=rect[2], bottom=rect[3]
        )

    def GetCachedPropertyValue(self, pid):
        if pid not in self.props:
            raise OSError("not cached")
        return self.props[pid]


def walk(el):
    for kid in el.kids:
        yield kid
        yield from walk(kid)


class FakeRaw(winuia.Raw):
    """winuia.Raw without COM: the tree is made of El."""

    front = None
    invoked: list = []

    def __init__(self):
        self.ua = SimpleNamespace(Control=SimpleNamespace(CreateControlFromElement=self.control))

    def control(self, el):
        invoked = FakeRaw.invoked

        class Pattern:
            def Invoke(self):
                invoked.append(("invoke", el.props[NAME]))

        class Control:
            def GetInvokePattern(self):
                return Pattern() if el.props.get("invokable", True) else None

            def GetTogglePattern(self):
                return None

            def GetSelectionItemPattern(self):
                return None

            def GetExpandCollapsePattern(self):
                return None

        return Control()

    def children(self, el):
        return el.kids

    def everything_under(self, el):
        return list(walk(el))

    def foreground(self):
        return FakeRaw.front


@pytest.fixture
def desk(monkeypatch):
    monkeypatch.setattr(winuia, "Raw", FakeRaw)
    monkeypatch.setattr(
        winuia,
        "Apartment",
        lambda: SimpleNamespace(__enter__=lambda s: None, __exit__=lambda s, *a: None) and _Null(),
    )
    monkeypatch.setattr(winuia, "_process_name", lambda pid: "notepad.exe")
    FakeRaw.invoked = []
    return FakeRaw


class _Null:
    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False


def notepad():
    return El(WINDOW, "Untitled - Notepad", [
        El(MENUBAR, "Application", [
            El(MENUITEM, "File", props={EXPAND: 0}),
            El(MENUITEM, "Edit", props={EXPAND: 0}),
        ]),
        El(EDIT, "Text Editor", props={VALUE: "Hello from Jarvis", FOCUS: True}),
        El(PANE, "", [El(TEXT, "")]),  # layout: nothing to say
        El(BUTTON, "Hidden thing", props={OFFSCREEN: True}),
        El(STATUSBAR, "Status Bar", [El(TEXT, "Ln 1, Col 18"), El(TEXT, "UTF-8")]),
    ])  # fmt: skip


def test_the_window_is_read_in_order_with_what_each_control_holds_and_is(desk):
    desk.front = notepad()
    info = winuia.outline()
    assert (
        info["title"] == "Untitled - Notepad"
        and info["app"] == "notepad.exe"
        and not info["truncated"]
    )
    assert info["text"].splitlines() == [
        "menu bar: Application",
        "  menu item: File (collapsed)",
        "  menu item: Edit (collapsed)",
        "edit field: Text Editor, contains “Hello from Jarvis” (focused)",
        "status bar: Status Bar",
        "  text: Ln 1, Col 18",
        "  text: UTF-8",
    ]
    assert info["lines"] == 7


def test_layout_and_what_is_off_screen_are_left_out(desk):
    desk.front = notepad()
    text = winuia.outline()["text"]
    assert "Hidden thing" not in text and text.count("text:") == 2


def test_a_long_list_is_counted_not_read_out(desk):
    desk.front = El(
        WINDOW, "Files", [El(LIST, "Recent", [El(LISTITEM, f"file {i}.txt") for i in range(50)])]
    )
    lines = winuia.outline()["text"].splitlines()
    assert lines[0] == "list: Recent" and len(lines) == 1 + winuia.LIST_SHOWN + 1
    assert lines[-1].strip() == "… and 30 more"


def test_state_words_for_switches_selection_and_unavailable(desk):
    desk.front = El(WINDOW, "Settings", [
        El(CHECKBOX, "Dark mode", props={TOGGLE: 1}),
        El(CHECKBOX, "Notifications", props={TOGGLE: 0, ENABLED: False}),
        El(LISTITEM, "Home", props={SELECTED: True}),
    ])  # fmt: skip
    assert winuia.outline()["text"].splitlines() == [
        "check box: Dark mode (on)",
        "check box: Notifications (unavailable, off)",
        "list item: Home (selected)",
    ]


def test_a_placeholder_for_a_pattern_an_element_lacks_is_not_taken_for_a_state(desk):
    """UI Automation answers a missing pattern's property with a placeholder object, not nothing:
    it must not read as "partly on" or "expanded"."""
    placeholder = object()
    desk.front = El(
        WINDOW,
        "App",
        [El(MENUITEM, "Open", props={winuia.P_TOGGLE: placeholder, winuia.P_EXPAND: placeholder})],
    )
    assert winuia.outline()["text"] == "menu item: Open"
    leaf = El(MENUITEM, "Plain", props={winuia.P_EXPAND: 3})
    desk.front = El(WINDOW, "App", [leaf])
    assert winuia.outline()["text"] == "menu item: Plain"  # a leaf has nothing to expand


def test_a_window_with_nothing_in_front_says_so(desk):
    desk.front = None
    assert winuia.outline()["text"] == "No window is in front."
    assert winuia.press("File") == {"found": False, "app": ""}


def test_a_name_is_matched_exactly_first_then_by_start_then_by_words(desk):
    desk.front = El(WINDOW, "App", [
        El(TEXT, "Save as the default"),
        El(BUTTON, "Save All"),
        El(BUTTON, "Save"),
        El(BUTTON, "Autosave"),
    ])  # fmt: skip
    [first, second, third, fourth] = winuia.find_controls("save", limit=4)
    assert [first["name"], second["name"], third["name"], fourth["name"]] == [
        "Save",
        "Save All",
        "Autosave",
        "Save as the default",
    ]
    assert [m["name"] for m in winuia.find_controls("save", exact=True)] == ["Save"]
    assert winuia.find_controls("nothing like it") == []


def test_a_button_beats_a_text_label_of_the_same_name(desk):
    desk.front = El(WINDOW, "App", [El(TEXT, "Open"), El(BUTTON, "Open")])
    assert winuia.find_controls("open", limit=1)[0]["role"] == "button"


def test_find_only_says_what_would_be_pressed_and_presses_nothing(desk):
    desk.front = El(
        WINDOW, "App", [El(BUTTON, "Send", props={HELP: "Send the message", AUTOID: "sendBtn"})]
    )
    found = winuia.press("send", find_only=True)
    assert found == {
        "found": True,
        "name": "Send",
        "app": "notepad.exe",
        "labels": ["Send", "Send the message", "sendBtn"],
    }
    assert desk.invoked == []


def test_a_control_is_pressed_by_its_own_invoke(desk):
    desk.front = El(WINDOW, "App", [El(BUTTON, "Save")])
    out = winuia.press("Save")
    assert out["found"] and "x" not in out and desk.invoked == [("invoke", "Save")]


def test_a_control_with_nothing_to_invoke_gets_a_mouse_click_at_its_middle(desk):
    desk.front = El(WINDOW, "App", [El(BUTTON, "Tile", invokable=False, rect=(100, 200, 300, 260))])
    out = winuia.press("Tile")
    assert (out["x"], out["y"]) == (200, 230) and desk.invoked == []


def test_a_double_or_right_click_is_always_the_mouse(desk):
    desk.front = El(WINDOW, "App", [El(BUTTON, "Tile")])
    assert "x" in winuia.press("Tile", how="right click") and desk.invoked == []


def test_a_name_that_isnt_there_says_which_app_was_looked_in(desk):
    desk.front = notepad()
    assert winuia.press("Save as") == {"found": False, "app": "notepad.exe"}


def test_a_sentence_in_pieces_is_one_line_and_a_label_is_not_said_twice(desk):
    desk.front = El(WINDOW, "Eden Code", [
        El(BUTTON, "Voice off", [El(TEXT, "Voice off")]),
        El(PANE, "", [
            El(TEXT, "Talk or type. Eden Code plans, edits and explains, in"),
            El(TEXT, "your project"),
            El(TEXT, "."),
            El(TEXT, "Pick a session."),
        ]),
        El(STATUSBAR, "Status", [El(TEXT, "Ln 1, Col 2"), El(TEXT, "100%"), El(TEXT, "UTF-8")]),
    ])  # fmt: skip
    assert winuia.outline()["text"].splitlines() == [
        "button: Voice off",
        "text: Talk or type. Eden Code plans, edits and explains, in your project.",
        "text: Pick a session.",
        "status bar: Status",
        "  text: Ln 1, Col 2",
        "  text: 100%",
        "  text: UTF-8",
    ]


def test_a_web_address_is_read_without_what_follows_a_question_mark(desk):
    web = "http://127.0.0.1:5000/app/?token=secret123&app=code#top"
    desk.front = El(WINDOW, "Eden", [
        El(DOCUMENT, "Eden", props={VALUE: web}),
        El(EDIT, "Address and search bar", props={VALUE: "https://example.com/a?b=c"}),
    ])  # fmt: skip
    text = winuia.outline()["text"]
    assert "secret123" not in text and "token" not in text and "#top" not in text
    assert "contains “http://127.0.0.1:5000/app/”" in text
    assert "contains “https://example.com/a”" in text
    assert winuia._without_query("not an address ?x=1") == "not an address ?x=1"


def test_a_password_field_is_named_but_never_read(desk):
    desk.front = El(WINDOW, "Sign in", [
        El(EDIT, "Email", props={VALUE: "ann@example.com"}),
        El(EDIT, "Password", props={VALUE: "hunter2-secret", winuia.P_PASSWORD: True}),
    ])  # fmt: skip
    text = winuia.outline()["text"]
    assert "ann@example.com" in text and "hunter2" not in text
    assert "password field: Password" in text


def test_the_focused_password_field_is_not_read_either():
    class Password:
        IsPassword = True
        IsEnabled = True
        HasKeyboardFocus = True
        ControlTypeName = "EditControl"
        Name = "Password"

        def GetValuePattern(self):
            raise AssertionError("a password's value is never asked for")

    info = winuia.describe(Password())
    assert info["role"] == "password field" and info["value"] == ""


def test_a_browsers_page_has_its_own_title_and_address(desk, monkeypatch):
    monkeypatch.setattr(winuia, "_process_name", lambda pid: "msedge.exe")
    desk.front = El(WINDOW, "Docs - Work - Microsoft Edge", [
        El(EDIT, "Address and search bar", props={VALUE: "https://example.com/docs?q=1"}),
        El(DOCUMENT, "Docs", props={VALUE: "https://example.com/docs?q=1"}),
    ])  # fmt: skip
    assert winuia.page_address() == {
        "url": "https://example.com/docs?q=1",
        "title": "Docs",
        "app": "msedge.exe",
    }
    desk.front = El(WINDOW, "Notes - Notepad", [El(EDIT, "Text Editor")])
    monkeypatch.setattr(winuia, "_process_name", lambda pid: "notepad.exe")
    assert winuia.page_address() == {}
