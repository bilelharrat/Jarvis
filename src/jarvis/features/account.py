"""The Jarvis account's feature module: Settings › Account, the link with the owner's
iPhone, and what a linked Mac does with it (docs/accounts.md). jarvis.account is the client,
jarvis.relay the encrypted relay, jarvis.account_sync the sync; push.py, claude_signin.py
and speaking.py use the account when it's there.

Settings it keeps (prefs.features):
- account_relay: reach this Mac through the account from anywhere (on unless turned off).
- account_plus_ai: Jarvis Plus answers instead of the Claude sign-in or an API key. Off
  unless chosen; a linked Mac with no other way in to Claude uses it anyway.
- account_server: the server this Mac links to, askeden.com or preview.askeden.com (its own
  accounts). Changes only while unlinked; a linked Mac stays with the server its token is for.
- account_eden_link: Eden on the web (askeden.com) reaches Jarvis and Code mode through this
  Mac (jarvis.eden_link; on unless turned off). The "account" event carries
  eden_link: {on, state: off | connecting | open | waiting, error}, sent again as the line
  connects and drops.

Window commands: account (the state, asked of askeden.com now), account_link (a new code;
{browser: true}: approved in the owner's browser, so the server's /link page opens with it),
account_link_open (that page again), account_link_cancel, account_unlink, account_sync (sync now), and approving a browser's
sign-in to Eden: account_web_peek {code}, account_web_approve {code}, account_web_deny
{code}, account_web_clear; each answered with an "account" event: {linked, account_id,
device_id, sync_key, link: {state, code, url, qr, seconds, error} | null, approval: {code,
name, state, error} | null, info: GET /account's answer | null, error, relay: {on, state},
plus: {chosen, in_use}, sync: {state, error, at}, push_via_account, claude_signed_in}. The
token and the sync key never reach the window.

Trusting a browser for Eden sync (jarvis.eden_trust): account_esync (askeden.com asked now),
account_esync_ask (this Mac asks a browser that syncs for Eden's key), account_esync_cancel,
account_esync_unlock {passphrase}, account_esync_approve {device_id, public_key},
account_esync_deny {device_id}, account_esync_forget; each answered with an "account_esync"
event: {state: off | locked | asking | on | unknown, wrap, asking: {code, state, error} | null,
requests: [{device_id, name, kind, public_key, code, expires}], trusted: [{name, kind, this}],
done, error}. Eden's key, this Mac's private key and the passphrase never reach the window.

Its loop (the app's, never in tests): the Keychain read once, whether Claude Code is signed
in to a Claude account (local, no model), the relay kept up while it's wanted, and sync.

Claude cost policy: nothing here calls a model. Jarvis Plus changes who pays for the
runs JARVIS already makes, not how many there are.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from typing import Any

from .. import claude_signin, lang
from ..account import PLUS_PREF, RELAY_PREF, SERVER_PREF, SERVERS, Account, AccountError
from ..account_sync import Sync
from ..eden_link import EDEN_LINK_PREF, EdenLink
from ..eden_trust import EdenTrust
from ..prefs import register_feature_pref
from ..relay import Keeper, Relay

log = logging.getLogger("jarvis")

register_feature_pref(RELAY_PREF, True)
register_feature_pref(PLUS_PREF, False)
register_feature_pref(EDEN_LINK_PREF, True)
register_feature_pref(SERVER_PREF, SERVERS[0], lambda v: v if v in SERVERS else None)

COMMANDS = (
    "account",
    "account_link",
    "account_link_cancel",
    "account_link_open",
    "account_unlink",
    "account_sync",
    "account_web_peek",
    "account_web_approve",
    "account_web_deny",
    "account_web_clear",
    "account_esync",
    "account_esync_ask",
    "account_esync_cancel",
    "account_esync_unlock",
    "account_esync_approve",
    "account_esync_deny",
    "account_esync_forget",
)
SIGNIN_SECONDS = 30 * 60  # whether Claude Code is signed in, looked at again after this

PLUS_USED_UP = (
    "Your Jarvis Plus allowance for this month is used up. It starts again with your next "
    "month; until then, sign in to Claude or add an Anthropic API key in Settings to carry on."
)
TRIAL_USED_UP = (
    "Your Jarvis Plus trial is used up. Subscribe to Jarvis Plus in the J.A.R.V.I.S. app on "
    "your iPhone, or sign in to Claude or add an Anthropic API key in Settings."
)
PLUS_SIGNED_OUT = (
    "Your Jarvis account didn't take this Mac's sign-in. Link it again in Settings › Account."
)
# The Chinese spells the name J.A.R.V.I.S.: said aloud, "Jarvis" would wake JARVIS itself.
lang.add_texts(
    {
        PLUS_USED_UP: "你本月的 J.A.R.V.I.S. Plus 额度已用完。下个月会重新开始；在此之前，可以在设置中登录 Claude 或添加 Anthropic API 密钥继续使用。",
        TRIAL_USED_UP: "你的 J.A.R.V.I.S. Plus 试用额度已用完。可以在 iPhone 上的 J.A.R.V.I.S. App 中订阅 J.A.R.V.I.S. Plus，或在设置中登录 Claude、添加 Anthropic API 密钥。",
        PLUS_SIGNED_OUT: "你的 J.A.R.V.I.S. 账户没有接受这台 Mac 的登录。请在“设置 › 账户”中重新关联。",
        "Couldn't reach askeden.com.": "无法连接 askeden.com。",
        "This Mac isn't linked to a Jarvis account.": "这台 Mac 没有关联 J.A.R.V.I.S. 账户。",
        "This Mac was signed out of the account.": "这台 Mac 已从账户中退出。",
        "askeden.com's answer couldn't be read.": "无法读取 askeden.com 的回复。",
        "The Keychain didn't take the account. If it's locked, unlock it and link again.": "钥匙串没有保存账户。如果它已锁定，请解锁后重新关联。",
    }
)


class AccountDesk:
    """The account's part of the app: the client, sync and the relay, and Settings."""

    def __init__(self, hub: Any, account: Account | None = None) -> None:
        self.hub = hub
        self.account = account or Account(hub.connectors.vault)
        self.sync = Sync(
            self.account,
            lambda: hub.memory,
            lambda: hub.prefs,
            hub.set_prefs,
            hub.feature_path("account-sync.json"),
            on_change=self._synced,
        )
        self.relay = Relay(self.account, self._port)
        self.keeper = Keeper(self.relay, self.relay_wanted)
        # Eden on the web's link (askeden.com → Eden's server on this Mac), kept the same way.
        self.eden_link = EdenLink(self.account)
        self.eden_link.on_change.append(self.emit)  # Settings shows the line as it goes
        self.eden_keeper = Keeper(self.eden_link, self.eden_link_wanted)
        # Eden sync's key on this Mac, to approve browsers (jarvis.eden_trust).
        self.trust = EdenTrust(self.account)
        self.trust.on_change.append(self.emit_esync)
        self.account.on_change.append(self._changed)
        self._plus = False  # whether runs went through Jarvis Plus, as last seen
        self._was_linked = False

    # ── what's wanted ──

    def _port(self) -> int | None:
        remote = self.hub.remote
        return remote.port if remote.running and remote.port else None

    def relay_on(self) -> bool:
        return self.hub.prefs.feature(RELAY_PREF) is not False

    def relay_wanted(self) -> bool:
        return self.account.linked and self.relay_on() and self._port() is not None

    def eden_link_on(self) -> bool:
        return self.hub.prefs.feature(EDEN_LINK_PREF) is not False

    def eden_link_wanted(self) -> bool:
        return self.account.linked and self.eden_link_on()

    def plus_in_use(self) -> bool:
        return claude_signin.plus_of(self.hub) is not None

    def _plus_moved(self) -> None:
        """Runs go through Jarvis Plus now and didn't before, or the other way round: the
        conversation's Claude Code starts again, signed in the new way (the conversation
        kept); Eden Code's next sessions follow by themselves."""
        now = self.plus_in_use()
        if now != self._plus:
            self._plus = now
            log.info("account: Jarvis Plus %s", "in use" if now else "not in use")
            claude_signin.forget(claude_signin.PLUS_CACHE)
            reload = getattr(self.hub, "_tools_changed", None)
            if callable(reload) and getattr(self.hub, "poll", False):
                reload()

    # ── hearing changes ──

    def _changed(self) -> None:
        linked = self.account.linked
        if self._was_linked and not linked:
            self.sync.reset()  # what was synced was that account's
            self.trust.reset()
        self._was_linked = linked
        self.keeper.poke()
        self.eden_keeper.poke()
        self.sync.poke()
        self._plus_moved()
        self.emit()

    def _synced(self) -> None:
        """Sync changed memory or settings here: the window shows them."""
        self.hub.emit("memory", items=self.hub.memory.public())

    def use_server(self) -> None:
        """The server Settings chose, while this Mac isn't linked (account.use_server)."""
        self.account.use_server(self.hub.prefs.feature(SERVER_PREF))

    def open_link_page(self) -> None:
        """The server's /link page, with this Mac's code, in the owner's own browser."""
        page = self.account.link_page()
        if not page:
            return
        opener = getattr(getattr(self.hub, "connectors", None), "open_url", None)
        try:
            if callable(opener):
                opener(page)
            else:
                from .. import osplat

                osplat.open_target(page)
        except Exception:
            log.warning("account: the browser couldn't be opened")

    def prefs_changed(self, _event: dict[str, Any]) -> None:
        self.use_server()
        self.keeper.poke()
        self.eden_keeper.poke()
        self.sync.poke()
        self._plus_moved()
        self.emit()  # the switches as they are now

    def remote_changed(self, _event: dict[str, Any]) -> None:
        self.keeper.poke()

    # ── words ──

    def error_words(self, kind: str) -> str:
        """In place of Claude Code's words for an error, while Jarvis Plus answers: the
        allowance used up, or the account not taking the token ("" for anything else)."""
        if not self.plus_in_use():
            return ""
        if kind == "billing_error":
            plan = (self.account.info or {}).get("plan") or {}
            words = PLUS_USED_UP if isinstance(plan, dict) and plan.get("active") else TRIAL_USED_UP
        elif kind == "authentication_failed":
            # Asked again now: a 401 there unlinks the Mac, and runs go back to Claude.
            with contextlib.suppress(RuntimeError):
                self.hub._spawn(self.account.status(fresh=True))
            words = PLUS_SIGNED_OUT
        else:
            return ""
        return lang.translate(words, self.hub.language)

    # ── Settings ──

    def public(self) -> dict[str, Any]:
        extension = getattr(self.hub.remote, "extension", None)
        sender = getattr(extension, "sender", None)
        return {
            **self.account.public(),
            "server_choice": self.hub.prefs.feature(SERVER_PREF),
            "servers": list(SERVERS),
            "relay": {"on": self.relay_on(), "state": self.relay.state},
            "eden_link": {"on": self.eden_link_on(), **self.eden_link.public()},
            "plus": {
                "chosen": self.hub.prefs.feature(PLUS_PREF) is True,
                "in_use": self.plus_in_use(),
            },
            "sync": self.sync.public(),
            "push_via_account": bool(sender is not None and sender.through_account()),
            "claude_signed_in": self.account.claude_signed_in,
        }

    def emit(self, **extra: Any) -> None:
        self.hub.emit("account", **{**self.public(), **extra})

    async def command(self, msg: dict[str, Any]) -> None:
        kind = msg.get("type")
        account = self.account
        if kind == "account":
            await account.load()
            if account.linked:
                await account.status(fresh=True)
            self.emit()
        elif kind == "account_link":
            browser = msg.get("browser") is True
            self.use_server()
            try:
                await account.link_start(browser=browser)
            except AccountError as exc:
                self.emit(error=lang.translate(exc.message, self.hub.language))
                return
            if browser:
                self.open_link_page()
        elif kind == "account_link_open":
            self.open_link_page()
        elif kind == "account_link_cancel":
            account.cancel_link()
        elif kind == "account_unlink":
            await account.unlink()
        elif kind == "account_sync":
            await self.sync.sync()
            self.emit()
        elif kind == "account_web_peek":
            try:
                await account.web_peek(msg.get("code"))
            except AccountError as exc:
                self.emit(approval_error=lang.translate(exc.message, self.hub.language))
        elif kind in ("account_web_approve", "account_web_deny"):
            try:
                await account.web_answer(msg.get("code"), kind == "account_web_approve")
            except AccountError as exc:
                self.emit(approval_error=lang.translate(exc.message, self.hub.language))
        elif kind == "account_web_clear":
            account.web_clear()
        elif kind.startswith("account_esync"):
            await self.esync_command(kind, msg)

    # ── Eden sync: trusting a browser ──

    def emit_esync(self, **extra: Any) -> None:
        self.hub.emit("account_esync", **{**self.trust.public(), **extra})

    async def esync_command(self, kind: str, msg: dict[str, Any]) -> None:
        trust = self.trust
        try:
            if kind == "account_esync":
                await trust.refresh()
            elif kind == "account_esync_ask":
                await trust.refresh()
                await trust.ask()
            elif kind == "account_esync_cancel":
                await trust.cancel()
            elif kind == "account_esync_unlock":
                await trust.unlock(msg.get("passphrase"))
            elif kind == "account_esync_approve":
                await trust.approve(msg.get("device_id"), msg.get("public_key"))
            elif kind == "account_esync_deny":
                await trust.deny(msg.get("device_id"))
            elif kind == "account_esync_forget":
                await trust.forget()
        except AccountError as exc:
            self.emit_esync(problem=lang.translate(exc.message, self.hub.language))
            return
        self.emit_esync()

    # ── the app's loop ──

    async def signed_in_to_claude(self) -> bool | None:
        """Whether Claude Code is signed in to a Claude account (its own auth status, local
        and free); None when it can't tell."""
        from .ops.doctor import _last_json, claude_cli

        cli = claude_cli()
        if not cli:
            return None
        try:
            proc = await asyncio.create_subprocess_exec(
                cli,
                "auth",
                "status",
                "--json",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
            )
        except OSError:
            return None
        try:
            out, _err = await asyncio.wait_for(proc.communicate(), 20)
        except TimeoutError:
            with contextlib.suppress(ProcessLookupError):
                proc.kill()
            await proc.wait()
            return None
        status = _last_json(out.decode(errors="replace"))
        found = status.get("loggedIn") if isinstance(status, dict) else None
        return found if isinstance(found, bool) else None

    async def _watch_signin(self) -> None:
        while True:
            if self.account.linked:
                found = await self.signed_in_to_claude()
                if found is not None and found != self.account.claude_signed_in:
                    self.account.claude_signed_in = found
                    self._plus_moved()
                    self.emit()
            await asyncio.sleep(SIGNIN_SECONDS)

    async def loop(self) -> None:
        await self.account.load()
        self.use_server()
        self._was_linked = self.account.linked
        if self.account.linked:
            log.info("account: this Mac is linked to a Jarvis account")
        self._plus_moved()
        jobs = [self.keeper.loop(), self.eden_keeper.loop(), self.sync.loop(), self._watch_signin()]
        try:
            await asyncio.gather(*jobs)
        finally:
            await self.trust.aclose()
            await self.account.aclose()


def install(hub: Any) -> None:
    desk = AccountDesk(hub)
    # Kept on the hub (the push sender, the companion API, the hosted voice and
    # claude_signin find it there), never in a map of this module's.
    hub.account = desk.account
    hub.account_desk = desk
    for kind in COMMANDS:
        fast = kind in ("account_link_cancel", "account_web_clear")
        hub.register_command(kind, desk.command, slow=not fast)
    hub.add_event_sink(("prefs",), desk.prefs_changed)
    hub.add_event_sink(("remote",), desk.remote_changed)
    hub.claude_error_words = desk.error_words
    hub.tasks.error_words = desk.error_words
    hub.register_loop("account", desk.loop)
