"""A PC's side of the file tools (jarvis.winfiles, and file_actions where it differs): the Recycle Bin's
notes, the names Windows won't have, the folders Windows keeps for a person, and (on a PC only) the real
Recycle Bin and clipboard. What can be checked anywhere is checked with the PC's rules switched on."""

from __future__ import annotations

import json
import os
import struct
import sys
import uuid
from datetime import UTC, datetime
from pathlib import Path

import pytest

from jarvis import file_actions as fa
from jarvis import osplat, winfiles

ON_A_PC = sys.platform == "win32"


def filetime(when: datetime) -> int:
    return int((when - datetime(1601, 1, 1, tzinfo=UTC)).total_seconds() * 10_000_000)


def info_v2(original: str, when: datetime, size: int = 12) -> bytes:
    text = original + "\x00"
    return (
        struct.pack("<qqq", 2, size, filetime(when))
        + struct.pack("<i", len(text))
        + text.encode("utf-16-le")
    )


def info_v1(original: str, when: datetime, size: int = 12) -> bytes:
    text = (original + "\x00").encode("utf-16-le")
    return struct.pack("<qqq", 1, size, filetime(when)) + text.ljust(520, b"\x00")


WHEN = datetime(2026, 10, 8, 12, 30, tzinfo=UTC)


def test_the_bins_note_says_where_a_file_was_and_when_it_went():
    where, when, size = winfiles.parse_info(
        info_v2(r"C:\Users\ann\Documents\budget.xlsx", WHEN, 9000)
    )
    assert where == r"C:\Users\ann\Documents\budget.xlsx" and when == WHEN and size == 9000
    where, when, size = winfiles.parse_info(info_v1(r"C:\Users\ann\notes.txt", WHEN))
    assert where == r"C:\Users\ann\notes.txt" and when == WHEN


@pytest.mark.parametrize(
    "raw",
    [
        b"",
        b"short",
        struct.pack("<qqq", 3, 1, 1) + b"\x00" * 600,
        info_v2("", WHEN),
        info_v2("x" * 40000, WHEN)[:60],
    ],
)
def test_a_note_that_isnt_one_is_nothing(raw):
    assert winfiles.parse_info(raw) is None


@pytest.mark.parametrize(
    ("name", "why"),
    [
        ("report.docx", ""),
        ("notes 2026.txt", ""),
        ("a:b.txt", "can't have"),
        ("what?.txt", "can't have"),
        ("a/b", "can't have"),
        ("draft.", "end with"),
        ("draft ", "end with"),
        ("CON", "device"),
        ("nul.txt", "device"),
        ("com1.log", "device"),
        ("Console.txt", ""),
    ],
)
def test_the_names_windows_wont_have(name, why):
    got = winfiles.bad_name(name)
    assert (why in got) if why else got == ""


def test_the_size_of_a_folder_is_what_is_in_it(tmp_path):
    (tmp_path / "a").mkdir()
    (tmp_path / "a" / "one.txt").write_bytes(b"x" * 100)
    (tmp_path / "two.txt").write_bytes(b"y" * 50)
    assert winfiles.size_of(tmp_path) == 150
    assert winfiles.size_of(tmp_path / "two.txt") == 50
    assert winfiles.size_of(tmp_path, limit=1) == -1  # too many things to count


def test_a_put_back_item_takes_the_bins_note_with_it(tmp_path):
    held, note = tmp_path / "$RABC123.txt", tmp_path / "$IABC123.txt"
    held.write_text("x")
    note.write_bytes(info_v2(r"C:\x.txt", WHEN))
    winfiles.left_the_bin(held)
    assert not note.exists()
    winfiles.left_the_bin(tmp_path / "plain.txt")  # not the bin's: nothing happens, nothing raises


# ── file_actions with a PC's rules ──


@pytest.fixture
def pc(monkeypatch):
    monkeypatch.setattr(osplat, "IS_WIN", True)


@pytest.fixture
def home(tmp_path):
    home = tmp_path / "home"
    for folder in (
        "Documents",
        "Videos",
        "AppData/Roaming",
        "OneDrive - Springfield College/Papers",
        "Work",
    ):
        (home / folder).mkdir(parents=True)
    (home / "Work" / "draft.docx").write_text("d")
    return home


def actions(tmp_path, home, **kw):
    return fa.FileActions(tmp_path / "undo.json", home=home, **kw)


