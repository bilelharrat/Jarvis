// Documents in the main chat, as the Claude, ChatGPT and Gemini apps take them: a 📎 by each
// request box (and dropping one on the window) adds PDFs and text files (code, Markdown, CSV,
// JSON, logs…) beside the pictures waiting there. They go with the request the same way
// (app.js's askPics: {type, data, name}): a PDF as base64, a text file as its text, which
// screenwatch.user_message makes Claude's document blocks. Six attachments at most, the
// sizes attach.js allows. helpers is exported for node --test (tests/web/ask-files.test.mjs).
(function (root) {
  'use strict';

  const TEXT_EXT = /\.(md|markdown|txt|csv|tsv|json|jsonl|ya?ml|toml|ini|xml|html?|css|scss|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|kt|swift|m|c|h|cc|cpp|hpp|cs|php|sh|zsh|sql|log|rtf)$/i;

  const helpers = {
    // 'pdf', 'text', or '' for a file this doesn't take (pictures are app.js's).
    kindOf(name, type) {
      if (type === 'application/pdf' || /\.pdf$/i.test(name || '')) return 'pdf';
      if (String(type || '').startsWith('image/')) return '';
      if (String(type || '').startsWith('text/') || TEXT_EXT.test(name || '') || type === 'application/json') return 'text';
      return '';
    },
    // A small card for the box: the document's extension on a page.
    iconUrl(name) {
      const ext = (String(name || '').split('.').pop() || 'doc').slice(0, 4).toUpperCase().replace(/[^A-Z0-9]/g, '');
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect x="12" y="6" width="40" height="52" rx="6" fill="#1f2a38" stroke="#7fd4ff" stroke-width="2"/><path d="M20 22h24M20 30h24M20 38h16" stroke="#7fd4ff" stroke-width="2" stroke-linecap="round"/><text x="32" y="54" font-family="Helvetica, Arial" font-size="10" font-weight="700" fill="#ffffff" text-anchor="middle">${ext}</text></svg>`;
      return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
    },
  };

  if (typeof module === 'object' && module.exports) { module.exports = helpers; return; }

  const F = root.jarvisFeatures;
  if (!F) return;
  const t = (s) => F.t(s);
  /* global askPics, setAskPics, requestBox */

  function read(file, kind) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      if (kind === 'pdf') reader.readAsDataURL(file);
      else reader.readAsText(file);
    });
  }

  async function add(files) {
    const limits = root.JarvisAttach && root.JarvisAttach.LIMITS;
    for (const file of files) {
      const kind = helpers.kindOf(file.name, file.type);
      if (!kind) continue;
      if (typeof askPics === 'undefined' || typeof setAskPics !== 'function') return;
      const held = askPics.map((p) => ({ kind: String(p.type).startsWith('image/') ? 'image' : (p.type === 'application/pdf' ? 'binary' : 'text'), size: p.size || 0 }));
      const problem = root.JarvisAttach ? root.JarvisAttach.check(held, kind === 'pdf' ? 'binary' : 'text', file.size) : '';
      if (problem || (limits && askPics.length >= limits.files)) {
        notify(problem === 'files' || (limits && askPics.length >= limits.files) ? 'Up to six attachments per request.' : `${file.name} is too big to send.`);
        continue;
      }
      try {
        const raw = await read(file, kind);
        const doc = {
          type: kind === 'pdf' ? 'application/pdf' : 'text/plain',
          data: kind === 'pdf' ? raw.split(',', 2)[1] : raw,
          url: helpers.iconUrl(file.name),
          name: file.name,
          size: file.size,
          order: Date.now(),
        };
        setAskPics([...askPics, doc]);
      } catch (_) {
        notify(`${file.name} couldn’t be read.`);
      }
    }
    if (typeof requestBox === 'function' && requestBox()) requestBox().focus();
  }

  function notify(text) {
    if (typeof root.notice === 'function') root.notice('Jarvis', '', t(text), 5000);
  }

  function mount() {
    for (const box of document.querySelectorAll('[data-pics]')) {
      const form = box.parentElement;
      if (!form || form.querySelector('.af-btn')) continue;
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.hidden = true;
      input.accept = 'application/pdf,.pdf,text/*,.md,.markdown,.csv,.tsv,.json,.jsonl,.yml,.yaml,.toml,.xml,.html,.css,.js,.ts,.tsx,.jsx,.py,.rb,.go,.rs,.java,.kt,.swift,.c,.h,.cpp,.cs,.php,.sh,.sql,.log,.txt';
      input.addEventListener('change', () => { add([...input.files]); input.value = ''; });
      const btn = F.el('button', 'af-btn', '📎');
      btn.type = 'button';
      btn.title = t('Attach a document');
      btn.setAttribute('aria-label', t('Attach a document'));
      btn.addEventListener('click', () => input.click());
      form.append(btn, input);
    }
  }

  // A PDF or text file dropped on the window: pictures stay app.js's.
  root.addEventListener('drop', (e) => {
    const files = [...((e.dataTransfer && e.dataTransfer.files) || [])].filter((f) => helpers.kindOf(f.name, f.type));
    if (!files.length) return;
    e.preventDefault();
    add(files);
  }, true);
  root.addEventListener('dragover', (e) => {
    if ([...((e.dataTransfer && e.dataTransfer.items) || [])].some((i) => i.kind === 'file')) e.preventDefault();
  }, true);

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})(typeof window !== 'undefined' ? window : globalThis);
