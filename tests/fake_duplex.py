"""A stand-in for audio/jarvis-duplex in tests: the live player's protocol on stdin and
stdout, and a scripted "microphone" on the capture pipe. No audio engine, no microphone.

    FAKE_DUPLEX_LOG     a file each command is written to ("args …", "A <bytes>", "M <id>",
                        "S", "V <permille>")
    FAKE_DUPLEX_REFUSE  a reason: it says "E <reason>" and exits (AirPods as the input…)
    FAKE_DUPLEX_MIC     a file of 16 kHz 16-bit PCM it "hears", over and over (a listener
                        that starts late still hears it)
    FAKE_DUPLEX_QUIET   "1": it confirms the microphone, then sends nothing (a stall)
"""

import os
import struct
import sys
import threading
import time


def log(line):
    path = os.environ.get("FAKE_DUPLEX_LOG")
    if path:
        with open(path, "a") as out:
            out.write(line + "\n")


def say(line):
    sys.stdout.write(line + "\n")
    sys.stdout.flush()


def main():
    args = sys.argv[1:]
    log("args " + " ".join(args))
    refuse = os.environ.get("FAKE_DUPLEX_REFUSE")
    if refuse:
        say("E " + refuse)
        return 5
    capture = os.fdopen(int(args[args.index("--capture-fd") + 1]), "wb", buffering=0)

    def microphone():
        path = os.environ.get("FAKE_DUPLEX_MIC")
        audio = open(path, "rb").read() if path else b""
        say("C Fake Mic")
        if os.environ.get("FAKE_DUPLEX_QUIET") == "1":
            return  # open, and silent
        position = 0
        while True:
            chunk = audio[position : position + 1600] if audio else bytes(1600)
            position = position + 1600 if position + 1600 < len(audio) else 0
            try:
                capture.write(chunk)
            except (BrokenPipeError, OSError):
                return
            time.sleep(0.01)  # five times real time: tests needn't wait

    threading.Thread(target=microphone, daemon=True).start()
    stdin = sys.stdin.buffer
    while True:
        head = stdin.read(5)
        if len(head) < 5:
            return 0
        kind, value = head[:1], struct.unpack("<I", head[1:])[0]
        if kind == b"A":
            log(f"A {len(stdin.read(value))}")
        elif kind == b"M":
            log(f"M {value}")
            say(f"M {value}")
        elif kind == b"S":
            log("S")
        elif kind == b"V":
            log(f"V {value}")


if __name__ == "__main__":
    sys.exit(main())
