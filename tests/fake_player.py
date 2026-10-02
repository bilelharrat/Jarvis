"""A stand-in for player/jarvis-player --live in tests: the live protocol on stdin and stdout,
no audio engine, nothing heard. Markers and pings are answered at once.

    FAKE_PLAYER_LOG     a file each start and command is written to ("start <pid>",
                        "A <bytes>", "M <id>", "P <id>", "S")
    FAKE_PLAYER_STUCK   a file holding a number: while it's above zero, each player started
                        takes one off it and is stuck (it says hello, reads every frame and
                        answers nothing: an engine that stopped playing across sleep)
    FAKE_PLAYER_WEDGED  the same, for a player that stops reading altogether once it has said
                        hello (stuck inside the audio system): its pipe fills up
    FAKE_PLAYER_OLD     "1": a player from before pings (no hello; a 'P' puts it out of
                        step, as the real one's "else" branch, so a test sees it was sent)
"""

import os
import struct
import sys
import time


def log(line):
    path = os.environ.get("FAKE_PLAYER_LOG")
    if path:
        with open(path, "a") as out:
            out.write(line + "\n")


def say(line):
    sys.stdout.write(line + "\n")
    sys.stdout.flush()


def counted(name):
    path = os.environ.get(name)
    if not path or not os.path.exists(path):
        return False
    left = int(open(path).read().strip() or 0)
    if left <= 0:
        return False
    with open(path, "w") as out:
        out.write(str(left - 1))
    return True


def main():
    log(f"start {os.getpid()}")
    old = os.environ.get("FAKE_PLAYER_OLD") == "1"
    silent = counted("FAKE_PLAYER_STUCK")
    wedged = counted("FAKE_PLAYER_WEDGED")
    if not old:
        say("H 1")
    if wedged:
        time.sleep(60)  # killed long before
        return 0
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
            if not silent:
                say(f"M {value}")
        elif kind == b"P" and not old:
            log(f"P {value}")
            if not silent:
                say(f"P {value}")
        elif kind == b"S":
            log("S")
        else:
            log(f"out of step {kind!r}")


if __name__ == "__main__":
    sys.exit(main())
