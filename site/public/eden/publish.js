// Turn a chat into an app (ROADMAP G10): "Publish" in the canvas keeps the artifact as a live
// page at askeden.com/p/<id> with a share link, "Only me" or "Anyone with the link", until it's
// taken down (site/src/accounts/published.js). Offered where Eden is signed in to askeden.com
// (the hosted page: meta.hosted, or a server that says meta.publish.available); elsewhere it
// says "Publish needs askeden.com" and offers the page as a standalone HTML file instead.
//
// publishedSection() is the "Published" list (who can see each, copy, open, take down), for
// the publish dialog and for the account page to mount: GET /api/chat/published →
// { pages: [{ id, url, title, access, bytes, created, updated }], max, bytes }.

import { el, ico, toast, copyText, download, sizeText } from './util.js';
import { state } from './state.js';
import { getJSON, postJSON, apiUrl } from './api.js';
import { PUBLISH_MAX_BYTES, byteSize, pageFileName, standaloneHtml } from './publish-rules.js';

let H = {};
export function initPublish(handlers = {}) { H = handlers; }

export const publishAvailable = () => !!(state.meta && (state.meta.hosted || (state.meta.publish && state.meta.publish.available)));

const ACCESS = {
  private: { label: 'Only me', note: 'You, signed in to Eden. Nobody else, even with the link.' },
  link: { label: 'Anyone with the link', note: 'No sign-in needed. Share it only with people you trust with what’s on it.' },
};
const absolute = (url) => new URL(apiUrl(url), location.href).href;

/** Save the page as a file (works everywhere, no account needed). */
export function downloadPage(title, html) {
  download(pageFileName(title), standaloneHtml(html, title), 'text/html');
  toast('Saved as an HTML file');
}

/** From the canvas: publish this artifact's HTML (or say why not, and offer the file). */
export function openPublish({ title, html }) {
  if (!H.openDialog) return;
  if (!publishAvailable()) {
    H.openDialog('Publish needs askeden.com', el('div', 'publish',
      el('p', 'pub-lead', 'Publishing keeps a live copy of this page at askeden.com, with a link to share. It needs Eden at askeden.com: sign in there to publish from your chats.'),
      el('p', 'pub-lead', 'Here you can save it as a standalone HTML file instead. It opens in any browser, offline, and can’t reach the network.'),
      el('div', 'dlg-acts',
        el('button', { type: 'button', class: 'btn', onclick: () => H.closeDialog() }, 'Close'),
        el('button', { type: 'button', class: 'btn primary', onclick: () => { downloadPage(title, html); H.closeDialog(); } }, ico('down', 14), 'Download HTML'))));
    return;
  }
  const size = byteSize(html);
  const name = el('input', { type: 'text', maxlength: 120, value: title || 'Untitled page', 'aria-label': 'Title' });
  name.value = title || 'Untitled page';
  let access = 'private';
  const choice = el('div', { class: 'pub-access', role: 'radiogroup', 'aria-label': 'Who can see it' });
  const drawChoice = () => choice.replaceChildren(...Object.entries(ACCESS).map(([k, a]) => el('button', {
    type: 'button', role: 'radio', 'aria-checked': String(access === k), class: `pub-opt${access === k ? ' on' : ''}`,
    onclick: () => { access = k; drawChoice(); choice.querySelector('[aria-checked="true"]').focus(); },
  }, ico(k === 'private' ? 'lock' : 'globe', 15), el('span', 'po-t', el('b', '', a.label), el('span', '', a.note)))));
  drawChoice();
  const go = el('button', { type: 'button', class: 'btn primary', disabled: size > PUBLISH_MAX_BYTES }, 'Publish');
  const err = el('div', { class: 'sp-warn', hidden: true, role: 'alert' });
  const body = el('div', 'publish',
    el('div', 'field', 'Title', name),
    el('div', 'field', 'Who can see it', choice),
    el('p', 'pub-note', `askeden.com keeps a live copy (${sizeText(size)}) until you take it down. It runs sandboxed: no network, no cookies, no forms.${size > PUBLISH_MAX_BYTES ? ' This one is over the 2 MB a page may be.' : ''}`),
    err,
    el('div', 'dlg-acts',
      el('button', { type: 'button', class: 'btn grow-l', onclick: () => downloadPage(name.value, html) }, ico('down', 14), 'Download HTML'),
      el('button', { type: 'button', class: 'btn', onclick: () => H.closeDialog() }, 'Cancel'),
      go));
  go.addEventListener('click', async () => {
    go.disabled = true;
    go.textContent = 'Publishing…';
    err.hidden = true;
    try {
      const page = await postJSON('/api/chat/publish', { html, title: name.value.trim(), access });
      showPublished(page);
    } catch (e) {
      err.replaceChildren(el('b', '', 'Couldn’t publish'), e.message);
      err.hidden = false;
      go.disabled = false;
      go.textContent = 'Publish';
    }
  });
  H.openDialog('Publish this page', body);
}

