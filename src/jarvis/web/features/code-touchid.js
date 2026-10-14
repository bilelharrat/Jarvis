// Touch ID for Eden Code's riskiest moments (jarvisFeatures.registerCheck): a session
// switched into Bypass permissions (on screen, or by voice: its card's tap), new sessions
// set to start in it, and a step allowed from its card that deletes, pushes, publishes,
// runs as root or edits outside the project. The app asks for the owner's fingerprint
// (app/features/touchid.js: macOS's own sheet, with the app's own words); where there's no
// Touch ID (or outside the app) the usual question asks instead. Its switch is in Eden Code
// settings › General (feature pref code_touchid).
//
// Answers given by voice, on the phone or from a notification are the owner's own there and
// go as they did. Pure helpers are exported for node --test (tests/web/code-touchid.test.mjs).
//
// The backend wants proof (audit S30, features/code_touchid.py's gate): a yes the app's main
// process saw is signed there, and sent just before the switch or the answer it's for
// (code_touchid_proof {kind, proof}). On a Mac without Touch ID the app asks with a dialog of
// its own (feature:touchid:confirm), which signs the same way; a page outside the app can't
// prove anything, so it asks its usual question and the backend says what's needed.
(function (root) {
  'use strict';

  const ALLOWING = new Set(['allow', 'always', 'allow_edits']);
  // The tap-only card that turns on Bypass permissions asked for by voice (voicecode.py).
  const BYPASS_BY_VOICE = 'code_bypass_by_voice';
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

  // Whether allowing this Eden Code approval is a risky step (only a session's steps, and
  // only a yes: a no is never held up).
  function risky(approval, choice) {
    const a = approval || {};
    if (a.tool === BYPASS_BY_VOICE) return ALLOWING.has(choice);  // full auto, asked for aloud
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

  // A signed yes goes to the backend just before what it's for.
  function prove(kind, got) {
    if (got && got.ok && typeof got.proof === 'string' && got.proof) F.send({ type: 'code_touchid_proof', kind, proof: got.proof });
    return !!(got && got.ok);
  }

  // The owner's fingerprint: true or false, or null where there's no Touch ID to ask with.
  // Without Touch ID, inside the app: the app's own dialog (true or false, signed the same).
  async function fingerprint(kind) {
    const app = bridge();
    if (!app) return null;
    let available = false;
    try { available = await app.invoke('feature:touchid:available'); } catch { available = false; }
    if (!available) {
      try {
        const got = await app.invoke('feature:touchid:confirm', kind, lang());
        return got && got.unsupported ? null : prove(kind, got);
      } catch { return null; }
    }
    try {
      return prove(kind, await app.invoke('feature:touchid:prompt', kind, lang()));
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
