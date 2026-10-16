// Eden Code settings › General › Security scanning (features/code_security.py): the switch
// for scanning each change with the security tools the owner has installed (feature pref
// code_security_scan, on), and the tools themselves: Semgrep, osv-scanner, npm audit and
// pip-audit, each installed or not, with the command that installs it. Eden Code never
// installs one, and a missing one never blocks anything. What they find shows on the turn's
// receipt (code-receipts.js), in Deep review (code_review.js) and on the push card. No model
// is called. Pure helpers are exported for node --test (tests/web/code-security.test.mjs).
(function (root) {
  'use strict';

  const LABEL = 'Scan changes with my security tools';
  const NOTE = 'Static analysis of the lines each change adds, and known vulnerabilities in the packages it brings in, shown on the receipt, in Deep review and before a push. Only tools installed on this Mac run; none is installed for you.';

  // Each tool's row: [its name, what it checks, whether it's installed, how to install it].
  function rows(tools) {
    return (Array.isArray(tools) ? tools : []).map((x) => [String(x.label || x.id || ''), String(x.what || ''), !!x.installed, String(x.install || '')]);
  }

  const api = { rows, LABEL, NOTE };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }

  const F = root.jarvisFeatures;
  if (!F) return;
  const { el, t, send } = F;
  let on = true;  // prefs.features.code_security_scan
  let tools = null;  // the last code_security_tools event's
  let sw = null;
  let list = null;

  function draw() {
    if (!list) return;
    if (!tools) { list.replaceChildren(el('div', 'jcs-row jc-dim', t('Looking for the tools…'))); return; }
    list.replaceChildren(...rows(tools).map(([label, what, installed, install]) => {
      const row = el('div', 'jcs-row jcx-sec-tool');
      const text = el('span');
      const name = el('span', '', label);
      name.dataset.noI18n = '';
      text.append(name, el('small', '', what));
      if (!installed) {
        const how = el('code', 'jcx-sec-install', install);
        how.dataset.noI18n = '';
        text.append(how);
      }
      row.append(text, el('span', `jcx-chip ${installed ? 'ok' : ''}`, installed ? t('Installed') : t('Not installed')));
      return row;
    }));
  }

  function build() {
    const general = document.getElementById('jcs-general');
    if (!general || document.getElementById('jcx-sec-switch')) return;
    const label = el('p', 'jcs-label', 'Security scanning');
    const group = el('div', 'jcs-group jcx-sec');
    const row = el('div', 'jcs-row');
    const text = el('span');
    text.append(document.createTextNode(t(LABEL)), el('small', '', NOTE));
    sw = el('button', 'jcs-switch');
    sw.type = 'button';
    sw.id = 'jcx-sec-switch';
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-label', t(LABEL));
    sw.setAttribute('aria-checked', String(on));
    sw.addEventListener('click', () => {
      on = !on;
      sw.setAttribute('aria-checked', String(on));
      send({ type: 'feature_prefs', changes: { code_security_scan: on } });
    });
    row.append(text, sw);
    list = el('div', 'jcx-sec-tools');
    const again = el('button', 'jc-btn small jcx-sec-again', 'Check again');
    again.type = 'button';
    again.title = t('Look again for the tools, after installing one');
    again.addEventListener('click', () => { tools = null; draw(); send({ type: 'code_security_tools' }); });
    const foot = el('div', 'jcs-row jcx-sec-foot');
    foot.append(el('span', 'jc-dim', 'Install a tool in Terminal, then check again.'), again);
    group.append(row, list, foot);
    const end = general.querySelector('.jcs-foot');
    if (end) general.insertBefore(label, end); else general.append(label);
    general.insertBefore(group, label.nextSibling);
    draw();
    send({ type: 'code_security_tools' });
  }

  const take = (features) => {
    on = !features || features.code_security_scan !== false;
    if (sw) sw.setAttribute('aria-checked', String(on));
  };
  build();
  F.on('code_security_tools', (ev) => { tools = ev.tools || []; draw(); });
  F.on('prefs', (ev) => take(ev.features), { replay: true });
  F.on('hello', (ev) => take(ev.prefs && ev.prefs.features), { replay: true });
})(typeof window === 'object' ? window : globalThis);