def test_a_pcs_own_folders_stay_where_they_are(pc, tmp_path, home):
    acts = actions(tmp_path, home)
    for name in ("Videos", "OneDrive - Springfield College", "AppData"):
        with pytest.raises(fa.Refused):
            acts.check_item(home / name)
    assert acts.check_item(home / "Work" / "draft.docx")  # a file in there is fine
    with pytest.raises(fa.Refused, match="app data"):
        acts.check_item(home / "AppData" / "Roaming")


def test_a_new_name_follows_windows_rules(pc, tmp_path, home):
    acts = actions(tmp_path, home)
    for bad in ("what?.docx", "a|b", "CON", "name.", "x\\y"):
        with pytest.raises(fa.Refused):
            acts.plan_rename(str(home / "Work" / "draft.docx"), bad)
    src, dest = acts.plan_rename(str(home / "Work" / "draft.docx"), "final")
    assert dest.name == "final.docx"


def test_putting_back_from_the_bin_clears_its_note(pc, tmp_path, home, monkeypatch):
    held = home / "Work" / "$RZZ1.txt"
    seen = []
    monkeypatch.setattr(winfiles, "left_the_bin", lambda path: seen.append(path))

    def into_the_bin(path):  # (stands in for the bin: the file goes under its $R name)
        path.write_text("kept")
        path.rename(held)
        return held

    acts = actions(tmp_path, home, trash=into_the_bin)
    record = acts.trash([home / "Work" / "draft.docx"])
    assert record.kind == "trash"
    said = acts.undo()
    assert "Recycle Bin" in said and seen == [held]
    assert (home / "Work" / "draft.docx").read_text() == "kept"


# ── the real thing, on a PC ──


@pytest.mark.skipif(not ON_A_PC, reason="the Recycle Bin and clipboard are Windows'")
def test_a_real_file_goes_to_the_recycle_bin_and_comes_back(tmp_path):
    path = Path.home() / f"jarvis-bin-test-{uuid.uuid4().hex[:8]}.txt"
    path.write_text("kept in the bin")
    acts = fa.FileActions(tmp_path / "undo.json")
    try:
        try:
            record = acts.trash([acts.check_item(path)])
        except OSError as exc:
            if "switched off" in str(exc) or "too big" in str(exc):
                pytest.skip(f"this machine's bin: {exc}")
            raise
        assert not path.exists()
        held = Path(record.items[0]["to"])
        assert held.name.startswith("$R") and held.exists() and "$Recycle.Bin" in str(held)
        assert held.read_text() == "kept in the bin"
        said = acts.undo()
        assert "Recycle Bin" in said
        assert path.read_text() == "kept in the bin"
        assert not (held.parent / ("$I" + held.name[2:])).exists()  # the bin's note went too
    finally:
        path.unlink(missing_ok=True)


@pytest.mark.skipif(not ON_A_PC, reason="the Recycle Bin is Windows'")
def test_the_bin_refuses_a_network_place_and_a_missing_drive():
    with pytest.raises(OSError, match="network"):
        winfiles.trash_item(Path(r"\\server\share\file.txt"))
    with pytest.raises(OSError):
        winfiles.trash_item(Path("relative.txt"))


@pytest.mark.skipif(not ON_A_PC, reason="the clipboard is Windows'")
def test_the_clipboard_round_trips_text_and_undo_puts_back_what_was_there(tmp_path):
    acts = fa.FileActions(tmp_path / "undo.json")
    try:
        winfiles.write_clipboard("what I had ✓")
    except OSError as exc:
        pytest.skip(f"no clipboard in this session: {exc}")
    assert acts.clipboard() == "what I had ✓"
    record = acts.copy("Jarvis wrote this")
    assert acts.clipboard() == "Jarvis wrote this"
    assert record.before == "what I had ✓"
    acts.undo()
    assert acts.clipboard() == "what I had ✓"


