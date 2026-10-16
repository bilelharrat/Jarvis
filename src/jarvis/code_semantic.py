"""What a piece of work changed, by symbol and by contract, not by line: the semantic
conflict guard's reading (features/code_semantic_guard.py).

Two sessions' work can merge without a single conflicting line and still not fit together:
both changed what one function does, one gave a function a new signature while the other
wrote new calls to it the old way, or one removed (or renamed) something the other's new
code still uses. git sees none of that, and neither did the merge queue. Here a piece of
work (an isolated copy's branch and uncommitted work, a pull request's branch, or what
landed in the branch they go into since they began) is read as:

- bodies: the symbols (functions, methods, classes, types) whose lines it changed, on
  either side of its diff, a changed line counted for the innermost symbol it's in. Blank
  lines don't count: they're where most noise between two functions comes from.
- contracts: the functions and methods it kept but whose signature changed in a way an
  old caller can't take (more required parameters, fewer allowed, a parameter renamed or
  taken out, a return type changed), and the new signature's parameters.
- removed: the symbols it took out, and what one was renamed to when a new one in the same
  file has much the same body.
- defined, calls, uses: the names its changed files define, and the calls and identifiers
  in the lines it added (strings and comments taken out first).

compare(a, b) then finds where two pieces of work collide: the same symbol's body changed
by both; a contract one changed while the other adds calls that don't fit the new one (a
call that does fit is the other side already having adapted, so it clears by itself); a
symbol one removed that the other's new lines still use, when the other doesn't define it
itself and the project's symbol map has no other definition of that name.

The symbols are the code index's (code_index.extract: Python's own parser for Python,
patterns a line at a time for JavaScript, TypeScript, Swift, Go, Rust, Java and the rest).
tree-sitter would read those exactly; it isn't in the app (code_index's docstring says
why), so signatures outside Python are read from their one line, and calls by matching
brackets over the added lines. It is a heuristic: it errs toward telling, and a finding
can always be overridden.

Everything here is blocking (git, reading files) and runs on this Mac. Cost policy: no
model is called, nothing is sent anywhere.
"""

from __future__ import annotations

import difflib
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

from . import code_changes, code_index
from .code_changes import FileDiff, git
from .computer import is_sensitive

FILES_MAX = 150  # files of one piece of work read; the rest aren't
TEXT_MAX = code_index.FILE_BYTES_MAX
CALL_CHARS = 600  # of a call's text, what's read to count its arguments
CALLS_PER_NAME = 20
RENAME_RATIO = 0.6  # how alike a removed and an added symbol's bodies are to be a rename
FINDINGS_MAX = 30
SKIP_LANGS = ("", "text", "markdown")
CALLABLE = ("function", "method")
NAMED = ("function", "method", "class", "struct", "enum", "interface", "type", "protocol",
         "trait", "record", "object", "module", "extension")  # fmt: skip
CONSTRUCTORS = ("__init__", "constructor", "init", "new")
# Names too common to say another piece of work "still uses" when one removes its own: a
# removed method called run says nothing about subprocess.run.
COMMON = frozenset(
    "run get set put add pop push open close read write load save start stop call apply "
    "init main new len str int map filter list dict keys values items update copy clear "
    "next send emit find join split format parse render test setup teardown handle process "
    "execute create delete remove reset build make value name data text type id key log "
    "print then catch resolve reject toString valueOf constructor describe it expect "
    "__init__ __call__ __repr__ __str__ __eq__ __hash__ __enter__ __exit__ self cls this "
    "super".split()
)
KEYWORDS = frozenset(
    "if elif else for while switch case catch return yield await async def class function "
    "func fn new not and or in is lambda with assert del raise try except finally import "
    "from as typeof instanceof sizeof guard let var const do throw throws defer go select "
    "match when where print super".split()
)
_IDENT = re.compile(r"[A-Za-z_$][\w$]*")
_CALL = re.compile(r"(?<![\w$])(?:new\s+)?([A-Za-z_$][\w$]*)\s*(?:<[^<>()]{0,80}>)?\s*\(")
_STRING = re.compile(
    r"'''.*?'''|\"\"\".*?\"\"\"|'(?:\\.|[^'\\])*'|\"(?:\\.|[^\"\\])*\"|`(?:\\.|[^`\\])*`"
)
_HASH_COMMENT = re.compile(r"(?:^|\s)#(?![!\[{]).*$")
_SLASH_COMMENT = re.compile(r"//.*$|/\*.*?\*/")
_HASH_LANGS = ("python", "ruby", "shell")
_OPEN, _CLOSE = "([{<", ")]}>"


