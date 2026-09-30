"""The Mac for a Jarvis Code session: the hook before each call (the owner's switch, Plan
mode, never JARVIS's own window, then the session's permission prompt every time), and the
approval cards' wording. Nothing here touches the real screen, mouse or keyboard."""

import asyncio

from jarvis import computer, sessionmac


def hook_of(allowed=True, mode="ask", guard=lambda *_a: ""):
    state = {"allowed": allowed, "mode": mode}
    matcher = sessionmac.pre_tool_hook(
        lambda: state["allowed"], lambda: state["mode"], computer.Screen(), guard
    )
    return matcher, state


def decide(matcher, tool, tool_input=None):
    out = asyncio.run(
        matcher.hooks[0]({"tool_name": tool, "tool_input": tool_input or {}}, "t1", None)
    )
    spec = out.get("hookSpecificOutput") or {}
    return spec.get("permissionDecision"), spec.get("permissionDecisionReason")


def test_every_call_asks_through_the_sessions_policy():
    matcher, _ = hook_of()
    assert matcher.matcher == "mcp__jarvis_mac__.*"
    assert decide(matcher, "mcp__jarvis_mac__click", {"x": 1, "y": 2}) == (
        "ask",
        "Operating the Mac",
    )
    assert decide(matcher, "mcp__jarvis_mac__see_screen") == ("ask", "Operating the Mac")
    assert decide(matcher, "mcp__other__thing") == (None, None)  # not ours


def test_turned_off_it_stops_at_once():
    matcher, state = hook_of()
    state["allowed"] = False
    kind, why = decide(matcher, "mcp__jarvis_mac__see_screen")
    assert kind == "deny" and "turned off" in why


def test_plan_mode_looks_but_never_clicks_or_types():
    matcher, _ = hook_of(mode="plan")
    for tool in ("click", "type_text", "press_keys", "press_button", "scroll"):
        assert decide(matcher, f"mcp__jarvis_mac__{tool}")[0] == "deny", tool
    assert decide(matcher, "mcp__jarvis_mac__see_screen")[0] == "ask"


def test_computers_file_readers_never_reach_a_session():
    matcher, _ = hook_of()
    for tool in sessionmac.HIDDEN:
        assert decide(matcher, f"mcp__jarvis_mac__{tool}")[0] == "deny"
    assert sessionmac.disallowed() == [f"mcp__jarvis_mac__{t}" for t in sessionmac.HIDDEN]


def test_the_jarvis_window_is_never_driven(monkeypatch):
    seen = []

    def guard(tool, tool_input, screen):
        seen.append((tool, tool_input))
        return "That's the J.A.R.V.I.S. window" if tool == "click" else ""

    matcher, _ = hook_of(guard=guard)
    kind, why = decide(matcher, "mcp__jarvis_mac__click", {"x": 10, "y": 10})
    assert kind == "deny" and why.startswith("That's the J.A.R.V.I.S. window")
    assert decide(matcher, "mcp__jarvis_mac__type_text", {"text": "hi"})[0] == "ask"
    assert seen[0] == ("click", {"x": 10, "y": 10})


def test_which_window_a_call_lands_on(monkeypatch):
    screen = computer.Screen()
    screen.scale = 2.0  # screenshot pixels to points
    at = []
    monkeypatch.setattr(
        sessionmac, "window_owner_at", lambda x, y: at.append((x, y)) or (1, "J.A.R.V.I.S.")
    )
    monkeypatch.setattr(sessionmac, "front_app", lambda: (2, "Safari"))
    assert "J.A.R.V.I.S. window" in sessionmac.refusal("click", {"x": 10, "y": 20}, screen)
    assert at == [(20.0, 40.0)]
    assert sessionmac.refusal("type_text", {"text": "x"}, screen) == ""  # Safari is in front
    monkeypatch.setattr(sessionmac, "front_app", lambda: (os_pid(), "Electron"))
    assert sessionmac.refusal("press_keys", {"keys": "return"}, screen)  # our own process
    assert sessionmac.refusal("see_screen", {}, screen) == ""

    def broken(*_a):
        raise RuntimeError("no Quartz")

    monkeypatch.setattr(sessionmac, "window_owner_at", broken)
    assert sessionmac.refusal("click", {"x": 1, "y": 1}, screen) == ""  # nothing to go on


def os_pid():
    import os

    return os.getpid()


def test_the_cards_say_what_each_call_does(tmp_path):
    click = sessionmac.FEATURE_TOOLS["mcp__jarvis_mac__click"]
    assert click[0] == "click on your Mac"
    assert (
        click[1]({"x": 120, "y": 40, "clicks": 2}, tmp_path)
        == "double-left click at 120, 40 of the latest screenshot"
    )
    typed = sessionmac.FEATURE_TOOLS["mcp__jarvis_mac__type_text"][1]({"text": "hello"}, tmp_path)
    assert typed == "type: hello"
    assert (
        sessionmac.FEATURE_TOOLS["mcp__jarvis_mac__press_button"][1]({"name": "Send"}, tmp_path)
        == "press “Send” in the app in front"
    )


def test_the_server_is_computers_own():
    server = sessionmac.build()
    assert server["type"] == "sdk" and server["name"] == computer.SERVER_NAME
