"""What only the owner's own install shows (features/newuser.py): the window hears whether
this Mac has the BSH research desk, and the app people download has none."""

from conftest import FakeClient

from jarvis.features import newuser
from jarvis.hub import Hub


def test_the_desk_is_there_only_with_its_folder_and_server(tmp_path):
    class Settings:
        bsh_dir = None

    assert not newuser.bsh_desk(Settings())
    Settings.bsh_dir = tmp_path / "bsh-research-center"
    assert not newuser.bsh_desk(Settings())  # a folder that isn't there
    (Settings.bsh_dir / "scripts").mkdir(parents=True)
    (Settings.bsh_dir / "scripts" / "bsh_mcp.py").write_text("")
    assert newuser.bsh_desk(Settings())


async def test_the_window_asks_and_hears(settings, quiet_speaker, isolated):
    hub = Hub(settings, client_factory=FakeClient, speaker=quiet_speaker, poll=False, **isolated)
    sent = []
    hub.emit = lambda kind, **data: sent.append((kind, data))
    await hub._commands["newuser_state"][0]({"type": "newuser_state"})
    assert sent == [("newuser", {"bsh_desk": False, "packaged": False})]  # tests: no desk