function linkRow(page) {
  const url = absolute(page.url);
  const input = el('input', { type: 'text', readonly: true, value: url, 'aria-label': 'Link to the page' });
  input.value = url;
  input.addEventListener('focus', () => input.select());
  return el('div', 'pub-link', input,
    el('button', { type: 'button', class: 'btn', onclick: () => copyText(url) }, ico('copy', 14), 'Copy'),
    el('a', { class: 'btn', href: url, target: '_blank', rel: 'noopener noreferrer' }, ico('ext', 14), 'Open'));
}

function showPublished(page) {
  H.openDialog('Published', el('div', 'publish',
    el('p', 'pub-lead', el('b', '', page.title), ` is live: ${ACCESS[page.access].label.toLowerCase()}.`),
    linkRow(page),
    el('p', 'pub-note', page.access === 'private' ? 'Only you can open it, signed in to Eden. Change who can see it below.' : 'Anyone with the link can open it. Take it down below whenever you like.'),
    publishedSection({ highlight: page.id }),
    el('div', 'dlg-acts', el('button', { type: 'button', class: 'btn primary', onclick: () => H.closeDialog() }, 'Done'))));
}

/** The account's published pages: change who sees each, copy, open, take down. */
export function publishedSection({ highlight } = {}) {
  const box = el('div', 'pub-list', el('div', 'muted', 'Loading your published pages…'));
  const draw = (data) => {
    const pages = data.pages || [];
    const head = el('div', 'pub-head', el('b', '', 'Published'), el('span', 'muted', `${pages.length} of ${data.max || 20}`));
    if (!pages.length) { box.replaceChildren(head, el('div', 'muted', 'Nothing published yet. Open an artifact in the canvas and press Publish.')); return; }
    box.replaceChildren(head, ...pages.map((p) => {
      const sel = el('select', { 'aria-label': `Who can see ${p.title}` }, ...Object.entries(ACCESS).map(([k, a]) => {
        const o = el('option', { value: k }, a.label);
        if (k === p.access) o.selected = true;
        return o;
      }));
      sel.addEventListener('change', async () => {
        try { await postJSON('/api/chat/published/access', { id: p.id, access: sel.value }); toast(`${p.title}: ${ACCESS[sel.value].label.toLowerCase()}`); }
        catch (e) { toast(`Couldn’t change it: ${e.message}`); load(); }
      });
      const down = el('button', { type: 'button', class: 'cap rev', title: 'Take it down: the link stops working at once' }, 'Take down');
      down.addEventListener('click', async () => {
        if (down.dataset.sure !== '1') { down.dataset.sure = '1'; down.textContent = 'Take down?'; setTimeout(() => { down.dataset.sure = ''; down.textContent = 'Take down'; }, 4000); return; }
        try { await postJSON('/api/chat/published/revoke', { id: p.id }); toast(`${p.title} is down`); load(); }
        catch (e) { toast(`Couldn’t take it down: ${e.message}`); }
      });
      return el('div', { class: `pub-row${p.id === highlight ? ' new' : ''}` },
        el('div', 'grow', el('a', { href: absolute(p.url), target: '_blank', rel: 'noopener noreferrer', class: 'pr-t' }, p.title),
          el('div', 'pr-c', `${sizeText(p.bytes)} · ${new Date(p.updated || p.created).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`)),
        sel,
        el('button', { type: 'button', class: 'iconbtn', title: 'Copy link', 'aria-label': `Copy the link to ${p.title}`, onclick: () => copyText(absolute(p.url)) }, ico('copy', 15)),
        down);
    }));
  };
  const load = () => getJSON('/api/chat/published').then(draw, (e) => box.replaceChildren(el('div', 'sp-warn', el('b', '', 'Couldn’t load your published pages'), e.message)));
  load();
  return box;
}
