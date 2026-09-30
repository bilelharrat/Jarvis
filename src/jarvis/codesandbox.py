"""Jarvis Code's sandbox: which domains a project's sandboxed commands may reach (Claude
Code's sandbox network allowlist), kept per project in code_sandbox.json beside the
settings (jsonstore: whole saves swapped in, a .bak).

Read defensively: a domain that isn't one is left out, and a file that can't be read is
set aside with the lists starting over (the sandbox then lets no domain through, never
more than the owner allowed).
"""

from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import Any

from . import jsonstore

log = logging.getLogger("jarvis")

DOMAINS_PER_PROJECT = 100
PROJECTS_KEPT = 500
# A domain as the sandbox takes it: a name, or every subdomain of one ("*.example.com").
_DOMAIN = re.compile(
    r"^(?:\*\.)?[a-z0-9](?:[a-z0-9\-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9\-]{0,61}[a-z0-9])?)+$"
)
# Ready-made sets the Permissions pane offers, for what projects most often fetch.
PRESETS: dict[str, tuple[str, ...]] = {
    "npm": ("registry.npmjs.org", "*.npmjs.org", "registry.yarnpkg.com"),
    "pypi": ("pypi.org", "files.pythonhosted.org"),
    "github": ("github.com", "*.github.com", "*.githubusercontent.com"),
}


class DomainError(ValueError):
    """Why a domain can't be allowed, in words for the owner."""


def clean_domain(text: str) -> str:
    """A domain as it's kept (lower case, no scheme, path or port); DomainError when it
    isn't one."""
    raw = str(text or "").strip().lower()
    raw = re.sub(r"^[a-z][a-z0-9+.\-]*://", "", raw)  # a pasted address: its host
    raw = raw.split("/", 1)[0].split("?", 1)[0].rsplit("@", 1)[-1]
    raw = re.sub(r":\d+$", "", raw).rstrip(".")
    if not raw:
        raise DomainError("Type a domain, like registry.npmjs.org.")
    if not _DOMAIN.match(raw) or len(raw) > 253:
        raise DomainError(f"“{text.strip()[:80]}” isn't a domain.")
    return raw


class SandboxBook:
    """The allowlists per project folder (path None: in memory)."""

    def __init__(self, path: Path | None = None) -> None:
        self.path = path
        self.projects: dict[str, list[str]] = {}
        self.unreadable = ""
        if path is None:
            return
        try:
            data = jsonstore.load_json(path, dict) or {}
        except jsonstore.Unreadable as exc:
            self.unreadable = exc.strerror or "it can't be read"
            log.warning("Jarvis Code sandbox: %s can't be read (%s)", path.name, exc)
            return
        projects = data.get("projects")
        items = list(projects.items()) if isinstance(projects, dict) else []
        for project, raw in items[:PROJECTS_KEPT]:
            if not isinstance(project, str) or not isinstance(raw, dict):
                continue
            domains = raw.get("domains")
            kept: list[str] = []
            for domain in domains if isinstance(domains, list) else []:
                try:
                    found = clean_domain(domain) if isinstance(domain, str) else ""
                except DomainError:
                    continue
                if found and found not in kept:
                    kept.append(found)
            if kept:
                self.projects[project] = kept[:DOMAINS_PER_PROJECT]

    def domains(self, project: str) -> list[str]:
        return list(self.projects.get(project, []))

    def add(self, project: str, domains: list[str]) -> list[str]:
        """Allow domains for a project (DomainError for one that isn't a domain, and then
        none is added): those that were new."""
        cleaned = [clean_domain(d) for d in domains]
        have = self.projects.setdefault(project, [])
        new = [d for d in dict.fromkeys(cleaned) if d not in have]
        if len(have) + len(new) > DOMAINS_PER_PROJECT:
            if not have:
                del self.projects[project]
            raise DomainError("That's as many domains as one project can allow.")
        have.extend(new)
        if not have:
            del self.projects[project]
        if new:
            self.save()
        return new

    def remove(self, project: str, domain: str) -> bool:
        have = self.projects.get(project)
        if not have or domain not in have:
            return False
        have.remove(domain)
        if not have:
            del self.projects[project]
        self.save()
        return True

    def save(self) -> None:
        if self.path is None:
            return
        if self.unreadable:
            raise jsonstore.refusal(self.path, self.unreadable)
        data: dict[str, Any] = {"projects": {p: {"domains": d} for p, d in self.projects.items()}}
        jsonstore.save_json(self.path, data)
