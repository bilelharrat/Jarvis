"""Backups of the data folder (jarvis.features.ops.backup): what goes in and what never
does, the manifest that proves a zip whole, and restores that only ever write the files a
backup holds, where they belong, at the next start."""

import hashlib
import json
import os
import stat
import zipfile
from datetime import datetime, timedelta

import pytest

from jarvis.features.ops import backup


def at(minutes=0):
    return lambda: datetime(2026, 9, 29, 20, 15, 12) + timedelta(minutes=minutes)


@pytest.fixture
def data(tmp_path):
    folder = tmp_path / "Jarvis"
    folder.mkdir()
    (folder / "prefs.json").write_text('{"language": "en"}')
    (folder / "memory.json").write_text('{"facts": ["Ann is my co-founder"]}')
    (folder / "permissions.json").write_text('{"/p": ["npm test"]}')
    (folder / "transactions.json").write_text('{"spent": 400}')
    (folder / "devices.json").write_text('[{"id": "phone"}]')
    # What must never go in: previous and damaged copies, temp files, the browser's
    # profile, the file index, locks, binaries and models.
    (folder / "prefs.json.bak").write_text("{}")
    (folder / "memory.json.bad-20260901-101010").write_text("{torn")
    (folder / ".memory.json.abc123.tmp").write_text("{}")
    (folder / "Cookies").write_text("session=secret")
    (folder / "Local State").write_text('{"os_crypt": "x"}')
    (folder / "Preferences").write_text("{}")
    (folder / "files.db").write_bytes(b"SQLite format 3\x00")
    (folder / "backend.lock").write_text("123")
    for sub in ("bin", "models", "workspace", "Cache", "Local Storage"):
        (folder / sub).mkdir()
    (folder / "bin" / "jarvis-player-abc").write_bytes(b"\xcf\xfa\xed\xfe")
    (folder / "models" / "hand_landmarker.task").write_bytes(b"model")
    (folder / "brain").mkdir()
    (folder / "brain" / "index.json").write_text('{"notes": []}')
    return folder


def zip_names(path):
    with zipfile.ZipFile(path) as zf:
        return sorted(zf.namelist())


def test_a_backup_holds_the_stores_and_never_secrets_logs_or_binaries(data, tmp_path):
    outside = tmp_path / "outside.json"
    outside.write_text('{"not": "ours"}')
    (data / "linked.json").symlink_to(outside)  # a link is never followed into a backup
    (data / "folder.json").mkdir()  # nor is a folder with a store's name
    made = backup.create(data, tmp_path / "Backups", clock=at())
    assert made["name"] == "Jarvis backup 2026-09-29 at 20.15.12.zip"
    assert made["kind"] == "manual" and made["files"] == 5 and not made["knowledge"]
    assert zip_names(made["path"]) == [
        "data/devices.json",
        "data/memory.json",
        "data/permissions.json",
        "data/prefs.json",
        "data/transactions.json",
        "manifest.json",
    ]
    manifest = json.loads(zipfile.ZipFile(made["path"]).read("manifest.json"))
    assert manifest["app"] == "jarvis" and manifest["format"] == backup.FORMAT
    memory = next(r for r in manifest["files"] if r["path"] == "memory.json")
    raw = (data / "memory.json").read_bytes()
    assert memory == {
        "path": "memory.json",
        "size": len(raw),
        "sha256": hashlib.sha256(raw).hexdigest(),
    }
    # Readable by the owner alone, in a folder only the owner can open.
    assert stat.S_IMODE(os.stat(made["path"]).st_mode) == 0o600
    assert stat.S_IMODE(os.stat(tmp_path / "Backups").st_mode) == 0o700


def test_the_second_brain_index_only_when_asked_and_never_through_a_link(data, tmp_path):
    made = backup.create(data, tmp_path / "B", knowledge=True, clock=at())
    assert "data/brain/index.json" in zip_names(made["path"]) and made["knowledge"]
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    (elsewhere / "index.json").write_text("{}")
    (data / "brain" / "index.json").unlink()
    (data / "brain").rmdir()
    (data / "brain").symlink_to(elsewhere)
    assert backup.KNOWLEDGE not in backup.collect(data, knowledge=True)


