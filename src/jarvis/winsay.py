"""`say` for Windows: the same command line the speech code gives macOS's `say`, spoken by
Windows' own voices (System.Speech, through PowerShell). Run as `python -I -m jarvis.winsay`.

  -r WPM            speaking rate in words per minute (SAPI's -10..10 is about 17 wpm a step around 175)
  -v NAME           an installed voice; `-v ?` lists them as `say -v ?` does (Name  en_US  # …)
  -o FILE.wav       write the speech to a file (with --data-format=LEI16@RATE) instead of speaking
  text              from stdin (UTF-8): a reply starting with "-" is never a flag
"""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile

PS = [
    "powershell.exe",
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
]
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)

LIST = (
    "Add-Type -AssemblyName System.Speech;"
    "$s=New-Object System.Speech.Synthesis.SpeechSynthesizer;"
    "foreach($v in $s.GetInstalledVoices()){$i=$v.VoiceInfo;"
    "if($v.Enabled){Write-Output ($i.Name+'|'+$i.Culture.Name)}}"
)

SPEAK = (
    "$ErrorActionPreference='Stop';"
    "Add-Type -AssemblyName System.Speech;"
    "$s=New-Object System.Speech.Synthesis.SpeechSynthesizer;"
    "if($env:WINSAY_VOICE){try{$s.SelectVoice($env:WINSAY_VOICE)}catch{}};"
    "$s.Rate=[int]$env:WINSAY_RATE;"
    "if($env:WINSAY_OUT){$f=New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo("
    "[int]$env:WINSAY_HZ,[System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,"
    "[System.Speech.AudioFormat.AudioChannel]::Mono);$s.SetOutputToWaveFile($env:WINSAY_OUT,$f)};"
    "$s.Speak([IO.File]::ReadAllText($env:WINSAY_TEXT,[Text.Encoding]::UTF8));$s.Dispose()"
)


def voices() -> list[tuple[str, str]]:
    out = subprocess.run(
        [*PS, LIST],
        capture_output=True,
        text=True,
        timeout=20,
        check=False,
        creationflags=NO_WINDOW,
    ).stdout
    found = []
    for line in out.splitlines():
        name, _, culture = line.strip().partition("|")
        if name:
            found.append((name, culture.replace("-", "_")))
    return found


def sapi_rate(wpm: int) -> int:
    return max(-10, min(10, round((wpm - 175) / 17)))


def main(argv: list[str]) -> int:
    rate, voice, out, hz = 175, "", "", 22050
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "-r":
            rate, i = int(argv[i + 1]), i + 2
        elif a == "-v":
            voice, i = argv[i + 1], i + 2
        elif a == "-o":
            out, i = argv[i + 1], i + 2
        elif a.startswith("--data-format="):
            spec = a.split("@", 1)
            hz = int(spec[1]) if len(spec) == 2 and spec[1].isdigit() else hz
            i += 1
        else:
            i += 1
    if voice == "?":
        for name, culture in voices():
            print(f"{name:<24} {culture:<6} # {name}")
        return 0
    text = sys.stdin.buffer.read().decode("utf-8", "replace")
    if not text.strip():
        return 0
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "text.txt")
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)
        env = {
            **os.environ,
            "WINSAY_TEXT": path,
            "WINSAY_VOICE": voice,
            "WINSAY_RATE": str(sapi_rate(rate)),
            "WINSAY_OUT": out,
            "WINSAY_HZ": str(hz),
        }
        run = subprocess.run(
            [*PS, SPEAK], env=env, capture_output=True, check=False, creationflags=NO_WINDOW
        )
    if run.returncode:
        sys.stderr.write(run.stderr.decode("utf-8", "replace")[:300])
    return run.returncode


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
