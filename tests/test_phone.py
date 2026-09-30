"""Phone calls: the owner's own number through their Twilio account (never anyone else's on
JARVIS's own say-so), capped so nothing runs up a bill; others ring from the iPhone."""

import asyncio
from types import SimpleNamespace
from urllib.parse import parse_qs

import pytest

from jarvis import phone
from jarvis.phone import Phone, PhoneError, clean_number, twiml

SID = "AC" + "0123456789abcdef" * 2
TOKEN = "fedcba9876543210" * 2


@pytest.mark.parametrize(
    ("said", "number"),
    [
        ("(415) 555-0100", "+14155550100"),
        ("1 415 555 0100", "+14155550100"),
        ("+44 20 7946 0958", "+442079460958"),
        ("", ""),
        ("call me maybe", None),
        ("12345", None),
    ],
)
def test_numbers_are_cleaned(said, number):
    assert clean_number(said) == number


def test_the_script_is_escaped_paused_and_fits_twilio():
    xml = twiml("Good morning <Robert> & co.\n\nThree meetings today.")
    assert "Good morning &lt;Robert&gt; &amp; co." in xml and xml.count('<Pause length="1"/>') == 2
    long = twiml("\n".join(["A sentence that goes on for a while."] * 400))
    assert len(long) <= phone.TWIML_LIMIT + 200 and long.endswith("</Response>")


def prefs(**kw):
    base = {"phone_me": "+14155550199", "phone_from": "+14155550100"}
    return SimpleNamespace(**{**base, **kw})


class Twilio:
    def __init__(self):
        self.calls = []

    def __call__(self, url, form, sid, token, timeout=15):
        self.calls.append((url, form, sid, token))
        return {"sid": "CA123"}


def made(p=None, clock=None):
    twilio = Twilio()
    ph = Phone(lambda: p or prefs(), post=twilio, clock=clock or (lambda: 1000.0))
    return ph, twilio


async def test_it_calls_only_the_owners_number_with_the_message():
    ph, twilio = made()
    ph.save_credentials(SID, TOKEN)
    assert await ph.call_me("Good morning.\n\nTwo meetings.") == "CA123"
    url, form, sid, token = twilio.calls[0]
    assert url.endswith(f"/Accounts/{SID}/Calls.json") and (sid, token) == (SID, TOKEN)
    assert form["To"] == "+14155550199" and form["From"] == "+14155550100"
    assert "Two meetings." in form["Twiml"]


async def test_nothing_happens_until_it_is_set_up():
    ph, twilio = made(prefs(phone_me=""))
    ph.save_credentials(SID, TOKEN)
    with pytest.raises(PhoneError, match="aren't set up"):
        await ph.call_me("hi")
    ph2, twilio2 = made()
    with pytest.raises(PhoneError, match="aren't set up"):  # no credentials
        await ph2.call_me("hi")
    assert not twilio.calls and not twilio2.calls


def test_credentials_are_checked_and_kept_out_of_the_status():
    ph, _ = made()
    with pytest.raises(PhoneError):
        ph.save_credentials("not a sid", TOKEN)
    with pytest.raises(PhoneError):
        ph.save_credentials(SID, "short")
    ph.save_credentials(SID, TOKEN)
    status = ph.status()
    assert status["signed_in"] and status["ready"] and TOKEN not in str(status)
    assert status["sid_hint"] == f"{SID[:4]}…{SID[-4:]}"
    ph.keychain.clear()
    assert not ph.status()["signed_in"]


async def test_calls_are_capped_per_hour_and_day():
    now = [1000.0]
    ph, twilio = made(clock=lambda: now[0])
    ph.save_credentials(SID, TOKEN)
    for _ in range(phone.CALLS_PER_HOUR):
        await ph.call_me("hi")
    with pytest.raises(PhoneError, match="this hour"):
        await ph.call_me("hi")
    for _ in range(3):
        now[0] += 3601
        for _ in range(phone.CALLS_PER_HOUR):
            if len(twilio.calls) < phone.CALLS_PER_DAY:
                await ph.call_me("hi")
    with pytest.raises(PhoneError, match="today"):
        await ph.call_me("hi")
    assert len(twilio.calls) == phone.CALLS_PER_DAY


