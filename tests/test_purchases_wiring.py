"""Purchases in the hub: every browser click goes through the guard, and by voice only
"confirm purchase" is a yes to a purchase card."""

from test_hub import make_hub

from jarvis.voicecode import REASK, voice_answer

CARD = {
    "ask_kind": "purchase",
    "question": "Buy 2 tickets from Example Shop for $42.00?",
    "choices": [{"id": "allow", "label": "Confirm purchase"}, {"id": "deny", "label": "Cancel"}],
}


def test_only_the_deliberate_phrase_confirms_by_voice():
    assert voice_answer("confirm purchase", CARD) == ("allow", "")
    assert voice_answer("yes", CARD) == (REASK, "")
    assert voice_answer("sure go ahead", CARD) == (REASK, "")
    assert voice_answer("no", CARD)[0] == "deny"
    assert voice_answer("确认购买", CARD) == ("allow", "")


async def test_a_final_button_is_never_pressed_unconfirmed(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    await hub.start()
    pressed = []

    async def window(action, args=None):
        if action == "read":
            return {
                "url": "https://shop.example.com/checkout",
                "title": "Checkout",
                "text": "Order summary. Total $42.00. Continue shopping Place order",
                "actions": ["Continue shopping", "Place order"],  # what's in view to press
                "links": [],
                "fields": [],
            }
        pressed.append((action, args))
        return {"ok": True}

    hub._browser_raw = window
    from jarvis import transactions

    hub._guarded_browser = transactions.guard_browser(hub.transactions, hub._browser_raw)
    result = await hub.browser_call("click", {"text": "Place order"})
    assert pressed == [] and (result.get("error") or result.get("ok") is False)
    result = await hub.browser_call("click", {"text": "Continue shopping"})
    assert pressed == [("click", {"text": "Continue shopping"})]


async def test_settings_shows_what_was_spent(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    await hub.start()
    purchases = hub.snapshot()["purchases"]
    assert purchases["limit_day"] == 500.0 and purchases["currency"] == "USD"
    hub.set_prefs({"pay_limit_day": 300})
    assert hub.transactions.public()["limit_day"] == 300.0
