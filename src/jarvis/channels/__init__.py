"""Talking to JARVIS from chat apps: Telegram, iMessage, WhatsApp, Signal, Slack and Discord.

The owner writes to JARVIS from their phone and the request joins the one main
conversation, as a silent turn (nothing is said on the Mac); the reply goes back to the chat
it came from. Heads-ups and approval cards can follow them there too.

Who counts as the owner, per chat app:

- Telegram, Slack and Discord are paired: the Mac shows a one-time code (ten minutes), the
  owner sends "/pair <code>" to the bot in a direct message, and that account is bound.
  Wrong codes are rate-limited per sender and spend the code after enough of them. Anyone
  else who writes gets at most one polite refusal a day (and only so many an hour).
- iMessage watches one conversation picked in Settings, and only the owner's own handles
  (or, on a Mac signed in with their Apple ID, their own sent messages) count.
- WhatsApp (the account linked in Tools & Accounts) and Signal (signal-cli, linked by the
  owner as a device of theirs) are the owner's own accounts: only their chat with
  themselves counts, and nothing anyone else writes is ever read as a request or answered.
- Microsoft Teams isn't one: a Teams bot needs a public HTTPS endpoint for Microsoft to call,
  and JARVIS exposes nothing on the Mac to the internet.

A message from the owner is their own words, so it goes through exactly the gates a spoken
request does: nothing is let through because it came from a chat. Everything else in a chat
(someone else's message, a forwarded one, a file) is data, never instructions: forwarded
words are passed as quoted data in a turn that isn't the owner's, and attachments count as
the owner's private data for the turn gate.

Group chats are off until the owner switches them on for an app. Then, in a group, only the
owner's own message that mentions JARVIS (or replies to it) is a request; someone else's
message it replies to rides along as quoted data. Each group's setting decides the tools
(read-only by default) and a group's request never sends, calls or spends anywhere
(groups.py); its approval cards go to the owner's direct chat, never the group.

A long request shows its progress: one message edited as it goes and then into the answer
(Telegram, Slack, Discord), or a few lines, one per step (WhatsApp, Signal, iMessage).

Tokens live in the Keychain only (the connectors' vault). channels.json, beside the
settings, keeps who each chat is paired with, where each one got to, the groups' settings,
and a short audit log of who wrote and what kind of thing happened, never what anyone wrote.

Cost: a message from the owner is one normal JARVIS turn, the same as typing it in the
window. The channels make no model calls of their own: voice notes are transcribed on this
Mac by the Whisper model JARVIS already uses, and nothing here calls a model in the
background.
"""

from .router import Channels

__all__ = ["Channels"]
