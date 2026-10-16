"""The other git hosts' clients (githosts/): which host a remote is, whose token each uses
(the Keychain, else the host's CLI; never one host's token sent to another), and each
client against recorded answers of its API (tests/fixtures/githosts, githost_fakes.py),
answering in GitHub's shapes so github.checks_from and the pull request desk read them as
they read GitHub's. Nothing leaves the machine."""

import base64

import pytest
from githost_fakes import Recorded

from jarvis import githosts, github
from jarvis.connectors import MemoryVault
from jarvis.githosts import base as hostbase
from jarvis.githosts import jira as jira_mod
from jarvis.githosts.base import HostRef


@pytest.fixture(autouse=True)
def _no_real_cli(monkeypatch):
    monkeypatch.setattr(hostbase.shutil, "which", lambda _name: None)
    monkeypatch.setattr(github.shutil, "which", lambda _name: None)


def lab_ref():
    return HostRef("acme", "app", kind="gitlab", host="gitlab.com")


def bb_ref():
    return HostRef("team", "app", kind="bitbucket", host="bitbucket.org")


def az_ref():
    return HostRef("acme/Shop Web", "app", kind="azure", host="dev.azure.com")


# ── which host ──


@pytest.mark.parametrize(
    ("url", "tag", "full"),
    [
        ("https://gitlab.com/acme/web/app.git", "gitlab:gitlab.com", "acme/web/app"),
        ("git@gitlab.com:acme/app.git", "gitlab:gitlab.com", "acme/app"),
        ("ssh://git@gitlab.com-work/acme/app.git", "gitlab:gitlab.com", "acme/app"),
        ("https://gitlab.acme.dev/a/b", "gitlab:gitlab.acme.dev", "a/b"),
        ("https://user@bitbucket.org/team/app.git", "bitbucket:bitbucket.org", "team/app"),
        ("git@bitbucket.org:team/app.git", "bitbucket:bitbucket.org", "team/app"),
        ("https://acme@dev.azure.com/acme/Shop%20Web/_git/app", "azure:dev.azure.com", "acme/Shop Web/app"),
        ("git@ssh.dev.azure.com:v3/acme/Shop/app", "azure:dev.azure.com", "acme/Shop/app"),
        ("https://acme.visualstudio.com/DefaultCollection/Shop/_git/app", "azure:acme.visualstudio.com", "acme/Shop/app"),
        ("https://dev.azure.com/acme/_git/app", "azure:dev.azure.com", "acme/app/app"),
    ],
)  # fmt: skip
def test_a_remote_says_which_host_and_repository(url, tag, full):
    ref = githosts.parse_remote(url)
    assert isinstance(ref, HostRef) and ref.tag == tag and ref.full == full
    assert githosts.ref_from(ref.tag, ref.full) == ref  # (as a PullRecord keeps it)


def test_github_stays_github_and_anything_else_is_no_host():
    ref = githosts.parse_remote("https://github.com/acme/app.git")
    assert type(ref) is github.RepoRef and ref.full == "acme/app"
    assert githosts.ref_from("", "acme/app") == ref
    for url in ("https://git.example.org/acme/app.git", "https://bitbucket.org/only-one",
                "https://gitlab.com/-/snippets/1", "file:///tmp/x", "https://dev.azure.com/acme/x/y",
                "https://gitlab.com/a b/c", ""):  # fmt: skip
        assert githosts.parse_remote(url) is None, url
    # The owner's own GitLab counts once it's named in settings.
    assert githosts.parse_remote("https://git.example.org/acme/app.git", ("git.example.org",)).tag == "gitlab:git.example.org"


def test_web_addresses_of_each_host():
    assert lab_ref().pull_url(7) == "https://gitlab.com/acme/app/-/merge_requests/7"
    assert bb_ref().pull_url(7) == "https://bitbucket.org/team/app/pull-requests/7"
    assert az_ref().pull_url(7) == "https://dev.azure.com/acme/Shop Web/_git/app/pullrequest/7"
    assert githosts.clean_host("https://GitLab.Acme.dev/group") == "gitlab.acme.dev"
    assert githosts.clean_host("not a host") == ""


# ── whose token ──


