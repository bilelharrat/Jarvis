"""Text in pictures on a PC (winocr.py) and where it is used: the second brain's images and
scanned PDFs (ocr.PcReader, collect_images) and a scanned PDF read aloud (pdfpages). PowerShell
is a stand-in here that answers as the real script does; Windows itself is never needed."""

from __future__ import annotations

import base64
import queue
import subprocess

import pytest
from test_browser_pdf import tiny_pdf

from jarvis import ocr, osplat, pdfpages, winocr


class FakePowerShell:
    """winocr's script, played: "0 ready", then a line for each picture asked about."""

    started: list[list[str]] = []
    texts: dict[str, str] = {}
    hang = False
    no_language = False

    def __init__(self, argv, **kwargs):
        FakePowerShell.started.append(argv)
        self.out: queue.Queue = queue.Queue()
        self.stdin = self
        self.stdout = self
        self.code = None
        self.out.put(b"0 err no-language\n" if self.no_language else b"0 ready\n")

    # stdin
    def write(self, data: bytes) -> None:
        for line in data.decode("ascii").splitlines():
            ask, b64 = line.split(" ")
            path = base64.b64decode(b64).decode("utf-8")
            if FakePowerShell.hang:
                continue
            name = path.replace("\\", "/").rsplit("/", 1)[-1]
            if name.startswith("broken"):
                self.out.put(f"{ask} err The component cannot be found.\n".encode())
                continue
            text = FakePowerShell.texts.get(name, f"Words in {name}")
            self.out.put(f"{ask} ok {base64.b64encode(text.encode()).decode()}\n".encode())

    def flush(self) -> None:
        pass

    def close(self) -> None:
        self.out.put(None)
        self.code = 0

    # stdout
    def __iter__(self):
        while (line := self.out.get()) is not None:
            yield line

    def poll(self):
        return self.code

    def wait(self, timeout=None):
        return 0

    def kill(self):
        self.close()


@pytest.fixture
def powershell(monkeypatch):
    FakePowerShell.started = []
    FakePowerShell.texts = {}
    FakePowerShell.hang = False
    FakePowerShell.no_language = False
    monkeypatch.setattr(subprocess, "Popen", FakePowerShell)
    monkeypatch.setattr(osplat, "IS_WIN", True)
    return FakePowerShell


def test_one_powershell_reads_a_batch_of_pictures_in_any_language(powershell, tmp_path):
    powershell.texts = {"letter.png": "Dear Professor,\nYour invoice of €120 is due 1 Nov.\n東京"}
    reader = winocr.WinOcr()
    assert (
        reader(tmp_path / "letter.png")
        == "Dear Professor,\nYour invoice of €120 is due 1 Nov.\n東京"
    )
    assert reader(tmp_path / "Ünïcode name.png") == "Words in Ünïcode name.png"
    assert reader(tmp_path / "broken.heic") == ""  # Windows can't open it: nothing to find
    reader.close()
    assert len(powershell.started) == 1
    argv = powershell.started[0]
    assert argv[0] == "powershell.exe" and argv[-2] == "-EncodedCommand"
    script = base64.b64decode(argv[-1]).decode("utf-16-le")
    assert "Windows.Media.Ocr.OcrEngine" in script and "TryCreateFromUserProfileLanguages" in script


def test_a_stalled_recogniser_times_out_and_a_fresh_one_starts(powershell, tmp_path):
    reader = winocr.WinOcr(timeout=0.2)
    powershell.hang = True
    with pytest.raises(TimeoutError):
        reader(tmp_path / "a.png")
    powershell.hang = False
    assert reader(tmp_path / "b.png") == "Words in b.png"
    assert len(powershell.started) == 2


def test_no_recognition_language_says_so(powershell, tmp_path):
    powershell.no_language = True
    with pytest.raises(OSError, match="no recognition language"):
        winocr.WinOcr()(tmp_path / "a.png")


def test_pictures_as_bytes_are_read_and_nothing_happens_off_windows(powershell, monkeypatch):
    assert winocr.read_pictures([b"one", b"two"]) == ["Words in page-1.png", "Words in page-2.png"]
    monkeypatch.setattr(osplat, "IS_WIN", False)
    assert winocr.read_pictures([b"one"]) == [] and winocr.reader() is None


# ── the second brain on a PC ──


class FakeOcr:
    def __init__(self):
        self.read = []
        self.closed = False

    def __call__(self, path):
        self.read.append(path.name)
        return f"Scanned words on {path.name}"

    def close(self):
        self.closed = True


def test_a_pc_reads_pictures_and_scanned_pdfs_but_leaves_text_pdfs_to_the_files_source(tmp_path):
    scan = tmp_path / "scan.pdf"
    scan.write_bytes(tiny_pdf([None, None]))
    typed = tmp_path / "typed.pdf"
    typed.write_bytes(tiny_pdf(["This PDF has plenty of its own text in it already."]))
    fake = FakeOcr()
    reader = ocr.PcReader(fake)
    assert (
        reader(scan)
        == "Page 1:\nScanned words on page-1.png\n\nPage 2:\nScanned words on page-2.png"
    )
    assert reader(typed) == "" and fake.read == ["page-1.png", "page-2.png"]
    assert reader(tmp_path / "photo.png") == "Scanned words on photo.png"
    reader.close()
    assert fake.closed


def test_the_brain_indexes_scanned_pdfs_on_a_pc(tmp_path, monkeypatch):
    monkeypatch.setattr(ocr, "MIN_BYTES", 0)
    home = tmp_path / "home"
    docs = home / "Documents"
    docs.mkdir(parents=True)
    (docs / "tax letter.pdf").write_bytes(tiny_pdf([None]))
    fake = FakeOcr()
    notes = ocr.collect_images(
        [docs], tmp_path / "images.db", lambda: ocr.PcReader(fake), home=home, pdfs=True
    )
    assert [n.text for n in notes] == [
        "Text in the scanned PDF tax letter.pdf:\nPage 1:\nScanned words on page-1.png"
    ]
    # On a Mac (pdfs off) a PDF isn't one of the brain's pictures.
    assert ocr.collect_images([docs], tmp_path / "mac.db", FakeOcr, home=home, pdfs=False) == []


def test_the_reader_on_a_pc_is_windows_own(monkeypatch):
    monkeypatch.setattr(osplat, "IS_WIN", True)
    assert isinstance(ocr.helper_reader(), ocr.PcReader)


def test_a_scanned_pdf_read_aloud_on_a_pc_comes_with_windows_words(tmp_path, monkeypatch):
    scan = tmp_path / "bill.pdf"
    scan.write_bytes(tiny_pdf([None, None]))
    monkeypatch.setattr(winocr, "available", lambda: True)
    monkeypatch.setattr(winocr, "read_pictures", lambda pictures: ["Amount due: $84.20", ""])
    result = pdfpages.scanned_result(scan, 1, "bill.pdf", "read_file")
    note = result["content"][0]["text"]
    assert (
        "<scanned_text>\nPage 1:\nAmount due: $84.20\n\nPage 2:\n(no words found)\n</scanned_text>"
        in note
    )
    assert "key facts first" in note
    assert [c["type"] for c in result["content"][1:]] == ["image", "image"]
    monkeypatch.setattr(winocr, "available", lambda: False)
    assert (
        "<scanned_text>"
        not in pdfpages.scanned_result(scan, 1, "bill.pdf", "read_file")["content"][0]["text"]
    )
