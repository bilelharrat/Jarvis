"""code_semantic.py: a piece of work read by symbol and contract, and where two collide:
the same symbol's body changed by both, a signature changed by one while the other adds
calls that don't fit it, a symbol removed or renamed while the other still uses it.

Real git in temp repositories for the reading; the rest is pure. No model is called."""

from pathlib import Path

from test_code_changes import git, make_repo

from jarvis import code_semantic as cs

TOTAL = "def total(items):\n    return sum(items)\n\n\ndef other():\n    return 1\n"


def work(repo: Path, files: dict[str, str]) -> cs.Change:
    """The change files would make on top of repo's main, read from its working tree, then
    put back as it was."""
    base = git(repo, "rev-parse", "HEAD").strip()
    before = {name: (repo / name).read_text() if (repo / name).exists() else None
              for name in files}  # fmt: skip
    for name, text in files.items():
        (repo / name).parent.mkdir(parents=True, exist_ok=True)
        (repo / name).write_text(text)
    try:
        return cs.read_work(repo, base)
    finally:
        for name, text in before.items():
            if text is None:
                (repo / name).unlink()
            else:
                (repo / name).write_text(text)


def kinds(found):
    return [(f.kind, f.symbol) for f in found]


# ── signatures and calls ──


def test_signatures_read_in_python_typescript_swift_and_java():
    py = cs.parse_signature("def f(self, a, b=1, *, c, **kw) -> int", "python", method=True)
    assert [(p.name, p.default, p.kind) for p in py.params] == [
        ("a", False, "pos"), ("b", True, "pos"), ("c", False, "kw"), ("kw", False, "varkw"),
    ]  # fmt: skip
    assert py.returns == "int" and py.required() == 1 and py.most() == 2
    ts = cs.parse_signature("  parse(text: string, opts?: Opts): Result {", "js", method=True)
    assert [(p.name, p.default, p.type) for p in ts.params] == [
        ("text", False, "string"), ("opts", True, "Opts"),
    ]  # fmt: skip
    assert ts.returns == "Result"
    sw = cs.parse_signature("func greet(_ name: String, loud: Bool = false) -> String {", "swift")
    assert [(p.label, p.name, p.default) for p in sw.params] == [
        ("_", "name", False), ("loud", "loud", True),
    ]  # fmt: skip
    java = cs.parse_signature("public int add(int a, int b) {", "java")
    assert [(p.name, p.type) for p in java.params] == [("a", "int"), ("b", "int")]
    assert cs.parse_signature("class Thing", "python") is None


def test_what_breaks_an_old_caller_and_what_doesnt():
    old = cs.parse_signature("def f(a, b)", "python")
    assert cs.breaking(old, cs.parse_signature("def f(a, b, c)", "python"), "python") == [
        "more required arguments"
    ]
    assert cs.breaking(old, cs.parse_signature("def f(a, b, c=None)", "python"), "python") == []
    assert "fewer arguments allowed" in cs.breaking(
        old, cs.parse_signature("def f(a)", "python"), "python"
    )
    renamed = cs.breaking(old, cs.parse_signature("def f(a, size)", "python"), "python")
    assert renamed == ["parameter renamed or taken out: b"]
    assert cs.breaking(old, cs.parse_signature("def f(a, b) -> str", "python"), "python") == [
        "return type changed"
    ]
    ts_old = cs.parse_signature("function f(a: number) {", "js")
    assert cs.breaking(ts_old, cs.parse_signature("function f(a: string) {", "js"), "js") == [
        "a parameter's type changed"
    ]


def test_a_call_fits_a_signature_or_doesnt_or_cant_be_told():
    sig = cs.parse_signature("def total(items, tax, *, rounding=2)", "python")
    call = lambda text: cs.Call("x.py", 1, text)  # noqa: E731
    assert cs.fits(call("cart, 0.2)"), sig, "python") is True
    assert cs.fits(call("cart, tax=0.2, rounding=0)"), sig, "python") is True
    assert cs.fits(call("cart)"), sig, "python") is False
    assert cs.fits(call("cart, 0.2, 3)"), sig, "python") is False
    assert cs.fits(call("cart, vat=1)"), sig, "python") is False
    assert cs.fits(call("cart,"), sig, "python") is None  # (runs on past what was added)
    assert cs.fits(call("*args)"), sig, "python") is None
    # Brackets and commas inside strings and nested calls aren't the call's own.
    assert cs.fits(call('f("a, b", (1, 2)), g(3))'), sig, "python") is True
    swift = cs.parse_signature("func greet(_ name: String, loud: Bool = false) {", "swift")
    assert cs.fits(call('"a", loud: true)'), swift, "swift") is True
    assert cs.fits(call('"a", quiet: true)'), swift, "swift") is False


# ── where two pieces of work collide ──


def test_both_changing_one_function_collides_and_different_functions_dont(tmp_path):
    repo = make_repo(tmp_path / "app", {"calc.py": TOTAL})
    a = work(repo, {"calc.py": TOTAL.replace("sum(items)", "sum(items) * 2")})
    b = work(repo, {"calc.py": TOTAL.replace("sum(items)", "round(sum(items))")})
    c = work(repo, {"calc.py": TOTAL.replace("return 1", "return 2")})
    assert kinds(cs.compare(a, b)) == [("body", "total")]
    assert cs.compare(a, c) == []
    # Blank lines between two functions are nobody's change of either.
    d = work(repo, {"calc.py": TOTAL.replace("\n\n\n", "\n\n\n\n")})
    assert cs.compare(a, d) == []


