// The EVES glass pill's markup (glass.css is its look; docs/verify/ui.md "The glass pill").
//   glassPill({ tone, label, sub, compact, tag, prefix, title, className, attrs }) → the element:
//     <tag class="eves-glass" data-tone="ok|warn|bad|info"> orb · "EVES" · (divider · verdict) </tag>
//   toneOfLabel(kind, severity?) → 'ok' | 'warn' | 'bad' | 'info'
//   phraseOfLabel(kind, text?) → the short fixed phrase the pill shows (never the server's long words)
// Built with createElement and textContent only, so words from the server can never become markup. No imports (the
// tests load this file alone). A pill the person can click is a <button> (tag: 'button', with its aria-expanded and
// aria-controls in `attrs`); one that only says something is a <span> or <div>.

export const TONES = ['ok', 'warn', 'bad', 'info'];

// What each label kind is called when nothing finer is known (src/verify/types.ts LabelKind).
const KIND_TONE = { from_sources: 'ok', checked_on_web: 'ok', eves_verified: 'ok', eves_disputed: 'warn', issues_found: 'bad', model_memory: 'info' };

/**
 * The orb a label gets. `severity` is what the page already worked out for that label (verify-model.js
 * chipSeverity, eves-model.js badgeView): it carries the rules that must not bend (green only for a label
 * that earned it, and never while a claim is in doubt), so when it is given it decides. With none, the kind's
 * own tone; an unknown kind (or `not_checked`) is info.
 */
export function toneOfLabel(kind, severity) {
  if (TONES.includes(severity)) return severity;
  return Object.prototype.hasOwnProperty.call(KIND_TONE, kind) ? KIND_TONE[kind] : 'info';
}

// The pill shows one short phrase per label kind, whatever the server's label.text says; the long explanation lives in
// the panel the pill opens (and in the pill's title / aria-label). Kinds the badge adds for a run EVES itself judged.
const KIND_PHRASE = {
  issues_found: 'Issues found in this answer', eves_disputed: 'Not fully verified', from_sources: 'From your sources', checked_on_web: 'Checked on the web',
  model_memory: 'Unverified', eves_single: 'Not cross-checked', failed: 'Not verified', stopped: 'Not verified', eves_partial: 'Partly checked',
};
export const MAX_PHRASE = 28;
/** A phrase cut to at most `max` characters, with an ellipsis. */
export function capPhrase(text, max = MAX_PHRASE) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}
/**
 * What the pill says for a label kind. eves_verified keeps the page's own short words ("Checked by 3 models") when they
 * are at most 24 characters, else "Verified"; any other kind uses the fixed table above; a kind not in it keeps its
 * own words, capped. Always at most MAX_PHRASE (28) characters.
 */
export function phraseOfLabel(kind, text = '') {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (kind === 'eves_verified') return capPhrase(t && t.length <= 24 ? t : 'Verified');
  if (Object.prototype.hasOwnProperty.call(KIND_PHRASE, kind)) return KIND_PHRASE[kind];
  return capPhrase(t);
}

const TAGS = ['span', 'div', 'button'];

/**
 * One pill. `tone`: the orb. `label`: the wordmark (EVES). `sub`: the verdict, a short phrase (capped at 28 characters;
 * it also truncates with an ellipsis in CSS). `full`: the whole words behind it (default `sub`), in `title` and, on a
 * button, `aria-label`, so nothing is lost. `compact`:
 * the orb and EVES alone. `prefix`: what a screen reader hears first ("Caution: "), so colour is never the only
 * signal. `attrs`: more attributes (type, data-*, aria-*); `on…` attributes are refused. `className`: more classes.
 */
export function glassPill({ tone = 'info', label = 'EVES', sub = '', full = '', compact = false, tag = 'span', prefix = '', title = '', className = '', attrs = {} } = {}) {
  const t = TONES.includes(tone) ? tone : 'info';
  const words = capPhrase(sub);
  const whole = String(full || '').replace(/\s+/g, ' ').trim() || words;
  const showSub = !compact && !!words;
  const kind = TAGS.includes(tag) ? tag : 'span';
  const root = document.createElement(kind);
  root.className = ['eves-glass', compact || !showSub ? 'eves-glass-compact' : '', className].filter(Boolean).join(' ');
  root.setAttribute('data-tone', t);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false || /^on/i.test(k)) continue;
    root.setAttribute(k, String(v));
  }
  const said = `${String(label)}${showSub ? ` · ${whole}` : ''}`;
  root.setAttribute('title', title || said);
  const name = document.createElement('span');
  name.className = 'eves-glass-name';
  name.textContent = String(label);
  const orb = document.createElement('span');
  orb.className = 'eves-glass-orb';
  orb.setAttribute('aria-hidden', 'true');
  root.append(orb, name);
  if (showSub) {
    const div = document.createElement('i');
    div.className = 'eves-glass-div';
    div.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span');
    text.className = 'eves-glass-sub';
    text.textContent = words;
    root.append(div, text);
  }
  // a button's name is one string (its content would be read in pieces, and a truncated verdict not at all)
  if (kind === 'button') root.setAttribute('aria-label', `${prefix}${said}`);
  else if (prefix) {
    const sr = document.createElement('span');
    sr.className = 'sr-only';
    sr.textContent = prefix;
    root.prepend(sr);
  }
  return root;
}
