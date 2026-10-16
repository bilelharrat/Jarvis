"""Eden Code on Windows, said where the owner looks (the code-windows feature): the window
asks what this computer can't do as a Mac does (code_parity {}) and, on a PC, lists it in
Eden Code settings › General, "On this PC", each with why (web/features/code-windows.js). The
facts are codeparity.py's; the whole table is docs/eden-code-windows-parity.md.

The sentences other Eden Code features say on a PC (codeparity's NO_SANDBOX, NO_SANDBOX_RUN,
NO_LINKS) get their Chinese here, so they're in the owner's language wherever they show.

Window commands: code_parity {} -> code_parity {os, features: [{id, name, state, why}]}.

Cost policy: nothing here calls a model.
"""

from __future__ import annotations

from typing import Any

from .. import codeparity, lang

lang.add_texts(
    {
        codeparity.NO_SANDBOX: "Claude Code 的沙盒在 Windows 上不可用（它基于 macOS 和 Linux 自带的机制），"
        "所以开启沙盒开关后，绕过权限或无人值守会话的每条命令都会先问你。",
        codeparity.NO_SANDBOX_RUN: "这次运行的命令必须在 Claude Code 的沙盒里执行，而沙盒在 Windows 上不可用，"
        "所以没有开始。可以为这个仓库关闭沙盒后再运行（命令仍只限于这次运行自己的列表），或者在 Mac 上运行。",
        codeparity.NO_LINKS: "{name} 没有链接：Windows 只在开启开发者模式时才允许应用创建链接"
        "（设置 › 系统 › 开发者选项）。请在副本里安装它的依赖。",
    }
)


def install(hub: Any) -> None:
    def cmd_parity(_msg: dict[str, Any]) -> None:
        hub.emit("code_parity", **codeparity.report())

    hub.register_command("code_parity", cmd_parity)