def test_tokens_come_from_the_keychain_and_never_cross_hosts(monkeypatch):
    vault = MemoryVault()
    vault.set(githosts.VAULT, "gitlab_token", "glpat-public-0123456789")
    assert githosts.host_token(vault, "gitlab", "gitlab.com") == "glpat-public-0123456789"
    # A self-hosted GitLab never gets gitlab.com's token: it has a key of its own.
    assert githosts.host_token(vault, "gitlab", "gitlab.acme.dev") == ""
    vault.set(githosts.VAULT, "gitlab_token:gitlab.acme.dev", "glpat-own-0123456789")
    assert githosts.host_token(vault, "gitlab", "gitlab.acme.dev") == "glpat-own-0123456789"
    assert githosts.host_token(vault, "bitbucket", "bitbucket.org") == ""

    class Locked(MemoryVault):
        def get(self, conn_id, key):
            raise RuntimeError("locked")

    assert githosts.host_token(Locked(), "azure", "dev.azure.com") == ""


def test_the_hosts_own_cli_lends_its_token_when_none_is_pasted(monkeypatch):
    ran = []

    class Done:
        returncode, stdout = 0, "glpat-from-glab-0123456789\n"

    def run(args, **kw):
        ran.append(args)
        return Done()

    monkeypatch.setattr(hostbase.shutil, "which", lambda name: f"/usr/local/bin/{name}")
    monkeypatch.setattr(hostbase.subprocess, "run", run)
    assert githosts.host_token(MemoryVault(), "gitlab", "gitlab.acme.dev") == "glpat-from-glab-0123456789"
    assert ran[-1][1:] == ["config", "get", "token", "--host", "gitlab.acme.dev"]
    Done.stdout = "eyJ0eXAiOiJKV1QiLCJhbGciOi.payload.sig\n"
    assert githosts.host_token(MemoryVault(), "azure", "dev.azure.com").startswith("Bearer eyJ0")
    assert githosts.host_token(MemoryVault(), "bitbucket", "bitbucket.org") == ""  # (no CLI)
    Done.stdout = "not a token\n"
    assert githosts.host_token(MemoryVault(), "gitlab", "gitlab.com") == ""


# ── GitLab ──


def gitlab(fake, token="glpat-x"):
    return githosts.GitLabClient(lambda: token, transport=fake.transport())


async def test_gitlab_merge_requests_read_as_pull_requests():
    fake = Recorded("gitlab")
    client = gitlab(fake)
    pull = await client.pull(lab_ref(), 7)
    assert pull["number"] == 7 and pull["head"] == {"ref": "feature/login", "sha": "head1"}
    assert pull["base"] == {"ref": "main", "sha": "base000"} and pull["mergeable_state"] == "clean"
    assert pull["html_url"] == "https://gitlab.com/acme/app/-/merge_requests/7"
    assert fake.sent("GET")[0].headers["authorization"] == "Bearer glpat-x"
    assert "/projects/acme%2Fapp/" in str(fake.sent("GET")[0].url)
    body = fake.body("GET https://gitlab.com/api/v4/projects/acme%2Fapp/merge_requests/7")
    body.update(has_conflicts=True)
    pull = await client.pull(lab_ref(), 7)
    assert pull["mergeable_state"] == "dirty" and pull["mergeable"] is False
    body.update(has_conflicts=False, detailed_merge_status="not_approved")
    assert (await client.pull(lab_ref(), 7))["mergeable_state"] == "blocked"
    body.update(state="merged")
    assert (await client.pull(lab_ref(), 7))["merged"] is True
    await client.aclose()


async def test_gitlab_opens_a_draft_and_an_existing_one_is_said_as_github_says_it():
    fake = Recorded("gitlab")
    client = gitlab(fake)
    made = await client.create_pull(lab_ref(), title="Make x two", head="feature/login",
                                    base="main", body="Why", draft=True)  # fmt: skip
    assert made["number"] == 7
    [sent] = fake.json_sent("POST", "/merge_requests")
    assert sent == {"source_branch": "feature/login", "target_branch": "main",
                    "title": "Draft: Make x two", "description": "Why", "remove_source_branch": False}  # fmt: skip
    fake.answer("POST https://gitlab.com/api/v4/projects/acme%2Fapp/merge_requests",
                {"message": ["Another open merge request already exists for this source branch: !7"]},
                status=409)  # fmt: skip
    with pytest.raises(github.GitHubError) as caught:
        await client.create_pull(lab_ref(), title="t", head="feature/login", base="main", body="")
    assert caught.value.status == 422 and "already exists" in str(caught.value)
    await client.aclose()


