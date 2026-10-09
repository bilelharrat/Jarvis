"""The forms helper on a PC (winforms.py, features/forms.py), against a made-up window standing in
for UI Automation: fields read with their labels, kinds, values and whether they're required;
answers filled one by one after one approval, each read back; passwords never touched; a Mac
told it is a PC feature."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest
from test_winuia import BUTTON, CHECKBOX, EDIT, LISTITEM, PANE, TEXT, WINDOW, El, FakeRaw, _Null

from jarvis import osplat, winforms, winuia
from jarvis.features import forms

NAME, VALUE, TOGGLE, SELECTED, HELP = (
    winuia.P_NAME, winuia.P_VALUE, winuia.P_TOGGLE, winuia.P_SELECTED, winuia.P_HELP,
)  # fmt: skip
COMBO, RADIO, GROUP = 50003, 50013, 50026


def edit(name="", value="", more=None):
    return El(EDIT, name, props={VALUE: value, winuia.P_READONLY: False, **(more or {})})


def application_form():
    return El(WINDOW, "Library card application - Edge", [
        El(TEXT, "Apply for a library card"),
        El(TEXT, "Full name *"),
        edit(),  # labelled by the text before it
        edit("Email", "", {winuia.P_REQUIRED: True}),
        edit("Password", "", {winuia.P_PASSWORD: True}),
        El(COMBO, "Branch", [El(LISTITEM, "Main library"), El(LISTITEM, "Science library")],
           props={VALUE: "", winuia.P_READONLY: True}),
        El(GROUP, "Card type", [
            El(RADIO, "Student", props={SELECTED: False}, rect=(20, 210, 120, 230)),
            El(RADIO, "Staff", props={SELECTED: False}, rect=(20, 240, 120, 260)),
        ], rect=(10, 200, 300, 270)),
        El(CHECKBOX, "Send me the newsletter", props={TOGGLE: 0}, rect=(20, 300, 220, 320)),
        El(PANE, "", [edit("Hidden", "", {winuia.P_OFFSCREEN: True})]),
        El(BUTTON, "Submit"),
    ])  # fmt: skip


class FormRaw(FakeRaw):
    """FakeRaw with windows by handle, fresh reads, and the patterns a form's fields have."""

    windows: dict[int, El] = {}
    done: list = []

    def foreground_handle(self):
        return 7

    def window(self, handle):
        return FormRaw.windows.get(handle)

    def refreshed(self, el):
        return self.node(el)

    def control(self, el):
        done = FormRaw.done

        class Value:
            IsReadOnly = bool(el.props.get(winuia.P_READONLY))

            def SetValue(self, text):
                el.props[VALUE] = text
                done.append(("set", el.props[NAME], text))

        class Toggle:
            def Toggle(self):
                el.props[TOGGLE] = 0 if el.props.get(TOGGLE) else 1
                done.append(("toggle", el.props[NAME]))

        class Select:
            def Select(self):
                el.props[SELECTED] = True
                done.append(("select", el.props[NAME]))
                for parent in walk_all(FormRaw.windows[7]):
                    if el in parent.kids and parent.props[winuia.P_TYPE] == COMBO:
                        parent.props[VALUE] = el.props[NAME]

        class Expand:
            def Expand(self):
                done.append(("expand", el.props[NAME]))

            def Collapse(self):
                done.append(("collapse", el.props[NAME]))

        return SimpleNamespace(
            GetValuePattern=lambda: Value() if VALUE in el.props else None,
            GetTogglePattern=lambda: Toggle(),
            GetSelectionItemPattern=lambda: Select(),
            GetExpandCollapsePattern=lambda: Expand(),
            GetRangeValuePattern=lambda: None,
        )


def walk_all(el):
    yield el
    for kid in el.kids:
        yield from walk_all(kid)


@pytest.fixture
def desk(monkeypatch):
    monkeypatch.setattr(winforms, "Raw", FormRaw)
    monkeypatch.setattr(winforms, "Apartment", _Null)
    monkeypatch.setattr(winforms, "_process_name", lambda pid: "msedge.exe")
    FormRaw.windows = {7: application_form()}
    FormRaw.done = []
    return FormRaw


def test_the_fields_are_read_with_labels_kinds_values_and_required(desk):
    form = winforms.form_fields()
    assert form["title"] == "Library card application - Edge" and form["handle"] == 7
    said = [
        (f["number"], f["label"], f["kind"], f["value"], f["required"], f["group"])
        for f in form["fields"]
    ]
    assert said == [
        (1, "Full name", "text field", "", True, ""),  # the text before it, its star: required
        (2, "Email", "text field", "", True, ""),  # the form's own required flag
        (3, "Password", "password field", "", False, ""),
        (4, "Branch", "drop-down", "", False, ""),
        (5, "Student", "option", "not selected", False, "Card type"),
        (6, "Staff", "option", "not selected", False, "Card type"),
        (7, "Send me the newsletter", "check box", "not checked", False, ""),
    ]  # (the offscreen field isn't one)


