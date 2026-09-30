"""What someone other than the owner shouldn't be shown: the window asks (newuser_state) and
hears {"bsh_desk", "packaged"} (a "newuser" event). The BSH research desk is the owner's
own: without its folder (settings.bsh_dir, which the app people download leaves unset) its
tools and second-brain source are off already, and the window then also leaves out its
switch and the "How's the portfolio?" chip, which asks about the BSH portfolio.

Cost: no model is called.
"""

from __future__ import annotations

from typing import Any

from .. import packaged


def bsh_desk(settings: Any) -> bool:
    """Whether this Mac has the owner's research desk: its folder, with its server in it."""
    folder = getattr(settings, "bsh_dir", None)
    try:
        return folder is not None and (folder / "scripts" / "bsh_mcp.py").is_file()
    except OSError:
        return False


def install(hub: Any) -> None:
    async def state(_msg: dict[str, Any] | None = None) -> None:
        hub.emit("newuser", bsh_desk=bsh_desk(hub.settings), packaged=packaged.is_packaged())

    hub.register_command("newuser_state", state)
