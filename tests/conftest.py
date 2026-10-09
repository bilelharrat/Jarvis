import asyncio
import functools
import os
from dataclasses import replace

import pytest
from claude_agent_sdk import (
    AssistantMessage,
    ResultMessage,
    TextBlock,
    ToolResultBlock,
    ToolUseBlock,
    UserMessage,
)

from jarvis.config import Settings

# Every Labs feature on (features/_labs.py): each is tested as if the owner turned it on.
os.environ.setdefault("JARVIS_LABS", "all")
from jarvis.speech import Speaker


def strip_note(query):
    """A query without the "[Note from the app: …]" the hub puts in front of it."""
    if isinstance(query, str) and query.startswith("[Note from the app:"):
        return query.split("]\n\n", 1)[-1]
    return query


class FakeClient:
    """Stands in for ClaudeSDKClient: records queries, replays a scripted response (as one
    turn from receive_response, and on the connection's stream from receive_messages)."""

    script: list = []

    def __init__(self, options=None):
        self.options = options
        self.queries = []
        self.interrupted = False
        self.connected = False
        self.stream = None

    def _stream(self):
        if self.stream is None:
            self.stream = asyncio.Queue()
        return self.stream

    async def connect(self):
        self.connected = True

    async def disconnect(self):
        self.connected = False

    @property
    def said(self):
        """The queries as the user put them, without the app's note in front."""
        return [strip_note(q) for q in self.queries]

    async def query(self, text):
        self.queries.append(text)
        for message in self.script:
            self._stream().put_nowait(message)

    async def receive_response(self):
        for message in self.script:
            yield message

    async def receive_messages(self):
        while True:
            yield await self._stream().get()

    async def interrupt(self):
        self.interrupted = True

    async def set_permission_mode(self, mode):
        self.modes = [*getattr(self, "modes", []), mode]

    async def set_model(self, model):
        self.model = model

    async def rewind_files(self, user_message_id):
        self.rewound = [*getattr(self, "rewound", []), user_message_id]

    async def get_context_usage(self):
        return {"percentage": 41.6, "totalTokens": 83000, "maxTokens": 200000}

    async def __aenter__(self):
        await self.connect()
        return self

    async def __aexit__(self, *exc):
        await self.disconnect()


def result(is_error=False, text="done", cost=0.01):
    return ResultMessage(
        subtype="error" if is_error else "success",
        duration_ms=1,
        duration_api_ms=1,
        is_error=is_error,
        num_turns=1,
        session_id="s",
        total_cost_usd=cost,
        result=text,
    )


CALENDAR_TURN = [
    AssistantMessage(
        content=[ToolUseBlock(id="t1", name="mcp__mac__list_events", input={})], model="m"
    ),
    UserMessage(content=[ToolResultBlock(tool_use_id="t1", content="ok", is_error=False)]),
    AssistantMessage(content=[TextBlock(text="Two meetings tomorrow.")], model="m"),
    result(),
]


@pytest.fixture
def settings(tmp_path):
    return replace(Settings(), bsh_dir=None, projects_dir=tmp_path)


@pytest.fixture
def quiet_speaker():
    speaker = Speaker.__new__(Speaker)
    speaker.voice, speaker.rate, speaker.muted, speaker._procs = "", 190, True, set()
    speaker.effect, speaker.cloud, speaker.cloud_error, speaker._playing = False, None, "", False
    speaker._player = None
    speaker.player_path, speaker._live, speaker._live_lock = None, None, None
    return speaker


@pytest.fixture(autouse=True)
def _quick_saves(monkeypatch):
    """Store saves in tests skip only the drive-cache flush (F_FULLFSYNC, about 5 ms a
    save; a plain fsync still runs): tests check what's written, not the drive's cache.
    test_jsonstore checks that the real saves ask for the flush."""
    import os

    from jarvis import jsonstore

    monkeypatch.setattr(jsonstore, "_sync", os.fsync)


@pytest.fixture(autouse=True)
def _no_real_private_folders(monkeypatch, tmp_path_factory):
    """The owner's private folders (private_folders.py) are never the real ones in a test: an
    empty list, its copy in a temp folder, and no setting from a hub of an earlier test."""
    from jarvis import private_folders

    monkeypatch.setattr(
        private_folders, "PATH", tmp_path_factory.mktemp("private") / "private_folders.json"
    )
    monkeypatch.setattr(private_folders, "_source", None)
    monkeypatch.setattr(private_folders, "_resolved", ((), []))
    monkeypatch.setattr(private_folders, "_file_seen", None)