async def test_someone_else_rings_from_the_iphone_after_a_yes():
    ran, asked, answers = [], [], [True, False]

    async def run(*args, timeout=30):
        ran.append(args)
        return ""

    async def confirm(question):
        asked.append(question)
        return answers.pop(0)

    async def lookup(_query):
        return [
            {
                "name": "Ann Lee",
                "phones": [{"label": "mobile", "value": "(415) 555-0123"}],
                "emails": [],
            }
        ]

    ph = Phone(lambda: prefs(), run=run)
    *_twilio_tools, ring_from_iphone = phone.build_tools(ph, confirm, lookup)
    assert ring_from_iphone.name == "ring_from_iphone"
    done = await ring_from_iphone.handler({"to": "Ann Lee"})
    assert asked == ["Call Ann Lee (+14155550123) from your iPhone?"]
    assert (
        ran == [("open", "tel://+14155550123")] and "Calling Ann Lee" in done["content"][0]["text"]
    )
    declined = await ring_from_iphone.handler({"to": "+1 415 555 0100"})
    assert asked[-1] == "Call +14155550100 from your iPhone?"
    assert declined.get("is_error") and len(ran) == 1  # a no rings no one
    with pytest.raises(PhoneError):
        await ph.dial("not a number")


async def test_call_me_tool_reports_why_it_cant(settings):
    ph = Phone(lambda: prefs(phone_me=""))

    async def confirm(_q):
        return True

    call_me, *_ = phone.build_tools(ph, confirm)
    said = await call_me.handler({"message": "hi"})
    assert said.get("is_error") and "aren't set up" in said["content"][0]["text"]


async def test_the_hub_saves_credentials_and_never_echoes_the_token(
    settings, quiet_speaker, isolated
):
    from test_hub import drain, make_hub

    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    await hub.start()
    q = hub.subscribe()
    await hub._handle({"type": "phone_credentials", "sid": SID, "token": TOKEN})
    events = [e for e in drain(q) if e["type"] == "phone_status"]
    assert events and events[-1]["signed_in"] and events[-1]["note"] == "Saved in your Keychain."
    assert TOKEN not in str(events)
    await hub._handle({"type": "phone_forget"})
    assert not [e for e in drain(q) if e["type"] == "phone_status"][-1]["signed_in"]


def test_the_wake_up_call_is_due_once_near_its_time(settings, quiet_speaker, isolated):
    from datetime import datetime

    from test_hub import make_hub

    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    hub.prefs.wake_call, hub.prefs.wake_call_time = True, "07:00"
    assert not hub.wake_call_due(datetime(2026, 9, 30, 6, 59))
    assert hub.wake_call_due(datetime(2026, 9, 30, 7, 5))
    assert not hub.wake_call_due(datetime(2026, 9, 30, 9, 0))  # too late to wake anyone
    hub.prefs.last_wake_call = "2026-09-30"
    assert not hub.wake_call_due(datetime(2026, 9, 30, 7, 5))
    hub.prefs.wake_call = False
    assert not hub.wake_call_due(datetime(2026, 10, 1, 7, 5))


def test_prefs_take_numbers_and_times_but_not_the_date():
    from jarvis.prefs import Prefs

    p = Prefs()
    changed = p.update(
        {
            "phone_me": "(415) 555-0199",
            "wake_call_time": "06:30",
            "last_wake_call": "2026-01-01",
            "phone_from": "nope",
        }
    )
    assert p.phone_me == "+14155550199" and p.wake_call_time == "06:30"
    assert p.last_wake_call == "" and p.phone_from == "" and "phone_from" not in changed
    assert "last_wake_call" not in p.public()


@pytest.mark.parametrize(
    ("code", "said", "shown"),
    [
        # What Twilio really answers for a wrong token, and for an account without an
        # approved identity check: both 401, told apart only by the message.
        (401, "authentication failed, auth token is not valid for account AC1", phone.BAD_SIGN_IN),
        (401, "Authenticate", phone.BAD_SIGN_IN),
        (401, "", phone.BAD_SIGN_IN),
        (
            401,
            "Primary compliance profile is not approved. Please refer to documentation and "
            "complete the KYC process in Trust Hub to gain access.",
            phone.NOT_VERIFIED,
        ),
        (
            400,
            "The source phone number provided is not yet verified.",
            "Twilio said no: The source",
        ),
    ],
)
def test_twilios_refusals_are_told_apart(monkeypatch, code, said, shown):
    _refused(monkeypatch, code, said, shown)


