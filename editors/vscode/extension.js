// Eden Code in your editor: the review side of Eden Code's window, in VS Code (and Cursor,
// Windsurf and VSCodium, which load VS Code extensions).
//
// - The Eden Code side bar lists the sessions of the running app (its local API:
//   docs/eden-code-api.md), each with the files it changed and its receipts.
// - A file opens as itself, the session's hunks marked in it: added lines tinted, removed
//   lines shown above where they were, and over each hunk "Change n · Keep · Undo · Diff",
//   the Changes pane's own buttons (features/code_hunks.py): Keep marks it reviewed (in the
//   window too), Undo puts back just that hunk after asking.
// - Line comments: the editor's own comment threads on any line of a hunk; "Send comments
//   to the session" sends them together, worded as the window's pane sends them.
// - Receipts: each turn's proof (what changed, tests, checks, risk) as a Markdown page.
// - "Send a message" types to the session; "Stop" stops the step under way.
//
// It follows the API's event stream, so a session's list and its changes stay current.
// Plain JavaScript and no packages: there's nothing to build. The API calls are in
// src/client.js, what is drawn in src/review.js (both checked by node --test).
//
// Cost policy: no model is called here. A message sent to a session is an ordinary turn of
// that session, on its model, under the owner's spending caps (features/code_usage.py).

'use strict';

const vscode = require('vscode');
const path = require('node:path');
const { Client, EdenError, Unreachable, findUrl, findToken } = require('./src/client');
const { hunkPlaces, baseText, fileLabel, sessionLabel, receiptsMarkdown, commentOf } = require('./src/review');

const SECRET = 'edenCode.token';
const BASE_SCHEME = 'eden-base';
const RECONNECT_MS = 5000;

