// Acting for someone at askeden.com (ROADMAP H14 delegates, G8 team spaces): while this browser
// uses a delegate's grant or a space, askeden.com answers only the routes the grant allows
// (site/src/accounts/delegates.js grantAllows: chat, compare, artifacts, and Gmail / Google
// Calendar when the delegate was given them). Everything else (the Mac through Jarvis, Code,
// background tasks, the brief, voice…) would be a 403. So the page knows it is acting from the
// first moment (kept in localStorage by account.js, which checks it against
// GET /api/web/account once that loads), hides those panels (app.js renderSidebar), and api.js
// answers a request the grant can't make here, without sending it, as the server would.

const KEY = 'eden:acting';

function read() {
  try {
    const a = JSON.parse(localStorage.getItem(KEY) || 'null');
    return a && typeof a === 'object' && (a.type === 'delegate' || a.type === 'space') ? a : null;
  } catch {
    return null; // storage off: account.js says so once the account loads
  }
}

let current = read();

/** The grant this browser is using ({ type, id, label, features, expires }), or null. */
export const acting = () => current;

/** What GET /api/web/account said (or a "Use"/"Switch back" about to reload): true when it changed. */
export function setActing(a) {
  const next = a && typeof a === 'object' && (a.type === 'delegate' || a.type === 'space')
    ? { type: a.type, id: String(a.id || ''), label: String(a.label || ''), features: Array.isArray(a.features) ? a.features.filter((f) => typeof f === 'string') : ['chat'], expires: a.expires || null }
    : null;
  const changed = JSON.stringify(next) !== JSON.stringify(current);
  current = next;
  try {
    if (next) localStorage.setItem(KEY, JSON.stringify(next));
    else localStorage.removeItem(KEY);
  } catch { /* storage off: this page still knows */ }
  return changed;
}

/** Whether the grant has this feature ('chat', 'mail', 'calendar'). */
export const actingHas = (feature) => !current || (current.features || []).includes(feature);

// The routes a grant may use (delegates.js CHAT_ROUTES, MAIL_ROUTES, CALENDAR_ROUTES), and the
// person's own (their published pages and shared chats, ownRoute). /api/web/* is always this browser's own session.
const CHAT = new Set(['GET /api/chat/meta', 'POST /api/route', 'POST /api/chat/send', 'POST /api/chat/artifact', 'GET /api/chat/jarvis/status', 'POST /api/chat/compare', 'POST /api/chat/compare/estimate', 'POST /api/chat/compare/stop', 'POST /api/chat/browser/steer']);
const MAIL = new Set(['POST /api/chat/gmail', 'POST /api/chat/approve', 'GET /api/chat/google/status']);
const CALENDAR = new Set(['POST /api/chat/approve', 'GET /api/chat/gcal/status', 'POST /api/chat/gcal', 'GET /api/chat/google/status']);

/** Whether a request may go to askeden.com while acting (always true when not acting). */
export function actingAllows(method, path) {
  if (!current) return true;
  const p = String(path || '').replace(/[?#].*$/, '').replace(/\/+$/, '');
  if (!p.startsWith('/api/chat') && p !== '/api/route') return true;
  if (p === '/api/chat/publish' || p.startsWith('/api/chat/published')) return true;
  if (p === '/api/chat/share' || p === '/api/chat/shares' || p.startsWith('/api/chat/shares/')) return true; // their own shared chats (Q3)
  const route = `${String(method || 'GET').toUpperCase()} ${p}`;
  if (CHAT.has(route)) return true;
  return (actingHas('mail') && MAIL.has(route)) || (actingHas('calendar') && CALENDAR.has(route));
}

/** Why a panel isn't here while acting (and what api.js answers in place of the 403). */
export function actingWhy() {
  if (!current) return '';
  return current.type === 'space'
    ? `In ${current.label || 'a team space'} Eden is chat only. Switch back to use your Mac, tasks and the rest.`
    : `As ${current.label ? `${current.label}’s` : 'a'} delegate you can chat${actingHas('mail') ? ', read their mail' : ''}${actingHas('calendar') ? ', see their calendar' : ''} here. Switch back to use your own Mac, tasks and the rest.`;
}

/**
 * api.js's answer for a request the grant can't make: a 403 like the server's, made here, so
 * nothing is sent and nothing fails in the console. Jarvis's status says "not here" instead
 * (the owner's Mac is theirs: a delegate never reaches it), so the page treats the Mac as off.
 */
export function actingAnswer(method, path) {
  if (!current) return null;
  const p = String(path || '').replace(/[?#].*$/, '');
  if (String(method || 'GET').toUpperCase() === 'GET' && p === '/api/chat/jarvis/status') {
    return new Response(JSON.stringify({ available: false, reason: actingWhy() }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (actingAllows(method, path)) return null;
  return new Response(JSON.stringify({ error: actingWhy(), code: 'grant_forbidden' }), { status: 403, headers: { 'content-type': 'application/json' } });
}