def test_a_new_signature_against_new_calls_written_the_old_way(tmp_path):
    repo = make_repo(tmp_path / "app", {"calc.py": TOTAL, "shop.py": "import calc\n"})
    a = work(repo, {"calc.py": TOTAL.replace("total(items)", "total(items, tax)")})
    old_way = work(repo, {"shop.py": "import calc\n\nprice = calc.total(cart)\n"})
    new_way = work(repo, {"shop.py": "import calc\n\nprice = calc.total(cart, 0.2)\n"})
    [f] = cs.compare(a, old_way)
    assert (f.kind, f.symbol, f.by, f.where) == ("contract", "total", 0, "shop.py:3")
    assert "more required arguments" in f.detail and "total(items, tax)" in f.detail
    # Told from the other side: the one who changed it is the other (by 1), its line the call.
    [g] = cs.compare(old_way, a)
    assert (g.kind, g.by, g.line) == ("contract", 1, 3)
    # Calls that fit the new signature: that side already adapted.
    assert cs.compare(a, new_way) == []
    # An optional parameter breaks nobody.
    soft = work(repo, {"calc.py": TOTAL.replace("total(items)", "total(items, tax=0)")})
    assert cs.compare(soft, old_way) == []


def test_typescript_and_swift_contracts(tmp_path):
    ts = "export function price(items: Item[]): number {\n  return 1;\n}\n"
    swift = "func greet(name: String) -> String {\n    return name\n}\n"
    repo = make_repo(tmp_path / "app", {"price.ts": ts, "use.ts": "\n", "Greet.swift": swift,
                                        "Use.swift": "\n"})  # fmt: skip
    a = work(repo, {"price.ts": ts.replace("items: Item[]", "items: Item[], region: string")})
    b = work(repo, {"use.ts": "\nconst p = price(cart);\n"})
    assert kinds(cs.compare(a, b)) == [("contract", "price")]
    assert cs.compare(a, work(repo, {"use.ts": "\nconst p = price(cart, 'eu');\n"})) == []
    s = work(repo, {"Greet.swift": swift.replace("name: String) ->", "person: String) ->")})
    t = work(repo, {"Use.swift": '\nlet hi = greet(name: "Ada")\n'})
    [f] = cs.compare(s, t)
    assert f.kind == "contract" and "parameter renamed or taken out: name" in f.detail
    assert cs.compare(s, work(repo, {"Use.swift": '\nlet hi = greet(person: "Ada")\n'})) == []


def test_a_removed_or_renamed_symbol_the_other_still_uses(tmp_path):
    lib = "def helper_total(xs):\n    out = 0\n    for x in xs:\n        out += x\n    return out\n"
    repo = make_repo(tmp_path / "app", {"lib.py": lib, "main.py": "import lib\n"})
    renamed = work(repo, {"lib.py": lib.replace("helper_total", "add_up")})
    removed = work(repo, {"lib.py": "\n"})
    user = work(repo, {"main.py": "import lib\n\nprint(lib.helper_total([1]))\n"})
    [f] = cs.compare(renamed, user)
    assert (f.kind, f.symbol, f.detail, f.where) == (
        "removed",
        "helper_total",
        "add_up",
        "main.py:3",
    )
    [g] = cs.compare(removed, user)
    assert (g.kind, g.detail) == ("removed", "")
    # The other defines the name itself: no collision. A name too common to tell: none.
    own = work(repo, {"main.py": "def helper_total(xs):\n    return 0\n\nhelper_total([])\n"})
    assert cs.compare(removed, own) == []
    # The project's symbol map still has it elsewhere: not removed.
    cs.drop_defined_elsewhere(removed, lambda name, touched: name == "helper_total")
    assert cs.compare(removed, user) == []


def test_a_moved_function_is_not_removed_and_strings_and_comments_are_not_uses(tmp_path):
    lib = "def helper_total(xs):\n    return sum(xs)\n"
    repo = make_repo(tmp_path / "app", {"lib.py": lib, "more.py": "\n", "main.py": "\n"})
    moved = work(repo, {"lib.py": "\n", "more.py": lib})
    user = work(repo, {"main.py": "\nfrom more import helper_total\n"})
    assert cs.compare(moved, user) == []
    removed = work(repo, {"lib.py": "\n"})
    said = work(repo, {"main.py": '\nx = "helper_total"  # helper_total is gone\n'})
    assert cs.compare(removed, said) == []


def test_a_deleted_file_and_a_new_untracked_one_are_read(tmp_path):
    repo = make_repo(tmp_path / "app", {"lib.py": "def helper_total(xs):\n    return 1\n"})
    base = git(repo, "rev-parse", "HEAD").strip()
    (repo / "lib.py").unlink()
    removed = cs.read_work(repo, base)
    assert "helper_total" in removed.removed
    git(repo, "checkout", "-q", "--", "lib.py")
    (repo / "new.py").write_text("import lib\nlib.helper_total([])\n")
    user = cs.read_work(repo, base)
    assert kinds(cs.compare(removed, user)) == [("removed", "helper_total")]
    # Between two commits too (a pull request's branch).
    git(repo, "add", "-A")
    git(repo, "commit", "-qm", "use it")
    head = git(repo, "rev-parse", "HEAD").strip()
    assert "helper_total" in cs.read_work(repo, base, head).calls