class Eden {
  constructor(context) {
    this.context = context;
    this.client = null;
    this.sessions = [];
    this.views = new Map(); // session id -> the Changes view last fetched
    this.reviews = new Map(); // absolute file path -> { id, file, view }
    this.pending = new Map(); // session id -> [{ comment, thread }]
    this.closeEvents = null;
    this.retry = null;
    this.disposed = false;
    this.changed = new vscode.EventEmitter();
    this.lensChanged = new vscode.EventEmitter();
    this.baseChanged = new vscode.EventEmitter();
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    this.status.command = 'edenCode.refresh';
    this.added = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
      overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.addedForeground'),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });
    this.addedKept = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      border: '0 0 0 2px solid', borderColor: new vscode.ThemeColor('editorGutter.addedBackground'),
    });
    this.removed = vscode.window.createTextEditorDecorationType({
      overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.deletedForeground'),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });
    this.comments = vscode.comments.createCommentController('edenCode.review', 'Eden Code review');
    this.comments.commentingRangeProvider = {
      provideCommentingRanges: (doc) => {
        const review = this.reviews.get(doc.uri.fsPath);
        if (!review) return [];
        return (review.file.hunks || []).map((h) => {
          const at = hunkPlaces(h);
          return new vscode.Range(at.start, 0, Math.min(at.end, doc.lineCount - 1), 0);
        });
      },
    };
    this.comments.options = { prompt: 'Comment on this line (sent to the session with the others)', placeHolder: 'What should the session change here?' };
  }

  get view() { return vscode.workspace.getConfiguration('edenCode').get('view') || 'session'; }

  // ── connecting ──

  async connect(quiet = false) {
    const setting = vscode.workspace.getConfiguration('edenCode').get('url') || '';
    const secret = (await this.context.secrets.get(SECRET)) || '';
    const token = await findToken({ secret });
    try {
      this.client = new Client(findUrl({ setting }), token);
    } catch (err) {
      this.say(err, quiet);
      return false;
    }
    if (!token) {
      this.setStatus('$(key) Eden Code: no token', 'Set the API token (Eden Code settings › Control from code › Show)');
      if (!quiet) this.askToken();
      return false;
    }
    try {
      await this.client.status();
    } catch (err) {
      this.say(err, quiet);
      this.reconnectLater();
      return false;
    }
    this.setStatus('$(eye) Eden Code', `Connected to ${this.client.url}`);
    await this.refresh();
    this.follow();
    return true;
  }

  async askToken() {
    const pick = await vscode.window.showWarningMessage(
      'Eden Code needs its API token. Copy it from Eden Code settings › Control from code › Show.', 'Set the token');
    if (pick) vscode.commands.executeCommand('edenCode.setToken');
  }

  setStatus(text, tooltip) {
    this.status.text = text;
    this.status.tooltip = tooltip;
    this.status.show();
  }

  say(err, quiet = false) {
    let text;
    if (err instanceof Unreachable) {
      text = "Can't reach Eden Code. Is it open, with Control from code › Programs on this Mac turned on?";
      this.setStatus('$(debug-disconnect) Eden Code', text);
    } else if (err instanceof EdenError && err.status === 401) {
      text = "Eden Code didn't take the token. Set it again (it changes when it's regenerated).";
      this.setStatus('$(key) Eden Code: wrong token', text);
    } else if (err instanceof EdenError && err.status === 404 && /not found/.test(err.message)) {
      text = 'Eden Code: not found (is Control from code turned on?)';
    } else {
      text = `Eden Code: ${err && err.message ? err.message : err}`;
    }
    if (!quiet) vscode.window.showErrorMessage(text);
  }

  // The event stream: the list when it changes, a session's changes when they do.
  follow() {
    if (this.closeEvents || !this.client) return;
    this.closeEvents = this.client.events((event) => this.onEvent(event), (err) => {
      this.closeEvents = null;
      if (this.disposed) return;
      if (err) this.say(err, true);
      this.reconnectLater();
    });
  }

  reconnectLater() {
    if (this.retry || this.disposed) return;
    this.retry = setTimeout(() => { this.retry = null; this.connect(true); }, RECONNECT_MS);
    if (this.retry.unref) this.retry.unref();
  }

  onEvent(event) {
    if (event.type === 'sessions') {
      this.sessions = event.sessions || [];
      this.views.clear(); // (fetched again as a session is opened in the side bar)
      this.changed.fire();
    } else if (event.type === 'finished' || event.type === 'changes') {
      this.reload(event.id);
    } else if (event.type === 'entry' && event.entry && event.entry.role === 'system' && /^Proof · /.test(event.entry.text || '')) {
      this.reload(event.id); // (a receipt: the turn's changes are in)
    }
  }

  // ── what's shown ──

  async refresh() {
    if (!this.client) return this.connect();
    try {
      this.sessions = await this.client.sessions();
    } catch (err) {
      this.say(err, true);
      this.sessions = [];
    }
    this.views.clear();
    this.changed.fire();
    for (const id of new Set([...this.reviews.values()].map((r) => r.id))) await this.reload(id);
  }

  session(id) { return this.sessions.find((s) => String(s.id) === String(id)); }

  async changesOf(id, fresh = false) {
    if (!fresh && this.views.has(id)) return this.views.get(id);
    const view = await this.client.changes(id, this.view);
    this.views.set(id, view);
    return view;
  }

  absolute(id, file) {
    const s = this.session(id);
    return s && s.path ? path.join(s.path, file) : '';
  }

  // A session's changes again: the side bar, the files open for review, their marks.
  async reload(id) {
    if (!this.client || id === undefined) return;
    let view;
    try {
      view = await this.changesOf(id, true);
    } catch (err) {
      this.say(err, true);
      return;
    }
    for (const [abs, review] of this.reviews) {
      if (String(review.id) !== String(id)) continue;
      const file = (view.files || []).find((f) => f.path === review.file.path);
      if (!file) { this.reviews.delete(abs); continue; }
      review.file = file.omitted ? await this.wholeFile(id, file) : file;
      review.view = view;
      this.baseChanged.fire(this.baseUri(id, abs));
    }
    this.changed.fire();
    this.lensChanged.fire();
    this.decorateAll();
  }

  async wholeFile(id, file) {
    try {
      const one = await this.client.changes(id, this.view, file.path);
      return one.file || file;
    } catch {
      return file;
    }
  }

  // Open one file of a session's change, its hunks marked in it.
  async open(id, filePath) {
    const view = await this.changesOf(id);
    let file = (view.files || []).find((f) => f.path === filePath);
    if (!file) return;
    if (file.sensitive) {
      vscode.window.showInformationMessage(`${file.path} holds credentials: its lines are never shown.`);
      return;
    }
    if (file.omitted) file = await this.wholeFile(id, file);
    const abs = this.absolute(id, file.path);
    if (!abs) return;
    this.reviews.set(abs, { id, file, view });
    this.lensChanged.fire();
    if (file.status === 'D') {
      vscode.window.showInformationMessage(`${file.path} was deleted by the session; Undo on its change puts it back.`);
      return;
    }
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(abs));
    await vscode.window.showTextDocument(doc, { preview: false });
    this.decorateAll();
  }

  decorateAll() {
    for (const editor of vscode.window.visibleTextEditors) this.decorate(editor);
  }

  decorate(editor) {
    const review = this.reviews.get(editor.document.uri.fsPath);
    const added = [];
    const kept = [];
    const removed = [];
    if (review) {
      const last = Math.max(0, editor.document.lineCount - 1);
      for (const h of review.file.hunks || []) {
        const at = hunkPlaces(h);
        for (const line of at.added) {
          if (line <= last) (at.kept ? kept : added).push(new vscode.Range(line, 0, line, 0));
        }
        if (at.kept) continue;
        for (const gone of at.removed) {
          const line = Math.min(gone.line, last);
          const shown = gone.texts.slice(0, 3).map((t) => t.trim()).join(' ⏎ ');
          const hover = new vscode.MarkdownString();
          hover.appendMarkdown(`**Removed by the session** (change ${h.n})\n`);
          hover.appendCodeblock(gone.texts.join('\n'), editor.document.languageId);
          removed.push({
            range: new vscode.Range(line, 0, line, 0),
            hoverMessage: hover,
            renderOptions: { before: {
              contentText: `− ${gone.texts.length} removed: ${shown.slice(0, 80)}${shown.length > 80 ? '…' : ''}  `,
              color: new vscode.ThemeColor('editorGutter.deletedBackground'), fontStyle: 'italic',
            } },
          });
        }
      }
    }
    editor.setDecorations(this.added, added);
    editor.setDecorations(this.addedKept, kept);
    editor.setDecorations(this.removed, removed);
  }

  // Keep and Undo over each hunk (CodeLens).
  lenses(doc) {
    const review = this.reviews.get(doc.uri.fsPath);
    if (!review) return [];
    const out = [];
    const last = Math.max(0, doc.lineCount - 1);
    const pending = (this.pending.get(review.id) || []).length;
    for (const h of review.file.hunks || []) {
      const at = hunkPlaces(h);
      const range = new vscode.Range(Math.min(at.first, last), 0, Math.min(at.first, last), 0);
      const args = [review.id, h.id, review.file.path, h.n];
      out.push(new vscode.CodeLens(range, { title: `Eden · change ${h.n}${at.kept ? ' ✓ kept' : ''}`, command: '' }));
      out.push(at.kept
        ? new vscode.CodeLens(range, { title: 'Un-keep', command: 'edenCode.unkeep', arguments: args })
        : new vscode.CodeLens(range, { title: 'Keep', command: 'edenCode.keep', arguments: args, tooltip: 'Mark it reviewed (in Eden Code too)' }));
      out.push(new vscode.CodeLens(range, { title: 'Undo', command: 'edenCode.undo', arguments: args, tooltip: 'Put just this change back as it was' }));
      out.push(new vscode.CodeLens(range, { title: 'Diff', command: 'edenCode.openDiff', arguments: [review.id, review.file.path] }));
    }
    if (pending && out.length) {
      out.push(new vscode.CodeLens(out[0].range, { title: `Send ${pending} comment${pending === 1 ? '' : 's'} to the session`, command: 'edenCode.sendComments', arguments: [review.id] }));
    }
    return out;
  }

  // ── actions ──

  async hunk(action, id, hunk, file, n) {
    if (action === 'undo') {
      const sure = await vscode.window.showWarningMessage(`Undo change ${n} in ${file}?`,
        { modal: true, detail: 'Puts just this change back as it was. Other changes stay.' }, 'Undo');
      if (sure !== 'Undo') return;
      const abs = this.absolute(id, file);
      const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === abs);
      if (doc && doc.isDirty) {
        vscode.window.showWarningMessage(`Save or revert ${file} first: Undo changes the file on disk.`);
        return;
      }
    }
    try {
      const done = await this.client.hunk(id, hunk, action, this.view, file);
      if (done.said) (done.done ? vscode.window.showInformationMessage : vscode.window.showWarningMessage)(done.said);
      this.views.set(id, done.changes);
    } catch (err) {
      this.say(err);
    }
    await this.reload(id);
  }

  baseUri(id, abs) {
    return vscode.Uri.from({ scheme: BASE_SCHEME, path: abs, query: `session=${encodeURIComponent(id)}` });
  }

  // The file before the session's hunks: its text now with each hunk put back.
  async baseOf(uri) {
    const file = vscode.Uri.file(uri.path);
    const review = this.reviews.get(file.fsPath);
    if (!review) return '';
    const doc = await vscode.workspace.openTextDocument(file);
    const text = baseText(doc.getText(), review.file.hunks || []);
    return text ?? '(This file has changed since Eden Code showed it, or its change is too big to show here. Refresh, or see it in the Eden Code window.)\n';
  }

  async openDiff(id, file) {
    if (!this.reviews.has(this.absolute(id, file))) await this.open(id, file);
    const abs = this.absolute(id, file);
    if (!abs) return;
    const s = this.session(id);
    await vscode.commands.executeCommand('vscode.diff', this.baseUri(id, abs), vscode.Uri.file(abs),
      `${file} (${s ? sessionLabel(s).label : `session ${id}`})`);
  }

  async receipts(id) {
    try {
      const list = await this.client.receipts(id);
      const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: receiptsMarkdown(this.session(id), list) });
      await vscode.window.showTextDocument(doc, { preview: true });
      vscode.commands.executeCommand('markdown.showPreview', doc.uri).then(undefined, () => {});
    } catch (err) {
      this.say(err);
    }
  }

  async send(id) {
    const s = this.session(id);
    const text = await vscode.window.showInputBox({
      title: `Message ${s ? sessionLabel(s).label : `session ${id}`}`,
      prompt: 'Sent to the session as your next message (slash commands are typed in the Eden Code window).',
      ignoreFocusOut: true,
    });
    if (!text || !text.trim()) return;
    try {
      await this.client.send(id, text.trim());
      vscode.window.setStatusBarMessage('Sent to Eden Code', 3000);
    } catch (err) {
      this.say(err);
    }
  }

  async stop(id) {
    try { await this.client.stop(id); } catch (err) { this.say(err); }
  }

  // A comment written in the editor's thread: kept until sent, with the line it's on.
  addComment(reply) {
    const thread = reply.thread;
    const review = this.reviews.get(thread.uri.fsPath);
    if (!review || !reply.text.trim()) return;
    const line = thread.range.start.line;
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === thread.uri.fsPath);
    const excerpt = doc && line < doc.lineCount ? doc.lineAt(line).text : '';
    const comment = commentOf(review.file.path, line, reply.text, excerpt);
    thread.comments = [...thread.comments, {
      body: new vscode.MarkdownString(comment.text), mode: vscode.CommentMode.Preview,
      author: { name: 'You (not sent yet)' }, contextValue: 'edenPending',
    }];
    thread.label = 'Eden Code review';
    thread.contextValue = 'edenThread';
    const list = this.pending.get(review.id) || [];
    list.push({ comment, thread });
    this.pending.set(review.id, list);
    this.lensChanged.fire();
  }

  async sendComments(id) {
    if (id === undefined) id = [...this.pending.keys()][0];
    const list = this.pending.get(id) || [];
    if (!list.length) {
      vscode.window.showInformationMessage('No comments to send.');
      return;
    }
    try {
      await this.client.comments(id, list.map((p) => p.comment));
      for (const p of list) p.thread.dispose();
      this.pending.delete(id);
      this.lensChanged.fire();
      vscode.window.showInformationMessage(`Sent ${list.length} comment${list.length === 1 ? '' : 's'} to the session.`);
    } catch (err) {
      this.say(err);
    }
  }

  clearComments() {
    for (const list of this.pending.values()) for (const p of list) p.thread.dispose();
    this.pending.clear();
    this.lensChanged.fire();
  }

  dispose() {
    this.disposed = true;
    if (this.closeEvents) this.closeEvents();
    if (this.retry) clearTimeout(this.retry);
    this.comments.dispose();
    this.status.dispose();
  }
}

