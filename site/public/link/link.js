// askeden.com/link: linking a Mac to this Eden account from the owner's browser (docs/web-auth.md
// "Linking a Mac from the browser"). J.A.R.V.I.S. on the Mac shows a code (and may open this page
// with it after #); the owner types or sees it, sees the Mac's name, and approves. Only a browser
// that signed in within the last 10 minutes may (askeden.com checks it again): otherwise "Sign in
// again", which comes back here with the code kept for this tab.

const $ = (id) => document.getElementById(id);
const KEPT = 'eden-link-mac-code';
const CODE = /^[0-9A-HJKMNP-TV-Z]{4}-?[0-9A-HJKMNP-TV-Z]{4}$/;
let asking = '';

function cleanCode(text) {
  const raw = String(text || '').trim().toUpperCase().replace(/^JARVIS-LINK:\/\//, '').replace(/^CODE=/, '').replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
  return CODE.test(raw) ? `${raw.slice(0, 4)}-${raw.slice(4)}` : null;
}

function kept(value) {
  try {
    if (value === undefined) return sessionStorage.getItem(KEPT) || '';
    if (value) sessionStorage.setItem(KEPT, value);
    else sessionStorage.removeItem(KEPT);
  } catch {
    // no storage here: the code is typed again
  }
  return '';
}

function status(text, kind = '') {
  $('status').textContent = text;
  $('status').className = `status ${kind}`.trim();
}

function alertText(text) {
  $('alert').textContent = text;
  $('alert').hidden = !text;
}

async function api(path, method = 'GET') {
  const init = { method, headers: { accept: 'application/json' }, credentials: 'same-origin' };
  if (method === 'POST') {
    init.headers['content-type'] = 'application/json';
    init.body = '{}';
  }
  const response = await fetch(path, init);
  if (response.status === 401) {
    location.assign('/signin?return=%2Flink');
    throw new Error('signed out');
  }
  const body = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || 'That didn’t work. Try again.');
    error.code = body.code || '';
    throw error;
  }
  return body;
}

function show(which) {
  $('stale').hidden = which !== 'stale';
  $('enter').hidden = which !== 'enter';
  $('ask').hidden = which !== 'ask';
  $('done').hidden = which !== 'done';
}

function stale() {
  show('stale');
  status('');
}

async function find(code) {
  status('Looking for your Mac…');
  $('find').disabled = true;
  try {
    const link = await api(`/api/web/mac-link/${encodeURIComponent(code)}`);
    if (!link.fresh) return stale();
    asking = link.code;
    $('macName').textContent = link.name || 'Mac';
    $('askCode').textContent = link.code;
    show('ask');
    status('');
    $('askTitle').focus();
  } catch (error) {
    status(error.message, 'warn');
  } finally {
    $('find').disabled = false;
  }
}

async function answer(approve) {
  $('approve').disabled = $('deny').disabled = true;
  status(approve ? 'Linking…' : '');
  try {
    await api(`/api/web/mac-link/${encodeURIComponent(asking)}/${approve ? 'approve' : 'deny'}`, 'POST');
    kept(null);
    if (approve) {
      show('done');
      status('Linked. J.A.R.V.I.S. on your Mac finishes by itself in a moment.', 'ok');
    } else {
      show('enter');
      $('code').value = '';
      status('Not linked. The code no longer works.');
    }
  } catch (error) {
    if (error.code === 'sign_in_again') return stale();
    show('enter');
    status(error.message, 'warn');
  } finally {
    $('approve').disabled = $('deny').disabled = false;
  }
}

async function start() {
  const fromHash = cleanCode(decodeURIComponent(location.hash.slice(1)));
  if (fromHash) {
    kept(fromHash);
    history.replaceState(null, '', location.pathname); // the code stays out of the history
  }
  const code = fromHash || cleanCode(kept());
  let ready;
  try {
    ready = await api('/api/web/mac-link');
  } catch (error) {
    if (error.message !== 'signed out') alertText(error.message);
    return;
  }
  if (!ready.fresh) return stale();
  show('enter');
  if (code) {
    $('code').value = code;
    await find(code);
  } else {
    $('code').focus();
  }
}

$('enter').addEventListener('submit', (event) => {
  event.preventDefault();
  const code = cleanCode($('code').value);
  if (!code) {
    status('A code has eight letters and numbers, like K7QM-4ZTR.', 'warn');
    return;
  }
  kept(code);
  find(code);
});
$('approve').addEventListener('click', () => answer(true));
$('deny').addEventListener('click', () => answer(false));
$('again').addEventListener('click', async () => {
  $('again').disabled = true;
  try {
    await fetch('/api/web/signout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', credentials: 'same-origin' });
  } catch {
    // signed out or not, the sign-in page comes next
  }
  location.assign('/signin?return=%2Flink');
});

start();
