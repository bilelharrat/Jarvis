"""The secret scan before a commit, a push or a landing (secret_scan.py): keys and tokens
by their formats, random-looking values given to secret names, credentials files; masked
wherever they're shown, and quiet about placeholders, lookups, hashes and lockfiles.

The keys below are made up, in the right shapes, and assembled at run time so this file
never looks like it holds one."""

from jarvis import secret_scan as scan
from jarvis.code_changes import FileDiff, Hunk


def added(path: str, *lines: str, start: int = 1) -> FileDiff:
    return FileDiff(path, hunks=[Hunk(0, 0, start, len(lines), "", [("+", x) for x in lines])])


AWS = "AKIA" + "Q7ZL3M9T2R5X8B4N"
GITHUB = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"
STRIPE = "sk_live_" + "4eC39HqLyjWDarjtT1zdp7dc"
ANTHROPIC = "sk-ant-" + "api03-Zq8Xr2Lk9Pm4Tn7Wv1Bc6Hd3"
RANDOM = "Zx9Qr2Lk8Pm4Tn7Wv1Bc6Hd3Jf5Gs0Ya"


def test_known_formats_are_found_and_never_shown_whole():
    found = scan.scan(
        [
            added(
                "config.py",
                f'AWS_KEY = "{AWS}"',
                f"token: {GITHUB}",
                f"stripe = '{STRIPE}'",
                "-----BEGIN OPENSSH PRIVATE KEY-----",
                f"client = Anthropic(api_key='{ANTHROPIC}')",
                "db = 'postgres://admin:hunter2secret@db.internal:5432/app'",
                start=10,
            )
        ]
    )
    kinds = [(f.kind, f.line) for f in found]
    assert ("AWS access key", 10) in kinds and ("GitHub token", 11) in kinds
    assert ("Stripe secret key", 12) in kinds and ("Private key", 13) in kinds
    assert ("Anthropic API key", 14) in kinds and ("Password in a URL", 15) in kinds
    shown = " ".join(f.preview for f in found) + scan.summary(found, limit=10)
    for secret in (AWS, GITHUB, STRIPE, ANTHROPIC, "hunter2secret"):
        assert secret not in shown
    assert next(f for f in found if f.kind == "AWS access key").preview == "AKIA…4N"
    assert "postgres://admin:••••@db.internal" in shown


def test_a_random_value_given_to_a_secret_name_is_found_a_placeholder_is_not():
    found = scan.scan(
        [
            added(
                "settings.py",
                f'API_KEY = "{RANDOM}"',
                'API_KEY = "your-api-key-here"',
                "api_key = os.environ['API_KEY']",
                "secret = settings.secret_key",
                'password = "password123"',  # a word and digits: not random enough to flag
                'SECRET = "${VAULT_SECRET}"',
            )
        ]
    )
    assert [(f.kind, f.line) for f in found] == [("Secret-looking value for API_KEY", 1)]


def test_long_random_strings_count_and_hashes_lockfiles_and_deletions_dont():
    found = scan.scan(
        [
            added("a.js", f'const blob = "{RANDOM}{RANDOM}";'),
            added("b.js", f'integrity: "sha512-{RANDOM}{RANDOM}"'),
            added("package-lock.json", f'"resolved": "{RANDOM}{RANDOM}"', f'"k": "{AWS}"'),
            FileDiff("gone.py", status="D", hunks=[Hunk(1, 1, 0, 0, "", [("-", AWS)])]),
            added("c.py", "x = 'not a secret at all, just a sentence'"),
        ]
    )
    assert [(f.path, f.kind) for f in found] == [("a.js", "High-entropy string")]


def test_a_credentials_file_is_a_finding_whatever_it_holds():
    found = scan.scan(
        [FileDiff(".env", status="?", sensitive=True), added("keys/deploy.pem", "abc")],
        shown=lambda p: f"app/{p}",
    )
    assert [(f.path, f.kind, f.line) for f in found] == [
        ("app/.env", "Credentials file", 0),
        ("app/keys/deploy.pem", "Credentials file", 0),
    ]
    assert found[0].said() == "Credentials file in app/.env"


def test_lines_are_counted_through_context_and_the_findings_bounded():
    diff = FileDiff(
        "a.py",
        hunks=[Hunk(5, 3, 5, 4, "", [(" ", "a"), ("-", "b"), ("+", f"k = '{AWS}'"), (" ", "c")])],
    )
    assert [f.line for f in scan.scan([diff])] == [6]
    many = added("many.py", *[f"k{i} = '{AWS}'" for i in range(200)])
    assert len(scan.scan([many])) == scan.MAX_FINDINGS
    assert scan.summary(scan.scan([many]), limit=2).endswith("…and 48 more.")
    assert scan.mask("short") == "••••••" and scan.entropy("aaaa") == 0.0