def test_a_trial_account_calling_an_unverified_number_is_explained(monkeypatch):
    _refused(
        monkeypatch, 400, "The number +14155550123 is unverified.", phone.TRIAL_UNVERIFIED, 21219
    )


def _refused(monkeypatch, code, said, shown, twilio_code=20003):
    import io
    import json
    import urllib.error

    def refuse(*_a, **_k):
        body = io.BytesIO(json.dumps({"code": twilio_code, "message": said}).encode())
        raise urllib.error.HTTPError("https://api.twilio.com", code, "no", {}, body)

    monkeypatch.setattr(phone.urllib.request, "urlopen", refuse)
    with pytest.raises(PhoneError) as caught:
        phone._post("https://api.twilio.com/x", {}, SID, TOKEN)
    assert str(caught.value).startswith(shown)


class Host:
    """Stands in for the Twilio Serverless upload."""

    def __init__(self):
        self.put_calls = []

    def put(self, wav, sid, token):
        self.put_calls.append((wav, sid, token))
        return "https://jarvis-voice-1-calls.twil.io/abc.wav"


async def test_calls_speak_in_jarvis_own_voice():
    import numpy as np

    voiced = []

    async def voice(text):
        voiced.append(text)
        return np.zeros(24000, dtype=np.float32), 24000  # a second of it

    twilio, host = Twilio(), Host()
    ph = Phone(lambda: prefs(), post=twilio, clock=lambda: 1000.0, voice=voice, audio=host)
    ph.save_credentials(SID, TOKEN)
    await ph.call_me("Good morning.\n\nTwo meetings.")
    assert voiced == ["Good morning.", "Two meetings.", phone.GOODBYE]
    wav, sid, token = host.put_calls[0]
    assert (sid, token) == (SID, TOKEN) and wav[:4] == b"RIFF"
    assert int.from_bytes(wav[24:28], "little") == phone.PHONE_RATE
    script = twilio.calls[0][1]["Twiml"]
    assert "<Play>https://jarvis-voice-1-calls.twil.io/abc.wav</Play>" in script
    assert "<Say" not in script


@pytest.mark.parametrize("trouble", ["no voice", "voice down", "upload refused"])
async def test_without_its_voice_twilios_british_one_reads_the_call(trouble):
    import numpy as np

    async def voice(_text):
        if trouble == "no voice":
            return None
        if trouble == "voice down":
            raise RuntimeError("402 Payment Required")
        return np.zeros(100, dtype=np.float32), 24000

    class Refusing(Host):
        def put(self, wav, sid, token):
            raise PhoneError("Twilio said no: nope")

    twilio = Twilio()
    ph = Phone(lambda: prefs(), post=twilio, voice=voice, audio=Refusing())
    ph.save_credentials(SID, TOKEN)
    await ph.call_me("Good morning.")
    script = twilio.calls[0][1]["Twiml"]
    assert f'<Say voice="{phone.VOICE}">Good morning.</Say>' in script and "<Play>" not in script
    assert "Brian" in phone.VOICE  # British, like the Mac's voice


def test_the_call_audio_is_phone_rate_with_pauses():
    import numpy as np

    clip = (np.sin(np.arange(24000) * 0.3) * 0.5).astype(np.float32), 24000
    wav = phone.phone_audio([clip, clip])
    samples = (len(wav) - 44) // 2
    assert samples == phone.PHONE_RATE * (0.5 + 1 + 1 + 1)  # lead-in, two seconds, one pause
    long = "A sentence that goes on for a while. " * 400
    parts = phone.spoken_parts(long)
    assert len(parts) == 2 and len(parts[0]) <= phone.SPOKEN_LIMIT and parts[0].endswith(".")
    assert parts[-1] == phone.GOODBYE