# ── signatures ──


@dataclass
class Param:
    name: str
    label: str = ""  # Swift's argument label ("_" for none); the name elsewhere
    default: bool = False
    kind: str = "pos"  # pos | posonly | kw (keyword-only) | var (*args, ...rest) | varkw
    type: str = ""  # its declared type, as written (Python's isn't a contract a call breaks)


@dataclass
class Sig:
    params: list[Param]
    returns: str
    text: str

    def positional(self) -> list[Param]:
        return [p for p in self.params if p.kind in ("pos", "posonly")]

    def required(self) -> int:
        return sum(1 for p in self.positional() if not p.default)

    def most(self) -> int | None:
        return None if any(p.kind == "var" for p in self.params) else len(self.positional())

    def names(self) -> set[str]:
        return {p.label or p.name for p in self.params if p.kind in ("pos", "kw")}


def _split_top(text: str, sep: str = ",") -> list[str]:
    """text split at sep where no bracket is open (strings already blanked)."""
    out, depth, start = [], 0, 0
    for i, ch in enumerate(text):
        if ch in _OPEN:
            depth += 1
        elif ch in _CLOSE:
            depth = max(0, depth - 1)
        elif ch == sep and depth == 0:
            out.append(text[start:i])
            start = i + 1
    out.append(text[start:])
    return [p.strip() for p in out if p.strip()]


def _matching(text: str, at: int) -> int:
    """The index of the bracket closing the one at text[at] (-1 when it doesn't close)."""
    depth = 0
    for i in range(at, len(text)):
        if text[i] in "([{":
            depth += 1
        elif text[i] in ")]}":
            depth -= 1
            if depth == 0:
                return i
    return -1


def _blank_strings(text: str) -> str:
    """Strings as a placeholder: a comma or a bracket in one isn't the code's."""
    return _STRING.sub("_s", text)


def parse_signature(signature: str, lang: str, method: bool = False) -> Sig | None:
    """A symbol's parameters and return type from its signature line (code_index's
    Symbol.signature), or None when it has no parameter list to read."""
    text = _blank_strings(signature or "")
    at = text.find("(")
    if at < 0:
        return None
    end = _matching(text, at)
    if end < 0:
        return None
    raw = _split_top(text[at + 1 : end])
    rest = text[end + 1 :]
    returns = ""
    m = re.match(r"\s*(?:->|:)\s*([^{=]*?)\s*(?:\{|=>|=|where\b|$)", rest)
    if m and not rest.strip().startswith("{"):
        returns = " ".join(m.group(1).split()).rstrip(":").strip()
    params: list[Param] = []
    keyword_only = False
    for i, p in enumerate(raw):
        p = p.strip()
        if lang == "python":
            if p == "/":
                for q in params:
                    q.kind = "posonly"
                continue
            if p == "*":
                keyword_only = True
                continue
            if p.startswith("**"):
                params.append(Param(p[2:].split(":")[0].strip(), kind="varkw"))
                continue
            if p.startswith("*"):
                params.append(Param(p[1:].split(":")[0].strip(), kind="var"))
                keyword_only = True
                continue
            name = re.split(r"[:=]", p, maxsplit=1)[0].strip()
            if i == 0 and method and name in ("self", "cls"):
                continue
            params.append(Param(name, default="=" in p, kind="kw" if keyword_only else "pos"))
        elif lang == "swift":
            head, _, _type = p.partition(":")
            words = head.split()
            if not words:
                continue
            label = words[0]
            name = words[-1]
            params.append(
                Param(
                    name,
                    label=label,
                    default="=" in p,
                    kind="var" if "..." in _type else "pos",
                    type=" ".join(_type.split("=")[0].split()),
                )  # fmt: skip
            )
        else:
            if p.startswith("..."):
                params.append(Param(p[3:].split(":")[0].strip(), kind="var"))
                continue
            if lang == "js" and re.match(r"this\s*:", p):
                continue
            head = re.split(r"[=]", p, maxsplit=1)[0]
            words = _IDENT.findall(head.split(":")[0]) or [head]
            name = words[-1] if lang in ("java", "c") else words[0]
            optional = "=" in p or bool(re.match(r"[\w$]+\?\s*:", p))
            if ":" in head:  # (TypeScript, Rust: name: Type)
                kind_of = " ".join(head.split(":", 1)[1].split())
            else:  # (Java, C, Go: the words besides its name)
                kind_of = " ".join(w for w in head.replace("?", " ").split() if w != name)
            params.append(Param(name, default=optional, type=kind_of))
    return Sig(params, returns, " ".join(signature.split())[:300])


