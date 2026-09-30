"""Text in screenshots and images (jarvis.ocr): only images in the folders the brain reads,
never the Photos library or anything private; each read once, by its contents; a few hundred
a rebuild. A fake reader stands in for Apple's Vision."""

import os

import pytest

from jarvis import ocr
from jarvis.ocr import TextCache, collect_images, walk_images


def image(path, size=10_000, stamp=None, fill=None):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(
        b"\x89PNG"
        + (fill or path.name.encode()) * (size // max(1, len(fill or path.name.encode())))
    )
    if stamp is not None:
        os.utime(path, (stamp, stamp))
    return path


class FakeReader:
    def __init__(self, texts=None, fail_on=None):
        self.read = []
        self.texts = texts or {}
        self.fail_on = fail_on
        self.closed = False

    def __call__(self, path):
        self.read.append(path.name)
        if path.name == self.fail_on:
            raise TimeoutError("stuck")
        return self.texts.get(path.name, f"Text on the screen of {path.name}")

    def close(self):
        self.closed = True


def test_only_images_outside_packages_links_and_secrets_are_walked(tmp_path):
    home = tmp_path / "home"
    docs = home / "Documents"
    image(docs / "Screenshot 1.png")
    image(docs / "deep" / "scan.JPG")
    image(docs / ".hidden.png")
    image(docs / "notes.txt")  # not an image
    image(docs / "tiny.png", size=100)  # an icon
    image(docs / "Passwords" / "vault.png")  # a folder named for a secret
    image(docs / "Photos Library.photoslibrary" / "originals" / "IMG_1.heic")  # never
    image(docs / "Deck.key" / "Data" / "slide.png")  # a document package
    image(docs / "node_modules" / "pkg" / "logo.png")
    (docs / "link.png").symlink_to(docs / "Screenshot 1.png")
    image(home / "Library" / "Caches" / "thumb.png")
    found = sorted(p.name for p, _ in walk_images(docs, home))
    assert found == ["Screenshot 1.png", "scan.JPG"]
    assert list(walk_images(home / "Library", home)) == []  # ~/Library, even when added


def test_the_home_folder_as_a_brain_folder_never_walks_into_library(tmp_path):
    """Settings take the home folder itself as a brain folder: its images are read, never
    another app's inside ~/Library (Mail's downloads, an app's container)."""
    home = tmp_path / "home"
    image(home / "Desktop" / "Screenshot 1.png")
    mail = home / "Library" / "Containers" / "com.apple.mail" / "Data" / "Library"
    image(mail / "Mail Downloads" / "scan.jpg")
    image(home / "Library" / "Application Support" / "SomeApp" / "cache.png")
    found = sorted(p.relative_to(home).as_posix() for p, _ in walk_images(home, home))
    assert found == ["Desktop/Screenshot 1.png"]


def test_images_are_read_newest_first_once_by_their_contents(tmp_path):
    home = tmp_path / "home"
    desk = home / "Desktop"
    image(desk / "old.png", stamp=1_700_000_000)
    image(desk / "new.png", stamp=1_790_000_000)
    reader = FakeReader({"old.png": "Quarterly board review\nRevenue up 12%"})
    cache = tmp_path / "brain" / "images.db"
    notes = collect_images([desk], cache, lambda: reader, home=home)
    assert reader.read == ["new.png", "old.png"] and reader.closed
    by_name = {n.title: n for n in notes}
    assert by_name["old"].source == "images" and "Revenue up 12%" in by_name["old"].text
    assert by_name["old"].id == f"image:{desk / 'old.png'}" and by_name["old"].group == "Desktop"
    # A rebuild reads nothing again; a copy under another name isn't read either.
    (desk / "old.png").rename(desk / "renamed.png")
    again = FakeReader()
    notes = collect_images([desk], cache, lambda: again, home=home)
    assert again.read == [] and {n.title for n in notes} == {"new", "renamed"}


def test_a_rebuild_reads_at_most_its_share_and_the_next_carries_on(tmp_path):
    home = tmp_path / "home"
    desk = home / "Desktop"
    for i in range(5):
        image(desk / f"shot{i}.png", stamp=1_790_000_000 + i)
    cache = tmp_path / "images.db"
    first = FakeReader()
    assert len(collect_images([desk], cache, lambda: first, home=home, limit=2)) == 2
    assert first.read == ["shot4.png", "shot3.png"]
    second = FakeReader()
    assert len(collect_images([desk], cache, lambda: second, home=home, limit=2)) == 4
    assert second.read == ["shot2.png", "shot1.png"]
    clock = iter([0.0, 0.0, 500.0])
    third = FakeReader()
    collect_images(
        [desk], cache, lambda: third, home=home, seconds=10, clock=lambda: next(clock, 500.0)
    )
    assert third.read == ["shot0.png"]


def test_images_with_little_or_no_text_are_remembered_but_not_notes(tmp_path):
    home = tmp_path / "home"
    desk = home / "Desktop"
    image(desk / "sunset.jpg")
    image(desk / "button.png")
    reader = FakeReader({"sunset.jpg": "", "button.png": "OK"})
    cache = tmp_path / "images.db"
    assert collect_images([desk], cache, lambda: reader, home=home) == []
    again = FakeReader()
    assert collect_images([desk], cache, lambda: again, home=home) == [] and again.read == []


def test_secrets_in_a_screenshot_are_blanked_before_they_are_kept(tmp_path):
    home = tmp_path / "home"
    desk = home / "Desktop"
    image(desk / "wifi.png")
    reader = FakeReader({"wifi.png": "Office wifi\npassword: hunter2\ncard 4111 1111 1111 1111"})
    cache = tmp_path / "images.db"
    [note] = collect_images([desk], cache, lambda: reader, home=home)
    assert "hunter2" not in note.text and "4111" not in note.text
    stored = TextCache(cache)
    try:
        texts = [t for (t,) in stored.conn.execute("SELECT text FROM texts")]
    finally:
        stored.close()
    assert texts and all("hunter2" not in t for t in texts)


def test_a_reader_that_stalls_or_cant_be_built_stops_reading_not_the_rebuild(tmp_path):
    home = tmp_path / "home"
    desk = home / "Desktop"
    image(desk / "a.png", stamp=1_790_000_002)
    image(desk / "b.png", stamp=1_790_000_001)
    cache = tmp_path / "images.db"
    stuck = FakeReader(fail_on="a.png")
    assert collect_images([desk], cache, lambda: stuck, home=home) == []
    assert stuck.read == ["a.png"]  # b waits for the next rebuild
    assert collect_images([desk], cache, lambda: None, home=home) == []
    later = FakeReader()
    assert len(collect_images([desk], cache, lambda: later, home=home)) == 2


def test_images_gone_from_the_folders_are_forgotten(tmp_path):
    home = tmp_path / "home"
    desk = home / "Desktop"
    image(desk / "a.png")
    cache = tmp_path / "images.db"
    collect_images([desk], cache, FakeReader, home=home)
    (desk / "a.png").unlink()
    assert collect_images([desk], cache, FakeReader, home=home) == []
    stored = TextCache(cache)
    try:
        assert stored.conn.execute("SELECT count(*) FROM files").fetchone()[0] == 0
        assert stored.conn.execute("SELECT count(*) FROM texts").fetchone()[0] == 0
    finally:
        stored.close()


def test_a_damaged_cache_is_started_afresh(tmp_path):
    cache = tmp_path / "images.db"
    cache.write_bytes(b"this is not a database at all" * 100)
    fresh = TextCache(cache)
    try:
        assert fresh.conn.execute("SELECT count(*) FROM texts").fetchone()[0] == 0
    finally:
        fresh.close()


def test_the_helper_reader_speaks_the_line_protocol(tmp_path):
    import stat
    import sys

    script = tmp_path / "fake-ocr"
    script.write_text(
        f"#!{sys.executable}\n"
        "import json, sys\n"
        "for line in sys.stdin:\n"
        "    item = json.loads(line)\n"
        "    if item['path'].endswith('bad.png'):\n"
        "        print(json.dumps({'id': item['id'], 'error': 'not an image'}), flush=True)\n"
        "    else:\n"
        "        print(json.dumps({'id': item['id'], 'text': 'Hello from ' + item['path'][-5:]}), flush=True)\n"
    )
    script.chmod(script.stat().st_mode | stat.S_IXUSR)
    reader = ocr.HelperReader(script, timeout=10)
    try:
        assert reader(tmp_path / "a.png") == "Hello from a.png"
        assert reader(tmp_path / "bad.png") == ""
    finally:
        reader.close()


@pytest.mark.parametrize("size", [ocr.MIN_BYTES - 1, ocr.MAX_BYTES + 1])
def test_images_too_small_or_too_big_are_not_read(tmp_path, size):
    home = tmp_path / "home"
    path = home / "Desktop" / "x.png"
    path.parent.mkdir(parents=True)
    with open(path, "wb") as fh:
        fh.truncate(size)
    assert list(walk_images(home / "Desktop", home)) == []
