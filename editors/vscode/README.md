# Eden Code Review (VS Code, Cursor, Windsurf, VSCodium)

Review what your Eden Code sessions changed without leaving your editor:

- **Sessions** in the Eden Code side bar, each with the files it changed and its **Receipts**.
- A file opens as itself with the session's hunks marked: added lines tinted, removed lines
  shown above where they were (hover for all of them). Over each hunk:
  **Eden · change n · Keep · Undo · Diff**, the Changes pane's own buttons. Keep marks it
  reviewed (in the Eden Code window too); Undo asks first, then puts back just that hunk.
  Diff opens the file side by side with how it was before the session's hunks.
- **Line comments**: click the `+` in the gutter on any line of a hunk, write, **Add comment**.
  **Send comments to the session** sends them together, worded as the window's pane sends them.
- **Send a message** and **Stop** on a session (the speech-bubble and the menu in the side bar).
- **Settings › Eden Code › View**: the session's changes (default), its latest turn only, or
  the whole branch.

It talks to the running Eden Code app through its local API (`docs/eden-code-api.md`), on
`127.0.0.1` only, and follows its event stream so everything stays current. Plain JavaScript
with no packages: there is nothing to build.

## Setting it up

1. In Eden Code: **Settings › General › Control from code › Programs on this Mac**: turn it on
   (its card, Touch ID).
2. Install the extension from this folder (it isn't published):
   - VS Code: `code --install-extension` needs a `.vsix`; simplest is to link the folder:
     `ln -s "$PWD" ~/.vscode/extensions/eden.eden-code-review-0.1.0`, then reload the window.
   - Cursor: `~/.cursor/extensions/`; Windsurf: `~/.windsurf/extensions/`; VSCodium:
     `~/.vscode-oss/extensions/`, the same way.
   - Or open this folder in the editor and press F5 (an Extension Development Host).
3. The token: it's read from the Keychain item Eden Code keeps (the Mac asks you once), or
   from `EDEN_CODE_TOKEN`. Or run **Eden Code: Set the API token** and paste it from
   **Control from code › Show** (kept in the editor's secret storage). After **Regenerate**,
   set it again.

Where it finds Eden Code: the **Eden Code › Url** setting, else `EDEN_CODE_URL`, else the
address the app wrote to `code_api.json`, else `http://127.0.0.1:8767`. Only this Mac's own
address is ever used.

Tests: `node --test tests/web/vscode-extension.test.mjs` from the repository's root (the API
client against a fake server, and the extension against a stand-in for VS Code).

## Zed and Neovim

Neither loads VS Code extensions. The same API works from either:

- **Zed**: run `eden-code tail <id> --follow` or `eden-code send <id> "…"` in its terminal
  (or as a task).
- **Neovim**: the session's hunks as a quickfix list (`:copen`), with `jq`:

  ```vim
  :cexpr system('curl -s -H "Authorization: Bearer $EDEN_CODE_TOKEN" http://127.0.0.1:8767/v1/sessions/3/changes | jq -r ''.files[] | .path as $p | .hunks[] | "\($p):\(.line): change \(.n) \(.where)"''')
  ```

  Run it from the session's folder so the paths open. Keep, Undo and comments are
  `POST /v1/sessions/<id>/hunks` and `/comments` (see `docs/eden-code-api.md`).

Cost: the extension calls no model. A message or comments sent to a session are an
ordinary turn of that session, under your spending caps.