def breaking(old: Sig, new: Sig, lang: str) -> list[str]:
    """Why a caller written for old may not fit new (nothing when every such call still
    does: an optional parameter added at the end, say)."""
    why: list[str] = []
    if new.required() > old.required():
        why.append("more required arguments")
    most_old, most_new = old.most(), new.most()
    if most_new is not None and (most_old is None or most_new < most_old):
        why.append("fewer arguments allowed")
    if lang in ("python", "swift"):
        gone = old.names() - new.names()
        if gone and not any(p.kind == "varkw" for p in new.params):
            why.append("parameter renamed or taken out: " + ", ".join(sorted(gone)[:3]))
        must = {p.name for p in new.params if p.kind == "kw" and not p.default}
        if must - {p.name for p in old.params if p.kind == "kw" and not p.default}:
            why.append("a new required keyword argument")
    if lang != "python":
        typed = list(zip(old.positional(), new.positional(), strict=False))
        if any(o.type != n.type for o, n in typed):
            why.append("a parameter's type changed")
    if old.returns != new.returns and (old.returns or new.returns):
        why.append("return type changed")
    return why


# ── calls ──


@dataclass
class Call:
    path: str
    line: int
    text: str  # what follows its "(", up to CALL_CHARS
    method: bool = False  # obj.name(…)


def arguments(text: str) -> tuple[int, set[str], bool] | None:
    """A call's positional arguments, keyword (or Swift label) names, and whether it
    spreads something (*args, ...rest): None when its brackets don't close in text."""
    end = _matching("(" + text, 0)
    if end < 0:
        return None
    inner = text[: end - 1]
    args = _split_top(inner)
    positional, keywords, spread = 0, set(), False
    for a in args:
        if a.startswith(("*", "...")):
            spread = True
            continue
        m = re.match(r"([A-Za-z_$][\w$]*)\s*(=(?!=)|:(?!:))", a)
        if m:
            keywords.add(m.group(1))
        else:
            positional += 1
    return positional, keywords, spread


def fits(call: Call, sig: Sig, lang: str) -> bool | None:
    """Whether a call fits a signature: None when it can't be told (its brackets don't
    close in the lines added, or it spreads its arguments)."""
    got = arguments(call.text)
    if got is None:
        return None
    positional, keywords, spread = got
    if spread:
        return None
    if lang == "swift":
        labelled = [p for p in sig.params if p.label != "_"]
        unlabelled = [p for p in sig.params if p.label == "_"]
        need = {p.label for p in labelled if not p.default}
        allowed = {p.label for p in labelled}
        if not need <= keywords or not keywords <= allowed:
            return False
        req = sum(1 for p in unlabelled if not p.default)
        return req <= positional <= len(unlabelled) or any(p.kind == "var" for p in unlabelled)
    pos = sig.positional()
    most = sig.most()
    if most is not None and positional > most:
        return False
    if lang == "python":
        covered = {p.name for p in pos[:positional]}
        names = {p.name for p in sig.params if p.kind in ("pos", "kw")}
        if keywords - names and not any(p.kind == "varkw" for p in sig.params):
            return False
        for p in sig.params:
            if p.kind in ("pos", "posonly", "kw") and not p.default:
                if p.name not in covered and p.name not in keywords:
                    return False
        return True
    total = positional + len(keywords)
    return total >= sig.required()


