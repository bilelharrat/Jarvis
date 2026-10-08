// askeden.com only: added to Eden's page by site/scripts/sync-eden.mjs (it isn't part of the
// Model Router's web/chat). Says who's signed in and what's left of the included AI, and
// signs this browser out. Everything else is Eden as it is on the Mac.

const ICON = 'M14 4.5h3.5a2 2 0 012 2v11a2 2 0 01-2 2H14M10 8l-4 4 4 4M6 12h9.5';

function svgIcon() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', 'ic');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', ICON);
  svg.append(path);
  return svg;
}

const money = (n) => (typeof n === 'number' ? `$${n.toFixed(2)}` : '');

function describe(session) {
  if (!session) return 'Signed in to askeden.com';
  const u = session.usage || {};
  const plus = session.plan && session.plan.active;
  const left = plus ? `${money(u.left_usd)} of Jarvis Plus AI left this month` : `${money(u.trial_left_usd)} of trial AI left`;
  return `Signed in to askeden.com · ${left}`;
}

async function signOut() {
  // In the Mac or iPhone app it's an app, not "this browser".
  const inApp = document.documentElement.classList.contains('eden-desktop') || document.documentElement.classList.contains('eden-app');
  if (!window.confirm(inApp ? 'Sign out of Eden?' : 'Sign this browser out of Eden?')) return;
  try {
    await fetch('/api/web/signout', { method: 'POST', headers: { 'content-type': 'application/json', 'X-Jarvis-Chat': '1' }, body: '{}' });
  } finally {
    location.replace('/');
  }
}

function mount(session) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'iconbtn';
  button.id = 'btnSignOut';
  button.title = `${describe(session)}. Sign out`;
  button.setAttribute('aria-label', document.documentElement.classList.contains('eden-desktop') || document.documentElement.classList.contains('eden-app') ? 'Sign out of Eden' : 'Sign out of Eden on this browser');
  button.append(svgIcon());
  button.addEventListener('click', signOut);
  const foot = document.querySelector('#sidebar .side-foot');
  if (foot) foot.append(button);
  else {
    button.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:50';
    document.body.append(button);
  }
}

async function main() {
  let session = null;
  try {
    const res = await fetch('/api/web/session', { headers: { 'X-Jarvis-Chat': '1' }, cache: 'no-store' });
    if (res.status === 401) {
      location.replace('/'); // signed out elsewhere (the app, or the 30 days ran out)
      return;
    }
    if (res.ok) session = await res.json();
  } catch {
    // offline: the page says so itself
  }
  mount(session);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', main, { once: true });
else main();
