"""Settings › Speaking › JARVIS (on this Mac): the offline voice's download and removal
(local_voice.py has the voice itself; speaking.py puts it to work).

Window commands: voice_local_download (every file not yet here, checked; the size is shown
in the pane before the owner presses it), voice_local_remove (the files deleted; the Mac
voice speaks again). Both answer with the usual "voice" event, whose "local" part says
whether it's set up in this build, downloaded, downloading (done/total bytes) and why it
last failed.

Cost policy: no Claude model is called. The download is one-off and only on the owner's
press.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from .. import local_voice
from . import voice as voice_feature

log = logging.getLogger("jarvis")


class OfflineVoice:
    def __init__(self, hub: Any) -> None:
        self.hub = hub

    @property
    def store(self) -> local_voice.Store:
        return local_voice.store_for(self.hub)

    def _voice(self) -> Any:
        return voice_feature.feature_for(self.hub)

    def emit(self) -> None:
        feature = self._voice()
        if feature is not None:
            feature.emit()

    async def _settle(self) -> None:
        """Speak as Settings say with the files as they are now, and show it."""
        feature = self._voice()
        if feature is not None:
            await feature.speaking.apply()
            if self.hub.poll:
                await feature.speaking.warm_local()
            await feature.status()

    async def download(self, _msg: dict[str, Any] | None = None) -> None:
        store = self.store
        if store.downloading is not None:
            return self.emit()
        if store.ready():
            return await self._settle()
        if not store.configured():
            store.error = "The offline voice isn’t set up in this build."
            self.emit()
            store.error = ""
            return None
        self.hub._spawn(self._download())
        await asyncio.sleep(0)  # (it has started: the pane shows its progress)
        self.emit()
        return None

    async def _download(self) -> None:
        await self.store.download(self.emit)
        await self._settle()
        self.store.error = ""  # shown once

    async def remove(self, _msg: dict[str, Any] | None = None) -> None:
        if self.store.downloading is None:
            await asyncio.to_thread(self.store.remove)
            log.info("offline voice: removed")
        await self._settle()


def install(hub: Any) -> None:
    offline = OfflineVoice(hub)
    hub.register_command("voice_local_download", offline.download)
    hub.register_command("voice_local_remove", offline.remove)
