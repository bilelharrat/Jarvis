"""The patterns of the conversations JARVIS holds (delegate), the interrupter, goals and the
invitation check (clashes) are compiled the first time they're tried, not when the backend
starts: most sessions never hold a conversation for the owner, and the interrupter's are
tried only once a message arrives. Compiled at import, they cost every start of the backend
(and every test process) some twenty milliseconds."""

import re
import subprocess
import sys

from jarvis import delegate, goals, interrupts, lang
from jarvis.features.proactive import clashes

MODULES = (delegate, interrupts, goals, clashes)


def _lazy() -> dict[str, lang.LazyPattern]:
    """Every pattern these modules keep, alone or in a list or table of their own."""
    found: dict[str, lang.LazyPattern] = {}
    for module in MODULES:
        for name, value in vars(module).items():
            items = value if isinstance(value, list | tuple) else [value]
            for n, item in enumerate(items):
                for part in item if isinstance(item, tuple) else (item,):
                    if isinstance(part, lang.LazyPattern):
                        found[f"{module.__name__}.{name}[{n}]"] = part
    return found


def test_every_pattern_compiles_and_none_is_left_eager():
    patterns = _lazy()
    assert len(patterns) > 100
    for name, pattern in patterns.items():
        assert isinstance(pattern.compiled(), re.Pattern), name
    for module in MODULES:  # nothing compiled at import is left behind
        eager = [n for n, v in vars(module).items() if isinstance(v, re.Pattern)]
        assert eager == [], module.__name__


def test_an_import_compiles_none_of_them():
    probe = (
        "from jarvis import delegate, goals, interrupts, lang\n"
        "from jarvis.features.proactive import clashes\n"
        "seen = []\n"
        "for m in (delegate, interrupts, goals, clashes):\n"
        "    for n, v in vars(m).items():\n"
        "        items = v if isinstance(v, (list, tuple)) else [v]\n"
        "        for i in items:\n"
        "            for p in i if isinstance(i, tuple) else (i,):\n"
        "                if isinstance(p, lang.LazyPattern) and p._compiled is not None:\n"
        "                    seen.append(m.__name__ + '.' + n)\n"
        "print(','.join(sorted(set(seen))))"
    )
    done = subprocess.run(
        [sys.executable, "-c", probe], capture_output=True, text=True, timeout=120
    )
    assert done.returncode == 0, done.stderr
    assert done.stdout.strip() == ""


def test_they_read_as_they_did():
    """A few of each, tried on what they're for, read as the compiled patterns did."""
    assert interrupts.urgency("URGENT: call me back, not an emergency") == (4, ["urgent", "call"])
    assert interrupts.urgency("不急，有空回电") == (1, ["call"])
    assert delegate._HAN.search("hello 你好").group() == "你"
    assert delegate._CARD.sub("#", "card 4111 1111 1111 1111 ok") == "card # ok"
    assert [m.group() for m in delegate._EMAIL.finditer("a@b.co, c.d@e.org")] == [
        "a@b.co",
        "c.d@e.org",
    ]
    assert goals._APOSTROPHE.sub("", "don't Mum’s") == "dont Mums"
    assert clashes.read_rule("No meetings before 10am") is not None
    assert clashes.read_rule("周五下午不开会") is not None