# ── a piece of work, read by symbol ──


@dataclass
class FileText:
    path: str
    old_path: str
    old: str | None  # None: the file is new
    new: str | None  # None: the file was deleted
    hunks: list[code_changes.Hunk]


@dataclass
class Contract:
    path: str
    symbol: str
    line: int
    old: Sig
    new: Sig
    why: list[str]
    lang: str


@dataclass
class Removed:
    path: str
    symbol: str
    kind: str
    line: int
    renamed_to: str = ""


@dataclass
class Change:
    bodies: dict[tuple[str, str], int] = field(default_factory=dict)  # (path, symbol) -> line
    contracts: dict[str, Contract] = field(default_factory=dict)  # by the name it's called by
    removed: dict[str, Removed] = field(default_factory=dict)  # by name
    defined: set[str] = field(default_factory=set)  # every name its changed files define
    introduced: set[str] = field(default_factory=set)  # the names it newly defines
    calls: dict[str, list[Call]] = field(default_factory=dict)
    uses: dict[str, tuple[str, int]] = field(default_factory=dict)
    files: list[str] = field(default_factory=list)
    langs: dict[str, str] = field(default_factory=dict)  # path -> language

    def empty(self) -> bool:
        return not (self.bodies or self.contracts or self.removed or self.calls or self.uses)


def symbols_of(text: str | None, lang: str) -> list[code_index.Symbol]:
    """A text's symbols with an end each: the language's own (Python) or the line before
    the next symbol (patterns), so a line is in the innermost symbol around it."""
    if not text:
        return []
    found, _imports = code_index.extract(text, lang)
    found = [s for s in found if not s.kind.startswith("heading")]
    total = text.count("\n") + 1
    for i, s in enumerate(found):
        if not s.end:
            s.end = (found[i + 1].line - 1) if i + 1 < len(found) else total
    return found


def innermost(symbols: list[code_index.Symbol], line: int) -> code_index.Symbol | None:
    best = None
    for s in symbols:
        if s.line > line:
            break
        if s.line <= line <= max(s.end, s.line):
            best = s
    return best


def _code_only(line: str, lang: str) -> str:
    line = _blank_strings(line)
    line = _SLASH_COMMENT.sub("", line) if lang not in _HASH_LANGS else line
    return _HASH_COMMENT.sub("", line) if lang in _HASH_LANGS else line


def _called_as(s: code_index.Symbol) -> str:
    return s.parent if s.name in CONSTRUCTORS and s.parent else s.name


def _body(text: str, s: code_index.Symbol) -> str:
    lines = text.split("\n")[s.line : max(s.end, s.line)]  # (its first line left out)
    return "\n".join(x.strip() for x in lines if x.strip())


