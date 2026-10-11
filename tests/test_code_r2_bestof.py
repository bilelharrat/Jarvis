# ruff: noqa: F811  (the fixtures are shared with test_code_pr / test_code_bestof)
"""Round-2 sweep fix CB2-7 (askeden/docs/bug-sweep/r2-eden-code-git.md): best of N keeps
exactly one variant, however many Keep cards were up and answered."""

import asyncio

from test_code_bestof import hub, latest, projects, until  # noqa: F401  (fixtures)
from test_code_changes import make_repo


async def two_done(hub):
    async def judge(prompt, **kw):
        return "Both fine."

    hub.code_bestof.ai = judge
    said = hub.code_bestof.start(
        {
            "directory": "proj",
            "prompt": "write the answer",
            "variants": [{"model": "sonnet"}, {"model": "opus"}],
        }
    )
    assert said == ""
    assert await until(lambda: latest(hub) and latest(hub)["status"] == "done")
    group = latest(hub)
    # The second variant's work is in another file: both could land without a conflict.
    second = hub.code_desk.store().find(group["variants"][1]["slug"])
    (second.cwd / "answer.txt").unlink()
    (second.cwd / "other.txt").write_text("variant two's work\n")
    return group


async def test_two_keeps_answered_together_land_one_variant(hub, projects):
    repo = make_repo(projects / "proj", {"a.py": "x = 1\n"})
    group = await two_done(hub)
    hub.answers = ["keep", "keep"]
    said = await asyncio.gather(
        hub.code_bestof.keep(group["group"], 1), hub.code_bestof.keep(group["group"], 2)
    )
    landed = [s for s in said if s.startswith("Kept")]
    assert len(landed) == 1, said
    assert (repo / "answer.txt").exists() != (repo / "other.txt").exists()
    final = latest(hub)
    kept = final["kept"]
    assert final["status"] == "kept" and landed[0].startswith(
        f"Kept {final['variants'][kept - 1]['label']}"
    )


async def test_a_keep_card_answered_after_another_kept_is_refused(hub, projects):
    repo = make_repo(projects / "proj", {"a.py": "x = 1\n"})
    group = await two_done(hub)
    waiting = asyncio.ensure_future(hub.code_bestof.keep(group["group"], 2))
    assert await until(lambda: len(hub.cards) == 1)
    hub.answers = ["keep"]
    first = await hub.code_bestof.keep(group["group"], 1)
    assert first.startswith("Kept") and (repo / "answer.txt").exists()
    hub.resolve(hub.cards[0]["id"], "keep")  # the first card, still up, answered now
    assert await waiting == "That comparison isn't there any more."
    assert not (repo / "other.txt").exists() and latest(hub)["kept"] == 1
