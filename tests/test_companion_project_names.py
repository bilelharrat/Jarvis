"""companion/project.yml keeps the Eden names the owner sees on the iPhone and Watch.

XcodeGen writes every target's Info.plist from the `info: properties:` in project.yml, so a
name fixed only in a plist comes back as "J.A.R.V.I.S." the next time someone runs
`xcodegen generate`. That happened after the J.A.R.V.I.S. -> Eden rename (2026-10-09, Eden
Secretary 2026-10-12): the plists said Eden, project.yml still said Jarvis.

Two checks:
- no user-visible value in project.yml (display names, Siri's alternative names, every
  permission prompt) says J.A.R.V.I.S. / JARVIS / Jarvis. Internal identifiers (bundle ids,
  app groups, the _jarvis._tcp Bonjour type, URL schemes, target names) keep "jarvis" on
  purpose and are not looked at.
- every committed Info.plist already holds what project.yml would write, so regenerating the
  project changes nothing the owner would see.

Cost policy: no model calls; reads two kinds of local files.
"""

import plistlib
import re
from pathlib import Path

import pytest
import yaml

COMPANION = Path(__file__).resolve().parent.parent / "companion"
OLD_NAME = re.compile(r"J\.A\.R\.V\.I\.S\.|jarvis", re.IGNORECASE)
# Keys whose values the owner reads on screen (Home Screen, Settings, Siri, permission alerts).
VISIBLE_KEY = re.compile(r"^(CFBundleDisplayName|CFBundleName|INAlternativeAppName|NS\w+UsageDescription)$")


def _project():
    return yaml.safe_load((COMPANION / "project.yml").read_text(encoding="utf-8"))


def _targets_with_info():
    for name, target in _project()["targets"].items():
        info = target.get("info")
        if info and info.get("properties"):
            yield name, info


def _visible_values(node, path=""):
    """Yields (key path, value) for every user-visible string anywhere in a properties tree."""
    if isinstance(node, dict):
        for key, value in node.items():
            if isinstance(value, str) and VISIBLE_KEY.match(key):
                yield f"{path}{key}", value
            else:
                yield from _visible_values(value, f"{path}{key}.")
    elif isinstance(node, list):
        for i, item in enumerate(node):
            yield from _visible_values(item, f"{path}{i}.")


def test_project_yml_has_targets_with_info():
    names = [name for name, _ in _targets_with_info()]
    assert "JarvisCompanion" in names and "EdenCode" in names


@pytest.mark.parametrize("target,info", list(_targets_with_info()), ids=lambda v: v if isinstance(v, str) else "")
def test_no_jarvis_wording_in_visible_values(target, info):
    leftovers = [f"{key}: {value}" for key, value in _visible_values(info["properties"]) if OLD_NAME.search(value)]
    assert not leftovers, f"{target} still shows the old name: {leftovers}"


@pytest.mark.parametrize("target,info", list(_targets_with_info()), ids=lambda v: v if isinstance(v, str) else "")
def test_committed_plist_matches_project_yml(target, info):
    plist = plistlib.loads((COMPANION / info["path"]).read_bytes())
    drift = {k: (v, plist.get(k)) for k, v in info["properties"].items() if plist.get(k) != v}
    assert not drift, f"{target}: {info['path']} differs from project.yml (yml, plist): {drift}"


def test_old_name_detector_catches_the_old_wording():
    old = {"CFBundleDisplayName": "J.A.R.V.I.S.", "X": [{"INAlternativeAppName": "Jarvis"}],
           "NSMicrophoneUsageDescription": "Listens for “Hey Jarvis”.", "CFBundleURLName": "com.askeden.jarvis.open"}
    hits = [key for key, value in _visible_values(old) if OLD_NAME.search(value)]
    assert hits == ["CFBundleDisplayName", "X.0.INAlternativeAppName", "NSMicrophoneUsageDescription"]