def test_fields_are_filled_and_read_back_by_number_in_the_same_window(desk):
    assert winforms.fill_field(7, 1, "Ada Lovelace", "Full name") == {
        "ok": True, "label": "Full name", "kind": "text field", "now": "Ada Lovelace",
    }  # fmt: skip
    assert winforms.fill_field(7, 4, "science")["now"] == "Science library"
    assert winforms.fill_field(7, 6, "yes")["now"] == "selected"
    assert winforms.fill_field(7, 7, "yes")["now"] == "checked"
    assert winforms.fill_field(7, 7, "no")["now"] == "not checked"
    assert ("expand", "Branch") in desk.done and ("select", "Science library") in desk.done


def test_what_is_never_filled_and_a_changed_form(desk):
    assert "type that yourself" in winforms.fill_field(7, 3, "hunter2")["why"]
    assert "the form changed" in winforms.fill_field(7, 2, "x", "Phone")["why"]
    assert "no choice like" in winforms.fill_field(7, 4, "Law library")["why"]
    assert "yes or no" in winforms.fill_field(7, 7, "maybe")["why"]
    assert "no field 40" in winforms.fill_field(7, 40, "x")["why"]
    assert "closed" in winforms.fill_field(99, 1, "x")["why"]
    assert not any(step[0] == "set" for step in desk.done)


# ── the tools ──


class Hub:
    def __init__(self, answer=True):
        self.answer = answer
        self.asked = []
        self.servers = {}

    async def _ask_user(self, question, detail=""):
        self.asked.append((question, detail))
        return self.answer

    def register_server(self, name, build, **kw):
        self.servers[name] = (build, kw)


def tools_of(hub):
    forms.install(hub)
    assert hub.forms.build_server()["name"] == "forms" and "forms" in hub.servers
    tools = {t.name: t for t in hub.forms.build_tools()}
    return {
        "list": lambda: asyncio.run(tools["list_form_fields"].handler({})),
        "fill": lambda answers: asyncio.run(tools["fill_form"].handler({"answers": answers})),
    }


def test_the_form_is_read_counts_first_and_filled_after_one_approval(desk, monkeypatch):
    monkeypatch.setattr(osplat, "IS_WIN", True)
    hub = Hub()
    tools = tools_of(hub)
    said = tools["list"]()["content"][0]["text"].splitlines()
    assert said[0] == (
        "7 fields in Library card application - Edge, 2 required (2 of those still empty)."
    )
    assert said[1] == "1. Full name, text field, holds nothing, required."
    assert said[3] == "3. Password, password field."
    assert said[5] == "5. Student, option in Card type, not selected."
    out = tools["fill"](
        [
            {"field": "full name", "value": "Ada Lovelace"},
            {"field": 4, "value": "Main library"},
            {"field": "newsletter", "value": "no"},
        ]
    )
    assert hub.asked == [
        (
            "Fill in 3 fields in Library card application - Edge?",
            "1. Full name: Ada Lovelace\n4. Branch: Main library\n7. Send me the newsletter: no",
        )
    ]
    lines = out["content"][0]["text"].splitlines()
    assert lines == [
        "Filled 3 of 3 fields, each read back:",
        "1. Full name: now holds “Ada Lovelace”.",
        "4. Branch: now holds “Main library”.",
        "7. Send me the newsletter: now not checked.",
        "Still empty and required: Email.",
        "The form isn't submitted: that's for them to say.",
    ]
    assert not any(step == ("invoke", "Submit") for step in desk.done)


def test_a_no_fills_nothing_and_a_password_or_unknown_field_is_refused(desk, monkeypatch):
    monkeypatch.setattr(osplat, "IS_WIN", True)
    hub = Hub(answer=False)
    tools = tools_of(hub)
    tools["list"]()
    out = tools["fill"]([{"field": "Email", "value": "ada@example.org"}])
    assert out["content"][0]["text"] == "They said no; nothing was filled." and desk.done == []
    out = tools["fill"]([{"field": "password", "value": "x"}])
    assert out.get("is_error") and "password field" in out["content"][0]["text"]
    out = tools["fill"]([{"field": "Shoe size", "value": "9"}])
    assert out.get("is_error") and "No field like Shoe size" in out["content"][0]["text"]
    assert len(hub.asked) == 1


def test_this_apps_own_window_is_not_taken_for_the_form(desk, monkeypatch):
    monkeypatch.setattr(osplat, "IS_WIN", True)
    monkeypatch.setattr(winforms, "_process_name", lambda pid: "J.A.R.V.I.S..exe")
    out = tools_of(Hub())["list"]()
    assert "this app's own" in out["content"][0]["text"]


def test_a_mac_is_told_it_is_a_pc_feature(monkeypatch):
    monkeypatch.setattr(osplat, "IS_WIN", False)
    tools = tools_of(Hub())
    assert "PC edition" in tools["list"]()["content"][0]["text"]
    assert "PC edition" in tools["fill"]([{"field": 1, "value": "x"}])["content"][0]["text"]