# The Mac's own voice and player: what no test may start.
REAL_AUDIO = frozenset({"say", "afplay"})


@functools.cache
def _portaudio():
    """sounddevice, imported once (it starts PortAudio); None where it can't load."""
    try:
        import sounddevice
    except Exception:  # no PortAudio on this machine: there's no microphone to open
        return None
    return sounddevice


@pytest.fixture(autouse=True)
def _no_real_audio(monkeypatch):
    """No test makes a sound, voices anything with the Mac's `say` or opens the real
    microphone. Starting `say` or `afplay` fails as it does on a Mac without them
    (FileNotFoundError), which every caller already takes in its stride: no fillers voiced,
    no chime, no preview. Switching the language (hub.set_prefs({"language": "zh"})) voiced
    the Chinese fillers with the real `say` (slow, and it hung under load), and a bare wake
    word or a heads-up played the real chime. PortAudio's streams can't open either: a
    hands-free listener whose other source ends falls back to the microphone. Stand-ins
    (fake players and helpers, run by Python) still start. The fixture's value lists what
    was refused ("say", "afplay", "microphone"), for tests that check it."""
    import errno
    import os
    import subprocess

    refused: list[str] = []
    real = subprocess.Popen

    class NoRealAudio(real):
        def __init__(self, args, *rest, **kwargs):
            program = args if isinstance(args, str | bytes | os.PathLike) else next(iter(args), "")
            name = os.fsdecode(program).strip()
            if kwargs.get("shell"):
                name = name.split(maxsplit=1)[0] if name else ""
            name = os.path.basename(name)
            if name in REAL_AUDIO:
                refused.append(name)
                raise FileNotFoundError(errno.ENOENT, "no real audio in tests", name)
            super().__init__(args, *rest, **kwargs)

    monkeypatch.setattr(subprocess, "Popen", NoRealAudio)
    sd = _portaudio()
    if sd is not None:

        def no_microphone(*_args, **_kwargs):
            refused.append("microphone")
            raise sd.PortAudioError("no real microphone or speaker in tests")

        for name in (
            "InputStream",
            "RawInputStream",
            "OutputStream",
            "RawOutputStream",
            "Stream",
            "RawStream",
            "rec",
            "play",
            "playrec",
        ):
            monkeypatch.setattr(sd, name, no_microphone)
    return refused


@pytest.fixture(autouse=True)
def _no_real_keychain(monkeypatch):
    """Phone credentials in tests live in a dict, never the login keychain."""
    from jarvis import phone

    class Memory:
        def __init__(self):
            self.items = {}

        def get_password(self, service, user):
            return self.items.get((service, user))

        def set_password(self, service, user, secret):
            self.items[(service, user)] = secret

        def delete_password(self, service, user):
            self.items.pop((service, user), None)

    real = phone.Keychain.__init__

    def init(self, backend=None):
        real(self, backend if backend is not None else Memory())

    monkeypatch.setattr(phone.Keychain, "__init__", init)


@pytest.fixture(autouse=True)
def _no_real_mac_commands(monkeypatch):
    """A request that reads like "open Safari" or "press command T" never opens, clicks or
    types on the real Mac in a test: the instant command says it isn't one (so it goes on to
    the fake Claude). test_system_voice tests the real one with fakes of its own."""
    from jarvis import system_voice

    async def not_here(*_a, **_k):
        return None

    monkeypatch.setattr(system_voice, "carry_out", not_here)


@pytest.fixture(autouse=True)
def _no_real_claude_records(monkeypatch):
    """JARVIS's past conversations (Claude Code's own session records) are never the
    owner's ~/.claude in a test: a hub finds none, unless a test gives it fakes."""
    from jarvis import conversation_past

    def none_listed(*_args, **_kwargs):
        return []

    def none_found(*_args, **_kwargs):
        return None

    monkeypatch.setattr(conversation_past, "_sdk", lambda: (none_listed, none_listed, none_found))