// The side bar: sessions › their changed files, and their receipts.
class Tree {
  constructor(eden) {
    this.eden = eden;
    this.onDidChangeTreeData = eden.changed.event;
  }

  getTreeItem(node) { return node; }

  async getChildren(node) {
    const eden = this.eden;
    if (!node) {
      return eden.sessions.map((s) => {
        const { label, description } = sessionLabel(s);
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed);
        item.description = description;
        item.tooltip = `${s.prompt || ''}\n\n${s.path || ''}${s.workspace && s.workspace.branch ? `\nIsolated copy on ${s.workspace.branch}` : ''}`;
        item.contextValue = 'edenSession';
        item.iconPath = new vscode.ThemeIcon(s.busy ? 'sync~spin' : 'comment-discussion');
        item.sessionId = s.id;
        return item;
      });
    }
    if (node.sessionId === undefined || node.filePath) return [];
    const id = node.sessionId;
    const receipts = new vscode.TreeItem('Receipts', vscode.TreeItemCollapsibleState.None);
    receipts.iconPath = new vscode.ThemeIcon('checklist');
    receipts.command = { command: 'edenCode.showReceipts', title: 'Receipts', arguments: [id] };
    let view;
    try {
      view = await eden.changesOf(id);
    } catch (err) {
      const item = new vscode.TreeItem(err.message || String(err));
      item.iconPath = new vscode.ThemeIcon('warning');
      return [item, receipts];
    }
    if (!view.git) {
      const item = new vscode.TreeItem(view.gone ? 'Its copy was landed or discarded' : 'Not a git repository: changes can’t be shown a hunk at a time');
      return [item, receipts];
    }
    const files = (view.files || []).map((f) => {
      const { label, description } = fileLabel(f);
      const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
      item.description = description;
      item.resourceUri = vscode.Uri.file(eden.absolute(id, f.path) || f.path);
      item.contextValue = 'edenFile';
      item.sessionId = id;
      item.filePath = f.path;
      item.command = { command: 'edenCode.openChanges', title: 'Review', arguments: [id, f.path] };
      return item;
    });
    if (!files.length) files.push(new vscode.TreeItem(`No changes in this ${view.view === 'turn' ? 'turn' : 'session'}`));
    return [...files, receipts];
  }
}