def test_kinds_are_named_and_a_second_one_in_the_same_second_gets_its_own_name(data, tmp_path):
    dest = tmp_path / "B"
    daily = backup.create(data, dest, kind="daily", clock=at())
    again = backup.create(data, dest, kind="daily", clock=at())
    safety = backup.create(data, dest, kind="safety", clock=at())
    assert daily["name"] == "Jarvis backup 2026-09-29 at 20.15.12 (daily).zip"
    assert again["name"] == "Jarvis backup 2026-09-29 at 20.15.12 (daily) 2.zip"
    assert safety["name"] == "Jarvis backup 2026-09-29 at 20.15.12 (before restore).zip"
    assert not [p for p in os.listdir(dest) if p.startswith(".")]  # no partial file left


def test_nothing_to_back_up_and_a_file_in_the_folders_place_say_so(tmp_path):
    empty = tmp_path / "empty"
    empty.mkdir()
    with pytest.raises(backup.BackupError, match="nothing to back up"):
        backup.create(empty, tmp_path / "B")
    (tmp_path / "file").write_text("x")
    (empty / "prefs.json").write_text("{}")
    with pytest.raises(backup.BackupError, match="isn't a folder"):
        backup.create(empty, tmp_path / "file")


def test_verify_reads_every_file_back_against_its_checksum(data, tmp_path):
    made = backup.create(data, tmp_path / "B", clock=at())
    good = backup.verify(tmp_path / "B" / made["name"])
    assert good["ok"] and good["files"] == 5 and not good["problem"]

    tampered = tmp_path / "tampered.zip"
    with zipfile.ZipFile(made["path"]) as src, zipfile.ZipFile(tampered, "w") as out:
        for info in src.infolist():
            body = src.read(info)
            if info.filename == "data/memory.json":
                body = body.replace(b"Ann", b"Bob")  # same size, other bytes
            out.writestr(info, body)
    bad = backup.verify(tampered)
    assert not bad["ok"] and bad["problem"] == "memory.json doesn't match its checksum."


def write_zip(path, manifest_files, entries, *, links=(), manifest=None):
    with zipfile.ZipFile(path, "w") as zf:
        for name, body in entries.items():
            info = zipfile.ZipInfo(name)
            mode = stat.S_IFLNK | 0o777 if name in links else stat.S_IFREG | 0o600
            info.external_attr = mode << 16
            zf.writestr(info, body)
        doc = manifest or {"format": 1, "app": "jarvis", "kind": "manual", "files": manifest_files}
        zf.writestr("manifest.json", json.dumps(doc))
    return path


def row(rel, body):
    return {"path": rel, "size": len(body), "sha256": hashlib.sha256(body).hexdigest()}


@pytest.mark.parametrize(
    ("rel", "problem"),
    [
        ("../escape.json", "../escape.json isn't a place a backup can restore to."),
        ("../../escape.json", "../../escape.json isn't a place a backup can restore to."),
        ("/etc/escape.json", "/etc/escape.json isn't a place a backup can restore to."),
        ("brain/../escape.json", "brain/../escape.json isn't a place a backup can restore to."),
        ("sub/escape.json", "sub/escape.json isn't a place a backup can restore to."),
        ("..\\escape.json", "..\\escape.json isn't a place a backup can restore to."),
        ("Cookies", "Cookies isn't a place a backup can restore to."),
        (".hidden.json", ".hidden.json isn't a place a backup can restore to."),
    ],
)
def test_a_path_outside_the_data_folder_is_refused_before_anything_is_written(
    data, tmp_path, rel, problem
):
    body = b'{"evil": true}'
    evil = write_zip(tmp_path / "evil.zip", [row(rel, body)], {backup.DATA + rel: body})
    assert backup.verify(evil)["problem"] == problem
    assert backup.preview(evil, data) == {"ok": False, "problem": problem}
    with pytest.raises(backup.BackupError):
        backup.stage(evil, data)
    assert not (tmp_path / "escape.json").exists() and not (data.parent / "escape.json").exists()
    assert backup.pending(data) is None