async def test_gitlab_pipeline_jobs_are_checks_and_a_failing_jobs_log_is_read():
    fake = Recorded("gitlab")
    client = gitlab(fake)
    runs = await client.check_runs(lab_ref(), "head1")
    checks = {c.name: c for c in github.checks_from(runs, [])}
    assert checks["tests"].state == "failed" and checks["tests"].actions
    assert checks["tests"].summary == "script failure" and checks["tests"].check_id == 8802
    assert checks["lint"].state == "passed"
    assert checks["audit"].state == "passed"  # allowed to fail: neutral
    assert checks["deploy"].state == "passed"  # a manual job: skipped
    assert github.overall(list(checks.values())) == "failed"
    log = github.trim_log(await client.job_log(lab_ref(), 8802))
    assert "FAILED tests/test_login.py::test_login" in log and "\x1b" not in log
    # Without a pipeline, the commit's statuses (another CI's) are its checks.
    fake.answer("GET https://gitlab.com/api/v4/projects/acme%2Fapp/pipelines", [])
    fake.answer("GET https://gitlab.com/api/v4/projects/acme%2Fapp/repository/commits/head2/statuses",
                [{"name": "jenkins", "status": "running", "target_url": "https://ci.example.test/1"}])  # fmt: skip
    [only] = github.checks_from(await client.check_runs(lab_ref(), "head2"), [])
    assert only.name == "jenkins" and only.state == "pending" and not only.actions
    await client.aclose()


async def test_gitlab_notes_split_into_review_comments_and_the_conversation():
    fake = Recorded("gitlab")
    client = gitlab(fake)
    inline = await client.review_comments(lab_ref(), 7)
    talk = await client.issue_comments(lab_ref(), 7)
    assert [(c["id"], c["path"], c["line"], c["user"]["login"]) for c in inline] == [
        (302, "a.py", 1, "reviewer")
    ]
    assert [c["id"] for c in talk] == [303]  # (GitLab's own "added 1 commit" is left out)
    assert talk[0]["html_url"] == "https://gitlab.com/acme/app/-/merge_requests/7#note_303"
    [approval] = await client.reviews(lab_ref(), 7)
    assert approval["state"] == "APPROVED" and approval["user"]["login"] == "reviewer"
    assert await client.may(lab_ref(), "reviewer", "write") is True  # Developer
    assert await client.may(lab_ref(), "stranger", "write") is False  # not a member
    assert await client.may(lab_ref(), "reviewer", "maintain") is False
    assert await client.login() == "octo-owner"
    await client.aclose()


async def test_gitlab_merges_at_the_checked_commit_and_a_not_yet_isnt_a_forbidden_method():
    fake = Recorded("gitlab")
    client = gitlab(fake)
    await client.merge(lab_ref(), 7, method="squash", sha="head1", title="Make x two")
    assert fake.json_sent("PUT", "/merge") == [
        {"sha": "head1", "squash": True, "squash_commit_message": "Make x two"}
    ]
    fake.answer("PUT https://gitlab.com/api/v4/projects/acme%2Fapp/merge_requests/7/merge",
                {"message": "405 Method Not Allowed"}, status=405)  # fmt: skip
    with pytest.raises(github.GitHubError) as caught:
        await client.merge(lab_ref(), 7, method="merge", sha="head1")
    assert caught.value.status == 409  # (merging when green stays on: it's only not yet)
    methods = await client.repo(lab_ref())
    assert methods["allow_squash_merge"] and methods["allow_merge_commit"]
    await client.aclose()


