"""Talking to JARVIS from a chat app: Telegram.

The owner writes to JARVIS from their phone and the request joins the one main
conversation, as a silent turn (nothing is said on the Mac); the reply goes back to the chat
it came from. Heads-ups and approval cards can follow them there too.

Who counts as the owner:

- Telegram is paired: the Mac shows a one-time code (ten minutes), the owner sends
  "/pair <code>" to the bot in a direct message, and that account is bound.
  Wrong codes are rate-limited per sender and spend the code after enough of them. Anyone
  else who writes gets at most one polite refusal a day (and only so many an hour).

A message from the owner is their own words, so it goes through exactly the gates a spoken
request does: nothing is let through because it came from a chat. Everything else in a chat
(someone else's message, a forwarded one, a file) is data, never instructions: forwarded
words are passed as quoted data in a turn that isn't the owner's, and attachments count as
the owner's private data for the turn gate.

Tokens live in the Keychain only (the connectors' vault). channels.json, beside the
settings, keeps who each chat is paired with, where each one got to, and a short audit log
of who wrote and what kind of thing happened, never what anyone wrote.

Cost: a message from the owner is one normal JARVIS turn, the same as typing it in the
window. The channels make no model calls of their own: voice notes are transcribed on this
Mac by the Whisper model JARVIS already uses, and nothing here calls a model in the
background.
"""

from .router import Channels

__all__ = ["Channels"]
