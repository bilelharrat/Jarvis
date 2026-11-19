"""Someone else's words (a GitHub issue, a review comment, a CI log, a Linear ticket, a Slack
message) put into a session's prompt as data: the one place code_prs and the triggers
(features/code_triggers.py) take them from, so both fold the same tricks.

- plain: the text as a reader (a model) sees it: compatibility forms folded (NFKC: a
  full-width ＜ is <) and the invisible characters gone (zero-width spaces and joiners, the
  word joiner, the byte order mark, the marks that turn text's direction around), so a
  closer can't hide in either.
- data: inside <tag>…</tag>, a "</tag>" (or an opener of the same tags) is written
  &lt;/tag>: the text can't close its tag and go on as the app's own words ("[Note from the
  app: …]"). Every other < stays as written: code, generics and HTML read as they are.
- attr: inside the app's own words (an attribute, a note's header): no quotes, angle or
  square brackets, line breaks or other control characters, at most 120 characters.

Standard library only.
"""

from __future__ import annotations

import re
import unicodedata

_INVISIBLE = re.compile("[\u00ad\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]")
_ATTR_OFF = re.compile(r'["<>\[\]\x00-\x1f\x7f\u0085\u2028\u2029]')
ATTR_MAX = 120


def plain(text: object) -> str:
    return _INVISIBLE.sub("", unicodedata.normalize("NFKC", str(text)))


def data(text: object, *tags: str) -> str:
    names = "|".join(re.escape(t) for t in tags)
    return re.sub(rf"<(?=\s*/?\s*(?:{names})\b)", "&lt;", plain(text), flags=re.IGNORECASE)


def attr(text: object) -> str:
    return _ATTR_OFF.sub("", plain(text))[:ATTR_MAX]
