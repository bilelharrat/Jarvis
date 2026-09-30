// Settings › Jarvis in other apps (the backend is jarvis.features.jarvis_mcp): let Claude Code
// and Claude Desktop use Jarvis as an MCP server (`jarvis mcp`), whether each app session asks
// first, the setup lines to paste into them, and what they've done lately. Paths, app names
// and commands are this Mac's and the apps' own: shown as data.
(() => {
  const F = window.jarvisFeatures;
  if (!F) return;
  const { el, send } = F;

  let state = null;
  let drawn = '';

  function mine(node) {
    node.setAttribute('data-no-i18n', '');
    return node;
  }

  function toggle(id, label, help) {
    const row = el('div', 'row');
    const words = el('span');
    words.append(el('strong', '', label), el('small', '', help));
    const sw = el('button', 'switch');
    sw.type = 'button';
    sw.id = id;
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-checked', 'false');
    sw.setAttribute('aria-label', label);
    row.append(words, sw);
    return row;
  }

  function snippet(id, label, help) {
    const box = el('div', 'mcp-snippet');
    const head = el('div', 'mcp-snippet-head');
    const copy = el('button', 'btn', 'Copy');
    copy.type = 'button';
    copy.addEventListener('click', async () => {
      const text = F.$(id).textContent;
      try {
        await navigator.clipboard.writeText(text);
        copy.textContent = F.t('Copied');
      } catch (_) {  // no clipboard here: the text is selected to copy by hand
        const range = document.createRange();
        range.selectNodeContents(F.$(id));
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }
      setTimeout(() => { copy.textContent = F.t('Copy'); }, 1500);
    });
    head.append(el('strong', '', label), copy);
    const pre = mine(el('pre', 'mcp-code'));
    pre.id = id;
    box.append(head, el('small', '', help), pre);
    return box;
  }

  function group() {
    let section = F.$('mcp-group');
    if (section) return section;
    const settings = F.$('settings');
    if (!settings) return null;
    section = el('section', 'group mcp-group');
    section.id = 'mcp-group';
    const enable = toggle('sw-mcp', 'Let Claude Code and Claude Desktop use Jarvis', 'They can search your second brain and read a note, recall what Jarvis remembers, read your calendar and send you heads-ups. Only apps on this Mac, through a private connection.');
    const ask = toggle('sw-mcp-ask', 'Ask when an app starts using Jarvis', 'A card, said aloud, the first time each app session reaches in. What it reads goes to that app and the model behind it.');
    enable.querySelector('.switch').addEventListener('click', () => send({ type: 'mcp_enable', on: !(state && state.enabled) }));
    ask.querySelector('.switch').addEventListener('click', () => send({ type: 'mcp_ask', on: !(state && state.ask) }));
    const status = el('p', 'small-status mcp-status');
    status.id = 'mcp-status';
    const setup = el('div', 'mcp-setup');
    setup.id = 'mcp-setup';
    setup.append(
      snippet('mcp-code-cli', 'Claude Code', 'Run this once in Terminal:'),
      snippet('mcp-code-desktop', 'Claude Desktop', 'In Claude Desktop, Settings › Developer › Edit Config: add this to claude_desktop_config.json, then restart Claude Desktop.'),
    );
    const recent = el('ul', 'mcp-recent');
    recent.id = 'mcp-recent';
    section.append(el('h3', '', 'Jarvis in other apps'), enable, ask, status, setup, recent);
    const last = settings.querySelector('#open-accounts');
    const before = last ? last.closest('section.group') : null;
    if (before) settings.insertBefore(section, before); else settings.append(section);
    return section;
  }

  const TOOL_WORDS = {
    search_notes: 'Searched your second brain',
    read_note: 'Read a note',
    recall: 'Recalled what Jarvis remembers',
    calendar: 'Read your calendar',
    notify_me: 'Sent you a heads-up',
  };

  function render() {
    if (!group() || !state) return;
    const sig = JSON.stringify(state);
    if (sig === drawn) return;
    drawn = sig;
    F.$('sw-mcp').setAttribute('aria-checked', String(!!state.enabled));
    F.$('sw-mcp-ask').setAttribute('aria-checked', String(!!state.ask));
    F.$('sw-mcp-ask').disabled = !state.enabled;
    const status = F.$('mcp-status');
    status.classList.toggle('bad', !!state.error);
    if (state.error) status.textContent = state.error;
    else if (state.enabled && state.running) status.textContent = F.t('On: apps you set up below can reach Jarvis while it runs.');
    else if (state.enabled) status.textContent = F.t('Starting…');
    else status.textContent = F.t('Off: no app can reach Jarvis.');
    F.$('mcp-setup').hidden = !state.enabled;
    F.$('mcp-code-cli').textContent = state.code_command || '';
    F.$('mcp-code-desktop').textContent = state.desktop_json || '';
    const recent = F.$('mcp-recent');
    const items = (state.recent || []).slice(0, 8);
    recent.hidden = !items.length || !state.enabled;
    recent.replaceChildren(...items.map((r) => {
      const li = el('li', r.ok ? '' : 'mcp-failed');
      const when = new Date(r.at);
      const time = el('time', '', Number.isNaN(when.getTime()) ? '' : when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
      li.append(time, mine(el('span', 'mcp-app', r.app)), el('span', '', TOOL_WORDS[r.tool] || r.tool));
      return li;
    }));
  }

  F.on('hello', () => { group(); send({ type: 'mcp_state' }); }, { replay: true });
  F.on('jarvis_mcp', (ev) => { state = ev; render(); });
})();
