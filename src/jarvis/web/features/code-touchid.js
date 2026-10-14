// Touch ID for Eden Code's riskiest moments (jarvisFeatures.registerCheck): a session
// switched into Bypass permissions (on screen, or by voice: its card's tap), new sessions
// set to start in it, and a step allowed from its card that deletes, pushes, publishes,
// runs as root or edits outside the project, and a card the backend marks touchid (Exterminator
// Mode's landing). The app asks for the owner's fingerprint
// (app/features/touchid.js: macOS's own sheet, with the app's own words); where there's no
// Touch ID (or outside the app) the usual question asks instead. Its switch is in Eden Code
// settings › General (feature pref code_touchid).
//
// Answers given by voice, on the phone or from a notification are the owner's own there and
// go as they did. Pure helpers are exported for node --test (tests/web/code-touchid.test.mjs).
//
// The backend wants proof (audit S30, features/code_touchid.py's gate): a yes the app's main
// process saw is signed there, and sent just before the switch or the answer it's for
// (code_touchid_proof {kind, proof}), signed for its subject (round 3, R2-12): a risky step's
// yes names its card's id, Bypass its session's id ('new' for one not started), so a yes is
// good for that one thing only (subject() below). On a Mac without Touch ID the app asks with a dialog of
// its own (feature:touchid:confirm), which signs the same way; a page outside the app can't
// prove anything, so it asks its usual question and the backend says what's needed. The key
// it's signed with is the app's own, never the page's token (round 1 A1). On the other app's
// backend (Eden Code beside Eden Secretary) this app has no key and says { relay }: the window
// asks the backend (code_touchid_ask {kind, lang, subject}), the app that started it shows its sheet,
// and the backend holds that proof and says how it went (code_touchid_answer {proof_kind, ok}).
// Turning the switch below off asks the same way first (kind 'touchid-off'), and so does a
// Permissions pane change that lets a lot go unasked (kind 'rules': code-rules.js asks).
(function (root) {
  'use strict';

  const ALLOWING = new Set(['allow', 'always', 'allow_edits']);
  // The tap-only card that turns on Bypass permissions asked for by voice (voicecode.py).
  const BYPASS_BY_VOICE = 'code_bypass_by_voice';
  // Commands that can't easily be undone, or reach past this Mac (features/code_touchid.py's
  // RISKY, the same table: tests/fixtures/risky_commands.json). A program named with its
  // folder or in quotes is the same program ("/bin/rm", "rm"), and its options may come in any
  // order (-R last, --no-preserve-root before -rf).
  const B = '(^|[\\s;&|(`])';
  const P = '["\']?(?:[\\w.~/-]*/)?';
  const Q = '["\']?';
  const OPTS = '\\s+([^;&|\\n]*\\s)?';
  const re = (source) => new RegExp(source);
  const RISKY = [
    re(B + P + '(sudo|doas)' + Q + '\\s'),  // as root
    re(B + P + 'rm' + Q + OPTS + '(-\\w*[rRf]\\w*|--recursive|--force)'),  // deleting folders, or without asking
    /\bgit\b[^;&|\n]*\s(push|reset\s+--hard|clean\s+-\w*f\w*|branch\s+-D|filter-branch|filter-repo)\b/,
    /\b(curl|wget)\b[^|\n]*\|\s*(sudo\s+)?\w*sh\b/,  // a download run as a script
    re(B + P + '(chmod|chown)' + Q + OPTS + '(-\\w*R\\w*|--recursive)'),
    re(B + P + '(dd\\s[^|\\n]*\\bof=|mkfs\\b|diskutil\\s+(erase\\w*|partition\\w*|reformat|zero\\w*))'),
    re(B + P + '(launchctl|csrutil|spctl|systemsetup|networksetup|defaults\\s+(write|delete))\\b'),
    re(B + P + '((npm|yarn|pnpm)\\s+publish|twine\\s+upload|cargo\\s+publish|gem\\s+push|docker\\s+push|pod\\s+trunk\\s+push)\\b'),
    re(B + P + '(kubectl\\s+(delete|apply|drain)|terraform\\s+(apply|destroy)|helm\\s+(install|upgrade|uninstall|delete))\\b'),
    /\b(drop\s+(table|database|schema)|truncate\s+table)\b/i,
    re(B + P + '(killall|pkill|shutdown|reboot|halt)\\b'),
    re(B + P + 'find\\s[^;&|\\n]*\\s-delete\\b'),
    // An interpreter's one-liner that deletes: python -c "shutil.rmtree('/')", node -e "fs.rmSync(…)".
    re(B + P + '(python[\\d.]*|perl|ruby|node|deno|bun|php|osascript)' + Q + '\\s([^\\n]*\\s)?(-\\w*[ceEr]\\w*|--eval)\\s[^\\n]*'
      + '(rmtree|removedirs|\\bremove\\s*\\(|unlink|rmdir|\\brm_r|rmSync|rimraf|\\brm\\s+-\\w*[rRf])'),
  ];

  // Round 3 (S3-6): a shell reads `\rm`, `r\m`, `r''m` and `rm${IFS}-rf` as rm -rf, so the
  // table is matched against the command as the shell reads those too (as written as well), and
  // a program known only when it runs (a variable's, $'…', $(…)) is risky by itself.
  const ESCAPED = /\\(.)/g;
  const IFS = /\$\{IFS\}|\$IFS\b/g;
  const INNER_QUOTES = /(?<=[\w/.~-])["']+/g;
  const VAR_PROGRAM = /(^|[;&|(`\n])\s*(\w+=\S*\s+)*["']?\$[\w{('"]/;
  function asShellReads(command) {
    return String(command || '').replace(ESCAPED, '$1').replace(IFS, ' ').replace(INNER_QUOTES, '');
  }

  // Whether a command is one of those.
  function riskyCommand(command) {
    const text = String(command || '');
    if (VAR_PROGRAM.test(text)) return true;
    const read = asShellReads(text);
    return RISKY.some((re) => re.test(text) || re.test(read));
  }

  // An allow rule that's Bypass for a whole kind of step (features/code_touchid.py broad_rule,
  // the same): every command, a program that runs anything or a risky one, edits anywhere.
  const RUNS_ANYTHING = new Set(['bash', 'sh', 'zsh', 'fish', 'dash', 'ksh', 'sudo', 'doas', 'env', 'eval', 'exec',
    'command', 'builtin', 'xargs', 'nohup', 'time', 'timeout', 'gtimeout', 'nice', 'watch', 'caffeinate', 'stdbuf',
    'python', 'perl', 'ruby', 'node', 'deno', 'bun', 'php', 'osascript', 'ssh', 'npx', 'bunx', 'uvx', 'pipx',
    'make', 'gmake', 'docker', 'podman', 'gh', 'uv', 'java']);  // (round 3, S3-9: these too)
  // Programs that run anything with one of their subcommands (S3-9; features/code_touchid.py RUNS_WITH).
  const RUNS_WITH = { npm: ['run', 'run-script', 'exec', 'x'], yarn: ['run', 'exec', 'dlx', 'node'], pnpm: ['run', 'exec', 'dlx'], cargo: ['run'], go: ['run'] };
  const EDITS = ['Edit', 'MultiEdit', 'Write', 'NotebookEdit'];
  function broadRule(text) {
    const m = /^\s*([^()\s]+)\s*(?:\(([\s\S]*)\))?\s*$/.exec(String(text || ''));
    if (!m) return false;
    const tool = m[1];
    let content = (m[2] || '').trim();
    if (content === '*') content = '';
    if (tool === 'Bash') {
      const prefix = content.replace(/:?\*$/, '').trim();
      if (!prefix) return true;
      const words = prefix.split(/\s+/);
      const first = words[0].replace(/^["']+|["']+$/g, '').split('/').pop();
      const second = (words[1] || '').replace(/^["']+|["']+$/g, '');
      const runs = Object.prototype.hasOwnProperty.call(RUNS_WITH, first) ? RUNS_WITH[first] : null;
      if (runs && (!second || runs.includes(second))) return true;
      return RUNS_ANYTHING.has(first) || RUNS_ANYTHING.has(first.replace(/[\d.]+$/, '')) || riskyCommand(prefix);
    }
    if (EDITS.includes(tool)) {
      if (!content) return true;
      return !content.replace(/\/+$/, '').includes('/') || content.startsWith('//') || content.startsWith('~') || content.split('/').includes('..');
    }
    return false;
  }

  // A change in the Permissions pane that needs the fingerprint (kind 'rules', the backend's
  // Gate.rule_change): such an allow rule added, or a deny rule taken away (also by making it
  // an ask or an allow), have: the project's rules, {deny, ask, allow}; or allow rules
  // exported into a .claude settings file (Gate.export_ok), which Claude Code follows itself.
  function loosensRules({ behavior, rule, have, removing, exporting, allows } = {}) {
    if (exporting) return allows > 0;  // allow rules into a .claude file: Claude Code's own
    const denied = ((have && have.deny) || []).includes(String(rule || '').trim());
    if (removing) return behavior === 'deny' && denied;
    return (behavior === 'allow' && broadRule(rule)) || (behavior !== 'deny' && denied);
  }

  // Whether allowing this Eden Code approval is a risky step (only a session's steps, and
  // only a yes: a no is never held up).
  function risky(approval, choice) {
    const a = approval || {};
    if (a.tool === BYPASS_BY_VOICE) return ALLOWING.has(choice);  // full auto, asked for aloud
    // A card the backend marks for Touch ID itself (Exterminator Mode's landing of its fixes).
    if (a.touchid === true) return ALLOWING.has(choice);
    if (!a.task_id || !ALLOWING.has(choice)) return false;
    if (a.tool === 'Bash') return riskyCommand(String(a.detail || '').replace(/^\$\s*/, ''));
    if (['Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(a.tool)) return /outside the project/.test(String(a.question || ''));
    return false;
  }

  // What a yes is for, signed into its proof (round 3, R2-12): a risky step's card (its id),
  // the session Bypass is for (its id, or 'new': info.subject, from app.js confirmBypass),
  // nothing for the kinds with no one thing to name. The backend checks it's the same.
  function subject(kind, info) {
    const i = info || {};
    const raw = kind === 'approve' ? (i.approval && i.approval.id) : kind === 'bypass' ? i.subject : '';
    const text = raw === undefined || raw === null ? '' : String(raw);
    return /^[A-Za-z0-9_-]{0,40}$/.test(text) ? text : '';
  }

  const api = { risky, riskyCommand, broadRule, loosensRules, subject };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }

  const F = root.jarvisFeatures;
  if (!F || !F.registerCheck) return;
  const { el, t } = F;
  let on = true;  // prefs.features.code_touchid
  const bridge = () => (root.jarvisApp && root.jarvisApp.feature) || null;
  const lang = () => (root.jarvisI18n && root.jarvisI18n.lang() === 'zh' ? 'zh' : 'en');

  // A signed yes goes to the backend just before what it's for.
  function prove(kind, got, about = '') {
    if (got && got.relay) return relay(kind, about);
    if (got && got.ok && typeof got.proof === 'string' && got.proof) F.send({ type: 'code_touchid_proof', kind, proof: got.proof });
    return !!(got && got.ok);
  }

  // On the other app's backend: that app asks (its sheet), the backend keeps the proof.
  // true or false; null when nothing can ask (a backend run by hand: the usual question).
  const RELAY_MS = 3 * 60 * 1000;
  let waiting = null;  // {kind, done}: the one ask out
  function relay(kind, about = '') {
    if (waiting) return Promise.resolve(false);  // (one sheet at a time)
    return new Promise((resolve) => {
      const done = (ok) => { if (waiting && waiting.done === done) { clearTimeout(waiting.timer); waiting = null; resolve(ok); } };
      waiting = { kind, done, timer: setTimeout(() => done(false), RELAY_MS) };
      if (!F.send({ type: 'code_touchid_ask', kind, lang: lang(), subject: about })) done(false);
    });
  }
  F.on('code_touchid_answer', (ev) => {
    if (!waiting || !ev || ev.proof_kind !== waiting.kind) return;
    waiting.done(ev.unavailable ? null : ev.ok === true);
  });

  // The owner's fingerprint: true or false, or null where there's no Touch ID to ask with.
  // Without Touch ID, inside the app: the app's own dialog (true or false, signed the same).
  async function fingerprint(kind, about = '') {
    const app = bridge();
    if (!app) return null;
    let available = false;
    try { available = await app.invoke('feature:touchid:available'); } catch { available = false; }
    if (!available) {
      try {
        const got = await app.invoke('feature:touchid:confirm', kind, lang(), about);
        return got && got.unsupported ? null : prove(kind, got, about);
      } catch { return null; }
    }
    try {
      return prove(kind, await app.invoke('feature:touchid:prompt', kind, lang(), about), about);
    } catch { return false; }
  }

  const RISKY_QUESTION = 'This step can’t easily be undone, or reaches past this Mac. Allow it?';
  const RULES_QUESTION = 'This rule lets Eden Code do much more without asking you. Change it?';
  F.registerCheck((kind, info) => {
    if (!on) return null;
    if (kind === 'bypass' || kind === 'bypass-default') {
      return fingerprint(kind, subject(kind, info)).then((ok) => (ok === null ? root.confirm(t(info.text)) : ok));
    }
    if (kind === 'approve' && risky(info.approval, info.choice)) {
      return fingerprint('approve', subject('approve', info)).then((ok) => (ok === null ? root.confirm(t(RISKY_QUESTION)) : ok));
    }
    if (kind === 'rules' && loosensRules(info)) {
      return fingerprint('rules').then((ok) => (ok === null ? root.confirm(t(RULES_QUESTION)) : ok));
    }
    return null;
  });

  // Eden Code settings › General: its switch, in a Safety group of its own.
  let sw = null;
  function build() {
    const general = document.getElementById('jcs-general');
    if (!general || document.getElementById('ct-touchid')) return;
    const label = el('p', 'jcs-label', 'Safety');
    const group = el('div', 'jcs-group');
    const row = el('div', 'jcs-row');
    const text = el('span');
    text.append(document.createTextNode(t('Touch ID for Bypass and risky steps')),
      el('small', '', 'Switching to Bypass permissions, and allowing a step that deletes, pushes, publishes or runs as root, asks for your fingerprint. Without Touch ID, it asks you to confirm.'));
    sw = el('button', 'jcs-switch');
    sw.type = 'button';
    sw.id = 'ct-touchid';
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-label', 'Touch ID for Bypass and risky steps');
    sw.setAttribute('aria-checked', String(on));
    // Off asks for the fingerprint first, as Bypass does (the backend wants its proof). One
    // ask at a time: while it's out the switch is busy (aria-busy) and a second press does
    // nothing (round 2, U12: a double press asked twice). Never disabled for it: a disabled
    // button lets go of the focus, which fell to the page while the sheet was up (round 3,
    // U3-8); aria-disabled says it can't be pressed, and the guard holds.
    let asking = false;
    sw.addEventListener('click', () => {
      if (asking) return;
      if (!on) { F.send({ type: 'feature_prefs', changes: { code_touchid: true } }); return; }
      asking = true;
      sw.setAttribute('aria-disabled', 'true');
      sw.setAttribute('aria-busy', 'true');
      fingerprint('touchid-off').then((ok) => {
        const yes = ok === null ? root.confirm(t('Turn off Touch ID for Bypass and risky steps?')) : ok;
        if (yes) F.send({ type: 'feature_prefs', changes: { code_touchid: false } });
      }).finally(() => {
        asking = false;
        sw.removeAttribute('aria-disabled');
        sw.removeAttribute('aria-busy');
      });
    });
    row.append(text, sw);
    group.append(row);
    const foot = general.querySelector('.jcs-foot');
    if (foot) general.insertBefore(label, foot); else general.append(label);
    general.insertBefore(group, label.nextSibling);
  }
  const take = (features) => {
    on = !features || features.code_touchid !== false;
    if (sw) sw.setAttribute('aria-checked', String(on));
  };
  build();
  F.on('prefs', (ev) => take(ev.features), { replay: true });
  F.on('hello', (ev) => take(ev.prefs && ev.prefs.features), { replay: true });
})(typeof window === 'object' ? window : globalThis);
