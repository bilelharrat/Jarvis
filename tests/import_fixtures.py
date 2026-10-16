"""A fake home folder with every coding tool's files in it, for the "Bring over from…" tests
(test_code_import.py): a small sample per tool, each with a secret somewhere, so the tests can
check what's found, that no secret ever shows, and that no file here ever changes."""

import hashlib
import json
import sqlite3
from pathlib import Path

SECRET = "sk-ant-api03-" + "Zq8xW2vR7tY1uI9oP3aS5dF6gH4jK0lM"
SECRET2 = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"
SECRET3 = "sk-proj-" + "Hy7Tg5Rf3Ed1Ws9Qa2Zx4Cv6Bn8Mm0Lk"
SECRETS = (SECRET, SECRET2, SECRET3)
SESSION = "0b6f1c2e-1a2b-4c3d-8e9f-001122334455"
APP = ("Library", "Application Support")


def _w(path: Path, text: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    return path


def _j(path: Path, data) -> Path:
    return _w(path, json.dumps(data, indent=1))


def build(home: Path) -> dict[str, Path]:
    """The fake tree; the project folders by name."""
    alpha, beta, gone = home / "code" / "alpha", home / "code" / "beta", home / "code" / "gone"
    alpha.mkdir(parents=True)
    beta.mkdir(parents=True)
    wt = alpha / ".claude" / "worktrees" / "try"
    wt.mkdir(parents=True)
    app = home.joinpath(*APP)
    # ── Claude Code ──
    c = home / ".claude"
    _w(c / "CLAUDE.md", "Always run the tests.\n")
    _j(c / "settings.json", {
        "permissions": {"allow": ["Bash(npm test)"], "deny": ["Read(.env)"], "defaultMode": "acceptEdits"},
        "hooks": {"PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "echo hi"}]}]},
        "env": {"API_TOKEN": SECRET, "PLAIN": "1"},
        "model": "sonnet",
        "outputStyle": "Explanatory",
        "statusLine": {"type": "command", "command": "echo status"},
    })  # fmt: skip
    _w(c / "keybindings.json", "[]")
    _w(c / "commands" / "review.md", "Review this.\n")
    _w(c / "agents" / "tester.md", "---\nname: tester\n---\nTest.\n")
    _w(c / "skills" / "s1" / "SKILL.md", "---\nname: s1\n---\nSkill.\n")
    rec = c / "projects" / "-Users-x-code-alpha" / f"{SESSION}.jsonl"
    _w(
        rec,
        json.dumps(
            {
                "type": "user",
                "cwd": str(alpha),
                "message": {"role": "user", "content": "add a retry"},
            }
        )
        + "\n",
    )
    _w(c / "projects" / "-Users-x-code-alpha-wt" / "1b6f1c2e-1a2b-4c3d-8e9f-001122334455.jsonl",
       json.dumps({"type": "user", "cwd": str(wt)}) + "\n")  # fmt: skip
    _j(home / ".claude.json", {
        "mcpServers": {"gh": {"type": "stdio", "command": "npx", "args": ["gh-mcp"], "env": {"GITHUB_TOKEN": SECRET2}}},
        "projects": {str(alpha): {"mcpServers": {"loc": {"command": "loc"}}}, str(gone): {}},
    })  # fmt: skip
    _j(alpha / ".mcp.json", {"mcpServers": {"team": {"command": "team-mcp"}}})
    # ── project files other tools read ──
    _w(alpha / "CLAUDE.md", "# Alpha\n")
    _w(alpha / "AGENTS.md", "Use pnpm in alpha.\n")
    _w(beta / "AGENTS.md", "Beta notes.\n")
    _w(alpha / ".cursorrules", "Cursor: prefer small functions.\n")
    _w(alpha / ".cursor" / "rules" / "style.mdc", "---\ndescription: style\n---\nTabs.\n")
    _j(
        alpha / ".cursor" / "mcp.json",
        {"mcpServers": {"alpha-db": {"command": "db-mcp", "args": ["--ro"]}}},
    )
    _w(alpha / ".windsurfrules", "Windsurf rule.\n")
    _w(alpha / ".github" / "copilot-instructions.md", "Copilot: be brief.\n")
    _w(
        alpha / ".github" / "prompts" / "release.prompt.md",
        "---\nmode: agent\n---\nCut a release.\n",
    )
    _w(alpha / "GEMINI.md", "Gemini notes.\n")
    _w(alpha / ".clinerules", "Cline rule.\n")
    _w(alpha / ".roorules", "Roo rule.\n")
    _w(alpha / ".junie" / "guidelines.md", "Junie guidelines.\n")
    _w(alpha / ".kiro" / "steering" / "product.md", "Kiro steering.\n")
    _w(alpha / ".kiro" / "specs" / "login" / "requirements.md", "Reqs.\n")
    _w(alpha / "WARP.md", "Warp rules.\n")
    _w(alpha / ".rules", "Zed rules.\n")
    _w(alpha / "CONVENTIONS.md", "Aider conventions.\n")
    _w(alpha / ".aider.chat.history.md",
       "\n# aider chat started at 2026-10-01 10:00:00\n\n#### make it faster\n\nDone, I cached it.\n")  # fmt: skip
    # ── Codex ──
    x = home / ".codex"
    _w(x / "config.toml", (
        'model = "gpt-5-codex"\n'
        f'[projects."{beta}"]\ntrust_level = "trusted"\n'
        '[model_providers.azure]\nenv_key = "AZURE_KEY"\n'
        '[mcp_servers.search]\ncommand = "search-mcp"\nargs = ["--fast"]\n'
        f'env = {{ SEARCH_API_KEY = "{SECRET3}", REGION = "eu" }}\n'
    ))  # fmt: skip
    _w(x / "AGENTS.md", "Codex: write tests first.\n")
    _w(x / "prompts" / "fix.md", "Fix the failing test: $ARGUMENTS\n")
    _w(x / "auth.json", json.dumps({"tokens": {"access_token": SECRET}}))
    _w(x / "sessions" / "2026" / "10" / "01" / "rollout-2026-10-01-abc.jsonl", "\n".join(json.dumps(line) for line in [
        {"type": "session_meta", "payload": {"id": "abc", "cwd": str(beta), "timestamp": "2026-10-01T10:00:00Z"}},
        {"type": "response_item", "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "<environment_context>x</environment_context>"}]}},
        {"type": "response_item", "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "rename the module"}]}},
        {"type": "response_item", "payload": {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "Renamed."}]}},
    ]) + "\n")  # fmt: skip
    # ── Cursor ──
    _j(
        home / ".cursor" / "mcp.json",
        {"mcpServers": {"linear": {"url": "https://mcp.linear.app/sse"}}},
    )
    _w(home / ".cursor" / "commands" / "ship.md", "Ship it.\n")
    cu = app / "Cursor" / "User"
    _j(cu / "workspaceStorage" / "w1" / "workspace.json", {"folder": alpha.as_uri()})
    db = cu / "globalStorage" / "state.vscdb"
    db.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(db)
    con.execute("CREATE TABLE ItemTable (key TEXT UNIQUE, value BLOB)")
    con.execute("CREATE TABLE cursorDiskKV (key TEXT UNIQUE, value BLOB)")
    con.execute("INSERT INTO ItemTable VALUES ('aicontext.personalContext', 'be kind')")
    con.execute("INSERT INTO cursorDiskKV VALUES (?, ?)", ("composerData:c1", json.dumps({
        "name": "Fix login", "createdAt": 1759312800000,
        "fullConversationHeadersOnly": [{"bubbleId": "b1", "type": 1}, {"bubbleId": "b2", "type": 2}]})))  # fmt: skip
    con.execute(
        "INSERT INTO cursorDiskKV VALUES (?, ?)",
        ("bubbleId:c1:b1", json.dumps({"type": 1, "text": "fix the login"})),
    )
    con.execute(
        "INSERT INTO cursorDiskKV VALUES (?, ?)",
        ("bubbleId:c1:b2", json.dumps({"type": 2, "text": "Fixed."})),
    )
    con.commit()
    con.close()
    # ── Windsurf ──
    ws = home / ".codeium" / "windsurf"
    _j(ws / "mcp_config.json", {"mcpServers": {
        "wind": {"serverUrl": "https://wind.example.com/mcp", "headers": {"Authorization": f"Bearer {SECRET}"}},
        "wind-ok": {"command": "wind-ok"},
    }})  # fmt: skip
    _w(ws / "memories" / "global_rules.md", "Windsurf global rule.\n")
    _w(ws / "global_workflows" / "deploy.md", "Deploy steps.\n")
    # ── VS Code: Copilot, Cline, Roo ──
    vc = app / "Code" / "User"
    _j(vc / "mcp.json", {"servers": {"fs": {"type": "stdio", "command": "npx", "args": ["fs-mcp"],
                                             "env": {"FS_ROOT": "/tmp", "VS_PAT": "${input:pat}"}}}})  # fmt: skip
    _w(
        vc / "settings.json",
        '{\n  // my settings\n  "editor.fontSize": 13,\n  "mcp": {"servers": {"vs-web": {"url": "https://web.example.com/mcp",}}},\n}\n',
    )
    _w(vc / "prompts" / "plan.prompt.md", "---\ndescription: plan\n---\nPlan the work.\n")
    _w(vc / "prompts" / "house.instructions.md", "House style.\n")
    _j(vc / "workspaceStorage" / "w2" / "workspace.json", {"folder": beta.as_uri()})
    _j(vc / "workspaceStorage" / "w2" / "chatSessions" / "s1.json",
       {"requests": [{"message": {"text": "explain this"}, "response": [{"value": "It sorts."}]}]})  # fmt: skip
    cl = vc / "globalStorage" / "saoudrizwan.claude-dev"
    _j(
        cl / "settings" / "cline_mcp_settings.json",
        {"mcpServers": {"cl": {"command": "cl-mcp", "disabled": True}}},
    )
    _j(cl / "tasks" / "t1" / "api_conversation_history.json",
       [{"role": "user", "content": [{"type": "text", "text": "<task>add docs</task>"}]},
        {"role": "assistant", "content": [{"type": "text", "text": "Added."}]}])  # fmt: skip
    _w(home / "Documents" / "Cline" / "Rules" / "mine.md", "Cline global rule.\n")
    roo = vc / "globalStorage" / "rooveterinaryinc.roo-cline"
    _j(roo / "settings" / "mcp_settings.json", {"mcpServers": {"roo-srv": {"command": "roo-mcp"}}})
    _w(roo / "settings" / "custom_modes.yaml", "customModes: []\n")
    # ── Gemini ──
    g = home / ".gemini"
    _j(g / "settings.json", {"mcpServers": {"gem": {"command": "gem-mcp", "env": {"GEMINI_API_KEY": SECRET}}},
                             "model": {"name": "gemini-2.5-pro"}})  # fmt: skip
    _w(g / "GEMINI.md", "Gemini global.\n")
    _w(
        g / "commands" / "git" / "commit.toml",
        'description = "commit"\nprompt = "Write a commit message."\n',
    )
    _j(g / "trustedFolders.json", {str(alpha): "TRUST_FOLDER"})
    _j(g / "tmp" / "h1" / "chats" / "session-1.json",
       {"sessionId": "g1", "messages": [{"type": "user", "content": "hello gemini"}, {"type": "gemini", "content": "Hi."}]})  # fmt: skip
    _j(g / "antigravity" / "mcp_config.json", {"mcpServers": {"anti": {"command": "anti-mcp"}}})
    # ── Aider ──
    _w(home / ".aider.conf.yml", f"model: sonnet\nopenai-api-key: {SECRET3}\n")
    # ── Zed ──
    _w(home / ".config" / "zed" / "settings.json", (
        '// Zed\n{\n  "context_servers": {\n    "zz": {"command": {"path": "zz-mcp", "args": [],'
        f' "env": {{"ZZ_TOKEN": "{SECRET2}"}}}}}}\n  }},\n'
        '  "agent": {"default_model": {"provider": "anthropic", "model": "claude-opus-5-5"}},\n}\n'
    ))  # fmt: skip
    # ── OpenCode ──
    oc = home / ".config" / "opencode"
    _j(oc / "opencode.json", {"mcp": {"oc": {"type": "local", "command": ["oc-mcp", "--x"], "environment": {"A": "b"}}},
                              "model": "anthropic/claude-sonnet-5-5",
                              "provider": {"openai": {"options": {"apiKey": SECRET3}}}})  # fmt: skip
    _w(oc / "AGENTS.md", "OpenCode global.\n")
    _w(oc / "command" / "tidy.md", "Tidy up.\n")
    # ── Continue ──
    co = home / ".continue"
    _w(co / "config.yaml", (
        "name: mine\nmodels:\n  - name: gpt\n    provider: openai\n    model: gpt-4.1\n"
        f"    apiKey: {SECRET}\nmcpServers:\n  - name: cont\n    command: cont-mcp\n"
        "rules:\n  - Be terse\n"
    ))  # fmt: skip
    _w(co / "prompts" / "explain.prompt", "---\nname: explain\n---\nExplain it.\n")
    _j(co / "sessions" / "sessions.json", [{"sessionId": "k1", "title": "Continue chat", "dateCreated": "1759312800000",
                                            "workspaceDirectory": str(alpha)}])  # fmt: skip
    _j(co / "sessions" / "k1.json", {"history": [{"message": {"role": "user", "content": "hey"}},
                                                 {"message": {"role": "assistant", "content": "Hello."}}]})  # fmt: skip
    # ── Amp ──
    _j(
        home / ".config" / "amp" / "settings.json",
        {"amp.mcpServers": {"ampy": {"command": "ampy-mcp"}}},
    )
    _w(home / ".config" / "amp" / "AGENTS.md", "Amp global.\n")
    # ── Kiro ──
    _j(
        home / ".kiro" / "settings" / "mcp.json",
        {"mcpServers": {"kiro-srv": {"command": "kiro-mcp"}}},
    )
    _w(home / ".kiro" / "steering" / "tech.md", "Kiro global steering.\n")
    # ── Warp, Junie ──
    (home / ".warp").mkdir()
    _j(home / ".junie" / "mcp" / "mcp.json", {"mcpServers": {"jj": {"command": "jj-mcp"}}})
    _w(app / "JetBrains" / "IntelliJIdea2026.1" / "options" / "recentProjects.xml",
       '<application><component name="RecentProjectsManager"><option name="additionalInfo"><map>'
       '<entry key="$USER_HOME$/code/alpha"><value/></entry></map></option></component></application>')  # fmt: skip
    return {"alpha": alpha, "beta": beta, "gone": gone, "worktree": wt}


def tree_hash(home: Path) -> dict[str, str]:
    """Every file under home and its bytes' hash (folders too, by name): what must never change."""
    out = {}
    for path in sorted(home.rglob("*")):
        rel = str(path.relative_to(home))
        if path.is_file():
            out[rel] = hashlib.sha256(path.read_bytes()).hexdigest()
        elif path.is_dir():
            out[rel] = "dir"
    return out
