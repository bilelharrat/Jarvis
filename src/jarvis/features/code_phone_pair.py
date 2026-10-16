"""Pairing the Eden Code phone apps by QR code: one scan instead of a typed address and code.

The Mac's "On your phone" pane (web/features/code_phone.js) and Settings › iPhone show a QR
code the native Eden Code apps (iPhone: companion/EdenCode; Android) read with their own
scanner, or the phone's Camera app opens through the edencode:// URL scheme. It is the same
pairing the companion has always done (remote.Devices: a one-time six-digit code, five
minutes, one pairing per code, traded at POST /api/pair for the device's own long token), and
the very same code Settings › iPhone & Watch › Pair a phone shows: minting one here shows it
there too (a "remote_code" event), and either one pairs. No second way in.

What the QR code says (docs/eden-code-phone.md, "Pairing by QR"; fixed, version 1):

  edencode://pair?v=1&code=<6 digits>&host=<the Mac's .local name>&ip=<LAN IPv4, optional>
    &port=<companion port>&fp=<SHA-256 hex of the Mac's certificate>&name=<the Mac's name>
    &ts=<Tailscale host, optional>&relay=1 (only when the askeden.com relay is up for this Mac)

Every value is percent-encoded (RFC 3986, a space is %20, never "+"); the parameters come in
that order and an optional one is left out rather than sent empty. The fingerprint is the one
the app pins before its first request (companion_tls: lowercase hex of the certificate's DER),
so the code only ever goes to the Mac that showed it; remote.py's /api/pair checks it again.
Nothing else rides in it: no token, no account id, no key. The code is spent by the first
pairing and dies after five minutes, so a photo of the screen is worth nothing later.

Window commands: code_phone_pair {fresh?: bool, peek?: bool}: peek shows the code on screen
now (if any) without making one; fresh makes a new one; neither makes one only when none is up.
Events: code_phone_pair {running, on, code, seconds, payload, qr, short, mac, paired, error}.

Cost policy (Claude): nothing here calls a model.
"""

from __future__ import annotations

import asyncio
import ipaddress
import json
import logging
import os
import re
import shutil
import subprocess
import time
from typing import Any
from urllib.parse import quote

log = logging.getLogger("jarvis")

SCHEME = "edencode"
VERSION = 1
NAME_MOST = 60  # characters of the Mac's name in the code (the phone shows it)
TAILSCALE_KEEP = 60.0  # seconds a Tailscale lookup is kept
TAILSCALE_APP = "/Applications/Tailscale.app/Contents/MacOS/Tailscale"
_HOST = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?")
_FP = re.compile(r"[0-9a-f]{64}")


def _q(value: str) -> str:
    return quote(str(value), safe="")


def pair_payload(
    *,
    code: str,
    host: str,
    port: int,
    fingerprint: str,
    name: str = "",
    ip: str = "",
    ts: str = "",
    relay: bool = False,
) -> str:
    """The QR code's text (the format above). ValueError for anything that isn't what the
    format allows, so a broken code is never drawn: the phone would refuse it anyway."""
    from ..companion_tls import normalize
    from ..textclean import clean_text

    code = str(code or "")
    if not (len(code) == 6 and code.isascii() and code.isdigit()):
        raise ValueError("the pairing code is six digits")
    host = str(host or "").strip().rstrip(".")
    if not _HOST.fullmatch(host):
        raise ValueError("this Mac has no address on the network")
    if not isinstance(port, int) or isinstance(port, bool) or not 0 < port < 65536:
        raise ValueError("the companion has no port")
    fp = normalize(fingerprint)
    if not _FP.fullmatch(fp):
        raise ValueError("the companion has no certificate")
    parts = [("v", str(VERSION)), ("code", code), ("host", host)]
    if ip:
        try:
            parts.append(("ip", str(ipaddress.IPv4Address(str(ip).strip()))))
        except ValueError:
            pass  # (an address that isn't IPv4 is left out: the host still works)
    parts += [("port", str(port)), ("fp", fp)]
    label = " ".join(clean_text(str(name or "")).split())[:NAME_MOST]
    if label:
        parts.append(("name", label))
    ts = str(ts or "").strip().rstrip(".")
    if ts and _HOST.fullmatch(ts):
        parts.append(("ts", ts))
    if relay:
        parts.append(("relay", "1"))
    return f"{SCHEME}://pair?" + "&".join(f"{k}={_q(v)}" for k, v in parts)