@pytest.mark.skipif(not ON_A_PC, reason="the clipboard is Windows'")
def test_what_a_password_manager_marks_private_is_never_read():
    import ctypes

    user32, kernel32 = winfiles._clipboard_api()
    try:
        winfiles.write_clipboard("hunter2")
    except OSError as exc:
        pytest.skip(f"no clipboard in this session: {exc}")
    fmt = user32.RegisterClipboardFormatW("ExcludeClipboardContentFromMonitorProcessing")
    handle = kernel32.GlobalAlloc(winfiles.GMEM_MOVEABLE, 4)
    pointer = kernel32.GlobalLock(handle)
    ctypes.c_uint.from_address(pointer).value = 1
    kernel32.GlobalUnlock(handle)
    winfiles._open_clipboard(user32)
    try:
        user32.SetClipboardData(fmt, handle)  # (added beside the text: it was written just now)
    finally:
        user32.CloseClipboard()
    with pytest.raises(fa.Refused, match="private"):
        fa.read_clipboard()
    winfiles.write_clipboard("")  # (and leave nothing behind)


@pytest.mark.skipif(not ON_A_PC, reason="Windows' own folders")
def test_the_folders_windows_keeps_are_found():
    found = winfiles.known_folders()
    assert "Documents" in found and "Desktop" in found
    assert all(isinstance(p, Path) and os.path.isabs(p) for p in found.values())
    assert winfiles.user_sid().startswith("S-1-")


# ── where a PC's own folders are, for the second brain and for documents ──


def test_a_pcs_folder_test_reads_backslashes(pc):
    """The file index's "is this inside that folder" was written for a Mac's slashes: on a PC it said
    no for everything below a root, and the index swept every file away."""
    from jarvis import fileindex

    assert fileindex._within(r"C:\Users\ann\Docs\sub\a.txt", r"C:\Users\ann\Docs")
    assert fileindex._within(r"C:\Users\ann\Docs", r"C:\Users\ann\Docs")
    assert not fileindex._within(r"C:\Users\ann\DocsExtra\a.txt", r"C:\Users\ann\Docs")
    assert not fileindex._within(r"C:\Users\bob\a.txt", r"C:\Users\ann")


def test_another_drive_is_a_root_a_pc_may_index_but_not_windows_itself(pc, monkeypatch):
    from jarvis import fileindex

    monkeypatch.setenv("SystemRoot", r"C:\Windows")
    monkeypatch.setenv("ProgramFiles", r"C:\Program Files")
    monkeypatch.setenv("ProgramData", r"C:\ProgramData")
    monkeypatch.setattr(
        os.path, "splitdrive", lambda p: (p[:2], p[2:]) if p[1:2] == ":" else ("", p)
    )
    assert fileindex._on_another_drive(r"D:\Research")
    assert fileindex._on_another_drive(r"E:\Papers\2026")
    assert not fileindex._on_another_drive("D:\\")  # a drive's top
    assert not fileindex._on_another_drive(r"C:\Windows\System32")
    assert not fileindex._on_another_drive(r"C:\Program Files\App")
    assert not fileindex._on_another_drive(r"C:\Users\bob\Documents")  # someone else's home
    assert not fileindex._on_another_drive(r"\\server\share\x")


def test_a_macs_personal_folders_are_under_its_home(tmp_path):
    assert osplat.personal_folders(tmp_path) == [
        tmp_path / "Documents",
        tmp_path / "Desktop",
        tmp_path / "Downloads",
    ]


@pytest.mark.skipif(not ON_A_PC, reason="Windows' own folders")
def test_a_pcs_personal_folders_are_where_windows_keeps_them():
    docs, desk, downloads = osplat.personal_folders()
    home = Path.home()
    for found, name in ((docs, "Documents"), (desk, "Desktop"), (downloads, "Downloads")):
        assert found.name == name or found == home / name
        assert home in found.parents  # (inside the home: OneDrive's, if it holds them)


@pytest.mark.skipif(not ON_A_PC, reason="Windows' own folders")
def test_documents_are_saved_where_the_person_will_find_them(monkeypatch, tmp_path):
    from jarvis import documents

    folder = documents.default_folder()
    assert folder.name == "JARVIS" and folder.parent.name == "Documents"
    monkeypatch.setenv(
        "USERPROFILE", str(tmp_path)
    )  # a home that isn't the real one: never the real Documents
    assert documents.default_folder() == tmp_path / "Documents" / "JARVIS"


