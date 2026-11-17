// Eden Crew's card words (crew.js), pure: no page, no imports, so src/__tests__/crew-card.test.ts loads it as the
// page serves it. Money, ranges and time in the card's words, a step's money, the header's line, the done line.

export const ENDED = new Set(['done', 'stopped', 'failed']);
export const STATES = {
  planning: 'Planning on your Mac…', review: 'Plan ready for you', running: 'Working', paused: 'Paused',
  stopping: 'Stopping…', done: 'Done', stopped: 'Stopped', failed: 'Couldn’t finish',
};
export const STEP_STATES = {
  planned: 'Not started', waiting: 'Waiting', running: 'Working', retrying: 'Trying again', verifying: 'Checking',
  asking: 'Needs you', blocked: 'Blocked', done: 'Done', skipped: 'Skipped', stopped: 'Stopped', failed: 'Failed',
};
export const TYPES = { research: 'Research', write: 'Write', code: 'Code', build: 'Build', browse: 'Browse', checkpoint: 'Checkpoint' };
// (icons from the page's own sprite: each state also says itself in words)
export const MARK = { done: 'check', skipped: 'check', running: 'routine', retrying: 'retry', verifying: 'search', asking: 'info', failed: 'x', stopped: 'x', blocked: 'x' };

/** Money in the card's words: 41¢, $1.37, $12. */
export function money(v) {
  const n = Number(v) || 0;
  if (n > 0 && n < 1) return `${Math.max(1, Math.round(n * 100))}¢`;
  return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
}
/** A cost range ("15¢–$1.20"), or one figure when both ends agree. */
export function range(lo, hi) {
  return money(lo) === money(hi) ? money(hi) : `${money(lo)}–${money(hi)}`;
}
/** Work time: "31 min", "1 h 5 min". */
export function workTime(seconds) {
  const m = Math.round((Number(seconds) || 0) / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
}
/** A step's money: spend against its cap while it works, its estimate before, "On your plan" for a subscription. */
export function stepMoney(s) {
  if (s.billing === 'plan') return 'On your plan';
  if (s.billing === 'local') return 'On this Mac';
  if (s.type === 'checkpoint') return 'No cost';
  if (['planned', 'waiting'].includes(s.state) || !(s.spent > 0)) return range(s.est_low, s.est_high);
  return s.cap > 0 ? `${money(s.spent)} of ${money(s.cap)}` : money(s.spent);
}
/** The header's one line: "Working · 2 of 7 steps · $1.37 of $5.00 · 31 min". */
export function summaryLine(c) {
  const steps = c.steps || [];
  const done = steps.filter((s) => ['done', 'skipped'].includes(s.state)).length;
  const bits = [STATES[c.state] || c.state];
  if (c.state !== 'planning' && steps.length) bits.push(c.state === 'review' ? `${steps.length} steps` : `${done} of ${steps.length} steps`);
  if (c.state === 'review') bits.push(`${range(c.low, c.high)}${c.confidence ? `, ${c.confidence}` : ''}`);
  else if (c.state !== 'planning') bits.push(`${money(c.spent)} of ${money(c.ceiling)}`);
  if (c.active_seconds > 60 && !['review', 'planning'].includes(c.state)) bits.push(workTime(c.active_seconds));
  return bits.join(' · ');
}
/** What the done line says: "Made 3 files for $1.37 in 31 min." */
export function doneLine(c) {
  const made = (c.deliverables || []).filter((d) => d.size > 0).length;
  return `Made ${made} ${made === 1 ? 'file' : 'files'} for ${money(c.spent)} in ${workTime(c.active_seconds)}. They’re in the crew’s folder on your Mac.`;
}
export const live = (c) => !!c && !ENDED.has(c.state);