async def test_a_used_up_limit_stops_every_call_until_it_resets_and_a_401_reads_the_token_again():
    fake = Recorded("gitlab")
    now = [1000.0]
    reads = []

    def token():
        reads.append(1)
        return "glpat-x"

    client = githosts.GitLabClient(token, transport=fake.transport(), clock=lambda: now[0])
    fake.answer("GET https://gitlab.com/api/v4/projects/acme%2Fapp/merge_requests/7",
                {"message": "Retry later"}, status=429, headers={"retry-after": "30"})  # fmt: skip
    with pytest.raises(github.RateLimited) as caught:
        await client.pull(lab_ref(), 7)
    assert caught.value.reset_at == 1030.0 and client.wait_seconds() == 30.0
    asked = len(fake.requests)
    with pytest.raises(github.RateLimited):
        await client.repo(lab_ref())
    assert len(fake.requests) == asked  # GitLab isn't asked again meanwhile
    now[0] = 1031.0
    fake.answer("GET https://gitlab.com/api/v4/projects/acme%2Fapp", {"message": "401 Unauthorized"}, status=401)
    with pytest.raises(github.GitHubError) as caught:
        await client.repo(lab_ref())
    assert caught.value.status == 401 and "Paste a fresh one" in str(caught.value)
    before = len(reads)
    with pytest.raises(github.GitHubError):
        await client.repo(lab_ref())
    assert len(reads) == before + 1  # read again at once after it was turned down
    empty = githosts.GitLabClient(lambda: "", transport=fake.transport())
    with pytest.raises(github.NotConnected) as caught:
        await empty.pull(lab_ref(), 7)
    assert "Add a GitLab token in Eden Code settings" in str(caught.value)
    await client.aclose()


# ── Bitbucket ──


def bitbucket(fake, token="octo-owner:app-password"):
    return githosts.BitbucketClient(lambda: token, transport=fake.transport())


async def test_bitbucket_sends_an_app_password_as_basic_and_an_access_token_as_bearer():
    fake = Recorded("bitbucket")
    await bitbucket(fake).repo(bb_ref())
    raw = base64.b64encode(b"octo-owner:app-password").decode()
    assert fake.requests[-1].headers["authorization"] == f"Basic {raw}"
    await bitbucket(fake, "ATCTT3xFfGN0-access-token").repo(bb_ref())
    assert fake.requests[-1].headers["authorization"] == "Bearer ATCTT3xFfGN0-access-token"


async def test_bitbucket_pull_requests_steps_statuses_and_a_steps_log():
    fake = Recorded("bitbucket")
    client = bitbucket(fake)
    pull = await client.pull(bb_ref(), 7)
    assert pull["head"] == {"ref": "feature/login", "sha": "head1aaaaaaa"} and pull["mergeable_state"] == "clean"
    runs = await client.check_runs(bb_ref(), pull["head"]["sha"])
    checks = {c.name: c for c in github.checks_from(runs, [])}
    assert set(checks) == {"lint", "tests", "SonarCloud"}  # (the pipeline's own status is its steps)
    assert checks["tests"].state == "failed" and checks["tests"].actions
    assert checks["SonarCloud"].state == "passed" and not checks["SonarCloud"].actions
    assert checks["tests"].url == "https://bitbucket.org/team/app/pipelines/results/12/steps/{s-test}"
    log = await client.job_log(bb_ref(), checks["tests"].check_id)
    assert "FAILED tests/test_login.py::test_login" in log
    [moved] = fake.sent("GET", "example-logs.test")
    assert "authorization" not in moved.headers  # the redirect is fetched without the token
    assert await client.job_log(bb_ref(), 12345) == ""  # (no such step)
    fake.answer("GET https://api.bitbucket.org/2.0/repositories/team/app/pullrequests/7/diffstat",
                {"values": [{"status": "merge conflict"}]})  # fmt: skip
    pull = await client.pull(bb_ref(), 7)
    assert pull["mergeable_state"] == "dirty" and pull["mergeable"] is False
    await client.aclose()