@pytest.fixture
def isolated(tmp_path):
    """Prefs and second-brain index in a temp folder, never the user's real ones."""
    from jarvis.connectors import ConnectorManager, MemoryVault
    from jarvis.invoices import InvoiceStore
    from jarvis.knowledge import KnowledgeBase
    from jarvis.memory import MemoryStore
    from jarvis.prefs import PrefsStore
    from jarvis.remote import Devices
    from jarvis.routines import RoutineStore
    from jarvis.screenwatch import ScreenWatcher
    from jarvis.transactions import Transactions

    async def never_asked(*_args):
        return "deny"

    async def no_picture():
        return ""

    async def no_page():
        return {"error": "no browser in tests"}

    from jarvis.answering import CallLog
    from jarvis.delegate import DelegationStore
    from jarvis.documents import DocumentStore
    from jarvis.fileindex import FileIndex
    from jarvis.goals import GoalStore
    from jarvis.hearing import Hearing
    from jarvis.interrupts import Interrupter
    from jarvis.providers import ProviderStore
    from jarvis.suggestions import Suggester
    from jarvis.video import VideoDesk

    store = PrefsStore(tmp_path / "prefs.json")
    store.prefs.hands_free = False  # never open the real microphone in tests
    return {
        "prefs_store": store,
        "kb": KnowledgeBase(tmp_path / "brain" / "index.json"),
        "memory": MemoryStore(tmp_path / "memory.json"),
        "routines": RoutineStore(tmp_path / "routines.json"),
        "devices": Devices(tmp_path / "devices.json"),
        "invoice_store": InvoiceStore(tmp_path / "invoices.json", tmp_path / "Invoices"),
        "screen_watch": ScreenWatcher(capture=no_picture),  # never the real screen
        "connectors": ConnectorManager(
            lambda *a, **k: None,
            never_asked,
            vault=MemoryVault(),
            store=tmp_path / "connections.json",
        ),
        "providers": ProviderStore(tmp_path / "providers.json", MemoryVault()),
        "goal_store": GoalStore(tmp_path / "goals.json"),
        # No real Messages or Mail databases, and its state in the temp folder.
        "delegation_store": DelegationStore(tmp_path / "delegations.json"),
        "file_index": FileIndex(tmp_path / "files.db", [], home=tmp_path),  # never the real home
        "transaction_desk": Transactions(
            no_page, never_asked, lambda: store.prefs, log_path=tmp_path / "transactions.json"
        ),
        "interrupter": Interrupter(
            lambda _alert: None, state_path=tmp_path / "interrupts.json", enabled=lambda: False
        ),
        "hearing_store": Hearing(tmp_path / "hearing.json"),
        # Documents in the temp folder, and never opened in a real app.
        "document_store": DocumentStore(
            tmp_path / "documents.json", folder=tmp_path / "Documents", opener=lambda _p: None
        ),
        # No real calendar or Mail behind it.
        "suggester": Suggester(lambda _s: None, tmp_path / "suggestions.json"),
        # Videos only from the temp folder, and write-ups filed there.
        "video_desk": VideoDesk(roots=[tmp_path], notes_dir=tmp_path / "Videos"),
        # Calls to the Jarvis number: never the real call log or its voicemails.
        "call_log": CallLog(tmp_path / "answering.json"),
    }


@pytest.fixture(autouse=True)
def _no_real_claude_for_jarvis_code(monkeypatch):
    """Eden Code's own Claude calls (code_ai: commit messages, reviews, the best-of
    judge) never reach Claude in a test: one a test didn't fake fails loudly instead."""
    from jarvis import code_ai

    async def refuse(*_args, **_kwargs):
        raise AssertionError("a test reached code_ai.complete: fake the feature's .ai")

    monkeypatch.setattr(code_ai, "complete", refuse)


@pytest.fixture(autouse=True)
def _no_real_claude_for_jarvis_itself(monkeypatch):
    """JARVIS's own background calls (utility_model: a skill's triage and draft) never
    reach Claude in a test: one a test didn't fake fails loudly instead."""
    from jarvis import utility_model

    async def refuse(*_args, **_kwargs):
        raise AssertionError("a test reached utility_model.run_turn: fake it")

    monkeypatch.setattr(utility_model, "run_turn", refuse)


@pytest.fixture(autouse=True)
def _no_real_reminders(monkeypatch):
    """The Reminders helper (reminders_desk: EventKit in a subprocess) never starts in a
    test, so a briefing's facts never read the owner's real reminders: whatever asks gets
    an error back. test_proactive_reminders fakes the helper's answers itself."""
    from jarvis import reminders_desk

    async def not_here(*_args, **_kwargs):
        return {"error": "Reminders aren't reachable in tests."}

    monkeypatch.setattr(reminders_desk, "_run", not_here)


@pytest.fixture(autouse=True)
def _no_real_maps(monkeypatch):
    """Apple Maps (maps.run_helper: CoreLocation and MapKit in a subprocess) never answers a
    test, so a briefing's trip or a leave-time heads-up never looks up the real one; tests
    that want travel times fake run_helper themselves."""
    from jarvis import maps

    async def not_here(*_args, **_kwargs):
        return {"error": "Maps isn't reachable in tests."}

    monkeypatch.setattr(maps, "run_helper", not_here)


