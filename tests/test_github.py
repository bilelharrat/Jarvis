"""The GitHub API client (github.py): which repository a remote is, the token (the
connector's, or gh's), errors in words, rate limits, ETags, pages, job logs fetched without
the token, and what checks add up to. GitHub itself is tests/github_fakes.py: an
httpx.MockTransport, so nothing leaves the machine."""

import subprocess

import httpx
import pytest
from github_fakes import API, LOGS, FakeGitHub

from jarvis import github
from jarvis.connectors import MemoryVault
from jarvis.github import Client, RepoRef, parse_remote

APP = RepoRef("acme", "app")


@pytest.fixture(autouse=True)
def _no_real_gh(monkeypatch):
    """gh is never run in a test: as if it isn't installed."""
    monkeypatch.setattr(github.shutil, "which", lambda _name: None)


@pytest.fixture
async def hub_client():
    fake = FakeGitHub()
    client = Client(lambda: "tok-123", transport=fake.transport())
    yield fake, client
    await client.aclose()


# ── which repository ──


@pytest.mark.parametrize(
    "url",
    [
        "https://github.com/acme/app.git",
        "https://github.com/acme/app",
        "https://github.com/acme/app/",
        "http://github.com/acme/app.git",
        "https://someone:ghp_secret@github.com/acme/app.git",
        "https://x-access-token:abc@www.github.com/acme/app",
        "ssh://git@github.com/acme/app.git",
        "ssh://git@ssh.github.com:443/acme/app.git",
        "git@github.com:acme/app.git",
        "git@github.com:acme/app",
        "github.com:acme/app.git",
        "git://github.com/acme/app.git",
        "git@github.com-work:acme/app.git",  # an ssh alias in ~/.ssh/config
        "git@github-personal:acme/app.git",
    ],
)
def test_a_github_remote_in_any_form_git_writes(url):
    assert parse_remote(url) == APP


@pytest.mark.parametrize(
    "url",
    [
        "",
        "https://gitlab.com/acme/app.git",
        "git@bitbucket.org:acme/app.git",
        "https://github.example.com/acme/app.git",  # an enterprise server: not github.com
        "git@github.company.com:acme/app.git",
        "https://gist.github.com/acme/abc123",
        "https://github.com/acme",
        "https://github.com/acme/app/pulls",
        "file:///Users/x/app.git",
        "/Users/x/origin.git",
        "https://github.com/acme/app name",
        "https://github.com/../app",
    ],
)
def test_anything_else_is_no_github_repository(url):
    assert parse_remote(url) is None


def _git(repo, *args):
    subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True)


def test_the_remote_is_the_branchs_upstream_else_origin_else_the_only_one(tmp_path):
    repo = tmp_path / "p"
    repo.mkdir()
    _git(repo, "init", "-q", "-b", "main")
    assert github.repo_for(repo) == ("", None)
    _git(repo, "remote", "add", "mine", "git@github.com:me/fork.git")
    assert github.repo_for(repo) == ("mine", RepoRef("me", "fork"))
    _git(repo, "remote", "add", "origin", "https://github.com/acme/app.git")
    assert github.repo_for(repo) == ("origin", APP)
    # The branch's upstream, when it has one, wins over origin.
    _git(
        repo,
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@e",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "x",
    )
    _git(repo, "update-ref", "refs/remotes/mine/main", "HEAD")
    _git(repo, "config", "branch.main.remote", "mine")
    _git(repo, "config", "branch.main.merge", "refs/heads/main")
    assert github.repo_for(repo) == ("mine", RepoRef("me", "fork"))


# ── the token ──


def test_the_token_is_the_connectors_else_gh_s(monkeypatch):
    vault = MemoryVault()
    assert github.token_from(vault) == ""
    vault.set("github", "token", "  github_pat_abc  ")
    assert github.token_from(vault) == "github_pat_abc"
    vault.delete("github", "token")
    ran = []

    def fake_run(args, **_kw):
        ran.append(args)
        return subprocess.CompletedProcess(args, 0, "gho_" + "x" * 36 + "\n", "")

    monkeypatch.setattr(
        github.shutil, "which", lambda name: "/opt/bin/gh" if name == "gh" else None
    )
    monkeypatch.setattr(github.subprocess, "run", fake_run)
    assert github.token_from(vault) == "gho_" + "x" * 36
    assert ran == [["/opt/bin/gh", "auth", "token", "--hostname", "github.com"]]
    # gh signed out, or saying something that isn't a token: nothing.
    monkeypatch.setattr(
        github.subprocess, "run", lambda args, **_k: subprocess.CompletedProcess(args, 1, "", "no")
    )
    assert github.token_from(vault) == ""

    class Locked:
        def get(self, *_a):
            raise RuntimeError("the keychain is locked")

    monkeypatch.setattr(github.shutil, "which", lambda _name: None)
    assert github.token_from(Locked()) == ""


async def test_without_a_token_nothing_is_asked_and_it_says_how_to_connect():
    fake = FakeGitHub()
    client = Client(lambda: "", transport=fake.transport())
    with pytest.raises(github.NotConnected) as caught:
        await client.repo(APP)
    assert "Connect GitHub in Tools & Accounts" in str(caught.value)
    assert fake.requests == []
    await client.aclose()


