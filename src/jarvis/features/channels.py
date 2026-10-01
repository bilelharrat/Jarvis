"""Chats: talking to JARVIS from Telegram, iMessage, WhatsApp, Signal, Slack and Discord
(jarvis.channels).

This registers the channels' settings (each one off until it's connected: its kill switch,
what heads-ups it forwards, whether approval cards follow the owner there, whether it
answers in group chats), the window's Settings › Chats commands, the heads-up and
approval-card sinks, the stream sink that follows a chat's request for its progress message,
the hook that keeps a group's request to the tools that group allows, the loop that runs the
connected channels, and the brain's send_file_to_chat.

Cost: a message from the owner is one normal JARVIS turn, the same as typing it in the
window. The channels make no model calls of their own (voice notes are transcribed on this
Mac by JARVIS's Whisper model), and nothing here calls a model in the background.
"""

from __future__ import annotations

from typing import Any

from .. import prefs
from ..channels.router import FORWARD_MODES, LABELS, ORDER, SERVER, Channels

COMMANDS = (
    "channels_status",
    "channels_connect",
    "channels_pair",
    "channels_unpair",
    "channels_disconnect",
    "channels_chats",
    "channels_imessage",
    "channels_group",
    "channels_signal",
)


def _forward(value: Any) -> str | None:
    return value if value in FORWARD_MODES else None


for _name in ORDER:
    prefs.register_feature_pref(f"channels_{_name}_on", False)
    prefs.register_feature_pref(f"channels_{_name}_forward", "urgent", _forward)
    prefs.register_feature_pref(f"channels_{_name}_approvals", True)
    prefs.register_feature_pref(f"channels_{_name}_groups", False)


def install(hub: Any) -> None:
    router = Channels(hub)
    hub.chat_channels = router
    hub.register_server(SERVER, router.build_server, prompt=router.prompt, labels=LABELS)
    for kind in COMMANDS:
        hub.register_command(kind, router.command)
    hub.add_notify_sink(router.heads_up)
    hub.add_approval_sink(router.card_up, resolved=router.card_down)
    hub.add_message_sink(router.stream)
    hub.add_connect_hook(router.on_connect)
    hub.register_loop("channels", router.supervise)