def test_dropbox_is_found_where_its_app_says_it_is(monkeypatch, tmp_path):
    """The Dropbox app writes its folders (personal and work) to info.json: Jarvis reads them as it does
    OneDrive's, so the second brain and the file tools reach them wherever they are."""
    roaming, local = tmp_path / "Roaming", tmp_path / "Local"
    personal, work = tmp_path / "Dropbox", tmp_path / "Dropbox (Springfield)"
    personal.mkdir()
    work.mkdir()
    (roaming / "Dropbox").mkdir(parents=True)
    (roaming / "Dropbox" / "info.json").write_text(
        json.dumps(
            {"personal": {"path": str(personal), "host": 1}, "business": {"path": str(work)}}
        )
    )
    monkeypatch.setenv("APPDATA", str(roaming))
    monkeypatch.setenv("LOCALAPPDATA", str(local))
    for key in ("OneDrive", "OneDriveConsumer", "OneDriveCommercial"):
        monkeypatch.delenv(key, raising=False)
    assert winfiles.dropbox_roots() == [personal, work]
    assert winfiles.cloud_roots() == [personal, work]
    # A folder that isn't there, a file that isn't JSON, or none at all: no Dropbox, and no trouble.
    (roaming / "Dropbox" / "info.json").write_text(
        json.dumps({"personal": {"path": str(tmp_path / "gone")}})
    )
    assert winfiles.dropbox_roots() == []
    (roaming / "Dropbox" / "info.json").write_text("{not json")
    assert winfiles.dropbox_roots() == []
    (roaming / "Dropbox" / "info.json").unlink()
    assert winfiles.cloud_roots() == []


# ── the Recycle Bin call is made by a short program with a time limit ──


def test_a_question_windows_puts_on_screen_does_not_hang_the_app_and_nothing_is_deleted(
    monkeypatch,
):
    import subprocess

    def hangs(*_a, **kw):
        raise subprocess.TimeoutExpired(cmd="recycle", timeout=kw["timeout"])

    monkeypatch.setattr(winfiles.subprocess, "run", hangs)
    assert winfiles.recycle(Path("C:/x/y.txt"), wait=0.01) == winfiles.ERROR_CANCELLED


def test_the_short_program_is_started_with_this_python_and_what_it_prints_is_the_code(monkeypatch):
    import subprocess

    started = {}

    def runs(argv, **kw):
        started.update(argv=argv, timeout=kw["timeout"])
        return subprocess.CompletedProcess(argv, 0, stdout="0\n", stderr="")

    monkeypatch.setattr(winfiles.subprocess, "run", runs)
    assert winfiles.recycle(Path("C:/x/y.txt")) == 0
    assert started["argv"][:4] == [sys.executable, "-I", "-m", "jarvis.winfiles"]
    assert started["argv"][4:] == ["recycle", str(Path("C:/x/y.txt"))]
    assert started["timeout"] == winfiles.RECYCLE_SECONDS
    monkeypatch.setattr(
        winfiles.subprocess,
        "run",
        lambda argv, **kw: subprocess.CompletedProcess(argv, 0, stdout="2\n", stderr=""),
    )
    assert (
        winfiles.recycle(Path("C:/x/y.txt")) == 2
    )  # (Windows' own code for "not found" and the like)
    monkeypatch.setattr(
        winfiles.subprocess,
        "run",
        lambda argv, **kw: subprocess.CompletedProcess(argv, 1, stdout="", stderr="boom"),
    )
    assert (
        winfiles.recycle(Path("C:/x/y.txt")) == 1
    )  # (nothing readable: an error, never "it went")


def test_when_no_program_can_be_started_it_is_done_here(monkeypatch):
    def cannot(*_a, **_k):
        raise OSError("no")

    monkeypatch.setattr(winfiles.subprocess, "run", cannot)
    monkeypatch.setattr(winfiles, "_recycle_here", lambda path: 0)
    assert winfiles.recycle(Path("C:/x/y.txt")) == 0


@pytest.mark.skipif(not ON_A_PC, reason="the Recycle Bin is Windows'")
def test_a_cancelled_delete_is_said_in_words(monkeypatch, tmp_path):
    victim = tmp_path / "keep.txt"
    victim.write_text("still here")
    monkeypatch.setattr(winfiles, "recycle", lambda path, wait=0: winfiles.ERROR_CANCELLED)
    monkeypatch.setattr(winfiles, "bin_limits", lambda drive: (False, 1 << 40))
    with pytest.raises(OSError, match="stopped waiting"):
        winfiles.trash_item(victim)
    assert victim.read_text() == "still here"