class Serverless:
    """Twilio Serverless as the uploader sees it: empty at first."""

    NOW = "2026-09-29T22:00:00Z"

    def __init__(self, build_ends="completed"):
        self.sent = []
        self.build_ends = build_ends
        self.polls = 0

    def __call__(self, method, url, sid, token, data=None, files=None):
        self.sent.append((method, url, data, files))
        path = url.split("/v1", 1)[1]
        if method == "GET" and path.startswith("/Services?"):
            return {"services": []}
        if method == "POST" and path == "/Services":
            return {"sid": "ZS1"}
        if method == "GET" and path.endswith("/Environments"):
            return {"environments": []}
        if method == "POST" and path.endswith("/Environments"):
            return {"sid": "ZE1", "domain_name": "jarvis-voice-1-calls.twil.io"}
        if method == "GET" and path.endswith("/Assets"):
            return {"assets": []}
        if method == "POST" and path.endswith("/Assets"):
            return {"sid": "ZH1"}
        if method == "POST" and path.endswith("/Versions"):
            return {"sid": "ZN3"}
        if method == "GET" and "/Versions" in path:
            return {
                "asset_versions": [
                    {"sid": "ZN1", "date_created": "2026-09-29T19:00:00Z"},  # hours ago
                    {"sid": "ZN3", "date_created": self.NOW},
                    {"sid": "ZN2", "date_created": "2026-09-29T21:50:00Z"},  # minutes ago
                ]
            }
        if method == "POST" and path.endswith("/Builds"):
            return {"sid": "ZB2", "status": "building"}
        if method == "GET" and path.endswith("/Status"):
            self.polls += 1
            return {"status": "building" if self.polls < 2 else self.build_ends}
        if method == "GET" and "/Builds?" in path:
            return {"builds": [{"sid": "ZB1"}, {"sid": "ZB2"}]}
        return {}


def test_call_audio_goes_up_protected_and_keeps_the_last_hour():
    from datetime import datetime

    server = Serverless()
    now = datetime.fromisoformat(Serverless.NOW.replace("Z", "+00:00")).timestamp()
    host = phone.CallAudio(request=server, clock=lambda: now, wait=lambda _s: None)
    url = host.put(b"RIFF...", SID, TOKEN)
    assert url.startswith("https://jarvis-voice-1-calls.twil.io/") and url.endswith(".wav")
    upload = next(s for s in server.sent if s[1].endswith("/Versions") and s[0] == "POST")
    assert upload[1].startswith(phone.UPLOAD) and upload[2]["Visibility"] == "protected"
    assert upload[2]["Path"] == url.split("twil.io", 1)[1] and upload[3]["Content"][1] == b"RIFF..."
    build = next(s for s in server.sent if s[0] == "POST" and s[1].endswith("/Builds"))
    assert build[2]["AssetVersions"] == ["ZN3", "ZN2"]  # this call's and the last hour's
    assert ("POST", f"{phone.SERVERLESS}/Services/ZS1/Environments/ZE1/Deployments") in [
        s[:2] for s in server.sent
    ]
    deleted = [s[1] for s in server.sent if s[0] == "DELETE"]
    assert deleted == [f"{phone.SERVERLESS}/Services/ZS1/Builds/ZB1"]
    server.sent.clear()
    host.put(b"RIFF...", SID, TOKEN)  # set up once: the second call only uploads
    assert not [s for s in server.sent if s[1].endswith(("/Services", "/Environments", "/Assets"))]


def test_a_failed_build_is_an_error_and_sets_up_again():
    server = Serverless(build_ends="failed")
    host = phone.CallAudio(request=server, clock=lambda: 0.0, wait=lambda _s: None)
    with pytest.raises(PhoneError, match="audio ready"):
        host.put(b"RIFF...", SID, TOKEN)
    assert SID not in host._places


def test_form_encoding_round_trips():
    # What _post sends is ordinary form data (Twilio's REST API).
    from urllib.parse import urlencode

    body = urlencode({"To": "+1", "Twiml": "<Response/>"})
    assert parse_qs(body)["Twiml"] == ["<Response/>"]
    assert asyncio.iscoroutinefunction(Phone.call_me)


# ── calling other people from the Twilio number ──


async def ann(_query):
    return [{"name": "Ann Lee", "phones": [{"label": "mobile", "value": "(415) 555-0123"}]}]


def tools_for(ph, answers, cards, followed=None):
    async def approve(question, detail, spoken):
        cards.append((question, detail, spoken))
        return answers.pop(0)

    async def confirm(_question):
        raise AssertionError("a call from the Twilio number asks on a card with the message")

    return phone.build_tools(
        ph,
        confirm,
        ann,
        approve=approve,
        after_call=(lambda sid, name: followed.append((sid, name)))
        if followed is not None
        else None,
    )


