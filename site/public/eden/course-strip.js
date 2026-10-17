// Under a reply in a course chat (Eden for Education, courses.js): the checked-answer strip, and the
// reply's text without its <sources> block. Its own small module so a chat page draws replies without
// loading the whole Courses panel (courses.js, its study tools and their models load when the panel opens).
// courses.js re-exports both, for the pages that import them from there (edu-app.js, tutor.js).
// Styles: courses.css (.crs-ground, .crs-src, .crs-hint).

import { el, ico } from './util.js';
import { hintNote } from './assignments.js'; // Q10: "Hint mode: graded assignment"

export const SHIELD = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 4 6v6c0 4.5 3.4 8.3 8 9 4.6-.7 8-4.5 8-9V6l-8-3z"/><path d="m9 12 2 2 4-4"/></svg>';
const svg = (html, cls = '') => { const s = el('span', cls); s.innerHTML = html; return s; }; // constant markup only

/** Under a reply in a course chat: Verified / Partly verified / Not verified / General, and the checked quotes. */
export function groundingStrip(g, courseId = null) {
  if (!g) return null;
  const where = g.scope === 'files' ? 'your files' : 'your course';
  const label = g.scope === 'web'
    ? (g.status === 'web' ? 'High-stakes question: checked against the web sources above' : 'High-stakes question: not checked against sources. Confirm with a professional.')
    : {
      verified: `Verified from ${where}`, partial: 'Partly verified',
      unverified: where === 'your files' ? 'Not verified: no quote was found in your files' : 'Not verified: no quote was found in your course materials', // AW3-1: cited, nothing checked out
      general: `Not from ${where === 'your files' ? 'your files' : 'your course materials'}`,
    }[g.status] || '';
  if (g.scope === 'web') return el('div', { class: `crs-ground ${g.status === 'web' ? 'partial' : 'general'}` }, el('div', 'crs-ground-h', ico('info', 12), label));
  const box = el('div', { class: `crs-ground ${g.status}` }, el('div', 'crs-ground-h', g.status === 'verified' ? svg(SHIELD) : ico('info', 12), label));
  if (g.hint) box.append(hintNote(g.hint)); // Q10: "Hint mode: graded assignment"
  for (const s of g.sources || []) {
    const open = courseId && s.doc && s.at ? () => dispatchEvent(new CustomEvent('eden:study-source', { detail: { course: courseId, doc: s.doc, loc: s.at, quote: s.ok ? s.quote : '' } })) : null;
    const said = `Source ${s.n}: ${s.file ? `${s.file}, ${s.at}` : 'none given'}${s.ok ? '' : s.file ? ', quote not found in the source' : ', unsupported'}${open ? '. Opens the page.' : ''}`;
    box.append(el(open ? 'button' : 'div', { ...(open ? { type: 'button', onclick: open, 'aria-label': said } : { role: 'note', 'aria-label': said }), class: `crs-src${s.ok ? '' : ' bad'}${open ? ' link' : ''}`, title: s.quote ? `“${s.quote}”` : '' },
      el('b', '', `${s.n}`), el('span', { class: 'crs-src-txt', ...(s.file ? { 'data-no-i18n': '' } : {}) }, s.file ? `${s.file} · ${s.at}` : 'No source given'),
      s.ok ? null : el('span', 'crs-flag', s.file ? 'quote not found in the source' : 'unsupported')));
  }
  return box;
}

/** A course reply's text for display: the <sources> block (shown by groundingStrip instead) cut off, also while it streams. */
export function stripSources(text) {
  const t = String(text).replace(/\s*<sources>[\s\S]*$/i, '');
  const lt = t.lastIndexOf('<');
  return lt >= 0 && t.length - lt < 9 && '<sources>'.startsWith(t.slice(lt).toLowerCase()) ? t.slice(0, lt).trimEnd() : t;
}
