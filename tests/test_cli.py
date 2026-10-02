"""The jarvis command line (cli.py)."""


def test_a_qr_code_draws_dark_on_white_two_rows_a_line():
    from jarvis.cli import qr_text

    text = qr_text([[True, False], [False, True]], quiet=1)
    lines = text.split("\n")
    assert len(lines) == 2  # 2 modules and a quiet row each side, two rows a line
    assert all(line.startswith("\x1b[30;47m") and line.endswith("\x1b[0m") for line in lines)
    assert "▀" in lines[0] or "▄" in lines[0] or "█" in lines[0] or "▀" in lines[1]
