"""Eden Code's rules-to-guardrails compiler: the owner's rules that a machine can check,
turned into checks that hold, so they aren't only words a session may forget.

A rule comes from one of three places: a lesson learned from the owner's corrections
(features/code_lessons.py), a line of the project's CLAUDE.md or AGENTS.md (its notes, Eden's
section among them), or a guardrail the owner confirmed from a suggestion (below). When its
words say something a step can be checked against, it compiles into one or more of:

- a permission rule, in Claude Code's own syntax (coderules: Bash(npm), Edit(generated)),
  to deny or to ask: "use pnpm, not npm" denies npm's commands and tells the session to use
  pnpm; "never edit generated/" denies edits in any folder named generated; "ask before
  adding a dependency" asks on every install command (npm install, pip install, cargo add…)
  and every edit of a dependency manifest (package.json, pyproject.toml…); "don't touch
  migrations" denies edits in migrations folders; "never force push", "don't deploy
  without asking", "never run migrations" and "don't use sudo" likewise;
- a test-runner check: "run tests with pnpm vitest" denies a step that runs tests (one
  codesupervisor's TEST_COMMAND knows) any other way, and says the right way;
- a check of what an edit writes (a grep after each edit): "never leave `console.log` in",
  "no `debugger`" flags an edit that adds it, and the session is told to take it out.

A guardrail only ever denies, asks or flags: nothing compiled here lets a step through that
wasn't let through before, so a rule from a repository's own files (whoever wrote them) can
make a session stricter, never looser. A rule whose words don't say anything a machine can
check ("prefer small functions", "never mock the database in these tests") stays as prose:
the session hears it as before, and the owner can ask for a suggestion (from_proposal).

compile_rule is pattern-based: no model. from_proposal reads a model's suggestion
(features/code_guardrails.py asks for one when the owner presses Suggest), keeping only
what fits the same kinds and checks, for the owner to confirm before it holds.

Cost policy (Claude): this module never calls a model.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from typing import Any

from . import coderules

RULE_CHARS = 240  # longer is a paragraph, not a rule
RULES_PER_FILE = 300
LITERAL_CHARS = 80
TARGETS = 8  # paths one rule may name

# Programs a rule may name without backticks ("never use sudo", "use pnpm not npm"): words
# that are a program, never an English word a rule would use otherwise ("go", "find", "make").
PROGRAMS = frozenset(
    """npm npx yarn pnpm bun bunx deno node pip pip3 pipx pipenv poetry conda mamba uv python
    python2 python3 easy_install gem bundle bundler rake composer brew cargo rustup swift
    xcodebuild pod carthage gradle gradlew mvn cmake docker podman kubectl terraform helm curl
    wget sudo jest vitest mocha pytest nose nosetests tox nox black ruff flake8 pylint isort
    mypy pyright prettier eslint biome tsc webpack vite rollup esbuild babel git gh vercel
    netlify wrangler firebase heroku flyctl alembic prisma""".split()
)
# Programs that do the same job: "always use pnpm" stops the others of its kind.
FAMILIES = (
    ("npm", "yarn", "pnpm", "bun"),
    ("pip", "pip3", "pipenv", "poetry", "uv", "conda"),
)

# The commands that add a dependency, and the files dependencies are listed in.
DEPENDENCY_COMMANDS = (
    "Bash(npm install)", "Bash(npm i)", "Bash(npm add)", "Bash(yarn add)", "Bash(pnpm add)",
    "Bash(bun add)", "Bash(pip install)", "Bash(pip3 install)", "Bash(python -m pip install)",
    "Bash(python3 -m pip install)", "Bash(uv add)", "Bash(uv pip install)", "Bash(poetry add)",
    "Bash(pipenv install)", "Bash(conda install)", "Bash(cargo add)", "Bash(go get)",
    "Bash(gem install)", "Bash(bundle add)", "Bash(composer require)", "Bash(brew install)",
    "Bash(swift package add-dependency)", "Bash(pod install)",
)  # fmt: skip
MANIFESTS = (
    "Edit(package.json)", "Edit(requirements*.txt)", "Edit(pyproject.toml)", "Edit(Pipfile)",
    "Edit(setup.py)", "Edit(setup.cfg)", "Edit(Cargo.toml)", "Edit(go.mod)", "Edit(Gemfile)",
    "Edit(composer.json)", "Edit(Podfile)", "Edit(Package.swift)", "Edit(build.gradle)",
    "Edit(build.gradle.kts)", "Edit(pom.xml)",
)  # fmt: skip
LOCKFILES = (
    "Edit(package-lock.json)", "Edit(yarn.lock)", "Edit(pnpm-lock.yaml)", "Edit(bun.lockb)",
    "Edit(poetry.lock)", "Edit(uv.lock)", "Edit(Pipfile.lock)", "Edit(Cargo.lock)",
    "Edit(Gemfile.lock)", "Edit(composer.lock)", "Edit(Podfile.lock)", "Edit(go.sum)",
)  # fmt: skip
MIGRATE_COMMANDS = (
    "Bash(alembic upgrade)", "Bash(alembic downgrade)", "Bash(python manage.py migrate)",
    "Bash(python3 manage.py migrate)", "Bash(rails db:migrate)", "Bash(rake db:migrate)",
    "Bash(prisma migrate)", "Bash(npx prisma migrate)", "Bash(knex migrate:latest)",
    "Bash(sequelize db:migrate)", "Bash(supabase db push)", "Bash(drizzle-kit push)",
    "Bash(drizzle-kit migrate)", "Bash(flyway migrate)",
)  # fmt: skip
DEPLOY_COMMANDS = (
    "Bash(vercel)", "Bash(netlify deploy)", "Bash(wrangler deploy)", "Bash(wrangler publish)",
    "Bash(flyctl deploy)", "Bash(fly deploy)", "Bash(firebase deploy)", "Bash(heroku)",
    "Bash(gcloud app deploy)", "Bash(gcloud run deploy)", "Bash(kubectl apply)",
    "Bash(terraform apply)", "Bash(helm upgrade)", "Bash(helm install)",
    "Bash(git push heroku)", "Bash(npm publish)", "Bash(pnpm publish)", "Bash(yarn publish)",
    "Bash(cargo publish)", "Bash(twine upload)", "Bash(gem push)",
)  # fmt: skip
FORCE_PUSH = ("Bash(git push --force)", "Bash(git push -f)", "Bash(git push --force-with-lease)")

# Folder and file words a rule names without a path ("don't touch migrations").
_NAMED_PLACES = {
    "generated": ("Edit(generated)", "Edit(__generated__)", "Edit(*.generated.*)"),
    "migration": ("Edit(migrations)",),
    "migrations": ("Edit(migrations)",),
    "vendor": ("Edit(vendor)",),
    "vendored": ("Edit(vendor)",),
    "dist": ("Edit(dist)",),
    "build": ("Edit(build)",),
    "node_modules": ("Edit(node_modules)",),
    "third_party": ("Edit(third_party)",),
    "lockfile": LOCKFILES,
    "lockfiles": LOCKFILES,
    "lock": LOCKFILES,
    ".env": ("Edit(.env)", "Edit(.env.*)"),
    "env": ("Edit(.env)", "Edit(.env.*)"),
    "dotenv": ("Edit(.env)", "Edit(.env.*)"),
}

KINDS = ("deny", "ask", "tests", "check")
# A language a check's rule names: its checks look only at that language's files.
_SCOPES = (
    (r"\b(?:typescript|ts)\b", (".ts", ".tsx", ".mts", ".cts")),
    (r"\b(?:javascript|js)\b", (".js", ".jsx", ".mjs", ".cjs")),
    (r"\b(?:python|py)\b", (".py",)),
    (r"\bswift\b", (".swift",)),
    (r"\b(?:go|golang)\s+(?:code|files)\b", (".go",)),
    (r"\brust\b", (".rs",)),
    (r"\bruby\b", (".rb",)),
)


@dataclass(frozen=True)
class Guardrail:
    """One rule, compiled. deny and ask are permission rules in Claude Code's syntax; tests
    the words a test run must have; checks the text an edit mustn't add; hint what the
    session is told to do instead (with a block); existing: the edit rules hold only for
    files already there ("don't edit existing migrations": a new one is fine)."""

    rule: str
    source: str = "lesson"  # lesson | CLAUDE.md | AGENTS.md | CLAUDE.local.md | suggested
    deny: tuple[str, ...] = ()
    ask: tuple[str, ...] = ()
    tests: str = ""
    checks: tuple[str, ...] = ()
    hint: str = ""
    existing: bool = False
    files: tuple[str, ...] = ()  # the checks hold for files ending so ("in TypeScript"); () all

    @property
    def id(self) -> str:
        return rule_id(self.rule)

    @property
    def kind(self) -> str:
        """Its strongest check, for its badge: deny, ask, tests or check."""
        if self.deny:
            return "deny"
        if self.tests:
            return "tests"
        if self.ask:
            return "ask"
        return "check"

    def enforced(self) -> list[str]:
        """What it checks, as the owner reads it (Settings, the receipt)."""
        out = [f"deny {r}" for r in self.deny] + [f"ask {r}" for r in self.ask]
        if self.tests:
            out.append(f"tests only with {self.tests}")
        out += [f"edits mustn't add {c}" for c in self.checks]
        return out

    def to_json(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "rule": self.rule,
            "source": self.source,
            "kind": self.kind,
            "deny": list(self.deny),
            "ask": list(self.ask),
            "tests": self.tests,
            "checks": list(self.checks),
            "hint": self.hint,
            "existing": self.existing,
            "files": list(self.files),
            "enforced": self.enforced(),
        }


def rule_id(text: str) -> str:
    """A rule's id, the same wherever it's read from (a lesson Eden also wrote into the
    project's CLAUDE.md is one rule, with one switch)."""
    key = " ".join(str(text or "").lower().split()).rstrip(".!")
    return hashlib.sha1(key.encode("utf-8")).hexdigest()[:12]


# ── reading a rule ──

_WORD = r"`?[A-Za-z][\w.+-]*`?"
_NEVER = (
    r"(?:never|don'?t|do\s+not|avoid|stop|"
    r"no(?=\s+`|\s+[A-Za-z_$][\w$]*\.[A-Za-z_$]|\s+debugger\b))"  # (no `x`, no console.log)
)
_CLAUSE = r"(?:[^.;!?]|[.!?](?=[^\s.;!?]))+"  # (to a sentence's end: a dot in .env or a.b isn't)
_ASKING = re.compile(
    r"\s*,?\s*(?:without\s+(?:first\s+)?(?:asking|checking|confirming|my\s+(?:ok|okay|approval|"
    r"permission|say[\s-]?so)|permission|approval|confirmation)(?:\s+(?:me|first))*|"
    r"unless\s+i\s+(?:say\s+so|ask|tell\s+you|approve)(?:\s+(?:to|it|so))*)\b.*$",
    re.IGNORECASE,
)
_ASK_BEFORE = re.compile(
    r"\b(?:ask|check\s+with\s+me|confirm\s+with\s+me|confirm|get\s+my\s+(?:ok|okay|approval|"
    r"permission))\s+(?:me\s+|first\s+)*before\s+(?:you\s+)?(?P<act>" + _CLAUSE + ")",
    re.IGNORECASE,
)
_NEVER_ACT = re.compile(rf"\b{_NEVER}\s+(?:ever\s+)?(?P<act>{_CLAUSE})", re.IGNORECASE)
_PREFER = (
    re.compile(
        rf"\buse\s+(?P<a>{_WORD})\s*,?\s*(?:and\s+)?(?:not|never|instead\s+of|rather\s+than|over)\s+"
        rf"(?P<b>{_WORD})",
        re.IGNORECASE,
    ),
    re.compile(
        rf"\bprefer\s+(?P<a>{_WORD})\s+(?:over|to|instead\s+of|rather\s+than)\s+(?P<b>{_WORD})",
        re.IGNORECASE,
    ),
    re.compile(
        rf"\b{_NEVER}\s+(?:use\s+|using\s+|run\s+|running\s+)?(?P<b>{_WORD})\s*[,;:.\-–—]*\s*"
        rf"(?:(?:always|just|only)\s+)?use\s+(?P<a>{_WORD})",
        re.IGNORECASE,
    ),
    re.compile(
        rf"\binstead\s+of\s+(?P<b>{_WORD})\s*,?\s*(?:always\s+)?use\s+(?P<a>{_WORD})",
        re.IGNORECASE,
    ),
    re.compile(rf"(?:^|\buse\s+)(?P<a>{_WORD})\s*,\s*not\s+(?P<b>{_WORD})", re.IGNORECASE),
)
_ONLY = re.compile(
    rf"(?:^|\b(?:always|only)\s+)use\s+(?:only\s+)?(?P<a>{_WORD})",
    re.IGNORECASE,
)
_TESTS_WITH = (
    re.compile(
        r"\brun\s+(?:the\s+|all\s+|any\s+)?(?:unit\s+|e2e\s+|integration\s+)?tests?\s+"
        r"(?:with|using|via|through|by\s+running)\s+(?P<cmd>`[^`]+`|[^,.;!?]+)",
        re.IGNORECASE,
    ),
    re.compile(
        r"\btests?\s+(?:are|is|should\s+be|must\s+be)?\s*run\s+(?:with|using|via)\s+"
        r"(?P<cmd>`[^`]+`|[^,.;!?]+)",
        re.IGNORECASE,
    ),
    re.compile(
        r"\buse\s+(?P<cmd>`[^`]+`|\S+(?:\s+\S+)?)\s+(?:to|for)\s+(?:run(?:ning)?\s+)?(?:the\s+)?tests?\b",
        re.IGNORECASE,
    ),
)
_CMD_STOP = {
    "not", "and", "or", "instead", "before", "after", "only", "when", "so", "because", "in",
    "from", "to", "never", "rather", "then", "always", "if", "unless", "first", "for", "with",
    "on", "at", "without", "directly", "yourself", "here", "there", "anymore", "again", "ever",
}  # fmt: skip
# Words after a program that aren't its subcommand ("never sudo anything").
_NOT_WORDS = {"anything", "everything", "it", "things", "stuff", "all", "any", "this", "that"}
_GERUNDS = {
    "pushing": "push", "committing": "commit", "deploying": "deploy", "migrating": "migrate",
    "adding": "add", "installing": "install", "deleting": "delete", "removing": "remove",
    "editing": "edit", "touching": "touch", "modifying": "modify", "changing": "change",
    "running": "run", "using": "use", "reading": "read", "opening": "open", "writing": "write",
    "introducing": "introduce", "updating": "update", "altering": "alter", "rewriting": "rewrite",
    "calling": "call", "executing": "execute", "leaving": "leave", "publishing": "publish",
    "upgrading": "upgrade", "releasing": "release",
}  # fmt: skip
_LEAD = re.compile(
    r"^(?:(?:ever|you|yourself|please|just|directly|manually|by\s+hand|go\s+and|try\s+to)\s+)+",
    re.IGNORECASE,
)
_EDIT = re.compile(
    r"^(?:hand[\s-]?)?(?:edit|touch|modify|change|write\s+(?:to|in|into)|alter|update|rewrite|"
    r"delete|remove|commit\s+changes\s+to)\s+(?P<what>.+)$",
    re.IGNORECASE,
)
_READ = re.compile(r"^(?:read|open|cat|look\s+(?:at|in|inside))\s+(?P<what>.+)$", re.IGNORECASE)
_RUN = re.compile(r"^(?:run|use|call|invoke|execute)\s+(?P<cmd>`[^`]+`|\S+)", re.IGNORECASE)
_PUT = re.compile(
    r"^(?:use|add|leave|commit|write|introduce|ship|keep|put)?\s*(?:any\s+|in\s+)?"
    r"(?P<code>`[^`]+`|[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*(?:\(\))?)",
    re.IGNORECASE,
)
_PATHISH = re.compile(r"^[\w.*?\[\]~@+-]*(?:/[\w.*?\[\]@+-]*)+/?$|^[\w*?\[\]@+-]*\.[\w*?\[\]+-]+$")
_FILLER = re.compile(
    r"^(?:(?:anything|any\s+files?|files?|code|stuff|things|whatever\s+is|what'?s|the|any|"
    r"in|inside|under|within|of|existing|old|applied|past|previous|checked[\s-]in|"
    r"committed|auto[\s-]?generated)\s+)+",
    re.IGNORECASE,
)
_EXISTING = re.compile(r"\b(?:existing|old|applied|past|previous|checked[\s-]in|committed)\b", re.I)
_PLACE_TAIL = re.compile(
    r"\s+(?:files?|folders?|director(?:y|ies)|dirs?|code|output|sources?|scripts?|by\s+hand|"
    r"manually|directly)\b.*$",
    re.IGNORECASE,
)


def _clean(text: str) -> str:
    """A rule's words as they're read: one line, without markdown's list marks and emphasis."""
    text = " ".join(str(text or "").split())
    text = re.sub(r"^(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?", "", text)
    text = re.sub(r"(\*\*|__)(.+?)\1", r"\2", text)
    text = re.sub(r"(?<![\w*])\*(?!\s)([^*]+?)\*(?![\w*])", r"\1", text)
    return text.strip()


def _bare(word: str) -> str:
    return word.strip().strip("`").strip(".,;:!?\"'()").lower()


def _program_ok(word: str, quoted: bool) -> bool:
    return bool(re.fullmatch(r"[a-z][\w.+-]*", word)) and (quoted or word in PROGRAMS)


def _family_of(program: str) -> tuple[str, ...]:
    return next((f for f in FAMILIES if program in f), ())


def _command_rule(command: str) -> str | None:
    """A command a rule names, as a Bash rule (None when it isn't one a rule can hold)."""
    command = " ".join(command.strip().strip("`").split())
    if not command or len(command) > 120 or re.search(r"[;&|<>$`\\(){}]", command):
        return None
    words = command.split()
    if not re.fullmatch(r"[\w./+-]+", words[0]):
        return None
    rule = coderules.valid(f"Bash({command})")
    return rule.text if rule is not None else None


def _verb(act: str) -> str:
    act = _LEAD.sub("", act.strip())
    first, _, rest = act.partition(" ")
    first = _GERUNDS.get(first.lower(), first)
    return f"{first} {rest}".strip()


def _targets(what: str) -> list[tuple[str, bool]]:
    """The places a "never edit …" rule names: (the words, quoted) for each, split at "or",
    "and" and commas."""
    out = []
    what = re.split(r"\s+[—–-]+\s+", re.sub(r"\([^)]*\)", " ", what), maxsplit=1)[0]  # (asides)
    for part in re.split(r"\s*(?:,|\bor\b|\band\b|/\s+(?=\w))\s*", what):
        part = part.strip()
        if not part:
            continue
        quoted = part.startswith("`")
        if quoted:
            m = re.match(r"`([^`]+)`", part)
            out.append((m.group(1).strip() if m else part.strip("`"), True))
        else:
            part = _FILLER.sub("", part)
            part = _PLACE_TAIL.sub("", part).strip(" .:;!?\"'")
            if part:
                out.append((part.split()[0] if " " in part else part, False))
    return out[:TARGETS]


def _place_rules(word: str, quoted: bool, tool: str = "Edit") -> list[str]:
    """A place as path rules (Edit(…) or Read(…)), or none when it isn't one."""
    key = word.lower().rstrip("/")
    if not quoted and key in _NAMED_PLACES:
        return [r.replace("Edit(", f"{tool}(", 1) for r in _NAMED_PLACES[key]]
    path = word.strip().rstrip("/").removeprefix("./")
    if not path or path in (".", "*", "**") or not (quoted or _PATHISH.match(word.strip())):
        return []
    if ".." in path.split("/") or re.search(r"\s", path):
        return []
    rule = coderules.valid(f"{tool}({path})")
    return [rule.text] if rule is not None else []


def _action(act: str) -> dict[str, Any]:
    """What a "never …" or "ask before …" act says a step mustn't do, as {"rules": [...],
    "checks": [...], "existing": bool, "manifests": bool}; empty when it says nothing a
    machine can check."""
    act = _verb(act)
    low = act.lower()
    if re.match(r"^force[\s-]?push", low):
        return {"rules": list(FORCE_PUSH)}
    m = re.match(
        r"^(?:git\s+)?push(?:\s+(?:anything|changes|code|commits|it|for\s+me))?"
        r"(?:\s+(?:directly\s+)?(?:to|into|on)\s+(?:the\s+)?(?:remote\s+)?`?(?P<br>[\w./-]+)`?"
        r"(?:\s+branch)?)?\s*$",
        low,
    )
    if m:
        branch = m.group("br") or ""
        if branch and branch not in ("origin", "remote", "github", "upstream", "it"):
            return {"rules": [f"Bash(git push {branch})", f"Bash(git push HEAD:{branch})"]}
        return {"rules": ["Bash(git push)"]}
    if re.match(
        r"^(?:git\s+)?commit(?:\s+(?:anything|changes|code|it|for\s+me|yourself))?\s*$", low
    ):
        return {"rules": ["Bash(git commit)"]}
    if re.match(r"^(?:deploy|publish|release|ship\s+to\s+prod)", low):
        return {"rules": list(DEPLOY_COMMANDS)}
    if re.match(
        r"^(?:run\s+(?:the\s+|any\s+|database\s+|db\s+)*migrations?|migrate\b(?:\s+the)?"
        r"(?:\s+(?:database|db))?)\s*$",
        low,
    ):
        return {"rules": list(MIGRATE_COMMANDS)}
    if re.match(
        r"^(?:add|install|introduce|pull\s+in|bring\s+in|upgrade|update|bump)\s+(?:(?:a|an|any|new|"
        r"another|more|extra|third[\s-]party|external|npm|node|python|pip|js|runtime|dev|other|"
        r"the|our)\s+)*(?:dependenc(?:y|ies)|packages?|librar(?:y|ies)|deps|modules?|crates?|gems?)\b",
        low,
    ):
        return {"rules": list(DEPENDENCY_COMMANDS), "manifests": True}
    if re.match(r"^(?:delete|remove)\s+(?:any\s+)?files?\s*$", low):
        return {"rules": ["Bash(rm)", "Bash(git rm)"]}
    if m := _EDIT.match(act):
        what = m.group("what")
        rules = [r for word, quoted in _targets(what) for r in _place_rules(word, quoted)]
        if rules:
            return {"rules": list(dict.fromkeys(rules)), "existing": bool(_EXISTING.search(what))}
    if m := _READ.match(act):
        rules = [r for w, q in _targets(m.group("what")) for r in _place_rules(w, q, "Read")]
        if rules:
            return {"rules": list(dict.fromkeys(rules))}
    if m := _RUN.match(act):
        raw = m.group("cmd")
        quoted = raw.startswith("`")
        word = _bare(
            raw.split()[0] if not quoted else raw.strip("`").split()[0] if raw.strip("`") else ""
        )
        runs = low.split()[0] in ("run", "call", "invoke", "execute")
        if quoted and (runs or word in PROGRAMS):
            rule = _command_rule(raw)
            if rule:
                return {"rules": [rule]}
        elif not quoted and _program_ok(word, False):
            words = act.split()
            if not (words[2:3] and words[2][:1].isdigit()):  # ("don't use python 2")
                # Its subcommand too, when the rule names one ("don't use npm run dev
                # directly": that, not every npm command).
                sub: list[str] = []
                for w in words[2:5] if not words[1].endswith((",", ";", ":")) else []:
                    bare = w.rstrip(",;:")
                    if bare.lower() in _CMD_STOP or bare.lower() in _NOT_WORDS:
                        break
                    if not re.fullmatch(r"[a-z][\w:.-]*|--?[a-z][\w-]*", bare):
                        break
                    sub.append(bare)
                    if bare != w:
                        break  # (a comma ends it)
                rule = _command_rule(" ".join([word, *sub]))
                return {"rules": [rule or f"Bash({word})"]}
    if m := _PUT.match(act):
        code = m.group("code").strip("`").strip()
        if code and len(code) <= LITERAL_CHARS and "\n" not in code:
            first = _bare(code.split()[0])
            if first in PROGRAMS and " " in code:  # ("never `git stash`": a command)
                rule = _command_rule(code)
                return {"rules": [rule]} if rule else {}
            return {"checks": [code]}
    if re.match(
        r"^(?:leave\s+|use\s+|add\s+|commit\s+)?(?:any\s+)?debugger(?:\s+statements?)?\b", low
    ):
        return {"checks": ["debugger"]}
    words = [w.strip(",:;\"'()") for w in low.split()]
    if words and words[0] in PROGRAMS:  # ("never git stash", "never sudo"): a command
        sub = words[1:2] if len(words) > 1 and re.fullmatch(r"[a-z][\w:-]*", words[1]) else []
        if sub and (sub[0] in _CMD_STOP or sub[0] in _NOT_WORDS):
            sub = []
        rule = _command_rule(" ".join(words[:1] + sub))
        return {"rules": [rule]} if rule else {}
    return {}


def _tests_command(raw: str) -> str:
    """The words of a "run tests with …" rule's command: backticked, or its first words up
    to one that ends the command ("pnpm vitest, not jest": pnpm vitest)."""
    raw = raw.strip()
    if raw.startswith("`"):
        words = raw.strip("`").split()
    else:
        words = []
        for word in raw.split():
            if word.lower() in _CMD_STOP or len(words) >= 4:
                break
            words.append(word.strip("\"'"))
    if not words:
        return ""
    first = _bare(words[0])
    quoted = raw.startswith("`")
    if not (quoted or first in PROGRAMS or coderules_test(" ".join(words))):
        return ""
    command = " ".join(words)
    return command if _command_rule(command) else ""


def coderules_test(command: str) -> bool:
    """Whether a command line runs tests (codesupervisor's TEST_COMMAND)."""
    from .codesupervisor import TEST_COMMAND

    return bool(TEST_COMMAND.search(command))


def compile_rule(text: str, source: str = "lesson") -> Guardrail | None:
    """A rule as a guardrail, or None when its words say nothing a machine can check."""
    rule = _clean(text)
    if not rule or len(rule) > RULE_CHARS:
        return None
    deny: list[str] = []
    ask: list[str] = []
    checks: list[str] = []
    hints: list[str] = []
    tests = ""
    existing = False
    quoted = {_bare(c) for c in re.findall(r"`([^`]+)`", rule)}

    # "Use pnpm, not npm": npm's commands are denied, and the session told to use pnpm.
    for pattern in _PREFER:
        for m in pattern.finditer(rule):
            a, b = _bare(m.group("a")), _bare(m.group("b"))
            if a == b or not _program_ok(b, b in quoted):
                continue
            if not _program_ok(a, a in quoted) and "," in m.group(0):
                continue  # ("tabs, not spaces": neither is a program)
            deny.append(f"Bash({b})")
            if b in ("pip", "pip3"):
                deny += ["Bash(python -m pip)", "Bash(python3 -m pip)"]
            hints.append(f"Use {a} instead of {b}.")
    if not deny:
        m = _ONLY.search(rule)
        a = _bare(m.group("a")) if m else ""
        family = _family_of(a)
        if family and re.search(r"\b(?:always|only)\b|^use\b", rule, re.IGNORECASE):
            others = [p for p in family if p != a]
            deny += [f"Bash({p})" for p in others]
            if "pip" in others:
                deny += ["Bash(python -m pip)", "Bash(python3 -m pip)"]
            hints.append(f"Use {a}.")
    # "Run tests with pnpm vitest"
    for pattern in _TESTS_WITH:
        m = pattern.search(rule)
        if m and (command := _tests_command(m.group("cmd"))):
            tests = command
            hints.append(f"Run the tests with {command}.")
            break
    # "Ask before adding a dependency", "don't deploy without asking"
    for m in _ASK_BEFORE.finditer(rule):
        found = _action(m.group("act"))
        ask += found.get("rules", []) + (list(MANIFESTS) if found.get("manifests") else [])
        existing = existing or bool(found.get("existing"))
    # "Never edit generated/", "don't touch migrations", "no console.log"
    for m in _NEVER_ACT.finditer(rule):
        act = m.group("act")
        asking = bool(_ASKING.search(act))
        act = _ASKING.sub("", act)
        found = _action(act)
        rules = found.get("rules", [])
        if rules and any(r in deny for r in rules):
            continue  # (the prefer form said it already)
        if asking:
            ask += rules + (list(MANIFESTS) if found.get("manifests") else [])
        else:
            deny += rules
            ask += list(MANIFESTS) if found.get("manifests") else []
            checks += found.get("checks", [])
        existing = existing or bool(found.get("existing"))
    deny = list(dict.fromkeys(deny))
    ask = [r for r in dict.fromkeys(ask) if r not in deny]
    checks = list(dict.fromkeys(c for c in checks if c))[:5]
    if not (deny or ask or tests or checks):
        return None
    files = tuple(
        dict.fromkeys(
            e for word, ends in _SCOPES if checks and re.search(word, rule, re.I) for e in ends
        )
    )
    return Guardrail(
        rule=rule,
        source=source,
        deny=tuple(deny),
        ask=tuple(ask),
        tests=tests,
        checks=tuple(checks),
        hint=" ".join(dict.fromkeys(hints)),
        existing=existing,
        files=files,
    )


# ── instruction files ──

_RULE_WORDS = re.compile(
    r"\b(?:never|always|don'?t|do\s+not|avoid|must|only|prefer|ask|instead|use\s+\S+\s+"
    r"(?:not|instead|over)|run\s+(?:the\s+)?tests?)\b",
    re.IGNORECASE,
)


def rules_in(text: str) -> list[str]:
    """The lines of an instruction file (CLAUDE.md, AGENTS.md) that read as rules: list items
    and sentences with a rule's words in them, outside code blocks, headings and comments."""
    out: list[str] = []
    fenced = False
    for raw in str(text or "").splitlines():
        line = raw.strip()
        if line.startswith(("```", "~~~")):
            fenced = not fenced
            continue
        if fenced or not line or line.startswith(("#", "<!--", "|", ">")):
            continue
        for sentence in re.split(r"(?<=[.!?])\s+(?=[A-Z`*])", _clean(line)):
            sentence = sentence.strip()
            if 3 <= len(sentence.split()) or (sentence and "`" in sentence):
                if len(sentence) <= RULE_CHARS and _RULE_WORDS.search(sentence):
                    out.append(sentence)
        if len(out) >= RULES_PER_FILE:
            break
    return list(dict.fromkeys(out))[:RULES_PER_FILE]


# ── a model's suggestion, checked ──

_PROPOSAL_TOOLS = {"Bash", "Edit", "Write", "MultiEdit", "Read", "WebFetch"}


def _proposal_rules(values: Any) -> list[str]:
    out = []
    for value in values if isinstance(values, list) else []:
        rule = coderules.valid(str(value)) if isinstance(value, str) else None
        if rule is None:
            continue
        if not (rule.tool in _PROPOSAL_TOOLS or rule.tool.startswith("mcp__")):
            continue
        if rule.content is None and not rule.tool.startswith("mcp__"):
            continue  # (all of Bash or every edit: never from a suggestion)
        out.append(rule.text)
    return list(dict.fromkeys(out))[:20]


def from_proposal(rule: str, reply: str) -> Guardrail | None:
    """A model's suggested guardrail for a rule (its reply's JSON object), keeping only what
    this module's own kinds can check: deny and ask rules in Claude Code's syntax (never a
    whole tool), a test command, text an edit mustn't add. None when nothing's left."""
    match = re.search(r"\{.*\}", str(reply or ""), re.S)
    if not match:
        return None
    try:
        data = json.loads(match.group(0))
    except ValueError:
        return None
    if not isinstance(data, dict):
        return None
    deny = _proposal_rules(data.get("deny"))
    ask = [r for r in _proposal_rules(data.get("ask")) if r not in deny]
    tests = str(data.get("tests") or "").strip()
    tests = tests if tests and len(tests) <= LITERAL_CHARS and _command_rule(tests) else ""
    checks = [
        str(c).strip()
        for c in (data.get("checks") if isinstance(data.get("checks"), list) else [])
        if isinstance(c, str) and 0 < len(c.strip()) <= LITERAL_CHARS and "\n" not in c
    ][:5]
    if not (deny or ask or tests or checks):
        return None
    hint = " ".join(str(data.get("hint") or "").split())[:200]
    return Guardrail(
        rule=" ".join(str(rule or "").split())[:RULE_CHARS],  # (its words as said: its id)
        source="suggested",
        deny=tuple(deny),
        ask=tuple(ask),
        tests=tests,
        checks=tuple(checks),
        hint=hint,
        existing=bool(data.get("existing")),
    )


def from_json(data: Any) -> Guardrail | None:
    """A guardrail as kept (a confirmed suggestion), checked again as it's read."""
    if not isinstance(data, dict) or not isinstance(data.get("rule"), str):
        return None
    found = from_proposal(data["rule"], json.dumps(data))
    if found is None:
        return None
    return Guardrail(
        rule=found.rule,
        source="suggested",
        deny=found.deny,
        ask=found.ask,
        tests=found.tests,
        checks=found.checks,
        hint=found.hint,
        existing=found.existing,
    )


# ── checking a step ──


def has_words(command: str, want: str) -> bool:
    """Whether a command line runs the words of want, in order, in one of its parts (from
    any place a command starts in it: after sudo, env, timeout…)."""
    need = [w for w in want.split() if not w.startswith("-")]
    if not need:
        return True
    for words in coderules.command_parts(command):
        for at in coderules.starts(words):
            rest = iter(words[at:])
            if all(any(coderules._program(w) == n or w == n for w in rest) for n in need):
                return True
    return False


def added_text(tool: str, tool_input: dict[str, Any]) -> tuple[str, str]:
    """(what an edit writes, what it replaces) for Edit, MultiEdit, Write, NotebookEdit."""
    if tool == "MultiEdit":
        edits = tool_input.get("edits") if isinstance(tool_input.get("edits"), list) else []
        new = "\n".join(str(e.get("new_string") or "") for e in edits if isinstance(e, dict))
        old = "\n".join(str(e.get("old_string") or "") for e in edits if isinstance(e, dict))
        return new, old
    if tool == "Write":
        return str(tool_input.get("content") or ""), ""
    if tool == "NotebookEdit":
        return str(tool_input.get("new_source") or ""), ""
    return str(tool_input.get("new_string") or ""), str(tool_input.get("old_string") or "")


def _literal(code: str) -> re.Pattern[str]:
    body = re.escape(code)
    if re.match(r"\w", code):
        body = r"(?<![\w$])" + body
    if re.search(r"\w$", code):
        body += r"(?![\w$])"
    return re.compile(body)


def flagged(guard: Guardrail, tool: str, tool_input: dict[str, Any]) -> list[str]:
    """The text a guardrail's checks find newly added by an edit (more of it after than
    before: an edit that only keeps what was there isn't flagged)."""
    if not guard.checks or tool not in coderules.EDIT_FAMILY:
        return []
    path = str(tool_input.get("file_path") or tool_input.get("notebook_path") or "")
    if guard.files and not path.lower().endswith(guard.files):
        return []
    new, old = added_text(tool, tool_input)
    return [
        code
        for code in guard.checks
        if len(_literal(code).findall(new)) > len(_literal(code).findall(old))
    ]
