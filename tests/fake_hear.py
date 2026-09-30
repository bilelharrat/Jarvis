"""A stand-in for audio/jarvis-hear in tests: the same modes and the same framed protocol,
no speech model. It "hears" each utterance as `heard <start>-<end>`, the stretch it was
asked about, so a test can check which audio was meant; it says a partial for every block.

    FAKE_HEAR_LOG       a file each command it gets is written to
    FAKE_HEAR_INSTALLED "0": the model isn't on this Mac (status, listen)
    FAKE_HEAR_SILENT    "1": never answers a request
    FAKE_HEAR_WORDS     the words it says it heard in every utterance (instead of the span)
"""

import json
import os
import struct
import sys


def say(event):
    sys.stdout.write(json.dumps(event) + "\n")
    sys.stdout.flush()


def log(line):
    path = os.environ.get("FAKE_HEAR_LOG")
    if path:
        with open(path, "a") as out:
            out.write(line + "\n")


def main():
    mode, code = sys.argv[1], sys.argv[2]
    installed = os.environ.get("FAKE_HEAR_INSTALLED", "1") == "1"
    locale = "zh-CN" if code == "zh" else "en-US"
    log(f"{mode} {code}")
    if mode == "status":
        say({"available": True, "locale": locale, "installed": installed})
        return 0
    if mode == "size":
        say({"bytes": 123_000_000})
        return 0
    if mode == "install":
        for step in (0.25, 0.5, 1.0):
            say({"progress": step, "bytes": 123_000_000})
        say({"done": True})
        return 0
    if not installed:
        say({"t": "error", "why": f"Apple's speech model for {locale} isn't on this Mac"})
        return 5
    say({"t": "ready", "locale": locale})
    position, start = 0, 0
    stream = sys.stdin.buffer
    while True:
        head = stream.read(5)
        if len(head) < 5:
            return 0
        kind, size = head[:1], struct.unpack("<I", head[1:])[0]
        body = stream.read(size)
        if kind == b"B":
            start = position
            log(f"B at {position}")
        elif kind == b"A":
            position += len(body) // 2
            say({"t": "partial", "start": start, "end": position, "text": f"words to {position}"})
        elif kind == b"F":
            request = json.loads(body)
            log(f"F {request['start']}-{request['end']}")
            if os.environ.get("FAKE_HEAR_SILENT") == "1":
                continue
            words = (
                os.environ.get("FAKE_HEAR_WORDS") or f"heard {request['start']}-{request['end']}"
            )
            say({"t": "done", "id": request["id"], "text": words})
        elif kind == b"C":
            log("C " + ",".join(json.loads(body)["strings"]))


if __name__ == "__main__":
    sys.exit(main())