def analyse(files: list[FileText]) -> Change:
    """One piece of work's files (old text, new text, the hunks between) as a Change."""
    out = Change()
    gone: list[tuple[FileText, code_index.Symbol, list[code_index.Symbol], str]] = []
    for f in files[:FILES_MAX]:
        lang = code_index.language_of(f.path)
        if lang in SKIP_LANGS:
            continue
        out.files.append(f.path)
        out.langs[f.path] = lang
        old_syms = symbols_of(f.old, lang)
        new_syms = symbols_of(f.new, lang)
        out.defined.update(s.name for s in new_syms)
        out.defined.update(_called_as(s) for s in new_syms)
        before = {s.name for s in old_syms} | {_called_as(s) for s in old_syms}
        out.introduced.update(
            n for s in new_syms for n in (s.name, _called_as(s)) if n not in before
        )
        defs = {s.line for s in new_syms}
        added: list[tuple[int, str]] = []
        for h in f.hunks:
            old_n, new_n = h.old_start, h.new_start
            for tag, text in h.lines:
                if tag == " ":
                    old_n += 1
                    new_n += 1
                elif tag == "-":
                    if text.strip() and (s := innermost(old_syms, old_n)) is not None:
                        out.bodies.setdefault((f.path, s.qualified()), new_n)
                    old_n += 1
                elif tag == "+":
                    if text.strip() and (s := innermost(new_syms, new_n)) is not None:
                        out.bodies.setdefault((f.path, s.qualified()), new_n)
                    added.append((new_n, text))
                    new_n += 1
        old_by = {s.qualified(): s for s in old_syms}
        new_by = {s.qualified(): s for s in new_syms}
        for q, s in old_by.items():
            n = new_by.get(q)
            if n is None:
                if s.kind in NAMED:
                    gone.append((f, s, [x for x in new_syms if x.qualified() not in old_by], lang))
                continue
            if s.kind not in CALLABLE or " ".join(s.signature.split()) == " ".join(
                n.signature.split()
            ):
                continue
            method = s.kind == "method"
            before = parse_signature(s.signature, lang, method)
            after = parse_signature(n.signature, lang, method)
            if before is None or after is None:
                continue
            why = breaking(before, after, lang)
            if why:
                out.contracts[_called_as(n)] = Contract(f.path, q, n.line, before, after, why, lang)
        _read_added(out, f.path, lang, added, defs)
    for f, s, fresh, _lang in gone:
        if s.name in out.defined:
            continue  # (moved, not removed)
        renamed = ""
        if f.old and f.new:
            mine = _body(f.old, s)
            best = 0.0
            for x in fresh:
                if x.kind != s.kind:
                    continue
                ratio = difflib.SequenceMatcher(None, mine, _body(f.new, x)).ratio()
                if ratio >= RENAME_RATIO and ratio > best:
                    best, renamed = ratio, x.qualified()
        out.removed[_called_as(s)] = Removed(f.path, s.qualified(), s.kind, s.line, renamed)
    return out


def _read_added(out: Change, path: str, lang: str, added: list[tuple[int, str]],
                defs: set[int]) -> None:  # fmt: skip
    """The calls and identifiers in a file's added lines (a definition's own line is a
    name defined, not a use)."""
    code = [(n, _code_only(t, lang)) for n, t in added]
    for i, (n, line) in enumerate(code):
        if n in defs:
            continue
        for word in _IDENT.findall(line):
            if word not in KEYWORDS:
                out.uses.setdefault(word, (path, n))
        for m in _CALL.finditer(line):
            name = m.group(1)
            if name in KEYWORDS:
                continue
            calls = out.calls.setdefault(name, [])
            if len(calls) >= CALLS_PER_NAME:
                continue
            # What follows the bracket, across the next added lines while they run on.
            tail, j = line[m.end() :], i + 1
            while len(tail) < CALL_CHARS and j < len(code) and code[j][0] == code[j - 1][0] + 1:
                tail += " " + code[j][1]
                j += 1
            before = line[: m.start(1)].rstrip()
            calls.append(Call(path, n, tail[:CALL_CHARS], before.endswith((".", "?."))))


# ── where two pieces of work collide ──


@dataclass
class Finding:
    kind: str  # body | contract | removed
    symbol: str
    path: str  # where the symbol is
    line: int  # in the work it's shown for: the line it points to
    by: int  # 0: the first piece of work changed it (the contract, the removal); 1: the other
    where: str = ""  # the other side's place it collides at (a call, a use): path:line
    detail: str = ""  # the new signature, what it was renamed to, why it breaks

    def key(self) -> str:
        return f"{self.kind}:{self.path}:{self.symbol}"


def _contract_vs_calls(c: Contract, calls: list[Call]) -> list[Call]:
    """The calls that don't fit a changed contract (a call that fits was written for the
    new one: that side has already adapted). A return type changed: every call."""
    if c.why == ["return type changed"]:
        return calls
    return [x for x in calls if fits(x, c.new, c.lang) is not True]


