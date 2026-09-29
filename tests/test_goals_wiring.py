"""Goals in the hub: Settings changes them without a card; a turn that read someone
else's words can't change them unasked."""

from test_hub import drain, make_hub


async def test_settings_add_and_remove_goals_and_rules(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    await hub.start()
    q = hub.subscribe()
    await hub._handle({"type": "goal_add", "text": "Close the seed round", "horizon": "quarter"})
    await hub._handle({"type": "constraint_add", "text": "No meetings before 10", "kind": "time"})
    goals = [e for e in drain(q) if e["type"] == "goals"][-1]
    (goal,) = goals["goals"]
    assert goal["text"] == "Close the seed round" and goal["horizon"] == "quarter"
    assert [c["text"] for c in goals["constraints"]] == ["No meetings before 10"]
    assert "Close the seed round" in hub.goal_store.prompt_block()
    await hub._handle({"type": "goal_update", "id": goal["id"], "status": "done"})
    assert hub.goal_store.public()["goals"][0]["status"] == "done"
    await hub._handle({"type": "goal_review", "on": True})
    assert hub._goals_payload()["review"]
    await hub._handle({"type": "goal_review", "on": False})
    assert not hub._goals_payload()["review"]
    assert "goals" in hub.snapshot()


async def test_bad_input_says_why(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    await hub.start()
    q = hub.subscribe()
    await hub._handle({"type": "goal_add", "text": ""})
    assert any(e["type"] == "error" for e in drain(q))


async def test_a_turn_that_read_an_email_never_sets_a_goal_unasked(
    settings, quiet_speaker, isolated
):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    await hub.start()
    asked = []

    async def ask_user(question):
        asked.append(question)
        return False

    hub._ask_user = ask_user
    hub._turn_text = "set a goal to run a marathon this year"
    assert await hub.feature_gate("set_goal", "Add it?")  # their own words: no card
    hub._rid = "r1"
    hub._reads()["private"] = True  # the turn read their mail
    assert not await hub.feature_gate("set_goal", "Add it?")
    assert asked == ["Add it?"]
