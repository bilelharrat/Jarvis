"""The privacy permissions macOS gives the app running JARVIS, read without ever asking.

A short helper, like calendar_kit.py and maps.py, run from the backend:

    python -m jarvis.features.ops.tcc [bundle id to check Automation for …]

It prints one JSON object, one answer per permission:

    granted | denied | not_asked | restricted | limited | off | not_running | unknown

Each is read with the call macOS offers for exactly this, none of which shows a prompt:
the status class methods of AVFoundation, Contacts, EventKit and CoreLocation, Quartz's
screen-capture preflight, AXIsProcessTrusted for Accessibility, a look at Messages' and
Mail's folders for Full Disk Access (no API says it; the folders are only opened, never
read), and AEDeterminePermissionToAutomateTarget with askUserIfNeeded false for
Automation. "off" is a switch that isn't on, where macOS doesn't say whether it was ever
asked; "not_running" means the app to automate isn't open, so macOS can't say. It runs
apart from the backend: a framework that misbehaves takes only this process down.
"""

from __future__ import annotations

import ctypes
import json
import os
import sys
from pathlib import Path
from typing import Any

AUTOMATION_APPS = ("com.apple.mail", "com.apple.iCal", "com.apple.Notes", "com.apple.Music")
_STATUS = {0: "not_asked", 1: "restricted", 2: "denied", 3: "granted"}


def _framework(name: str) -> dict[str, Any]:
    import objc

    found: dict[str, Any] = {}
    objc.loadBundle(name, found, bundle_path=f"/System/Library/Frameworks/{name}.framework")
    return found


def microphone() -> str:
    device = _framework("AVFoundation")["AVCaptureDevice"]
    return _STATUS.get(int(device.authorizationStatusForMediaType_("soun")), "unknown")


def contacts() -> str:
    store = _framework("Contacts")["CNContactStore"]
    status = int(store.authorizationStatusForEntityType_(0))  # CNEntityTypeContacts
    return "limited" if status == 4 else _STATUS.get(status, "unknown")


def calendars() -> str:
    import EventKit

    status = int(EventKit.EKEventStore.authorizationStatusForEntityType_(0))  # events
    return "limited" if status == 4 else _STATUS.get(status, "unknown")  # 4: write-only


def location() -> str:
    import CoreLocation

    if not CoreLocation.CLLocationManager.locationServicesEnabled():
        return "off"  # Location Services are off for the whole Mac
    status = int(CoreLocation.CLLocationManager.alloc().init().authorizationStatus())
    return "granted" if status in (3, 4) else _STATUS.get(status, "unknown")


def screen() -> str:
    import Quartz

    return "granted" if Quartz.CGPreflightScreenCaptureAccess() else "off"


def accessibility() -> str:
    services = ctypes.cdll.LoadLibrary(
        "/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices"
    )
    services.AXIsProcessTrusted.restype = ctypes.c_bool
    return "granted" if services.AXIsProcessTrusted() else "off"


def full_disk(home: Path | None = None) -> str:
    """Only Full Disk Access opens these (the first that's there decides)."""
    home = home or Path.home()
    for place in (home / "Library" / "Messages", home / "Library" / "Mail"):
        try:
            os.scandir(place).close()
        except FileNotFoundError:
            continue
        except PermissionError:
            return "off"
        except OSError:
            continue
        return "granted"
    return "unknown"


class _AEDesc(ctypes.Structure):
    _pack_ = 2  # AEDataModel.h: #pragma pack(push, 2)
    _fields_ = [("descriptorType", ctypes.c_uint32), ("dataHandle", ctypes.c_void_p)]


def _code(text: str) -> int:
    return int.from_bytes(text.encode("ascii"), "big")


def automation(bundle_id: str) -> str:
    core = ctypes.cdll.LoadLibrary("/System/Library/Frameworks/CoreServices.framework/CoreServices")
    core.AECreateDesc.argtypes = [
        ctypes.c_uint32,
        ctypes.c_void_p,
        ctypes.c_long,
        ctypes.POINTER(_AEDesc),
    ]
    core.AECreateDesc.restype = ctypes.c_int16
    core.AEDisposeDesc.argtypes = [ctypes.POINTER(_AEDesc)]
    core.AEDeterminePermissionToAutomateTarget.argtypes = [
        ctypes.POINTER(_AEDesc),
        ctypes.c_uint32,
        ctypes.c_uint32,
        ctypes.c_ubyte,
    ]
    core.AEDeterminePermissionToAutomateTarget.restype = ctypes.c_int32
    raw = bundle_id.encode("utf-8")
    target = _AEDesc()
    if core.AECreateDesc(_code("bund"), raw, len(raw), ctypes.byref(target)) != 0:
        return "unknown"
    try:
        wild = _code("****")
        status = core.AEDeterminePermissionToAutomateTarget(ctypes.byref(target), wild, wild, 0)
    finally:
        core.AEDisposeDesc(ctypes.byref(target))
    return {0: "granted", -1743: "denied", -1744: "not_asked", -600: "not_running"}.get(
        int(status), "unknown"
    )


CHECKS = {
    "microphone": microphone,
    "calendars": calendars,
    "contacts": contacts,
    "location": location,
    "screen": screen,
    "accessibility": accessibility,
    "full_disk": full_disk,
}


def _safely(check) -> str:
    try:
        return check()
    except Exception:  # a framework missing or changed: said honestly
        return "unknown"


def main(argv: list[str] | None = None) -> None:
    apps = [a for a in (argv if argv is not None else sys.argv[1:]) if a][:8] or list(
        AUTOMATION_APPS
    )
    out: dict[str, Any] = {name: _safely(check) for name, check in CHECKS.items()}
    out["automation"] = {app: _safely(lambda app=app: automation(app)) for app in apps}
    print(json.dumps(out), flush=True)


if __name__ == "__main__":
    main()