async def test_bitbucket_comments_reviews_and_who_may_write():
    fake = Recorded("bitbucket")
    client = bitbucket(fake)
    await client.pull(bb_ref(), 7)
    inline = await client.review_comments(bb_ref(), 7)
    talk = await client.issue_comments(bb_ref(), 7)
    assert [(c["id"], c["path"], c["line"]) for c in inline] == [(501, "a.py", 1)]
    assert [c["id"] for c in talk] == [502]  # (a deleted one is left out)
    [review] = await client.reviews(bb_ref(), 7)
    assert review["state"] == "APPROVED" and review["user"]["login"] == "reviewer"
    assert await client.may(bb_ref(), "octo-owner", "write") is True  # the token's own: admin
    assert await client.may(bb_ref(), "reviewer", "write") is False  # Bitbucket won't say: never a guess
    await client.aclose()


async def test_bitbucket_merges_only_while_the_head_is_the_checked_commit():
    fake = Recorded("bitbucket")
    client = bitbucket(fake)
    await client.merge(bb_ref(), 7, method="squash", sha="head1aaaaaaabbbbbbbb", title="Make x two")
    assert fake.json_sent("POST", "/merge") == [{"merge_strategy": "squash", "message": "Make x two"}]
    with pytest.raises(github.GitHubError) as caught:
        await client.merge(bb_ref(), 7, method="merge", sha="ffff0000ffff")
    assert caught.value.status == 409 and len(fake.sent("POST", "/merge")) == 1
    await client.aclose()


# ── Azure DevOps ──


def azure(fake, token="azure-pat-0123456789"):
    return githosts.AzureClient(lambda: token, transport=fake.transport())


async def test_azure_sends_a_pat_as_basic_and_reads_pull_requests():
    fake = Recorded("azure")
    client = azure(fake)
    pull = await client.pull(az_ref(), 7)
    raw = base64.b64encode(b":azure-pat-0123456789").decode()
    assert fake.requests[-1].headers["authorization"] == f"Basic {raw}"
    assert fake.requests[-1].url.params["api-version"] == "7.1"
    assert pull["head"] == {"ref": "feature/login", "sha": "head1"} and pull["mergeable_state"] == "clean"
    assert pull["html_url"] == "https://dev.azure.com/acme/Shop Web/_git/app/pullrequest/7"
    bearer = githosts.AzureClient(lambda: "Bearer eyJ0eXAi", transport=fake.transport())
    await bearer.pull(az_ref(), 7)
    assert fake.requests[-1].headers["authorization"] == "Bearer eyJ0eXAi"
    await client.aclose()


async def test_azure_builds_and_statuses_are_checks_and_a_failing_tasks_log_is_read():
    fake = Recorded("azure")
    client = azure(fake)
    await client.pull(az_ref(), 7)  # (the desk reads the pull request first: its head's number)
    runs = await client.check_runs(az_ref(), "head1")
    statuses = await client.statuses(az_ref(), "head1")
    checks = {c.name: c for c in github.checks_from(runs, statuses)}
    assert set(checks) == {"CI", "sonar/gate"}  # (Docs ran on an older commit)
    assert checks["CI"].state == "failed" and checks["CI"].check_id == 901 and checks["CI"].actions
    assert checks["sonar/gate"].state == "passed"  # the latest of its statuses
    asked = [r.url.params["branchName"] for r in fake.sent("GET", "/build/builds")]
    assert asked == ["refs/pull/7/merge", "refs/heads/feature/login"]
    log = await client.job_log(az_ref(), 901)
    assert log.index("Run tests") < log.index("── Job")  # a task's own log first
    assert "FAILED tests/test_login.py::test_login" in github.trim_log(log)
    await client.aclose()


async def test_azure_threads_votes_and_only_the_tokens_own_user_is_trusted():
    fake = Recorded("azure")
    client = azure(fake)
    await client.pull(az_ref(), 7)
    inline = await client.review_comments(az_ref(), 7)
    talk = await client.issue_comments(az_ref(), 7)
    assert [(c["id"], c["path"], c["line"]) for c in inline] == [(11001, "a.py", 1)]
    assert [c["user"]["login"] for c in talk] == ["owner@acme.test"]  # (system comments left out)
    [review] = await client.reviews(az_ref(), 7)
    assert review["state"] == "APPROVED" and review["user"]["login"] == "reviewer@acme.test"
    assert await client.login() == "owner@acme.test"
    assert await client.may(az_ref(), "owner@acme.test", "write") is True
    assert await client.may(az_ref(), "reviewer@acme.test", "write") is False
    made = await client.comment(az_ref(), 7, "ok")
    assert made["id"] == 14001  # (as its thread lists it: seen once)
    await client.aclose()


