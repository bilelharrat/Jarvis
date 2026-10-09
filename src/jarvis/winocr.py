"""Text in pictures on a PC: Windows' own text recognition (Windows.Media.Ocr, in every copy of
Windows 10 and 11, in the languages the user has installed), driven through PowerShell the way
winsay.py drives System.Speech, so nothing new is installed. The Mac reads pictures with Apple's
Vision instead (ocr.py and native/jarvis-ocr.swift).

One PowerShell is kept running while a batch of pictures is read (the second brain's rebuild, a
scanned PDF's pages): starting PowerShell and loading Windows' runtime takes a second or two, a
picture after that a fraction of one. It reads a line per picture, the path in base64 (UTF-8),
and answers a line: "<id> ok <text in base64>" or "<id> err <why>". Base64 both ways, so no
code page ever mangles a name or a word.

Claude cost policy: none; this never calls a model.
"""

from __future__ import annotations

import base64
import logging
import queue
import subprocess
import tempfile
import threading
from pathlib import Path

from . import osplat

log = logging.getLogger("jarvis")

PS = [
    "powershell.exe",
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",  # (the script as UTF-16 base64: no quoting on a command line to go wrong)
]
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
START_SECONDS = 40.0  # PowerShell, Windows' runtime and the recogniser, the first time
IMAGE_SECONDS = 30.0

SERVE = r"""
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null=[Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime]
$null=[Windows.Storage.Streams.IRandomAccessStream,Windows.Storage.Streams,ContentType=WindowsRuntime]
$null=[Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics,ContentType=WindowsRuntime]
$null=[Windows.Graphics.Imaging.SoftwareBitmap,Windows.Graphics,ContentType=WindowsRuntime]
$null=[Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]
$asTask=([System.WindowsRuntimeSystemExtensions].GetMethods()|Where-Object{$_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'})[0]
function Wait-Op($op,[Type]$type){$t=$asTask.MakeGenericMethod($type).Invoke($null,@($op));$null=$t.Wait(-1);$t.Result}
$engine=[Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if($engine -eq $null){[Console]::Out.WriteLine('0 err no-language');[Console]::Out.Flush();exit 3}
[Console]::Out.WriteLine('0 ready');[Console]::Out.Flush()
while(($line=[Console]::In.ReadLine()) -ne $null){
  $parts=$line.Split(' ');$id=$parts[0]
  try{
    $path=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($parts[1]))
    $file=Wait-Op ([Windows.Storage.StorageFile]::GetFileFromPathAsync($path)) ([Windows.Storage.StorageFile])
    $stream=Wait-Op ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $decoder=Wait-Op ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap=Wait-Op ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $result=Wait-Op ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
    $text=($result.Lines|ForEach-Object{$_.Text}) -join [char]10
    $stream.Dispose()
    [Console]::Out.WriteLine($id+' ok '+[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($text)))
  }catch{
    $why=($_.Exception.Message -replace '[\r\n]+',' ')
    [Console]::Out.WriteLine($id+' err '+$why)
  }
  [Console]::Out.Flush()
}
"""


def encoded(script: str) -> str:
    """A script as PowerShell's -EncodedCommand takes it."""
    return base64.b64encode(script.encode("utf-16-le")).decode("ascii")


def available() -> bool:
    """Whether this computer reads text in pictures this way (a PC)."""
    return osplat.IS_WIN


class WinOcr:
    """A running recogniser: call it with a picture's path for its text ("" when it has
    none, None when it couldn't be read now). close() when the batch is done. A recogniser
    that stalls or dies is started afresh on the next picture."""

    def __init__(self, timeout: float = IMAGE_SECONDS, start_timeout: float = START_SECONDS):
        self.timeout = timeout
        self.start_timeout = start_timeout
        self._proc: subprocess.Popen[bytes] | None = None
        self._lines: queue.Queue[bytes | None] = queue.Queue()
        self._ids = 0
        self._lock = threading.Lock()

    def _start(self) -> subprocess.Popen[bytes]:
        self._lines = queue.Queue()
        proc = subprocess.Popen(  # noqa: S603 - Windows' own PowerShell, our own script
            [*PS, encoded(SERVE)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            creationflags=NO_WINDOW,
        )
        lines = self._lines

        def pump() -> None:
            assert proc.stdout is not None
            for raw in proc.stdout:
                lines.put(raw)
            lines.put(None)

        threading.Thread(target=pump, daemon=True, name="winocr").start()
        self._proc = proc
        first = self._line(self.start_timeout)
        if not first.startswith(b"0 ready"):
            self.close()
            raise OSError(
                "Windows text recognition isn't set up on this PC (no recognition language)"
                if b"no-language" in first
                else "Windows text recognition didn't start"
            )
        return proc

    def _line(self, timeout: float) -> bytes:
        try:
            line = self._lines.get(timeout=timeout)
        except queue.Empty as exc:
            raise TimeoutError("Windows text recognition didn't answer in time") from exc
        if line is None:
            raise OSError("Windows text recognition stopped")
        return line.strip()

    def __call__(self, path: Path) -> str | None:
        with self._lock:
            try:
                proc = self._proc if self._proc and self._proc.poll() is None else self._start()
                self._ids += 1
                ask = str(self._ids)
                name = base64.b64encode(str(path).encode("utf-8")).decode("ascii")
                assert proc.stdin is not None
                proc.stdin.write(f"{ask} {name}\n".encode("ascii"))
                proc.stdin.flush()
                while True:
                    line = self._line(self.timeout).decode("ascii", "replace")
                    got, _, rest = line.partition(" ")
                    if got == ask:
                        break
            except BaseException:
                self.close()  # stuck or gone: a fresh one next time
                raise
        status, _, payload = rest.partition(" ")
        if status == "ok":
            try:
                return base64.b64decode(payload).decode("utf-8", "replace")
            except ValueError:
                return None
        log.info("windows ocr: couldn't read %s (%s)", Path(path).name, payload[:120])
        return ""  # not a picture Windows can open: nothing to find there

    def close(self) -> None:
        proc, self._proc = self._proc, None
        if proc is None:
            return
        try:
            if proc.stdin:
                proc.stdin.close()
            proc.wait(timeout=3)
        except (OSError, subprocess.TimeoutExpired):
            proc.kill()


def reader() -> WinOcr | None:
    """A recogniser for the second brain's rebuild (ocr.collect_images), or None off Windows."""
    return WinOcr() if available() else None


def read_pictures(pictures: list[bytes], suffix: str = ".png") -> list[str]:
    """The text in each of these pictures (PNG bytes by default), read by one recogniser; ""
    for one with none. [] when this isn't a PC or the recogniser won't start."""
    if not pictures or not available():
        return []
    ocr = WinOcr()
    out: list[str] = []
    with tempfile.TemporaryDirectory(prefix="jarvis-ocr-", ignore_cleanup_errors=True) as tmp:
        try:
            for i, data in enumerate(pictures):
                path = Path(tmp) / f"page-{i + 1}{suffix}"
                path.write_bytes(data)
                out.append(ocr(path) or "")
        except (OSError, TimeoutError) as exc:
            log.info("windows ocr: %s", exc)
        finally:
            ocr.close()  # (before the pictures are deleted: Windows can't delete an open file)
    return out
