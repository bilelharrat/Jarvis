"""Files that may go out with an email or a text: only ones JARVIS made for the owner (a
document it wrote, an invoice it issued, a research report), or ones the owner named in
their own words this request ("attach budget 2026", a path they typed). Nothing else on the
Mac rides along, whatever an email, a page or Claude asks for, and credentials never do.

The Send card always lists every file with its size before anything goes.
"""

from __future__ import annotations

import os
import re
from collections.abc import Iterable
from pathlib import Path
from typing import Any

MAX_FILES = 10
EMAIL_EACH = 20_000_000  # what mail servers take in one message, near enough
EMAIL_TOTAL = 20_000_000
TEXT_EACH = 100_000_000  # iMessage's own limit
TEXT_TOTAL = 100_000_000


def _plain(text: str) -> str:
    """Lower case, with the _ - . + between a file name's words read as spaces."""
    return " ".join(re.sub(r"[_\-.+]+", " ", str(text or "").casefold()).split())


def named_in(words: str, path: Path) -> bool:
    """The owner's own words name this file: its name (with or without the extension, the
    _ - . between words as spaces) or its whole path. A name must be a few letters long,
    so "a.pdf" is never "named" by any sentence with an "a" in it."""
    said = _plain(words)
    if not said:
        return False
    home = str(Path.home())
    forms = {path.name, path.stem, str(path)}
    if str(path).startswith(home):
        forms.add("~" + str(path)[len(home) :])
    for form in forms:
        wanted = _plain(form)
        if len(wanted) < 3 or not (re.search(r"[a-z]", wanted) or len(wanted) >= 6):
            continue
        if re.search(rf"(?<![a-z0-9]){re.escape(wanted)}(?![a-z0-9])", said):
            return True
    return False


def size_words(n: int) -> str:
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f} MB".replace(".0 MB", " MB")
    return f"{max(1, n // 1000)} KB"


def describe(files: list[Path]) -> str:
    """ "plan.pdf (1.2 MB), budget.xlsx (48 KB)" for a card."""
    parts = []
    for f in files:
        try:
            parts.append(f"{f.name} ({size_words(f.stat().st_size)})")
        except OSError:
            parts.append(f.name)
    return ", ".join(parts)


def check(
    values: Iterable[Any],
    *,
    made: list[Any],
    words: str,
    each: int = EMAIL_EACH,
    total: int = EMAIL_TOTAL,
) -> tuple[list[Path], str]:
    """The files these values mean, when every one may go: (paths, ""), or ([], why not).
    made: what JARVIS made (channels.media.Made: path, title); words: the owner's own words
    this request. A value is a path, or the title or name of a file JARVIS made."""
    from .channels.media import find_made
    from .computer import is_sensitive
    from .private_folders import is_private
    from .private_folders import refusal as is_private_refusal

    wanted = [" ".join(str(v).split()) for v in values if str(v).strip()]
    if not wanted:
        return [], ""
    if len(wanted) > MAX_FILES:
        return [], f"That's {len(wanted)} files; at most {MAX_FILES} can go at once."
    home = Path.home().resolve()
    ours = {str(Path(m.path).resolve()) for m in made}
    found: list[Path] = []
    for value in wanted:
        path: Path | None = None
        looks_like_path = (
            value.startswith(("/", "~"))
            or "/" in value
            or "\\" in value
            or bool(re.match(r"[A-Za-z]:", value))
        )  # (a Windows path has a drive and backslashes)
        if looks_like_path:
            try:
                path = Path(value).expanduser().resolve()
            except (OSError, RuntimeError, ValueError):
                path = None
        if path is None or not path.is_file():
            if looks_like_path:
                return [], f"There's no file at {value}."
            hits = find_made(made, value)
            if len(hits) > 1:
                names = "; ".join(h.path.name for h in hits[:6])
                return [], f"Several files I made fit “{value}”: {names}. Which one?"
            if not hits:
                return [], (
                    f"I can't find a file called “{value}”. Give its path (find_files finds "
                    "it), or name one I made."
                )
            path = Path(hits[0].path).resolve()
        if is_private(path):  # local only: a private folder's files never leave the computer
            return [], is_private_refusal(path)
        if home not in path.parents or is_sensitive(path):
            return (
                [],
                f"{path.name} can't be sent: it's outside your home folder or holds credentials.",
            )
        if str(path) not in ours and not named_in(words, path):
            return [], (
                f"I can only attach files I made for you, or ones you name yourself. You didn't "
                f"name {path.name}: ask the user to say which file to attach."
            )
        if path not in found:
            found.append(path)
    sizes = []
    for path in found:
        try:
            sizes.append(os.stat(path).st_size)
        except OSError:
            return [], f"{path.name} can't be read."
    for path, size in zip(found, sizes, strict=True):
        if size > each:
            return [], f"{path.name} is {size_words(size)}; at most {size_words(each)} can go."
    if sum(sizes) > total:
        return [], f"Together the files are {size_words(sum(sizes))}; at most {size_words(total)}."
    return found, ""
