"""The jarvis command line (cli.py)."""


def test_a_qr_code_draws_dark_on_white_two_rows_a_line():
    from jarvis.cli import qr_text

    text = qr_text([[True, False], [False, True]], quiet=1)
    lines = text.split("\n")
    assert len(lines) == 2  # 2 modules and a quiet row each side, two rows a line
    assert all(line.startswith("\x1b[30;47m") and line.endswith("\x1b[0m") for line in lines)
    assert "▀" in lines[0] or "▄" in lines[0] or "█" in lines[0] or "▀" in lines[1]


def test_the_command_line_imports_no_agent_sdk_until_a_command_needs_it():
    """`jarvis mcp` is started by Claude Code and Claude Desktop for each session: the
    command line itself imports neither the Agent SDK nor the brain or the voice."""
    import subprocess
    import sys

    probe = (
        "import sys, jarvis.cli\n"
        "heavy = [m for m in ('claude_agent_sdk', 'jarvis.brain', 'jarvis.speech', 'jarvis.hub')"
        " if m in sys.modules]\n"
        "print(','.join(heavy))"
    )
    done = subprocess.run(
        [sys.executable, "-c", probe], capture_output=True, text=True, timeout=120
    )
    assert done.returncode == 0, done.stderr
    assert done.stdout.strip() == ""


def test_the_commands_still_find_what_they_import():
    """What moved into the commands is still there to import (a typo would only show
    when the owner ran one)."""
    import ast
    import importlib
    import inspect

    from jarvis import cli

    tree = ast.parse(inspect.getsource(cli))
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module and node.module != "__future__":
            name = ("jarvis." + node.module) if node.level else node.module
            module = importlib.import_module(name)
            for alias in node.names:
                assert hasattr(module, alias.name), (name, alias.name)