async def test_someone_else_is_called_from_twilio_with_the_exact_message_after_a_yes():
    twilio, cards, followed = Twilio(), [], []
    ph = Phone(lambda: prefs(owner_name="Robert"), post=twilio, clock=lambda: 1000.0)
    ph.save_credentials(SID, TOKEN)
    _call_me, call_someone, _ring = tools_for(ph, [True, False], cards, followed)
    message = "Robert asked me to let you know he's running 20 minutes late."
    done = await call_someone.handler({"to": "Ann Lee", "message": message})
    assert not done.get("is_error"), done
    question, detail, spoken = cards[0]
    assert question == "Call Ann Lee from your Twilio number?"
    assert "Ann Lee (+14155550123)" in detail and "+14155550100" in detail and message in detail
    assert "Robert's AI assistant" in detail  # the card shows the opening too
    assert message in spoken and spoken.endswith("Shall I make the call?")
    url, form, sid, token = twilio.calls[0]
    assert url.endswith(f"/Accounts/{SID}/Calls.json") and (sid, token) == (SID, TOKEN)
    assert form["To"] == "+14155550123" and form["From"] == "+14155550100"
    assert form["MachineDetection"] == "DetectMessageEnd"  # waits out a voicemail greeting
    script = form["Twiml"]
    opens = script.index("Hello, this is Jarvis, Robert's AI assistant, with a message for you.")
    assert opens < script.index("running 20 minutes late")  # who's calling comes first
    assert phone.GOODBYE_OTHERS in script and phone.GOODBYE not in script
    assert followed == [("CA123", "Ann Lee")]
    declined = await call_someone.handler({"to": "Ann Lee", "message": message})
    assert declined.get("is_error") and len(twilio.calls) == 1  # a no calls no one


async def test_a_call_to_someone_else_speaks_in_jarvis_own_voice():
    import numpy as np

    voiced = []

    async def voice(text):
        voiced.append(text)
        return np.zeros(8000, dtype=np.float32), 8000

    twilio, host = Twilio(), Host()
    ph = Phone(lambda: prefs(), post=twilio, voice=voice, audio=host)
    ph.save_credentials(SID, TOKEN)
    await ph.call_someone("+14155550123", "Dinner is at seven.")
    assert voiced == [phone.opening(""), "Dinner is at seven.", phone.GOODBYE_OTHERS]
    assert "<Play>" in twilio.calls[0][1]["Twiml"]


async def test_calls_to_others_are_checked_before_the_owner_is_asked():
    cards = []
    ph = Phone(lambda: prefs(phone_from=""), post=Twilio())
    ph.save_credentials(SID, TOKEN)
    _call_me, call_someone, _ring = tools_for(ph, [True], cards)
    said = await call_someone.handler({"to": "+14155550123", "message": "hi"})
    assert said.get("is_error") and said["content"][0]["text"] == phone.NO_TWILIO

    twilio = Twilio()
    ph = Phone(lambda: prefs(), post=twilio)
    ph.save_credentials(SID, TOKEN)
    _call_me, call_someone, _ring = tools_for(ph, [True], cards)
    for args, why in [
        ({"to": "+14155550123", "message": "x" * (phone.MESSAGE_LIMIT + 1)}, "at most"),
        ({"to": "+14155550123", "message": "  "}, "nothing to tell"),
        ({"to": "+14155550100", "message": "hi"}, "Twilio number I call from"),
        ({"to": "", "message": "hi"}, "Say who to call"),
    ]:
        said = await call_someone.handler(args)
        assert said.get("is_error") and why in said["content"][0]["text"], (args, said)
    assert not cards and not twilio.calls  # nothing was put to the owner, nothing rang


async def test_calls_to_others_have_their_own_cap():
    now = [1000.0]
    twilio = Twilio()
    ph = Phone(lambda: prefs(), post=twilio, clock=lambda: now[0])
    ph.save_credentials(SID, TOKEN)
    for _ in range(phone.OTHERS_PER_HOUR):
        await ph.call_someone("+14155550123", "hi")
    with pytest.raises(PhoneError, match="this hour"):
        await ph.call_someone("+14155550123", "hi")
    await ph.call_me("still fine")  # the owner's own calls are counted apart
    assert len(twilio.calls) == phone.OTHERS_PER_HOUR + 1


def test_the_call_opens_by_saying_its_an_ai():
    assert (
        phone.opening("Robert")
        == "Hello, this is Jarvis, Robert's AI assistant, with a message for you."
    )
    assert phone.opening("  ") == "Hello, this is Jarvis, an AI assistant, with a message for you."


