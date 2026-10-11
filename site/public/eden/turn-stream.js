// What chat.js does with each event of a normal reply's stream (askeden opt2-ae-web: moved here from eves-model.js,
// so chat.js no longer needs that 48 KB module where EVES isn't offered: askeden.com). Import-free.

/**
 * What chat.js does with one event of a normal reply's stream (POST /api/chat/send). `phase` is 'reply' until the
 * reply's `done`, then 'after' (the turn is over for the person; the server may still send the label). →
 *   'eves'          an EVES stream came instead (an `eves` event): hand it to the EVES handler
 *   'ignore'        not for the reply: a lane's own event (lane 0..2, the work behind EVES), or, after `done`, anything
 *                   but the label, a late note and the end
 *   'done'          the reply is complete: end the turn now (composer, queue, approvals)
 *   'verification'  the label under the reply (before or after `done`)
 *   'note'          after `done`: a note about the finished reply that a server may send late (memory, grounding)
 *   'end'           the stream's last event
 *   'apply'         a reply event (route, text, usage, …), including EVES's final answer (lane "final")
 */
const LATE_NOTES = ['memory', 'grounding', 'refusal', 'research_report']; // research_report: the checked research report's title and sources (Q2)
export function turnStreamStep(phase, type, data) {
  const d = data && typeof data === 'object' ? data : {};
  if (type === 'verification') return 'verification';
  if (type === 'end') return 'end';
  if (phase === 'after') return LATE_NOTES.includes(type) && (d.lane === undefined || d.lane === null) ? 'note' : 'ignore';
  if (type === 'eves') return 'eves';
  if (d.lane !== undefined && d.lane !== null && d.lane !== 'final') return 'ignore';
  if (type === 'done') return 'done';
  return 'apply';
}