def _tailscale_lookup() -> str:
    """This Mac's name on the owner's tailnet (MagicDNS), else its Tailscale IPv4; "" without
    Tailscale. Its own command line, two seconds at most; never the network."""
    cli = shutil.which("tailscale") or (TAILSCALE_APP if os.path.exists(TAILSCALE_APP) else "")
    if not cli:
        return ""
    try:
        out = subprocess.run(
            [cli, "status", "--json", "--peers=false"], capture_output=True, text=True, timeout=2
        ).stdout
        me = (json.loads(out or "{}").get("Self") or {}) if out else {}
    except (OSError, subprocess.SubprocessError, ValueError, AttributeError):
        return ""
    if not isinstance(me, dict) or me.get("Online") is False:
        return ""
    dns = str(me.get("DNSName") or "").rstrip(".")
    if dns and _HOST.fullmatch(dns):
        return dns
    for address in me.get("TailscaleIPs") or []:
        try:
            if ipaddress.ip_address(str(address)).version == 4:
                return str(address)
        except ValueError:
            continue
    return ""


class PhonePair:
    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self.tailscale = _tailscale_lookup  # (the tests put their own)
        self._ts: tuple[float, str] = (0.0, "")
        self._qr: tuple[str, list[str]] = ("", [])

    async def tailscale_host(self) -> str:
        at, host = self._ts
        if time.monotonic() - at > TAILSCALE_KEEP or not at:
            try:
                host = await asyncio.to_thread(self.tailscale)
            except Exception:
                host = ""
            self._ts = (time.monotonic(), host)
        return host

    def relay_up(self) -> bool:
        """The askeden.com relay will carry this Mac's companion (account linked, relay on)."""
        desk = getattr(self.hub, "account_desk", None)
        try:
            return bool(desk is not None and desk.relay_wanted())
        except Exception:
            return False

    async def payload(self, code: str) -> str:
        from ..remote import lan_address

        remote = self.hub.remote
        identity = remote.identity
        if identity is None:
            raise ValueError("the companion has no certificate yet")
        ip = await asyncio.to_thread(lan_address)
        public = os.environ.get("JARVIS_PUBLIC_HOST", "").strip()
        host = public or (f"{remote.host_name}.local" if remote.host_name else ip)
        return pair_payload(
            code=code,
            host=host,
            port=int(remote.port or 0),
            fingerprint=identity.fingerprint,
            name=remote.mac_name or remote.host_name or "Mac",
            ip="" if public else ip,
            ts=await self.tailscale_host(),
            relay=self.relay_up(),
        )

    async def command(self, msg: dict[str, Any]) -> None:
        from .. import qr
        from ..remote import addresses
        from .code_phone import PREF

        remote = self.hub.remote
        devices = remote.devices
        reply: dict[str, Any] = {
            "running": bool(remote.running),
            "on": self.hub.prefs.feature(PREF) is True,
            "code": "",
            "seconds": 0,
            "payload": "",
            "qr": [],
            "short": getattr(remote.identity, "short", "") if remote.identity else "",
            "mac": remote.mac_name or remote.host_name or "",
            "paired": len(devices.items),
            "error": "",
        }
        if not remote.running:
            reply["error"] = "Turn on the phone companion in Settings › iPhone & Watch first."
            self.hub.emit("code_phone_pair", **reply)
            return
        live = devices.code is not None and devices.code_expires - time.monotonic() > 1
        if msg.get("fresh") is True or (not live and msg.get("peek") is not True):
            devices.start_pairing()  # (the same code Settings › iPhone & Watch shows)
            live = True
            self.hub.emit(
                "remote_code",
                code=devices.code,
                seconds=round(devices.code_expires - time.monotonic()),
                urls=addresses(remote.port),  # (as hub.py's remote_pair says it)
            )
        if not live:
            self.hub.emit("code_phone_pair", **reply)
            return
        code = devices.code or ""
        try:
            payload = await self.payload(code)
        except ValueError as exc:
            reply["error"] = f"No QR code: {exc}."
            self.hub.emit("code_phone_pair", **reply)
            return
        if self._qr[0] != payload:
            try:
                self._qr = (payload, qr.rows(await asyncio.to_thread(qr.encode, payload)))
            except Exception:
                log.warning("Eden Code pairing: no QR code", exc_info=True)
                self._qr = (payload, [])
        reply.update(
            code=code,
            seconds=max(0, round(devices.code_expires - time.monotonic())),
            payload=payload,
            qr=self._qr[1],
        )
        self.hub.emit("code_phone_pair", **reply)


def install(hub: Any) -> None:
    pair = PhonePair(hub)
    hub.code_phone_pair = pair  # (for the tests)
    hub.register_command("code_phone_pair", pair.command, slow=True)  # (a Tailscale look)