@pytest.mark.parametrize(
    ("call", "said"),
    [
        (
            {"status": "completed", "answered_by": "machine_end_beep"},
            "left your message on their voicemail",
        ),
        (
            {"status": "completed", "answered_by": "human", "duration": "42"},
            "picked up; the call lasted 42 seconds",
        ),
        ({"status": "completed", "answered_by": "fax"}, "fax machine"),
        ({"status": "busy"}, "line was busy"),
        ({"status": "no-answer"}, "didn't answer"),
        ({"status": "failed"}, "didn't go through"),
        ({"status": "in-progress"}, None),
    ],
)
def test_how_a_call_went_is_said_plainly(call, said):
    out = phone.outcome_text(call, "Ann Lee")
    assert (out is None) if said is None else (said in out and "Ann Lee" in out)


async def test_the_outcome_is_followed_until_the_call_ends():
    looks, slept = [], []
    answers = [
        {"status": "ringing"},
        PhoneError("Couldn't reach Twilio (ConnectError)."),  # a blip: looks again
        {"status": "completed", "answered_by": "machine_end_beep"},
    ]

    def fetch(method, url, sid, token, data=None, files=None):
        looks.append((method, url))
        answer = answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return answer

    async def sleep(seconds):
        slept.append(seconds)

    ph = Phone(lambda: prefs(), fetch=fetch, sleep=sleep)
    ph.save_credentials(SID, TOKEN)
    call_sid = "CA" + "ab" * 16
    said = await ph.outcome(call_sid, "Ann Lee")
    assert said == "Ann Lee didn't pick up, so I left your message on their voicemail."
    assert looks[0] == ("GET", f"{phone.API}/Accounts/{SID}/Calls/{call_sid}.json")
    assert len(looks) == 3 and slept == [phone.FOLLOW_EVERY] * 3
    assert await ph.outcome("not a call id", "Ann Lee") is None


# ── the caller ID name ──


class TrustHub:
    """Twilio's Trust Hub as the registration sees it."""

    def __init__(self, profiles=None, products=None, evaluation="compliant", numbers=None):
        self.sent = []
        self.profiles = (
            [{"sid": "BU1", "status": "twilio-approved", "policy_sid": "RNp", "email": "r@x.com"}]
            if profiles is None
            else profiles
        )
        self.products = products or []  # existing CNAM products, with "pn" and "name"
        self.evaluation = evaluation
        self.numbers = (
            [{"sid": "PN1", "phone_number": "+14155550100"}] if numbers is None else numbers
        )

    def __call__(self, method, url, sid, token, data=None, files=None):
        self.sent.append((method, url, data))
        host, path = url.split("/", 3)[2], "/" + url.split("/", 3)[3]
        if host == "api.twilio.com":
            return {"incoming_phone_numbers": self.numbers}
        path, _, query = path.partition("?")
        if method == "GET" and path == "/v1/TrustProducts":
            assert f"PolicySid={phone.CNAM_POLICY}" in query
            return {"results": [p["product"] for p in self.products], "meta": {"key": "results"}}
        for p in self.products:
            sid_ = p["product"]["sid"]
            if path == f"/v1/TrustProducts/{sid_}/ChannelEndpointAssignments":
                return {"results": [{"channel_endpoint_sid": p["pn"]}]}
            if path == f"/v1/TrustProducts/{sid_}/EntityAssignments":
                return {"results": [{"object_sid": "BU1"}, {"object_sid": f"IT{sid_}"}]}
            if path == f"/v1/EndUsers/IT{sid_}":
                return {"attributes": {"cnam_display_name": p["name"]}}
        if method == "GET" and path == "/v1/CustomerProfiles":
            return {"results": self.profiles, "meta": {"key": "results"}}
        if method == "GET" and path.startswith("/v1/Policies/"):
            return {"friendly_name": "Primary Customer Profile of type Business"}
        if method == "GET" and path.endswith("/ChannelEndpointAssignments"):
            return {"results": []}
        if method == "POST" and path == "/v1/TrustProducts":
            return {"sid": "BUnew"}
        if method == "POST" and path == "/v1/EndUsers":
            return {"sid": "ITnew"}
        if method == "POST" and path.endswith("/Evaluations"):
            if self.evaluation == "compliant":
                return {"status": "compliant", "results": []}
            return {
                "status": "noncompliant",
                "results": [{"passed": False, "invalid": [{"failure_reason": self.evaluation}]}],
            }
        return {}


