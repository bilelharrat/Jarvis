"""Starts an MCP server brought over from another coding tool with its keys (code_import).

Claude Code starts it as `python -I import_mcp_launch.py <code-import.json> <server name>`:
this reads the server's command from Eden's import ledger, its keys from the Keychain (the
entries code_import made when the owner ticked "bring its keys"), and runs the server in
their place with the keys in its environment. So a key is never in a file, a setting, a
command line (Claude Code's own --mcp-config is one) or the window: only this process and
the server have it.

Run isolated (-I) and standalone: it imports nothing of JARVIS's, only keyring (the
Keychain), so the session's folder can't put a module of its own in the way.

Cost policy: nothing here calls a model.
"""

from __future__ import annotations

import json
import os
import sys

SERVICE = "Jarvis connectors"  # connectors.SERVICE
PREFIX = "code-import:"  # code_import.VAULT_PREFIX


def spec_of(ledger: dict, name: str) -> dict | None:
    for entry in (ledger.get("sources") or {}).values():
        kept = (entry.get("mcp") or {}).get(name) if isinstance(entry, dict) else None
        if isinstance(kept, dict) and isinstance(kept.get("spec"), dict):
            return kept
    return None


def environment(kept: dict, get) -> dict[str, str]:
    """The server's environment: this one, its plain variables, and each key it has."""
    env = dict(os.environ)
    for k, v in (kept["spec"].get("env") or {}).items():
        env[str(k)] = str(v)
    for key in kept.get("keys") or []:
        value = get(f"{PREFIX}{kept['name']}:{key}")
        if value:
            env[str(key)] = value
    return env


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print("usage: import_mcp_launch.py <ledger> <server>", file=sys.stderr)
        return 2
    try:
        with open(argv[1], encoding="utf-8") as handle:
            ledger = json.load(handle)
    except (OSError, ValueError):
        print("Eden Code: couldn't read the imported servers.", file=sys.stderr)
        return 1
    kept = spec_of(ledger, argv[2])
    if kept is None or kept["spec"].get("type") != "stdio":
        print(f"Eden Code: no imported server called {argv[2]}.", file=sys.stderr)
        return 1
    kept = {**kept, "name": argv[2]}
    import keyring

    env = environment(kept, lambda account: keyring.get_password(SERVICE, account))
    command = str(kept["spec"]["command"])
    args = [str(a) for a in kept["spec"].get("args") or []]
    try:
        os.execvpe(command, [command, *args], env)
    except OSError as exc:
        print(f"Eden Code: couldn't start {command}: {exc.strerror}", file=sys.stderr)
        return 1
    return 0  # (never reached: exec replaced this process)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