def test_a_link_in_the_zip_or_a_file_it_doesnt_list_is_refused(data, tmp_path):
    body = b"/etc/passwd"
    link = write_zip(
        tmp_path / "link.zip",
        [row("memory.json", body)],
        {"data/memory.json": body},
        links={"data/memory.json"},
    )
    assert backup.verify(link)["problem"] == "memory.json is a link, which a backup never holds."
    extra = write_zip(
        tmp_path / "extra.zip",
        [row("memory.json", b"{}")],
        {"data/memory.json": b"{}", "data/../../../evil.sh": b"rm -rf ~"},
    )
    assert backup.verify(extra)["problem"] == "It holds files that aren't in its list."
    with pytest.raises(backup.BackupError):
        backup.stage(extra, data)


def test_what_isnt_a_jarvis_backup_says_so(data, tmp_path):
    (tmp_path / "junk.zip").write_bytes(b"not a zip")
    assert (
        backup.verify(tmp_path / "junk.zip")["problem"] == "It isn't a zip file, or it's damaged."
    )
    other = tmp_path / "other.zip"
    with zipfile.ZipFile(other, "w") as zf:
        zf.writestr("readme.txt", "hi")
    assert backup.verify(other)["problem"].startswith("It isn't a Jarvis backup")
    newer = write_zip(
        tmp_path / "newer.zip", [], {}, manifest={"format": 99, "app": "jarvis", "files": []}
    )
    assert backup.verify(newer)["problem"] == "It was made by a newer version of Jarvis."
    assert backup.verify(tmp_path / "gone.zip")["problem"] == "That backup isn't there any more."


def test_the_list_holds_jarvis_backups_newest_first(data, tmp_path):
    dest = tmp_path / "B"
    backup.create(data, dest, clock=at(0))
    backup.create(data, dest, kind="daily", clock=at(60))
    (dest / "holiday photos.zip").write_bytes(b"PK")  # someone else's zip
    (dest / ".Jarvis backup x.zip.part").write_bytes(b"PK")
    listed = backup.list_backups([dest, tmp_path / "missing"])
    assert [b["kind"] for b in listed] == ["daily", "manual"]
    assert listed[0]["created"] == "2026-09-29T21:15:12" and listed[0]["files"] == 5


def test_preview_says_what_a_restore_changes_and_what_it_keeps(data, tmp_path):
    made = backup.create(data, tmp_path / "B", clock=at())
    (data / "memory.json").write_text('{"facts": []}')  # changed since
    (data / "permissions.json").unlink()  # gone since
    (data / "goals.json").write_text("{}")  # new since
    (data / "transactions.json").write_text('{"spent": 450}')
    seen = backup.preview(made_path(made), data)
    assert seen["ok"]
    assert seen["replace"] == ["memory.json"]
    assert seen["add"] == ["permissions.json"]
    assert seen["same"] == ["prefs.json"]
    assert seen["keep"] == ["devices.json", "transactions.json"]
    assert seen["left"] == ["goals.json", "brain/index.json"]  # not in it: left as they are


def made_path(made):
    from pathlib import Path

    return Path(made["path"])


def test_a_restore_is_staged_then_applied_at_the_next_start(data, tmp_path):
    made = backup.create(data, tmp_path / "B", clock=at())
    (data / "memory.json").write_text('{"facts": ["changed"]}')
    (data / "transactions.json").write_text('{"spent": 450}')
    (data / "devices.json").write_text("[]")  # a lost phone unpaired since
    staged = backup.stage(made_path(made), data, safety="Jarvis backup safety.zip", clock=at(5))
    assert staged["files"] == 3 and staged["backup"] == made["name"]
    # Nothing the app has open changes until the next start.
    assert json.loads((data / "memory.json").read_text()) == {"facts": ["changed"]}
    assert backup.pending(data)["files"] == 3

    result = backup.apply_pending(data, clock=at(10))
    assert result["ok"] and result["files"] == 3
    assert json.loads((data / "memory.json").read_text()) == {"facts": ["Ann is my co-founder"]}
    assert stat.S_IMODE(os.stat(data / "memory.json").st_mode) == 0o600
    # The purchase log and the paired phones are never rolled back.
    assert json.loads((data / "transactions.json").read_text()) == {"spent": 450}
    assert json.loads((data / "devices.json").read_text()) == []
    assert not (data / "ops" / "restore").exists() and backup.pending(data) is None
    told = backup.take_result(data)
    assert told["ok"] and told["files"] == 3 and told["backup"] == made["name"]
    assert backup.take_result(data) is None  # said once
    assert backup.apply_pending(data) is None  # nothing waiting now