def test_the_caller_name_is_registered_with_twilio():
    hub = TrustHub()
    said = phone.CallerName(request=hub).register("+14155550100", "J.A.R.V.I.S.", SID, TOKEN)
    assert said.startswith("Sent “J.A.R.V.I.S.” to Twilio for review")
    posts = [(url.split(".com", 1)[1], data) for method, url, data in hub.sent if method == "POST"]
    assert posts == [
        (
            "/v1/CustomerProfiles/BU1/ChannelEndpointAssignments",
            {"ChannelEndpointType": "phone-number", "ChannelEndpointSid": "PN1"},
        ),
        (
            "/v1/TrustProducts",
            {
                "FriendlyName": "J.A.R.V.I.S. caller ID +14155550100",
                "Email": "r@x.com",
                "PolicySid": phone.CNAM_POLICY,
            },
        ),
        ("/v1/TrustProducts/BUnew/EntityAssignments", {"ObjectSid": "BU1"}),
        (
            "/v1/EndUsers",
            {
                "Type": "cnam_information",
                "FriendlyName": "Caller ID name J.A.R.V.I.S.",
                "Attributes": '{"cnam_display_name": "J.A.R.V.I.S."}',
            },
        ),
        ("/v1/TrustProducts/BUnew/EntityAssignments", {"ObjectSid": "ITnew"}),
        (
            "/v1/TrustProducts/BUnew/ChannelEndpointAssignments",
            {"ChannelEndpointType": "phone-number", "ChannelEndpointSid": "PN1"},
        ),
        ("/v1/TrustProducts/BUnew/Evaluations", None),
        ("/v1/TrustProducts/BUnew", {"Status": "pending-review"}),
    ]
    lookup = hub.sent[0][1]
    assert "PhoneNumber=%2B14155550100" in lookup  # the + survives the query string


@pytest.mark.parametrize(
    ("profiles", "shown"),
    [
        ([], phone.NEEDS_BUSINESS),
        ([{"sid": "BU1", "status": "in-review", "policy_sid": "RNp"}], phone.PROFILE_IN_REVIEW),
    ],
)
def test_without_an_approved_business_profile_it_says_what_to_do(profiles, shown):
    hub = TrustHub(profiles=profiles)
    with pytest.raises(PhoneError) as caught:
        phone.CallerName(request=hub).register("+14155550100", "J.A.R.V.I.S.", SID, TOKEN)
    assert str(caught.value) == shown
    assert not [s for s in hub.sent if s[0] == "POST"]  # nothing half-made


def test_an_earlier_registration_is_reported_not_repeated():
    product = {"sid": "BUold", "status": "in-review", "date_created": "2026-09-29T10:00:00Z"}
    hub = TrustHub(products=[{"product": product, "pn": "PN1", "name": "J.A.R.V.I.S."}])
    register = phone.CallerName(request=hub).register
    said = register("+14155550100", "J.A.R.V.I.S.", SID, TOKEN)
    assert said == "Twilio is still reviewing “J.A.R.V.I.S.” as your caller ID name."
    other = register("+14155550100", "JARVIS", SID, TOKEN)
    assert "To show “JARVIS” instead" in other.split("\n")[1]
    product["status"] = "twilio-rejected"
    product["errors"] = [{"code": 18601}]
    said = register("+14155550100", "J.A.R.V.I.S.", SID, TOKEN)
    assert said.startswith("Twilio turned down “J.A.R.V.I.S.” as your caller ID name (error 18601)")
    assert not [s for s in hub.sent if s[0] == "POST"]
    # Turned down, but for another name: this one is tried.
    assert register("+14155550100", "JARVIS", SID, TOKEN).startswith("Sent “JARVIS”")


def test_a_failed_check_leaves_no_half_made_registration():
    hub = TrustHub(evaluation="The display name is not allowed.")
    with pytest.raises(PhoneError) as caught:
        phone.CallerName(request=hub).register("+14155550100", "J.A.R.V.I.S.", SID, TOKEN)
    assert str(caught.value) == (
        "Twilio's check turned down the caller ID name: The display name is not allowed."
    )
    deleted = [url for method, url, _data in hub.sent if method == "DELETE"]
    assert deleted == [f"{phone.TRUSTHUB}/TrustProducts/BUnew", f"{phone.TRUSTHUB}/EndUsers/ITnew"]
    assert not [s for s in hub.sent if s[2] == {"Status": "pending-review"}]


