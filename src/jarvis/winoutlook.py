"""The calendar in Outlook for Windows (the desktop program), read through Outlook's own "save calendar
as iCalendar" (the same thing File > Save Calendar does), so that every repeat, change and cancellation
comes out as the one reader (ics.py) already understands, and no date-format guessing is needed.

- Read only. New events go on Jarvis's own calendar, never into Outlook.
- Only while Outlook is open: Jarvis attaches to the running program (it never starts Outlook, which could
  stop at a sign-in or a profile question nobody is there to answer). With Outlook shut, the last copy
  read is still used, and Settings says so.
- Only the classic Outlook program has this (the "new Outlook" is a web app with no way in), and
  only when the person turns it on in Settings > Calendars. Private appointments come out as "Private
  appointment", without their details.
"""

from __future__ import annotations

import contextlib
import gc
import logging
import subprocess
import sys
from datetime import datetime
from pathlib import Path

log = logging.getLogger("jarvis")

OL_FOLDER_CALENDAR = 9
OL_FULL_DETAILS = 2
EXPORT_SECONDS = 60  # what Outlook is given to save the calendar before it is left (a dialog on screen can hold it)


class OutlookError(RuntimeError):
    """What went wrong with Outlook, in words for the owner."""


class Outlook:
    def available(self) -> bool:
        """Whether the classic Outlook program is installed (it registers itself as Outlook.Application)."""
        if sys.platform != "win32":
            return False
        try:
            import winreg

            with winreg.OpenKey(winreg.HKEY_CLASSES_ROOT, r"Outlook.Application\CLSID"):
                return True
        except OSError:
            return False

    def running(self) -> bool:
        try:
            import psutil

            return any(
                (p.info["name"] or "").lower() == "outlook.exe"
                for p in psutil.process_iter(["name"])
            )
        except Exception:  # noqa: BLE001 - not knowing is "not running"
            return False

    def export(self, path: Path, start: datetime, end: datetime) -> None:
        """Save the calendar from start to end as an .ics file at path (give it a name ending in .ics, as
        Outlook expects). OutlookError says why not. It is done in a process of its own, which is ended if
        Outlook doesn't answer: a dialog open in Outlook can hold such a call for good."""
        if sys.platform != "win32":
            raise OutlookError("Outlook is only on a PC.")
        argv = [
            sys.executable,
            "-I",
            "-m",
            "jarvis.winoutlook",
            "export",
            str(path),
            start.isoformat(),
            end.isoformat(),
        ]
        try:
            done = subprocess.run(
                argv,
                capture_output=True,
                text=True,
                timeout=EXPORT_SECONDS,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            raise OutlookError(
                "Outlook didn't answer in time (it may be asking something on screen)."
            ) from exc
        except OSError as exc:
            raise OutlookError("Outlook's calendar couldn't be asked for just now.") from exc
        if done.returncode != 0:
            said = (done.stdout or "").strip().splitlines()
            raise OutlookError(said[-1] if said else "Outlook wouldn't give its calendar.")


def export_here(path: Path, start: datetime, end: datetime) -> None:
    """The saving itself, in this process (see Outlook.export). OutlookError says why not."""
    import pythoncom
    import win32com.client

    pythoncom.CoInitialize()  # (COM is per thread)
    app = folder = exporter = None
    try:
        try:
            app = win32com.client.GetActiveObject("Outlook.Application")
        except pythoncom.com_error as exc:
            raise OutlookError("Outlook isn't open.") from exc
        try:
            folder = app.GetNamespace("MAPI").GetDefaultFolder(OL_FOLDER_CALENDAR)
            exporter = folder.GetCalendarExporter()
            exporter.CalendarDetail = OL_FULL_DETAILS
            exporter.IncludeAttachments = False
            exporter.IncludePrivateDetails = False
            exporter.RestrictToWorkingHours = False
            exporter.IncludeWholeCalendar = False
            exporter.StartDate = start
            exporter.EndDate = end
            path.parent.mkdir(parents=True, exist_ok=True)
            exporter.SaveAsICal(str(path))
        except pythoncom.com_error as exc:
            log.info("outlook export: %s", exc)
            raise OutlookError(
                "Outlook wouldn't give its calendar (it may be asking something on screen)."
            ) from exc
    finally:
        app = folder = exporter = (
            None  # (let go of Outlook's objects before COM is shut down on this thread)
        )
        gc.collect()
        with contextlib.suppress(Exception):
            pythoncom.CoUninitialize()


def main(argv: list[str]) -> int:
    """python -m jarvis.winoutlook export <path> <start> <end>: the words of what went wrong go to stdout."""
    if len(argv) == 4 and argv[0] == "export":
        try:
            export_here(
                Path(argv[1]), datetime.fromisoformat(argv[2]), datetime.fromisoformat(argv[3])
            )
        except OutlookError as exc:
            print(str(exc))
            return 1
        except Exception as exc:  # noqa: BLE001
            print(f"Outlook's calendar couldn't be read ({type(exc).__name__}).")
            return 1
        return 0
    print("usage: python -m jarvis.winoutlook export <path> <start> <end>")
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
