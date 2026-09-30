// Touch ID for Jarvis Code's riskiest moments (jarvisFeatures.registerCheck): a session
// switched into Bypass permissions, new sessions set to start in it, and a step allowed from
// its card that deletes, pushes, publishes, runs as root or edits outside the project. The
// app asks for the owner's fingerprint (app/features/touchid.js: macOS's own sheet, with the
// app's own words); where there's no Touch ID (or outside the app) the usual question asks
// instead. Its switch is in Jarvis Code settings › General (feature pref code_touchid).
//
// Answers given by voice, on the phone or from a notification are the owner's own there and
// go as they did. Pure helpers are exported for node --test (tests/web/code-touchid.test.mjs).
(function (root) {
  'use strict';

  const ALLOWING = new Set(['allow', 'always', 'allow_edits']);
  // Commands that can't easily be undone, or reach past this Mac.
  const RISKY = [
    /(^|[\s;&|(`])(sudo|doas)\s/,  // as root
    /(^|[\s;&|(`])rm\s+(-\w*[rRf]\w*|--recursive|--force)/,  // deleting folders, or without asking
    /\bgit\b[^;&|\n]*\s(push|reset\s+--hard|clean\s+-\w*f\w*|branch\s+-D|filter-branch|filter-repo)\b/,
    /\b(curl|wget)\b[^|\n]*\|\s*(sudo\s+)?\w*sh\b/,  // a download run as a script
    /(^|[\s;&|(`])(chmod|chown)\s+-\w*R/,
    /(^|[\s;&|(`])(dd\s[^|\n]*\bof=|mkfs\b|diskutil\s+(erase\w*|partition\w*|reformat|zero\w*))/,
    /(^|[\s;&|(`])(launchctl|csrutil|spctl|systemsetup|networksetup|defaults\s+(write|delete))\b/,
    /(^|[\s;&|(`])((npm|yarn|pnpm)\s+publish|twine\s+upload|cargo\s+publish|gem\s+push|docker\s+push|pod\s+trunk\s+push)\b/,
    /(^|[\s;&|(`])(kubectl\s+(delete|apply|drain)|terraform\s+(apply|destroy)|helm\s+(install|upgrade|uninstall|delete))\b/,
    /\b(drop\s+(table|database|schema)|truncate\s+table)\b/i,
    /(^|[\s;&|(`])(killall|pkill|shutdown|reboot|halt)\b/,
    /(^|[\s;&|(`])find\s[^;&|\n]*\s-delete\b/,
  ];

  // Whether a command is one of those.
  function riskyCommand(command) {
    const text = String(command || '');
    return RISKY.some((re) => re.test(text));
  }

  // Whether allowing this Jarvis Code approval is a risky step (only a session's steps, and
  // only a yes: a no is never held up).
  function risky(approval, choice) {
    const a = approval || {};
    if (!a.task_id || !ALLOWING.has(choice)) return false;
    if (a.tool === 'Bash') return riskyCommand(String(a.detail || '').replace(/^\$\s*/, ''));
    if (['Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(a.tool)) return /outside the project/.test(String(a.question || ''));
    return false;
  }

  const api = { risky, riskyCommand };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }

  const F = root.jarvisFeatures;
  if (!F || !F.registerCheck) return;
  const { el, t } = F;
  let on = true;  // prefs.features.code_touchid
  const bridge = () => (root.jarvisApp && root.jarvisApp.feature) || null;
  const lang = () => (root.jarvisI18n && root.jarvisI18n.lang() === 'zh' ? 'zh' : 'en');

  // The owner's fingerprint: true or false, or null where there's no Touch ID to ask with.
  async function fingerprint(kind) {
    const app = bridge();
    if (!app) return null;
    let available = false;
    try { available = await app.invoke('feature:touchid:available'); } catch { available = false; }
    if (!available) return null;
    try {
      const got = await app.invoke('feature:touchid:prompt', kind, lang());
      return !!(got && got.ok);
    } catch { return false; }
  }

  const RISKY_QUESTION = 'This step can’t easily be undone, or reaches past this Mac. Allow it?';
  F.registerCheck((kind, info) => {
    if (!on) return null;
    if (kind === 'bypass' || kind === 'bypass-default') {
      return fingerprint(kind).then((ok) => (ok === null ? root.confirm(t(info.text)) : ok));
    }
    if (kind === 'approve' && risky(info.approval, info.choice)) {
      return fingerprint('approve').then((ok) => (ok === null ? root.confirm(t(RISKY_QUESTION)) : ok));
    }
    return null;
  });

  // Jarvis Code settings › General: its switch, in a Safety group of its own.
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
    sw.addEventListener('click', () => F.send({ type: 'feature_prefs', changes: { code_touchid: !on } }));
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
