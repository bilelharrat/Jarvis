"""A fake language server for the tests (tests/test_code_lsp.py): it speaks the Language
Server Protocol over stdio (a Content-Length header, then JSON), as pyright or gopls do, about
a tiny Python-like language, so no real server need be installed.

- Symbols are words; one is defined where a line says `def <name>` or `class <name>`.
- definition, references, hover, prepareRename and rename work on whole words, across the
  .py files under the root (an open file's text as the client last sent it, the rest from
  disk), with UTF-16 columns as the protocol counts them.
- Diagnostics: an error at every `undefined_name`, a warning at every `TODO`, published after
  each didOpen and didChange (with --pull, answered to textDocument/diagnostic instead).
- After initialized it asks the client workspace/configuration and
  window/workDoneProgress/create, as real servers do.

Flags, for the failures the client must survive: --record FILE (every message it gets, a JSON
line each), --document-changes (renames as documentChanges, with a file rename too), --pull,
--busy N (the first N references answered ContentModified), --slow METHOD (never answers it),
--die-after-init, --noise (prints a line that isn't the protocol), --ignore-exit (stays after
exit), --apply-edit (asks the client to apply the rename itself), --no-prepare.
"""

import argparse
import json
import os
import re
import signal
import sys
import time
from pathlib import Path
from urllib.parse import unquote, urlparse

parser = argparse.ArgumentParser()
parser.add_argument("--record", default="")
parser.add_argument("--document-changes", action="store_true")
parser.add_argument("--pull", action="store_true")
parser.add_argument("--busy", type=int, default=0)
parser.add_argument("--slow", default="")
parser.add_argument("--die-after-init", action="store_true")
parser.add_argument("--noise", action="store_true")
parser.add_argument("--ignore-exit", action="store_true")
parser.add_argument("--apply-edit", action="store_true")
parser.add_argument("--no-prepare", action="store_true")
args = parser.parse_args()

stdin = sys.stdin.buffer
stdout = sys.stdout.buffer
root: Path | None = None
docs: dict[str, str] = {}
busy_left = args.busy
next_id = 1000
WORD = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
KEYWORDS = {"def", "class", "return", "import", "if", "else", "for", "in", "pass"}


def record(message):
    if args.record:
        with open(args.record, "a", encoding="utf-8") as f:
            f.write(json.dumps(message) + "\n")


def send(message):
    body = json.dumps(message).encode()
    stdout.write(b"Content-Length: %d\r\n\r\n" % len(body) + body)
    stdout.flush()


def read():
    length = None
    while True:
        line = stdin.readline()
        if not line:
            return None
        line = line.strip()
        if not line:
            if length is None:
                continue
            break
        name, _, value = line.partition(b":")
        if name.lower() == b"content-length":
            length = int(value)
    return json.loads(stdin.read(length))


def path_of(uri):
    return Path(unquote(urlparse(uri).path))


def uri_of(path):
    return Path(path).resolve().as_uri()


def u16(text):
    return sum(2 if ord(c) > 0xFFFF else 1 for c in text)


def index16(line, col):
    units = 0
    for i, c in enumerate(line):
        if units >= col:
            return i
        units += 2 if ord(c) > 0xFFFF else 1
    return len(line)


def text_of(uri):
    if uri in docs:
        return docs[uri]
    try:
        return path_of(uri).read_text(encoding="utf-8")
    except OSError:
        return ""


def files():
    uris = {uri_of(p) for p in sorted(root.rglob("*.py"))} if root else set()
    return sorted(uris | set(docs))


def word_at(uri, pos):
    lines = text_of(uri).split("\n")
    if pos["line"] >= len(lines):
        return None
    line = lines[pos["line"]]
    at = index16(line, pos["character"])
    for m in WORD.finditer(line):
        if m.start() <= at <= m.end():
            return m.group(), pos["line"], m.start(), m.end(), line
    return None


def rng(line_no, line, a, b):
    return {
        "start": {"line": line_no, "character": u16(line[:a])},
        "end": {"line": line_no, "character": u16(line[:b])},
    }


def occurrences(word):
    out = []
    pattern = re.compile(rf"(?<![A-Za-z0-9_]){re.escape(word)}(?![A-Za-z0-9_])")
    for uri in files():
        for n, line in enumerate(text_of(uri).split("\n")):
            for m in pattern.finditer(line):
                out.append((uri, n, line, m.start(), m.end()))
    return out


def definitions(word):
    out = []
    for uri, n, line, a, b in occurrences(word):
        if re.match(rf"\s*(def|class)\s+{re.escape(word)}\b", line):
            out.append({"uri": uri, "range": rng(n, line, a, b)})
    return out


def diagnostics(uri):
    out = []
    for n, line in enumerate(text_of(uri).split("\n")):
        for word, severity, message in (
            ("undefined_name", 1, "`undefined_name` is not defined"),
            ("TODO", 2, "A TODO is left"),
        ):
            at = line.find(word)
            if at >= 0:
                out.append(
                    {
                        "range": rng(n, line, at, at + len(word)),
                        "severity": severity,
                        "code": "fake-rule",
                        "source": "fakepy",
                        "message": message,
                    }
                )
    return out