def test_a_staged_file_changed_since_it_was_checked_restores_nothing(data, tmp_path):
    made = backup.create(data, tmp_path / "B", clock=at())
    (data / "memory.json").write_text('{"facts": ["now"]}')
    (data / "prefs.json").write_text('{"language": "zh"}')
    backup.stage(made_path(made), data)
    (data / "ops" / "restore" / "memory.json").write_text('{"facts": ["injected"]}')
    result = backup.apply_pending(data)
    assert not result["ok"] and result["problem"] == "memory.json changed after it was checked."
    assert json.loads((data / "prefs.json").read_text()) == {"language": "zh"}  # all or none
    assert json.loads((data / "memory.json").read_text()) == {"facts": ["now"]}
    assert not (data / "ops" / "restore").exists()


def test_a_link_where_a_file_goes_is_never_written_through(data, tmp_path):
    made = backup.create(data, tmp_path / "B", knowledge=True, clock=at())
    backup.stage(made_path(made), data)
    victim = tmp_path / "victim.json"
    victim.write_text("precious")
    (data / "memory.json").unlink()
    (data / "memory.json").symlink_to(victim)
    result = backup.apply_pending(data)
    assert not result["ok"] and "is a link" in result["problem"]
    assert victim.read_text() == "precious"
    # A linked brain folder is refused the same way.
    (data / "memory.json").unlink()
    backup.stage(made_path(made), data)
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    for name in os.listdir(data / "brain"):
        os.unlink(data / "brain" / name)
    (data / "brain").rmdir()
    (data / "brain").symlink_to(elsewhere)
    result = backup.apply_pending(data)
    assert not result["ok"] and not os.listdir(elsewhere)


def test_a_restore_folder_that_isnt_ours_is_never_followed(data, tmp_path):
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    (elsewhere / "keep.txt").write_text("mine")
    (data / "ops").mkdir()
    (data / "ops" / "restore").symlink_to(elsewhere)
    result = backup.apply_pending(data)
    assert result is not None and not result["ok"]
    assert (elsewhere / "keep.txt").read_text() == "mine"


def test_a_staged_restore_can_be_taken_back(data, tmp_path):
    made = backup.create(data, tmp_path / "B", clock=at())
    backup.stage(made_path(made), data)
    assert backup.cancel_pending(data)
    assert backup.pending(data) is None and backup.apply_pending(data) is None
    assert not backup.cancel_pending(data)


def test_old_daily_and_safety_backups_go_but_a_manual_one_or_another_zip_never(data, tmp_path):
    dest = tmp_path / "B"
    for day in range(9):
        backup.create(data, dest, kind="daily", clock=at(day * 24 * 60))
    manual = backup.create(data, dest, clock=at(-60))
    (dest / "photos.zip").write_bytes(b"PK")
    removed = backup.prune(dest, "daily")
    assert removed == [
        "Jarvis backup 2026-09-30 at 20.15.12 (daily).zip",
        "Jarvis backup 2026-09-29 at 20.15.12 (daily).zip",
    ]
    left = backup.list_backups([dest])
    assert sum(b["kind"] == "daily" for b in left) == 7
    assert (dest / manual["name"]).exists() and (dest / "photos.zip").exists()
    assert backup.prune(dest, "manual") == []


def test_restore_after_restore_has_its_safety_backup_listed_as_such(data, tmp_path):
    dest = tmp_path / "B"
    safety = backup.create(data, dest, kind="safety", clock=at())
    listed = backup.list_backups([dest])
    assert listed[0]["name"] == safety["name"] and listed[0]["kind"] == "safety"