def test_a_number_not_on_the_account_is_said_so():
    hub = TrustHub(numbers=[])
    with pytest.raises(PhoneError, match="isn't a number on your Twilio account"):
        phone.CallerName(request=hub).register("+14155550100", "J.A.R.V.I.S.", SID, TOKEN)


@pytest.mark.parametrize(
    ("name", "ok"),
    [
        ("J.A.R.V.I.S.", True),
        ("Jarvis, Inc", True),
        ("1JARVIS", False),
        ("J" * 16, False),
        ("J@RVIS", False),
    ],
)
def test_caller_names_follow_the_carriers_rules(name, ok):
    assert (phone.clean_caller_name(name) is not None) == ok


async def test_show_as_adds_the_contacts_card_and_registers_with_twilio():
    ran = []

    async def applescript(script, *args, timeout=30):
        ran.append(args)
        return "ok"

    class Registrar:
        def __init__(self):
            self.asked = []

        def register(self, number, name, sid, token):
            self.asked.append((number, name, sid, token))
            return "Sent “J.A.R.V.I.S.” to Twilio for review as your caller ID name."

    registrar = Registrar()
    ph = Phone(lambda: prefs(), applescript=applescript, caller_name=registrar)
    ph.save_credentials(SID, TOKEN)
    said = await ph.show_as("J.A.R.V.I.S.")
    assert ran == [("+14155550100", "J.A.R.V.I.S.")]
    assert registrar.asked == [("+14155550100", "J.A.R.V.I.S.", SID, TOKEN)]
    card, twilio = said.split("\n")
    assert card == "Your Twilio number is in Contacts as J.A.R.V.I.S., so your iPhone shows it."
    assert twilio.startswith("Sent “J.A.R.V.I.S.”")
    with pytest.raises(PhoneError, match="15 letters"):
        await ph.show_as("J@RVIS")

    async def refused(script, *args, timeout=30):
        raise phone.mac_tools.ToolFailure("not allowed to use Contacts")

    ph.applescript = refused
    said = await ph.show_as()
    assert said.startswith(
        "Couldn't add your Twilio number to Contacts (not allowed to use Contacts)."
    )


async def test_the_hub_asks_with_call_buttons_and_says_how_the_call_went(
    settings, quiet_speaker, isolated
):
    from test_hub import drain, make_hub

    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    await hub.start()
    assert "mcp__phone" in hub.client.options.allowed_tools
    assert "ring_from_iphone" in hub.client.options.system_prompt
    assert "the Jarvis number" in hub.client.options.system_prompt  # what the user calls it
    q = hub.subscribe()
    pending = asyncio.create_task(hub.call_gate("Call Ann Lee from your Twilio number?", "hi"))
    await asyncio.sleep(0)
    approval = next(e for e in drain(q) if e["type"] == "approval")
    assert [c["label"] for c in approval["choices"]] == ["Call", "Don't call"]
    hub.resolve(approval["id"], "allow")
    assert await pending is True

    async def outcome(call_sid, name):
        return f"{name} didn't pick up, so I left your message on their voicemail."

    hub.phone.outcome = outcome
    hub.prefs.proactive = False  # a call they asked for is still reported
    await hub._call_outcome("CA" + "ab" * 16, "Ann Lee")
    alert = next(e for e in drain(q) if e["type"] == "alert")
    assert alert["alert_kind"] == "call" and "Ann Lee" in alert["text"]


async def test_the_hub_sets_the_caller_name_from_settings(settings, quiet_speaker, isolated):
    from test_hub import drain, make_hub

    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    await hub.start()
    names = []

    async def show_as(name):
        names.append(name)
        return "Your Twilio number is in Contacts as J.A.R.V.I.S., so your iPhone shows it."

    hub.phone.show_as = show_as
    q = hub.subscribe()
    await hub._handle({"type": "phone_caller_name", "name": ""})
    status = [e for e in drain(q) if e["type"] == "phone_status"][-1]
    assert names == [phone.CALLER_NAME] and "Contacts as J.A.R.V.I.S." in status["note"]