def publish(uri, version=None):
    if not args.pull:
        params = {"uri": uri, "diagnostics": diagnostics(uri)}
        if version is not None:
            params["version"] = version
        send({"jsonrpc": "2.0", "method": "textDocument/publishDiagnostics", "params": params})


def answer(message):
    global root, busy_left, next_id
    method, params, ident = message.get("method"), message.get("params") or {}, message.get("id")
    if method == args.slow:
        return  # never answered
    result = None
    if method == "initialize":
        root = path_of(params["rootUri"])
        caps = {
            "textDocumentSync": {"openClose": True, "change": 1, "save": True},
            "definitionProvider": True,
            "typeDefinitionProvider": True,
            "referencesProvider": True,
            "hoverProvider": True,
            "renameProvider": True if args.no_prepare else {"prepareProvider": True},
        }
        if args.pull:
            caps["diagnosticProvider"] = {
                "interFileDependencies": False,
                "workspaceDiagnostics": False,
            }
        result = {"capabilities": caps, "serverInfo": {"name": "fakepy"}}
    elif method == "shutdown":
        result = None
    elif method in ("textDocument/definition", "textDocument/typeDefinition"):
        found = word_at(params["textDocument"]["uri"], params["position"])
        result = definitions(found[0]) if found else None
    elif method == "textDocument/references":
        if busy_left > 0:
            busy_left -= 1
            send(
                {
                    "jsonrpc": "2.0",
                    "id": ident,
                    "error": {"code": -32801, "message": "content modified"},
                }
            )
            return
        found = word_at(params["textDocument"]["uri"], params["position"])
        include = params.get("context", {}).get("includeDeclaration", True)
        result = []
        if found:
            for uri, n, line, a, b in occurrences(found[0]):
                if not include and re.match(rf"\s*(def|class)\s+{found[0]}\b", line):
                    continue
                result.append({"uri": uri, "range": rng(n, line, a, b)})
    elif method == "textDocument/hover":
        found = word_at(params["textDocument"]["uri"], params["position"])
        if found and definitions(found[0]):
            result = {
                "contents": {
                    "kind": "markdown",
                    "value": f"```python\ndef {found[0]}(...)\n```\nA fake symbol.",
                }
            }
    elif method == "textDocument/prepareRename":
        found = word_at(params["textDocument"]["uri"], params["position"])
        if found and found[0] not in KEYWORDS:
            result = {"range": rng(found[1], found[4], found[2], found[3]), "placeholder": found[0]}
    elif method == "textDocument/rename":
        found = word_at(params["textDocument"]["uri"], params["position"])
        if found:
            by_uri = {}
            for uri, n, line, a, b in occurrences(found[0]):
                by_uri.setdefault(uri, []).append(
                    {"range": rng(n, line, a, b), "newText": params["newName"]}
                )
            if args.document_changes:
                result = {
                    "documentChanges": [
                        {"textDocument": {"uri": u, "version": None}, "edits": e}
                        for u, e in by_uri.items()
                    ]
                    + [{"kind": "rename", "oldUri": "file:///old.py", "newUri": "file:///new.py"}]
                }
            else:
                result = {"changes": by_uri}
            if args.apply_edit:
                next_id += 1
                send(
                    {
                        "jsonrpc": "2.0",
                        "id": next_id,
                        "method": "workspace/applyEdit",
                        "params": {"edit": result},
                    }
                )
    elif method == "textDocument/diagnostic":
        result = {"kind": "full", "items": diagnostics(params["textDocument"]["uri"])}
    else:
        send({"jsonrpc": "2.0", "id": ident, "error": {"code": -32601, "message": f"no {method}"}})
        return
    send({"jsonrpc": "2.0", "id": ident, "result": result})


def main():
    global next_id
    while True:
        message = read()
        if message is None:
            return
        record(message)
        method = message.get("method")
        if method is None:
            continue  # an answer to one of ours (recorded)
        if "id" in message:
            answer(message)
            continue
        params = message.get("params") or {}
        if method == "initialized":
            if args.noise:
                stdout.write(b"Starting the fake server, hello!\n")
                stdout.flush()
            if args.die_after_init:
                sys.stderr.write("fakepy: something broke\n")
                sys.stderr.flush()
                os._exit(3)
            for m in ("workspace/configuration", "window/workDoneProgress/create"):
                next_id += 1
                p = (
                    {"items": [{"section": "python"}]}
                    if m.endswith("configuration")
                    else {"token": "t"}
                )
                send({"jsonrpc": "2.0", "id": next_id, "method": m, "params": p})
        elif method == "textDocument/didOpen":
            doc = params["textDocument"]
            docs[doc["uri"]] = doc["text"]
            publish(doc["uri"], doc.get("version"))
        elif method == "textDocument/didChange":
            uri = params["textDocument"]["uri"]
            docs[uri] = params["contentChanges"][-1]["text"]
            publish(uri, params["textDocument"].get("version"))
        elif method == "textDocument/didClose":
            docs.pop(params["textDocument"]["uri"], None)
        elif method == "exit":
            if args.ignore_exit:
                signal.signal(signal.SIGTERM, signal.SIG_IGN)
                while True:
                    time.sleep(1)
            return


if __name__ == "__main__":
    main()