async def test_the_token_goes_in_the_header_and_is_read_once_in_a_while():
    reads = []
    fake = FakeGitHub()
    now = [1000.0]

    def token():
        reads.append(1)
        return "tok-1"

    client = Client(token, transport=fake.transport(), clock=lambda: now[0])
    await client.repo(APP)
    await client.repo(APP)
    assert len(reads) == 1
    assert fake.requests[0].headers["authorization"] == "Bearer tok-1"
    assert fake.requests[0].headers["user-agent"] == "Jarvis-Code"
    now[0] += github.TOKEN_FRESH + 1
    await client.repo(APP)
    assert len(reads) == 2
    await client.aclose()


# ── errors, in words ──


async def test_errors_say_what_to_do(hub_client):
    fake, client = hub_client
    fake.fail[("GET", "/repos/acme/app")] = (401, {"message": "Bad credentials"}, {})
    with pytest.raises(github.GitHubError) as caught:
        await client.repo(APP)
    assert "Reconnect GitHub in Tools & Accounts" in str(caught.value)
    assert caught.value.status == 401 and client._token is None  # read again next time
    fake.fail[("GET", "/repos/acme/app")] = (403, {"message": "Resource not accessible"}, {})
    with pytest.raises(github.GitHubError) as caught:
        await client.repo(APP)
    assert "isn't allowed to do that in acme/app" in str(caught.value)
    del fake.fail[("GET", "/repos/acme/app")]
    with pytest.raises(github.GitHubError) as caught:
        await client.repo(RepoRef("acme", "gone"))
    assert "can't find acme/gone" in str(caught.value)
    fake.add_pull("acme/app", "jarvis/x")
    with pytest.raises(github.GitHubError) as caught:
        await client.create_pull(APP, title="t", head="jarvis/x", base="main", body="")
    assert str(caught.value) == "GitHub said no: A pull request already exists for acme:jarvis/x."
    fake.fail[("GET", "/repos/acme/app")] = (502, {}, {})
    with pytest.raises(github.GitHubError) as caught:
        await client.repo(APP)
    assert "GitHub had a problem (502)" in str(caught.value)


async def test_a_network_failure_is_said_plainly():
    def down(_request):
        raise httpx.ConnectError("Name or service not known")

    client = Client(lambda: "tok", transport=httpx.MockTransport(down))
    with pytest.raises(github.GitHubError) as caught:
        await client.repo(APP)
    assert str(caught.value) == "Couldn't reach GitHub: Name or service not known"
    await client.aclose()


async def test_errors_come_in_chinese_when_the_owner_speaks_it():
    fake = FakeGitHub()
    client = Client(lambda: "", transport=fake.transport(), language=lambda: "zh")
    with pytest.raises(github.NotConnected) as caught:
        await client.repo(APP)
    assert str(caught.value).startswith("请先在“工具与账户”里连接 GitHub")
    await client.aclose()


# ── rate limits ──


async def test_a_used_up_limit_stops_every_call_until_it_resets(hub_client):
    fake, client = hub_client
    now = [1_000_000.0]
    client.clock = lambda: now[0]
    fake.fail[("GET", "/repos/acme/app")] = (
        403,
        {"message": "API rate limit exceeded"},
        {"x-ratelimit-remaining": "0", "x-ratelimit-reset": str(int(now[0] + 600))},
    )
    with pytest.raises(github.RateLimited) as caught:
        await client.repo(APP)
    assert caught.value.reset_at == now[0] + 600 and "rate limit is used up until" in str(
        caught.value
    )
    asked = len(fake.requests)
    with pytest.raises(github.RateLimited):
        await client.pull(APP, 1)
    assert len(fake.requests) == asked  # not asked again meanwhile
    assert client.low() and 590 < client.wait_seconds() <= 600
    now[0] += 601
    del fake.fail[("GET", "/repos/acme/app")]
    assert (await client.repo(APP))["default_branch"] == "main"


async def test_a_secondary_limit_waits_as_long_as_github_says(hub_client):
    fake, client = hub_client
    now = [5000.0]
    client.clock = lambda: now[0]
    fake.fail[("GET", "/repos/acme/app")] = (429, {"message": "slow down"}, {"retry-after": "30"})
    with pytest.raises(github.RateLimited) as caught:
        await client.repo(APP)
    assert caught.value.reset_at == 5030.0
    fake.fail[("GET", "/repos/acme/app")] = (
        403,
        {"message": "You have exceeded a secondary rate limit."},
        {},
    )
    now[0] += 31
    with pytest.raises(github.RateLimited) as caught:
        await client.repo(APP)
    assert caught.value.reset_at == now[0] + github.SECONDARY_WAIT


async def test_few_calls_left_make_background_polling_wait(hub_client):
    fake, client = hub_client
    client.clock = lambda: 1000.0
    fake.remaining = github.LOW - 1
    await client.repo(APP)
    assert client.low()
    fake.remaining = 4000
    await client.repo(APP)
    assert not client.low() and client.wait_seconds() == 0