def compare(a: Change, b: Change) -> list[Finding]:
    """Where a and b collide, each finding told from a's side (line: a's own place)."""
    out: list[Finding] = []
    both = set(a.bodies) & set(b.bodies)
    for path, symbol in sorted(both):
        out.append(Finding("body", symbol, path, a.bodies[(path, symbol)], 0))
    touched = {s.split(".")[-1] for _p, s in both}
    for first, second, by in ((a, b, 0), (b, a, 1)):
        for name, c in first.contracts.items():
            method = "." in c.symbol
            if name in second.introduced or c.symbol.split(".")[-1] in touched:
                continue
            if method and name in COMMON and name not in c.symbol.split(".")[:1]:
                continue  # (a save() method's new signature says nothing about file.save())
            bad = _contract_vs_calls(c, second.calls.get(name, []))
            if not bad:
                continue
            where = f"{bad[0].path}:{bad[0].line}"
            line = c.line if by == 0 else bad[0].line
            out.append(Finding("contract", c.symbol, c.path, line, by, where,
                               f"{c.new.text} ({'; '.join(c.why)})"))  # fmt: skip
        for name, r in first.removed.items():
            if len(name) < 3 or name in COMMON or name in second.introduced:
                continue
            use = second.uses.get(name)
            if use is None:
                continue
            line = r.line if by == 0 else use[1]
            out.append(Finding("removed", r.symbol, r.path, line, by, f"{use[0]}:{use[1]}",
                               r.renamed_to))  # fmt: skip
    return out[:FINDINGS_MAX]


def drop_defined_elsewhere(change: Change, defined: Callable[[str, set[str]], bool]) -> None:
    """Removed symbols the project still defines somewhere this work didn't touch (the
    code index's symbol map: defined(name, the files it changed)) aren't removed."""
    for name in [n for n in change.removed if defined(n, set(change.files))]:
        del change.removed[name]


# ── reading a piece of work from git ──


def _show(top: Path | str, rev: str, path: str) -> str | None:
    found = git(top, "show", f"{rev}:{path}")
    return found.out if found.ok and len(found.out) <= TEXT_MAX else None


def _read(top: Path | str, path: str) -> str | None:
    p = Path(top) / path
    try:
        if p.is_symlink() or not p.is_file() or p.stat().st_size > TEXT_MAX:
            return None
        data = p.read_bytes()
    except OSError:
        return None
    if b"\0" in data[:8000]:
        return None
    return data.decode("utf-8", errors="replace")


def work_files(top: Path | str, base: str, head: str = "") -> list[FileText]:
    """The code files that differ from base to head (to the working tree with no head, its
    untracked files too), with both texts and the hunks between (blocking: git)."""
    args = ["diff", "-U0", "--no-color", "--no-ext-diff", "--no-textconv", "-M", base]
    found = git(top, *args, *([head] if head else []), "--", timeout=60)
    diffs: list[FileDiff] = code_changes.parse_patch(found.out) if found.ok else []
    if not head:
        repo = code_changes.Repo(Path(top), "")
        known = {d.path for d in diffs}
        diffs += [d for d in code_changes.untracked_files(repo) if d.path not in known]
    out: list[FileText] = []
    for d in diffs:
        if len(out) >= FILES_MAX:
            break
        if d.binary or d.sensitive or code_index.language_of(d.path) in SKIP_LANGS:
            continue
        if is_sensitive(Path(top) / d.path):
            continue
        old_path = d.old_path or d.path
        old = None if d.status in ("A", "?") else _show(top, base, old_path)
        if d.status == "D":
            new = None
        else:
            new = _show(top, head, d.path) if head else _read(top, d.path)
        if old is None and new is None:
            continue
        out.append(FileText(d.path, old_path, old, new, d.hunks))
    return out


def read_work(top: Path | str, base: str, head: str = "") -> Change:
    return analyse(work_files(top, base, head))
