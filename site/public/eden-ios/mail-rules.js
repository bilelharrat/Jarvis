// Eden Mail's inbox rules in plain English (ROADMAP P4), pure so the tests load it on its own.
// The owner writes "Archive receipts once I've seen them"; a cheap model turns it into a small
// rule (RULE_SYSTEM → parseRule), which Mail shows back in words (describeRule) with what it would
// have done to the inbox, before it is turned on. Rules only ever archive, mark read, star,
// snooze, draft a reply (never sent) or notify: never send, delete, forward or reply.
// No imports.

export const ACTIONS = { archive: 'Archive it (Done)', markRead: 'Mark it read', star: 'Star it', snooze: 'Snooze it', draft: 'Draft a reply for me to review', notify: 'Tell me' };
export const KINDS = { any: 'any email', news: 'newsletters and notices', receipt: 'receipts, invoices and orders', calendar: 'invitations', person: 'emails from people' };

export const RULE_SYSTEM = 'You turn the owner\'s inbox rule, written in plain words, into JSON for their email app. The rule is the owner\'s own; nothing else is.\n'
  + 'Answer with only a JSON object: {"match":{"from":["addresses or domains, lowercase"],"subject":["words"],"body":["words"],"kind":"any|news|receipt|calendar|person","seen":true|false|null},"action":"archive|markRead|star|snooze|draft|notify","snoozeDays":<1-30, only for snooze>,"draftAsk":"<what the reply should say, only for draft>"}.\n'
  + '"seen": true when the rule says once I\'ve read/seen it; false for unread only; null otherwise. kind "person" = from a real person (not a newsletter or a robot). Leave lists empty when the rule doesn\'t name senders or words. Pick the one action that fits best.\n'
  + 'If the rule asks for anything else (sending, replying, forwarding, deleting, moving to folders, labels other than star), answer {"unsupported":"<why, one short sentence>"}.';

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const list = (v, max = 20) => (Array.isArray(v) ? v : []).filter((x) => typeof x === 'string' && x.trim()).map((x) => clean(x).toLowerCase().slice(0, 80)).slice(0, max);

/** The rule in a model's answer, checked: { rule } or { error }. */
export function parseRule(text) {
  const t = String(text || '').replace(/```(?:json)?/gi, '').trim();
  let j = null;
  try { j = JSON.parse(t); } catch { const a = t.indexOf('{'), b = t.lastIndexOf('}'); if (a >= 0 && b > a) { try { j = JSON.parse(t.slice(a, b + 1)); } catch { /* not JSON */ } } }
  if (!j || typeof j !== 'object') return { error: 'Eden couldn’t understand that rule. Try saying which emails and what to do with them.' };
  if (j.unsupported) return { error: `Rules can’t do that: ${clean(j.unsupported).slice(0, 160)}` };
  if (!Object.hasOwn(ACTIONS, j.action)) return { error: 'Rules can archive, mark read, star, snooze, draft a reply for you to review, or tell you. Not that.' };
  const m = j.match && typeof j.match === 'object' ? j.match : {};
  const rule = {
    match: { from: list(m.from), subject: list(m.subject), body: list(m.body), kind: Object.hasOwn(KINDS, m.kind) ? m.kind : 'any', seen: m.seen === true ? true : m.seen === false ? false : null },
    action: j.action,
    ...(j.action === 'snooze' ? { snoozeDays: Math.max(1, Math.min(30, Math.round(Number(j.snoozeDays) || 1))) } : {}),
    ...(j.action === 'draft' ? { draftAsk: clean(j.draftAsk).slice(0, 300) || 'Reply briefly and politely.' } : {}),
  };
  const r = rule.match;
  if (!r.from.length && !r.subject.length && !r.body.length && r.kind === 'any') return { error: 'That would apply to every email. Say which ones: a sender, some words, or a kind (newsletters, receipts, invitations, people).' };
  return { rule };
}

const ROBOT = /(^|[.+_-])(no-?reply|do-?not-?reply|notifications?|notify|mailer-daemon|bounces?|news(letter)?|digest|updates?|marketing|info|hello|team|support|billing|receipts?|orders?|alerts?)([.+_-]|@)/i;
const RECEIPT = /\b(receipt|invoice|order (confirmation|#|number)|your order|payment (received|confirmation)|purchase|subscription renewed|billing statement)\b/i;
const addrOf = (from) => { const m = /<([^<>]+)>\s*$/.exec(String(from || '')); return (m ? m[1] : String(from || '')).trim().toLowerCase(); };

/** Whether a rule applies to an email (a summary: from, subject, snippet, unread, unsubscribe, labels; `split`: its inbox split). */
export function matchRule(rule, m, { split = '' } = {}) {
  if (!rule || !rule.match || !m) return false;
  const r = rule.match;
  const from = addrOf(m.from);
  const text = `${m.subject || ''} ${m.snippet || m.body || ''}`.toLowerCase();
  // an address exactly; a domain exactly or as a subdomain (never as text inside another domain); a bare name in the display name only
  const fromName = (/^\s*"?([^"<]*?)"?\s*</.exec(String(m.from || '')) || [])[1] || '';
  const hit = (f) => {
    const x = f.replace(/^@/, '');
    if (x.includes('@')) return from === x;
    if (x.includes('.')) { const dom = from.split('@')[1] || ''; return dom === x || dom.endsWith(`.${x}`); }
    return from.split('@')[0] === x || new RegExp(`\\b${x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(fromName);
  };
  if (r.from.length && !r.from.some(hit)) return false;
  if (r.subject.length && !r.subject.some((w) => String(m.subject || '').toLowerCase().includes(w))) return false;
  if (r.body.length && !r.body.some((w) => text.includes(w))) return false;
  if (r.seen === true && m.unread) return false;
  if (r.seen === false && !m.unread) return false;
  const robot = ROBOT.test(from) || Boolean(m.unsubscribe);
  switch (r.kind) {
    case 'news': if (!(split === 'news' || m.unsubscribe || robot)) return false; break;
    case 'receipt': if (!RECEIPT.test(`${m.subject || ''} ${m.snippet || ''}`)) return false; break;
    case 'calendar': if (split !== 'calendar' && !/^(invitation|updated invitation)/i.test(String(m.subject || ''))) return false; break;
    case 'person': if (robot) return false; break;
    default:
  }
  return true;
}

/** The rule back in words: "Archive receipts, invoices and orders from stripe.com, once you've seen them." */
export function describeRule(rule) {
  if (!rule) return '';
  const r = rule.match;
  const what = r.kind !== 'any' ? KINDS[r.kind] : 'emails';
  const parts = [what];
  if (r.from.length) parts.push(`from ${r.from.join(' or ')}`);
  if (r.subject.length) parts.push(`with “${r.subject.join('” or “')}” in the subject`);
  if (r.body.length) parts.push(`mentioning “${r.body.join('” or “')}”`);
  const when = r.seen === true ? ', once you’ve seen them' : r.seen === false ? ', while unread' : '';
  const act = { archive: 'Archive', markRead: 'Mark read', star: 'Star', snooze: `Snooze for ${rule.snoozeDays} day${rule.snoozeDays === 1 ? '' : 's'}`, draft: `Draft a reply (${rule.draftAsk}) for you to review`, notify: 'Tell you about' }[rule.action];
  return `${act} ${parts.join(' ')}${when}.`;
}