function activate(context) {
  const eden = new Eden(context);
  const tree = new Tree(eden);
  const reg = (name, fn) => context.subscriptions.push(vscode.commands.registerCommand(name, fn));
  const idOf = (arg) => (arg && typeof arg === 'object' ? arg.sessionId : arg);
  const picked = async (arg) => {
    const id = idOf(arg);
    if (id !== undefined) return id;
    if (!eden.sessions.length) await eden.refresh();
    const choice = await vscode.window.showQuickPick(eden.sessions.map((s) => ({ ...sessionLabel(s), id: s.id })), { title: 'Which Eden Code session?' });
    return choice ? choice.id : undefined;
  };

  context.subscriptions.push(
    eden,
    vscode.window.registerTreeDataProvider('edenCode.sessions', tree),
    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, { onDidChangeCodeLenses: eden.lensChanged.event, provideCodeLenses: (doc) => eden.lenses(doc) }),
    vscode.workspace.registerTextDocumentContentProvider(BASE_SCHEME, { onDidChange: eden.baseChanged.event, provideTextDocumentContent: (uri) => eden.baseOf(uri) }),
    vscode.window.onDidChangeVisibleTextEditors(() => eden.decorateAll()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('edenCode.url')) { if (eden.closeEvents) eden.closeEvents(); eden.closeEvents = null; eden.client = null; eden.connect(); }
      if (e.affectsConfiguration('edenCode.view')) eden.refresh();
    }),
  );

  reg('edenCode.refresh', () => eden.refresh());
  reg('edenCode.setToken', async () => {
    const token = await vscode.window.showInputBox({ title: 'Eden Code API token', prompt: 'From Eden Code settings › Control from code › Show. Kept in the editor’s secret storage.', password: true, ignoreFocusOut: true });
    if (token === undefined) return;
    await context.secrets.store(SECRET, token.trim());
    if (eden.closeEvents) eden.closeEvents();
    eden.closeEvents = null;
    eden.client = null;
    eden.connect();
  });
  reg('edenCode.openChanges', (id, file) => (id && typeof id === 'object' ? eden.open(id.sessionId, id.filePath) : eden.open(id, file)));
  reg('edenCode.openDiff', (id, file) => (id && typeof id === 'object' ? eden.openDiff(id.sessionId, id.filePath) : eden.openDiff(id, file)));
  reg('edenCode.keep', (id, hunk, file, n) => eden.hunk('keep', id, hunk, file, n));
  reg('edenCode.unkeep', (id, hunk, file, n) => eden.hunk('unkeep', id, hunk, file, n));
  reg('edenCode.undo', (id, hunk, file, n) => eden.hunk('undo', id, hunk, file, n));
  reg('edenCode.showReceipts', async (arg) => { const id = await picked(arg); return id === undefined ? undefined : eden.receipts(id); });
  reg('edenCode.sendMessage', async (arg) => { const id = await picked(arg); return id === undefined ? undefined : eden.send(id); });
  reg('edenCode.stop', async (arg) => { const id = await picked(arg); return id === undefined ? undefined : eden.stop(id); });
  reg('edenCode.addComment', (reply) => eden.addComment(reply));
  reg('edenCode.sendComments', (arg) => eden.sendComments(idOf(arg)));
  reg('edenCode.clearComments', () => eden.clearComments());

  eden.connect(true);
  return eden; // (for the tests)
}

function deactivate() {}

module.exports = { activate, deactivate };