@pytest.fixture(autouse=True)
def _no_real_whisper(monkeypatch):
    """A hub a test starts without a transcriber of its own never warms up the real Whisper:
    that loaded a model per hub, each in a thread of its own (a few dozen hubs grew the
    process by gigabytes), after asking Hugging Face over the network for its revision."""
    from jarvis import listen

    monkeypatch.setattr(listen.Transcriber, "warm_up", lambda _self: None)


# On Windows only what can't hold there is left out: whole test files for what only a Mac has
# (its helper programs, its Trash, the iPhone companion) or only a POSIX shell can run, and the
# few tests that read a file's permission bits (a PC has none). The rest run, and show what a PC
# does differently.
collect_ignore: list[str] = []
NOT_ON_WINDOWS = {
    "test_companion_phone": "the iPhone companion is the Mac's",
    "test_companion_wake": "launchd, which wakes the Mac's companion",
    "test_duplex": "the Mac's audio helper",
    "test_embeddings": "the Mac's Swift helper",
    "test_mac_reading": "the Mac's accessibility helper",
    "test_voice_player": "the Mac's player helper",
    "test_comms": "Messages and Mail.app",
    "test_sms_line": "Messages",
    "test_line_voice": "the phone line's Node helper, built for a POSIX shell",
    "test_ops_doctor": "macOS's privacy permissions",
    "test_hooks": "scripts that are POSIX shell scripts",
    "test_jarvis_mcp": "Unix sockets, which Python on Windows lacks",
    "test_simtools": "the iOS Simulator",
    "test_stress_r1_injection": "Mac paths (~/Library, the Desktop's Mac names)",
}
# Single tests that hold a Mac's way of doing things (its shell, its open command, its Finder, a
# permission bit, a path written with slashes in what is said, a coincidence of the clock), each with why:
# a PC does these its own way and is checked by tests of its own (test_win*.py).
PC_SKIPS = {
    "test_agents.py::test_a_chats_route_and_a_called_name_pick_the_agent": "texts are not set up on a PC",
    "test_agents.py::test_an_agent_gets_only_its_tools_its_persona_and_its_memory": "texts are not set up on a PC",
    "test_agents.py::test_lazily_read_agents_rescope_the_first_prompt": "texts are not set up on a PC",
    "test_agents.py::test_the_window_gets_the_tools_personas_and_errors": "texts are not set up on a PC",
    "test_messaging.py::test_hub_offers_send_tools_with_a_tap_to_send": "texts are not set up on a PC",
    "test_browser_ai_page.py::test_a_fresh_selection_rides_along_once": "the Mac's page-reading helper",
    "test_browser_ai_macros.py::test_settings_run_asks_in_the_owner_s_words": "stops the test worker on a PC",
    "test_channels_groups.py::test_a_groups_progress_never_names_the_steps": "a Mac's timing of chat edits",
    "test_channels_groups.py::test_a_long_request_is_one_message_edited_into_the_answer": "a Mac's timing of chat edits",
    "test_channels_groups.py::test_without_edits_each_step_is_a_line_of_its_own_and_few": "a Mac's timing of chat edits",
    "test_computer_tools.py::test_a_screenshot_is_measured_without_starting_sips_for_it": "sips, a Mac program",
    "test_computer_tools.py::test_find_files_weighs_only_as_many_as_it_shows": "Spotlight, the Mac's search",
    "test_computer_tools.py::test_press_button_presses_by_name": "Finder's accessibility tree",
    "test_computer_tools.py::test_sensitive_paths_are_judged_as_before": "Mac paths (/Users/ann)",
    "test_diagnostics.py::test_a_checkers_report_is_read_off_the_event_loop": "a Mac's checkers",
    "test_diagnostics.py::test_a_long_build_log_looks_each_file_up_once": "paths written with slashes",
    "test_diagnostics.py::test_a_real_check_with_the_projects_checkers": "the checkers a Mac has",
    "test_diagnostics.py::test_each_checkers_report_becomes_problems": "paths written with slashes",
    "test_ui.py::test_bang_runs_in_the_project_and_hash_saves_a_memory": "a POSIX shell's semantics",
    "test_ui.py::test_open_project_file_stays_inside_the_project": "the Mac's open command",
    "test_providers.py::test_the_helper_command_survives_the_shell": "a POSIX shell",
    "test_code_secrets.py::test_secret_run_gives_the_command_its_value_and_scrubs_its_output": "a POSIX shell",
    "test_stopping.py::test_nothing_it_started_outlives_a_stop": "a PC's launcher program is one process more",
    "test_mcp_calendar.py::test_no_answer_in_time_changes_nothing": "a PC's clock ticks in 15 ms steps",
    "test_proactive_quiet.py::test_reading_focus_says_why_it_cant": "the Mac's Focus modes",
    "test_proactive_calls.py::test_the_call_is_them_and_the_microphone_is_you": "paths written with slashes",
    "test_fileindex_wiring.py::test_only_files_the_index_showed_can_be_opened": "the Mac's open command",
    "test_documents.py::test_tools": "paths are written with backslashes on a PC",
    "test_companion_api.py::test_journal_meetings_and_research_by_their_own_ids_never_a_path": "line ends: a PC writes \\r\\n",
    "test_ops_audit.py::test_the_data_folder_scan_never_follows_a_link": "links need a privilege on a PC",
    "test_ops_audit.py::test_the_scan_reaches_jarvis_own_folders_before_a_deep_cache_uses_its_budget": "paths written with slashes",
    "test_skill_workshop.py::test_the_window_lists_switches_previews_and_removes": "paths written with slashes",
    "test_memory_import.py::test_claude_md_is_read_only_when_asked_and_about_me_only_when_picked": "the Mac's Claude folder",
    "test_code_video.py::test_a_projects_switch_records_after_a_ui_turn_and_keeps_the_video": "the Mac's screen recorder",
    "test_code_history.py::test_the_history_lists_every_projects_sessions_newest_first": "Claude Code's Mac folder names",
    "test_eden_meetings.py::test_a_promise_is_kept_only_on_a_yes_and_can_be_undone": "the Mac's Reminders app",
}
MODE_BITS = {
    "test_action_log.py::test_entries_are_kept_per_day_and_read_back",
    "test_ops_backup.py::test_a_backup_holds_the_stores_and_never_secrets_logs_or_binaries",
    "test_ops_backup.py::test_a_restore_is_staged_then_applied_at_the_next_start",
    "test_stress_r1_stores.py::test_chat_projects_it_cant_read_are_never_saved_over",
    "test_stress_r1_stores.py::test_kept_session_settings_it_cant_read_are_never_saved_over",
    "test_answering.py::test_a_message_is_fetched_transcribed_here_kept_and_announced",
    "test_code_editor.py::test_line_endings_mode_and_links_are_kept",
    "test_code_isolation.py::test_an_isolated_session_runs_in_its_own_copy_on_its_own_branch",
    "test_code_rules.py::test_claude_code_s_settings_are_read_and_added_to_keeping_the_rest",
    "test_connector_log.py::test_each_call_is_a_line_without_its_contents",
    "test_delegate.py::test_a_conversation_is_saved_and_survives_a_restart",
    "test_eden_browser.py::test_a_task_cut_off_by_a_restart_comes_back_stopped",
    "test_goals.py::test_goals_constraints_and_priorities_survive_a_restart",
    "test_ops_wiring.py::test_the_security_review_and_its_tightens",
    "test_transactions.py::test_the_log_is_private_to_the_owner",
    "test_voice_id.py::test_enroll_tunes_the_threshold_to_the_owners_own_clips",
    "test_whatsapp.py::test_the_store_is_kept_where_only_the_user_can_read_it",
}


if os.name == "nt":
    # A PC's home folder is USERPROFILE (HOME means nothing to Python there): a test that moves "HOME" to a
    # temp folder means the home folder, so moving it moves that too and never the owner's real one.
    _setenv = pytest.MonkeyPatch.setenv

    def _setenv_with_profile(self, name, value, prepend=None):
        _setenv(self, name, value, prepend)
        if name == "HOME":
            _setenv(self, "USERPROFILE", value)

    pytest.MonkeyPatch.setenv = _setenv_with_profile


def pytest_collection_modifyitems(config, items):
    if os.name != "nt":
        return
    for item in items:
        why = NOT_ON_WINDOWS.get(item.path.stem)
        short = item.nodeid.split("tests/")[-1].split("[")[0]
        if why is None and short in MODE_BITS:
            why = "a PC has no permission bits to check"
        if why is None and short in PC_SKIPS:
            why = PC_SKIPS[short]
        if why:
            item.add_marker(pytest.mark.skip(reason=f"not on Windows: {why}"))
