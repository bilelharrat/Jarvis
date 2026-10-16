"""A fake debug adapter for the debugger's tests (tests/test_code_dap.py, test_code_debugger.py):
DAP over stdio, or over TCP when started with a port and a host (as js-debug's server is).

The "program" is the launch's program file, one step a line: it starts at line 1 and runs to
the next breakpoint (or the end: exit code 0). next/stepIn/stepOut go one line on. Its locals
are `line` (where it is) and `data` (an object with one child). FAKE_DAP_MODE changes it:
- hang: never says "initialized" (the start's timeout).
- child: (TCP) a launch asks the client for a child session (startDebugging), as js-debug
  does; the child connection does the work.
- terminal: asks the client to runInTerminal and prints what it answered.
- exception: a continue stops on an exception.
- forever: a continue never stops by itself (only pause does).
"""

import json
import os
import socket
import sys
import threading

MODE = os.environ.get("FAKE_DAP_MODE", "")


class Conn:
    def __init__(self, rfile, wfile, server=None):
        self.rfile, self.wfile, self.server = rfile, wfile, server
        self.seq = 0
        self.lock = threading.Lock()
        self.program = ""
        self.lines = 10
        self.line = 1
        self.breakpoints = set()
        self.launch_seq = None
        self.launch_command = "launch"
        self.config = {}
        self.child = False
        self.reverse = {}

    def send(self, msg):
        with self.lock:
            self.seq += 1
            msg = {"seq": self.seq, **msg}
            body = json.dumps(msg).encode()
            self.wfile.write(b"Content-Length: %d\r\n\r\n" % len(body) + body)
            self.wfile.flush()

    def event(self, _event, **body):
        self.send({"type": "event", "event": _event, "body": body})

    def respond(self, req, body=None, ok=True, message=""):
        msg = {
            "type": "response",
            "request_seq": req["seq"],
            "command": req["command"],
            "success": ok,
        }
        if ok:
            msg["body"] = body or {}
        else:
            msg["message"] = message
        self.send(msg)

    def read(self):
        length = None
        while True:
            line = self.rfile.readline()
            if not line:
                return None
            line = line.strip()
            if not line:
                break
            name, _, value = line.decode().partition(":")
            if name.lower() == "content-length":
                length = int(value)
        return json.loads(self.rfile.read(length))

    # ── the program ──

    def run_on(self):
        for n in sorted(self.breakpoints):
            if n > self.line:
                self.line = n
                self.event("stopped", reason="breakpoint", threadId=1)
                return
        self.end()

    def end(self):
        self.event("output", category="stdout", output="done\n")
        self.event("exited", exitCode=0)
        self.event("terminated")

    def start_running(self):
        if self.config.get("stopOnEntry"):
            self.event("stopped", reason="entry", threadId=1)
        elif 1 in self.breakpoints:
            self.event("stopped", reason="breakpoint", threadId=1)
        else:
            self.run_on()

    # ── requests ──

    def handle(self, req):
        if req.get("type") == "response":
            self.reverse[req.get("request_seq")] = req
            if req.get("command") == "runInTerminal":
                self.event(
                    "output",
                    category="console",
                    output=f"runInTerminal: {req.get('success')} {req.get('message', '')}\n",
                )
            return True
        cmd = req["command"]
        args = req.get("arguments") or {}
        if cmd == "initialize":
            self.respond(
                req,
                {"supportsConfigurationDoneRequest": True, "supportsConditionalBreakpoints": True},
            )
        elif cmd in ("launch", "attach"):
            self.config = args
            self.launch_seq, self.launch_command = req, cmd
            self.program = str(args.get("program") or "")
            try:
                with open(self.program, encoding="utf-8") as fh:
                    self.lines = max(1, len(fh.read().splitlines()))
            except OSError:
                self.lines = 10
            self.child = bool(args.get("__pendingTargetId"))
            if MODE == "hang":
                return True
            self.event("output", category="stdout", output=f"hello from fake ({cmd})\n")
            self.event("process", name=self.program, systemProcessId=os.getpid())
            if MODE == "terminal":
                self.send(
                    {"type": "request", "command": "runInTerminal", "arguments": {"args": ["x"]}}
                )
            self.event("initialized")
        elif cmd == "setBreakpoints":
            lines = [b["line"] for b in args.get("breakpoints") or []]
            self.breakpoints = {n for n in lines if n <= self.lines}
            self.respond(
                req,
                {
                    "breakpoints": [
                        {
                            "verified": n <= self.lines,
                            "line": n,
                            **({} if n <= self.lines else {"message": "no code there"}),
                        }
                        for n in lines
                    ]
                },
            )
        elif cmd == "configurationDone":
            self.respond(req)
            if self.launch_seq is not None:
                self.respond(self.launch_seq)
                self.launch_seq = None
            if MODE == "child" and self.server is not None and not self.child:
                cfg = {**self.config, "__pendingTargetId": "t1"}
                self.send(
                    {
                        "type": "request",
                        "command": "startDebugging",
                        "arguments": {"request": "launch", "configuration": cfg},
                    }
                )
                return True
            self.start_running()
        elif cmd == "threads":
            self.respond(req, {"threads": [{"id": 1, "name": "MainThread"}]})
        elif cmd == "stackTrace":
            src = {"path": self.program, "name": os.path.basename(self.program)}
            self.respond(
                req,
                {
                    "stackFrames": [
                        {"id": 1000, "name": "main", "source": src, "line": self.line, "column": 1},
                        {"id": 1001, "name": "<module>", "source": src, "line": 1, "column": 1},
                    ],
                    "totalFrames": 2,
                },
            )
        elif cmd == "scopes":
            self.respond(
                req,
                {
                    "scopes": [
                        {"name": "Locals", "variablesReference": 100, "expensive": False},
                        {"name": "Globals", "variablesReference": 200, "expensive": True},
                    ]
                },
            )
        elif cmd == "variables":
            ref = args.get("variablesReference")
            if ref == 100:
                variables = [
                    {
                        "name": "line",
                        "value": str(self.line),
                        "type": "int",
                        "variablesReference": 0,
                    },
                    {
                        "name": "data",
                        "value": "{'k': 'v'}",
                        "type": "dict",
                        "variablesReference": 101,
                    },
                ]
            elif ref == 101:
                variables = [
                    {"name": "'k'", "value": "'v'", "type": "str", "variablesReference": 0}
                ]
            else:
                variables = [
                    {"name": f"g{i}", "value": "x" * 1000, "variablesReference": 0}
                    for i in range(100)
                ]
            self.respond(req, {"variables": variables})
        elif cmd == "evaluate":
            expr = args.get("expression", "")
            if expr == "boom":
                self.respond(req, ok=False, message="NameError: name 'boom' is not defined")
            else:
                self.respond(
                    req,
                    {"result": f"{expr} -> {self.line}", "type": "str", "variablesReference": 0},
                )
        elif cmd in ("next", "stepIn", "stepOut"):
            self.respond(req)
            self.event("continued", threadId=1, allThreadsContinued=True)
            self.line += 1
            if self.line > self.lines:
                self.end()
            else:
                self.event("stopped", reason="step", threadId=1)
        elif cmd == "continue":
            self.respond(req, {"allThreadsContinued": True})
            if MODE == "forever":
                return True
            if MODE == "exception":
                self.event(
                    "stopped",
                    reason="exception",
                    threadId=1,
                    text="ZeroDivisionError: division by zero",
                )
                return True
            self.run_on()
        elif cmd == "pause":
            self.respond(req)
            self.event("stopped", reason="pause", threadId=1)
        elif cmd == "disconnect":
            self.event(
                "output",
                category="console",
                output=f"disconnect terminate={args.get('terminateDebuggee')}\n",
            )
            self.respond(req)
            return False
        else:
            self.respond(req, ok=False, message=f"fake: no {cmd}")
        return True

    def serve(self):
        while True:
            msg = self.read()
            if msg is None or not self.handle(msg):
                return


def main():
    argv = sys.argv[1:]
    if len(argv) >= 2 and argv[-2].isdigit():
        port, host = int(argv[-2]), argv[-1]
        srv = socket.socket()
        srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        srv.bind((host, port))
        srv.listen(4)
        print(f"Debug server listening at {host}:{port}", flush=True)
        sock, _ = srv.accept()
        parent = Conn(sock.makefile("rb"), sock.makefile("wb"), server=srv)

        def others():
            while True:
                s, _ = srv.accept()
                child = Conn(s.makefile("rb"), s.makefile("wb"), server=srv)
                threading.Thread(target=child.serve, daemon=True).start()

        threading.Thread(target=others, daemon=True).start()
        parent.serve()  # the parent: its end is the server's
        return
    Conn(sys.stdin.buffer, sys.stdout.buffer).serve()


if __name__ == "__main__":
    main()