# ── ETags, pages, redirects ──


async def test_an_unchanged_answer_comes_back_from_its_etag(hub_client):
    fake, client = hub_client
    served = []

    def handle(request):
        served.append(request)
        if request.headers.get("if-none-match") == '"v1"':
            return httpx.Response(304)
        return httpx.Response(200, json={"default_branch": "main"}, headers={"etag": '"v1"'})

    client._transport = httpx.MockTransport(handle)
    await client.aclose()
    assert (await client.repo(APP)) == {"default_branch": "main"}
    assert (await client.repo(APP)) == {"default_branch": "main"}
    assert "if-none-match" not in served[0].headers and served[1].headers["if-none-match"] == '"v1"'


async def test_lists_follow_their_pages(hub_client):
    _fake, client = hub_client

    def handle(request):
        page = int(request.url.params.get("page", "1"))
        link = {"link": f'<{API}/repos/acme/app/pulls/1/reviews?page={page + 1}>; rel="next"'}
        return httpx.Response(
            200, json=[{"id": page * 10 + i} for i in range(3)], headers=link if page < 3 else {}
        )

    client._transport = httpx.MockTransport(handle)
    await client.aclose()
    found = await client.reviews(APP, 1)
    assert [r["id"] for r in found] == [10, 11, 12, 20, 21, 22, 30, 31, 32]


async def test_a_renamed_repository_is_followed_once(hub_client):
    fake, client = hub_client
    fake.fail[("GET", "/repos/acme/old")] = (
        301,
        {"message": "Moved Permanently"},
        {"location": f"{API}/repos/acme/app"},
    )
    assert (await client.repo(RepoRef("acme", "old")))["full_name"] == "acme/app"


# ── job logs ──


async def test_a_jobs_log_is_fetched_where_github_sends_it_without_the_token(hub_client):
    fake, client = hub_client
    fake.logs[55] = "2026-09-29T10:00:00.1234567Z starting\n" + "x\n" * 10 + "FAILED test_a\n"
    text = await client.job_log(APP, 55)
    assert text.endswith("FAILED test_a\n")
    [log_request] = [r for r in fake.requests if str(r.url).startswith(LOGS)]
    assert "authorization" not in log_request.headers
    assert log_request.headers["range"] == f"bytes=-{github.LOG_TAIL}"


async def test_a_long_log_keeps_only_its_end(hub_client):
    fake, client = hub_client
    fake.logs[56] = "early line\n" * 30_000 + "the end\n"
    text = await client.job_log(APP, 56)
    assert len(text) <= github.LOG_TAIL and text.endswith("the end\n")


# ── what checks add up to ──


def test_checks_are_one_per_name_failures_first():
    runs = [
        {"id": 1, "name": "tests", "status": "completed", "conclusion": "failure",
         "app": {"slug": "github-actions"}, "output": {"title": "2 failed"}},
        {"id": 2, "name": "lint", "status": "in_progress", "conclusion": None, "app": {"slug": "x"}},
        {"id": 3, "name": "docs", "status": "completed", "conclusion": "skipped", "app": {}},
        {"id": 4, "name": "old", "status": "completed", "conclusion": "cancelled", "app": {}},
    ]  # fmt: skip
    statuses = [
        {
            "context": "ci/circle",
            "state": "error",
            "description": "Tests failed",
            "target_url": "u",
        },
        {"context": "tests", "state": "success"},  # a run of that name is already there
    ]
    checks = github.checks_from(runs, statuses)
    assert [(c.name, c.state) for c in checks] == [
        ("ci/circle", "failed"),
        ("tests", "failed"),
        ("lint", "pending"),
        ("docs", "passed"),
        ("old", "cancelled"),
    ]
    tests = checks[1]
    assert tests.actions and tests.check_id == 1 and tests.summary == "2 failed"
    assert github.overall(checks) == "failed"
    assert github.overall([c for c in checks if c.state != "failed"]) == "pending"
    assert github.overall([checks[3], checks[4]]) == "passed"
    assert github.overall([]) == "none"
    assert github.checks_from(["junk", None], [7]) == []  # odd answers are skipped


def test_a_log_is_trimmed_to_what_a_fix_needs():
    lines = [
        f"2026-09-29T10:00:{i % 60:02d}.0000000Z \x1b[32mok line {i}\x1b[0m" for i in range(300)
    ]
    lines[120] = "2026-09-29T10:02:00.0000000Z ##[error]AssertionError: expected 2, got 3"
    lines.insert(0, "##[group]Run npm test")
    text = github.trim_log("\n".join(lines), limit=4000)
    assert "\x1b" not in text and "2026-09-29T" not in text and "##[group]" not in text
    assert "##[error]AssertionError: expected 2, got 3" in text
    assert "ok line 114" in text and "ok line 131" in text  # its context
    assert "ok line 299" in text  # the end
    assert "ok line 50\n" not in text and "…" in text
    assert len(github.trim_log("error\n" * 10_000, limit=500)) <= 502