async def test_azure_completes_at_the_checked_commit_and_a_duplicate_is_said_as_github_says_it():
    fake = Recorded("azure")
    client = azure(fake)
    await client.merge(az_ref(), 7, method="squash", sha="head1", title="Make x two")
    [sent] = fake.json_sent("PATCH", "/pullrequests/7")
    assert sent == {"status": "completed", "lastMergeSourceCommit": {"commitId": "head1"},
                    "completionOptions": {"mergeStrategy": "squash", "mergeCommitMessage": "Make x two"}}  # fmt: skip
    fake.answer("POST https://dev.azure.com/acme/Shop%20Web/_apis/git/repositories/app/pullrequests",
                {"message": "TF401179: An active pull request for the source and target branch already exists."},
                status=409)  # fmt: skip
    with pytest.raises(github.GitHubError) as caught:
        await client.create_pull(az_ref(), title="t", head="feature/login", base="main", body="")
    assert caught.value.status == 422
    await client.aclose()


# ── Jira ──


async def test_jira_cloud_searches_reads_adf_and_writes_a_comment_as_a_document():
    fake = Recorded("jira")
    client = githosts.JiraClient(lambda: "atl-token", site="acme.atlassian.net",
                                 email="owner@acme.test", transport=fake.transport())  # fmt: skip
    found = await client.search("assignee = currentUser()")
    assert [i["key"] for i in found] == ["SHOP-12", "SHOP-13"]
    raw = base64.b64encode(b"owner@acme.test:atl-token").decode()
    assert fake.requests[-1].headers["authorization"] == f"Basic {raw}"
    assert fake.requests[-1].url.path == "/rest/api/3/search/jql"
    issue = await client.issue("SHOP-12")
    assert issue["body"].startswith("Clicking Checkout does nothing.\n- Safari 18")
    assert issue["url"] == "https://acme.atlassian.net/browse/SHOP-12" and issue["reporter"] == "Pat Reporter"
    await client.comment("SHOP-12", "Pull request: https://x")
    [sent] = fake.json_sent("POST", "/comment")
    assert sent["body"]["type"] == "doc" and sent["body"]["content"][0]["content"][0]["text"] == "Pull request: https://x"
    await client.link("SHOP-12", "https://gitlab.com/acme/app/-/merge_requests/7", "Make x two")
    [link] = fake.json_sent("POST", "/remotelink")
    assert link["globalId"] == link["object"]["url"]  # (made again, nothing changes)
    assert await client.move("SHOP-12", ("In Review",), "") == "In Review"
    assert fake.json_sent("POST", "/transitions") == [{"transition": {"id": "31"}}]
    await client.aclose()


async def test_jira_data_center_speaks_api_2_with_a_bearer_token():
    fake = Recorded("jira")
    client = githosts.JiraClient(lambda: "dc-pat", site="jira.acme.dev", transport=fake.transport())
    [issue] = await client.search("project = OPS")
    assert issue["body"] == "Plain text on Data Center."
    assert fake.requests[-1].headers["authorization"] == "Bearer dc-pat"
    await client.comment("OPS-1", "hello")
    assert fake.json_sent("POST", "/comment") == [{"body": "hello"}]
    await client.aclose()


def test_jira_keys_transitions_and_sites():
    assert jira_mod.keys_in("SHOP-12 Fix checkout", branch="feature/shop-14-cart") == ["SHOP-14", "SHOP-12"]
    assert jira_mod.keys_in("no key here", branch="main") == []
    rows = Recorded("jira").body("GET https://acme.atlassian.net/rest/api/3/issue/SHOP-12/transitions")["transitions"]
    assert jira_mod.pick_transition(rows, ("in progress",), "indeterminate") == "21"  # by its status's name
    assert jira_mod.pick_transition(rows, ("Nope",), "done") == "41"  # by category
    assert jira_mod.pick_transition(rows, ("Nope",), "") == ""
    assert jira_mod.clean_site("https://Acme.atlassian.net/jira/software") == "acme.atlassian.net"
    assert jira_mod.clean_site("not a site") == ""
