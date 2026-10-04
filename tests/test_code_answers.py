"""Sessions don't wait on questions Jarvis can answer (features/code_answers.py): the
owner's earlier choices, a sure fact in memory, and while they're busy a session that
chooses for itself (never on a risky question), with a digest once they're free."""

from pathlib import Path
from types import SimpleNamespace

from jarvis.features import code_answers as ca


def asked(question, options, header="", multi=False):
    return {"question": question, "header": header, "options": options, "multi": multi}


def test_an_earlier_choice_answers_the_same_question_in_the_same_project():
    q = asked("Which package manager should I use?", ["npm", "pnpm", "yarn"])
    learned = [{"project": "web", "question": q["question"], "header": "", "answer": "pnpm"}]
    assert ca.from_choices(learned, "web", q)[0] == "pnpm"
    assert ca.from_choices(learned, "api", q) is None  # another project: theirs to say
    learned.append({"project": "web", "question": q["question"], "header": "", "answer": "npm"})
    assert ca.from_choices(learned, "web", q) is None  # answered both ways: ask
    gone = asked("Which package manager should I use?", ["npm", "yarn"])
    assert ca.from_choices(learned[:1], "web", gone) is None  # not an option now


def test_a_close_question_needs_two_matching_answers():
    q = asked("Should I add tests for the new login endpoint?", ["Yes", "No"])
    old = {"project": "web", "header": "", "answer": "Yes"}
    one = [{**old, "question": "Should I add tests for the new signup endpoint?"}]
    assert ca.from_choices(one, "web", q) is None
    two = one + [{**old, "question": "Should I add tests for the new logout endpoint?"}]
    assert ca.from_choices(two, "web", q)[0] == "Yes"


def test_a_sure_fact_naming_one_option_answers():
    q = asked("Which package manager should I use?", ["npm", "pnpm"])
    fact = SimpleNamespace(text="We use pnpm as our package manager", confidence="high")
    unsure = SimpleNamespace(text="maybe pnpm package manager", confidence="low")
    assert ca.from_memory([unsure, fact], q)[0] == "pnpm"
    both = SimpleNamespace(text="npm or pnpm, either package manager", confidence="high")
    assert ca.from_memory([both], q) is None


def test_risky_questions_always_reach_the_owner():
    assert ca.risky(asked("Force push to main?", ["Yes", "No"]))
    assert ca.risky(asked("Run the migration on production?", ["Yes", "No"]))
    assert not ca.risky(asked("Tabs or spaces?", ["Tabs", "Spaces"]))


class Hub:
    def __init__(self, tmp_path, busy):
        self.busy = busy
        self.notes = []
        self.memory = None
        self.prefs = SimpleNamespace(feature=lambda key: True)
        self.tmp = tmp_path

    def feature_path(self, name):
        return self.tmp / name

    def quiet_now(self):
        return self.busy

    def notify(self, alert, speak=True):
        self.notes.append(alert)


async def test_while_busy_a_session_chooses_for_itself_and_it_is_told_after(tmp_path):
    hub = Hub(tmp_path, busy=True)
    desk = ca.Answers(hub)
    task = SimpleNamespace(id=3, title="Refactor", prompt="", cwd=Path("/p/web"), workspace={})
    out = await desk.pre_answer(task, asked("Tabs or spaces?", ["Tabs", "Spaces"]))
    assert out[0] == "go_on" and "safest" in out[1]
    assert await desk.pre_answer(task, asked("Delete the old table?", ["Yes", "No"])) is None
    assert "Tabs or spaces?" in desk.digest() and "Tabs or spaces?" in desk.briefing_note()
    desk.answered(task, asked("Tabs or spaces?", ["Tabs", "Spaces"]), "Spaces")
    hub.busy = False
    again = await desk.pre_answer(task, asked("Tabs or spaces?", ["Tabs", "Spaces"]))
    assert again[:2] == ("answer", "Spaces")
    fresh = ca.Answers(hub)  # kept on disk
    fresh._load()
    assert fresh.learned[-1]["answer"] == "Spaces" and fresh.chosen
