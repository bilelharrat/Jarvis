// The first minute (ROADMAP Q4): under a new person's first answer, a small card that says what just happened, with
// that turn's real numbers: which model the router picked and why, what it cost against the most expensive model,
// and what the label under the reply means (or why there is none). Three starter prompts show routing, checking and a
// tool; the full try-it tour (I1, tour.js) is one link away, not repeated here. Pure: first-run.js draws it, and
// first-run.test.ts tests it.

/** localStorage key: { conv, node, at } once the card is given to a reply; { skip: true } for someone who isn't new; dismissed: true after ×. */
export const FIRST_KEY = 'eden:first-minute';

/** A reply that finished and was routed (it has a model to talk about). */
const answered = (n) => !!(n && n.role === 'assistant' && !n.error && (n.route || n.usage));

/** Someone is new when no chat holds an answered reply other than `exceptNodeId` (the first answer, the one being shown). */
export function isNewUser(convs, exceptNodeId) {
  return !(Array.isArray(convs) ? convs : []).some((c) => c && Object.values(c.nodes || {}).some((n) => n && n.id !== exceptNodeId && answered(n)));
}

/**
 * What to store when a reply finishes: the record to keep (or null for no change).
 * - a record already exists: nothing changes (the card belongs to the first answer only);
 * - practice mode (the tour's sandbox) or a temporary chat: nothing (the real first answer is still to come);
 * - a new person's first answer: { conv, node, at };
 * - anyone else: { skip: true }, so a person with history never sees it.
 */
export function claim(record, { isNew, conv, node, practice = false, temp = false, now = Date.now() }) {
  if (record && typeof record === 'object') return null;
  if (practice || temp || !conv || !node || node.role !== 'assistant') return null;
  if (!isNew) return { skip: true };
  if (!answered(node) || node.finish === 'aborted' || node.eves || (node.route && node.route.lane !== undefined)) return null; // wait for a plain, finished answer
  return { conv: conv.id, node: node.id, at: now };
}

/** The card goes under this reply now. */
export function showsFor(record, conv, node) {
  return !!(record && !record.skip && !record.dismissed && conv && node && record.conv === conv.id && record.node === node.id && !node.streaming && answered(node));
}

const clean = (v, max = 240) => {
  const t = String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Dollars, small ones readable ($0.0004, $0.012, $1.20). */
export function dollars(x) {
  if (num(x) === null) return '';
  if (x === 0) return '$0';
  if (x < 0.001) return `$${x.toPrecision(1)}`;
  if (x < 0.1) return `$${x.toFixed(3)}`;
  return `$${x.toFixed(2)}`;
}

const EFFORT_WORDS = { none: 'no extra thinking', minimal: 'minimal thinking', low: 'low effort', medium: 'medium effort', high: 'high effort', xhigh: 'extra-high effort', max: 'max effort' };

/** What each label under a reply means, in plain words. */
export const LABEL_MEANING = {
  from_sources: 'Every claim in the answer is cited, and Eden found it in the sources you gave it.',
  checked_on_web: 'Eden searched the web and cited what it found. Tap the label to see what was checked.',
  model_memory: 'The answer comes from the model’s memory: Eden couldn’t check it against a source, so double-check what matters.',
  issues_found: 'A check found a problem: Eden corrected or removed it, or flagged what it couldn’t fix. Tap the label for the details.',
  eves_verified: 'Several models answered and Eden settled where they disagreed.',
  eves_disputed: 'Several models answered and some claims couldn’t be settled.',
};
export const NO_LABEL =
  'No label under this reply: it was an everyday question, so Eden didn’t spend extra checking it. When a question is risky (health, money, law, exact figures, quotes, recent events), Eden searches or checks the answer and a label here says what it did.';

/**
 * The card's words from the turn's real numbers: { model, why, cost, label, ratio }.
 * `usage.topUSD` is the server's price of the same tokens on the most expensive model (H3); without it, the route's
 * own candidates give an estimate (said as such).
 */
export function explain(node) {
  const r = (node && node.route) || {};
  const u = (node && node.usage) || {};
  const name = clean(r.modelName || r.model || 'a model', 60);
  const effort = EFFORT_WORDS[r.effort] || '';
  const model = `Routed to ${name}${effort ? `, ${effort}` : ''}`;
  const why = clean(r.override ? 'You picked this model yourself, so the router stood aside.' : r.rationale || 'The router picked it for this kind of question: good enough for it, at the lowest price.', 260);

  let cost = '';
  let ratio = null;
  const paid = num(u.costUSD);
  const top = num(u.topUSD);
  if (paid !== null && top !== null && top > 0) {
    ratio = paid > 0 ? top / paid : null;
    // Subscription: its notional price counts the CLI's own prompt and cache tokens, which `top` doesn't, so it can be
    // the larger one; then a comparison would contradict the price on the reply's chip (QA 2026-10-09).
    if (u.notional) cost = `This answer ran on your Claude subscription, so nothing was billed.${paid < top ? ` The most expensive model would have cost ${dollars(top)} for the same words.` : ''}`;
    else if (paid >= top) cost = `This answer cost ${dollars(paid)}: the question needed the strongest model, so that is what it got.`;
    else cost = `This answer cost ${dollars(paid)}. The most expensive model would have cost ${dollars(top)} for the same words${ratio && ratio >= 1.5 ? `, about ${ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1)}× more` : ''}.`;
  } else {
    const cands = Array.isArray(r.candidates) ? r.candidates.filter((c) => num(c.costUSD) !== null) : [];
    const most = cands.reduce((m, c) => (!m || c.costUSD > m.costUSD ? c : m), null);
    const est = paid !== null ? paid : num(r.costUSD);
    if (est !== null && most && most.costUSD > est) {
      ratio = est > 0 ? most.costUSD / est : null;
      cost = `${paid !== null ? `This answer cost ${dollars(est)}` : `This answer was estimated at ${dollars(est)}`}. The priciest model the router considered, ${clean(most.name || most.model, 40)}, was estimated at ${dollars(most.costUSD)}.`;
    } else if (est !== null) cost = `This answer cost ${dollars(est)}.`;
  }

  const v = node && node.verification;
  const kind = v && v.label && v.label.kind;
  const label = kind && kind !== 'not_checked'
    ? { has: true, text: clean(v.label.text || '', 80), meaning: LABEL_MEANING[kind] || clean(v.label.detail || '', 260) }
    : { has: false, text: '', meaning: NO_LABEL };
  return { model, why, cost, ratio, label };
}

/** Three prompts that show what Eden does: routing, checking and a tool. */
export const STARTERS = [
  { kind: 'routing', title: 'See the router step up', text: 'Prove that there are infinitely many prime numbers, step by step.', why: 'A harder question gets a stronger model: compare its model and cost with this one.' },
  { kind: 'checking', title: 'See an answer checked', text: 'What is the population of Lisbon today, and where does that number come from?', why: 'An exact figure: Eden searches, cites its sources and labels the answer.' },
  { kind: 'tool', title: 'See a tool at work', text: 'Make an HTML page with a bouncing ball animation.', why: 'Eden builds it and opens it live in the canvas beside the chat.' },
];
