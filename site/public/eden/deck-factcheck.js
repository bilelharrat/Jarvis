// EVES fact-check in the slide editor (web only). "Check facts on this slide" (Inspector › Format › Check facts, and
// the slide/thumbnail right-click menu) and "Check the whole deck…" (Inspector › Document › Check facts, after a
// card with the estimated cost) send the words the slides show to Eden's existing check, POST /api/chat/eves/check
// (src/chat/eves-check.ts → src/verify/check.ts), the same check as "Check with EVES" on a chat reply. Nothing is
// sent until the person clicks. The result is kept with the deck version (version.factCheck) and carried to later
// versions for the boxes whose words haven't changed; claims are marked on the slide (deck-marks to the frame) and
// listed per slide with their sources; "Fix with sources" rewrites a claim from its sources, cites it and adds the
// source to the sources slide (a preview first, then one version). A toolbar badge shows the deck's count.
// Off when the server's switch is off (meta.evesCheck), and never in the iPhone app (deck.js imports this only
// when !IN_APP). The words and the mapping are in deck-factcheck-model.js (pure, tested).
// On askeden.com, where check-anything isn't served but EVES is (meta.eves), the same buttons run the live EVES
// chat pipeline as it is (POST /api/chat/eves through eves.js beginEves, one run per slide; the cost card prices
// each slide with POST /api/chat/eves/estimate, which calls no model). deck-factcheck-hosted.js maps EVES's checked
// answer and its judge's verdicts onto the same per-claim result, so the marks, the list and Fix with sources work
// the same way. The Mac's own check (check-anything) stays first wherever it is on.

import { el } from './util.js';
import { postJSON } from './api.js';
import { state, saveConversation } from './state.js';
import { routeSettings } from './router.js';
import { deckCanvasVersion } from './artifact.js';
import { evesCheckAvailable } from './eves-check.js';
import { beginEves, evesAvailable } from './eves.js';
import { usd as usdWords, secondsWords } from './eves-model.js';
import { IN_APP_SHELL } from './native.js'; // IN_APP is false in the iPhone app since 2026-11-05 (it gets the whole website); hosted EVES stays out of any app shell
import * as H from './deck-factcheck-hosted.js';
import { registerInspector, registerContextMenu, registerTool, kit, icon, context, onSelection } from './deck-shell.js';
import * as F from './deck-factcheck-model.js';
import { modelJob, busyAi } from './deck-ai.js';

const tx = (s) => context().tx(s);
let running = null; // { scope, slides, ctl, done?, total? }

// ── the result kept with the version ──

const versions = (c) => (c && Array.isArray(c.deckVersions) ? c.deckVersions : []);
/** The stored version shown in the canvas, or null. */
function shownVersion(c) {
  let v = null;
  try { v = deckCanvasVersion(); } catch { /* no canvas on this page */ }
  const vs = versions(c);
  if (v && Number.isInteger(v.deckIdx) && vs[v.deckIdx]) return vs[v.deckIdx];
  return vs.at(-1) || null; // the canvas shows no stored version: the newest
}
/** The shown version's check: its own, or the nearest earlier one's carried forward (claims on unchanged boxes). */
export function resultNow(c = context().conv) {
  const vs = versions(c);
  const v = shownVersion(c);
  if (!v) return null;
  if (v.factCheck) return v.factCheck;
  for (let k = vs.indexOf(v) - 1; k >= 0; k--) {
    if (vs[k].factCheck) return F.carryResult(vs[k].factCheck, vs[k].deck, v.deck);
  }
  return null;
}
function keep(c, result) {
  const v = shownVersion(c);
  if (!v) return;
  v.factCheck = result;
  saveConversation(c);
  afterChange();
}

// ── running a check ──

async function sendCheck(built, scope, slides) {
  const c = context().conv;
  const ctl = new AbortController();
  running = { scope, slides, ctl };
  afterChange();
  try {
    const out = await postJSON('/api/chat/eves/check', { text: built.text, settings: routeSettings() }, { signal: ctl.signal, timeout: 95_000, late: 'EVES took too long. Try again.' });
    const r = F.slideResult(out, built, { scope, slides });
    if (r.error && !r.claims.length) { context().toast(tx(r.error)); return; }
    if (cur() !== c) return; // another chat is open now: the result still belongs to that deck's version, but don't draw it here
    keep(c, F.mergeResult(resultNow(c), r));
    const b = F.badgeOf(resultNow(c));
    if (b) context().toast(tx(b.text));
  } catch (e) {
    if (!(e && e.name === 'AbortError')) context().toast(`${tx('EVES couldn’t check that:')} ${(e && e.message) || ''}`.trim());
  } finally { running = null; afterChange(); }
}
const cur = () => context().conv;

/** One EVES run (the live chat pipeline, unchanged) on one slide's question → { state, answer, citations }. */
async function evesRun(q, outer, models) {
  const node = { id: `dfc-${Date.now().toString(36)}`, role: 'assistant', parts: [], citations: [] }; // a stand-in reply: nothing goes into the chat
  const ctrl = new AbortController();
  const turn = beginEves(node, { mode: 'on', ...(models && models.length ? { models } : {}) }, ctrl, () => {});
  let plain = ''; // a run the server answered without checking (no lanes) streams its answer untagged
  const onEvent = turn.onEvent;
  turn.onEvent = (type, d) => { if (type === 'text' && d && d.lane === undefined) plain += String(d.text || ''); onEvent.call(turn, type, d); };
  const stop = () => turn.stop();
  if (outer.signal.aborted) stop(); else outer.signal.addEventListener('abort', stop, { once: true });
  try {
    await turn.send({ messages: [{ role: 'user', content: q.prompt }], settings: routeSettings() });
    turn.end();
  } catch (e) {
    if (e && e.name === 'AbortError') turn.stopped(); else turn.failed((e && e.message) || 'EVES failed.');
    throw e;
  } finally { outer.signal.removeEventListener('abort', stop); }
  const answer = node.parts.map((p) => (p && p.type === 'text' ? p.text : '')).join('') || plain;
  return { state: turn.state, answer, citations: node.citations || [] };
}

/** The slides through hosted EVES, one run at a time (each holds part of the allowance while it runs). */
async function sendHosted(deck, slides, scope, models = {}) {
  const c = context().conv;
  const ctl = new AbortController();
  running = { scope, slides, ctl, done: 0, total: slides.length };
  afterChange();
  let merged = null, failed = '';
  try {
    for (const i of slides) {
      if (ctl.signal.aborted) break;
      const q = H.hostedPrompt(deck, i);
      if (q.items.length) {
        const r = await evesRun(q, ctl, models[i]);
        const one = H.hostedResult(r.state, r.answer, q.items, { scope: 'slide', slides: [i], citations: r.citations });
        if (one.error && !r.answer.trim()) failed = one.error;
        else merged = F.mergeResult(merged, one);
      }
      running.done++;
      afterChange();
    }
  } catch (e) {
    if (!(e && e.name === 'AbortError')) failed = (e && e.message) || 'EVES couldn’t check that.';
  } finally {
    running = null;
    if (merged && cur() === c) {
      const whole = scope === 'deck' && merged.slides.length === slides.filter((i) => H.hostedPrompt(deck, i).items.length).length;
      keep(c, whole ? { ...merged, scope: 'deck' } : F.mergeResult(resultNow(c), merged)); // a whole deck checked again replaces the old result; a part is folded in
      const b = F.badgeOf(resultNow(c));
      if (b) context().toast(tx(b.text));
    }
    if (failed) context().toast(`${tx('EVES couldn’t check that:')} ${failed}`);
    afterChange();
  }
}

export function checkSlide(i) {
  const c = context();
  if (!available() || running || !c.deck || !c.deck.slides[i]) return;
  const built = F.checkText(c.deck, [i]);
  if (built.text.trim().length < 20) { c.toast(tx('Nothing to check on this slide')); return; }
  if (local()) sendCheck(built, 'slide', [i]);
  else sendHosted(c.deck, [i], 'slide');
}

export function checkDeck() {
  const c = context();
  if (!available() || running || !c.deck) return;
  const built = F.checkText(c.deck);
  if (built.text.trim().length < 20) { c.toast(tx('Nothing to check in this deck')); return; }
  if (!local()) { hostedCard(c.deck); return; }
  const e = F.checkEstimate(built.text);
  const meta = state.meta && state.meta.evesCheck;
  const left = meta && Number.isFinite(Number(meta.left)) ? Number(meta.left) : null;
  const go = kit.button({ label: tx('Check the deck'), primary: true, key: 'fc-go', disabled: left === 0, onClick: () => { s.close(); sendCheck(built, 'deck', c.deck.slides.map((_, k) => k)); } });
  const s = kit.sheet({
    title: tx('Check the whole deck with EVES'),
    content: el('div', { class: 'dfc-confirm' },
      el('p', '', tx('EVES (Eden’s verification and evaluation system) reads the words on your slides and checks each factual claim against web sources. Nothing has been sent yet.')),
      el('dl', { class: 'dfc-est' },
        el('dt', '', tx('Slides')), el('dd', '', String(c.deck.slides.filter((x) => x.layout !== 'sources').length)),
        el('dt', '', tx('Claims, about')), el('dd', '', String(e.claims || 1)),
        el('dt', '', tx('Estimated cost')), el('dd', { 'data-fc': 'estimate' }, e.words),
        ...(left !== null ? [el('dt', '', tx('Checks left today')), el('dd', '', String(left))] : [])),
      built.truncated ? el('p', { class: 'dsh-hint' }, tx('The deck is long: only the start will be checked.')) : null,
      el('p', { class: 'dsh-hint' }, tx('Takes up to a minute. The result is kept with this version of the deck.'))),
    actions: [kit.button({ label: tx('Cancel'), quiet: true, onClick: () => s.close() }), go],
  });
  requestAnimationFrame(() => go.focus());
}

/** The cost card for a whole-deck check through hosted EVES: each slide priced by the estimator (no model call). */
async function hostedCard(deck) {
  const slides = deck.slides.map((_, k) => k).filter((k) => H.hostedPrompt(deck, k).items.length);
  const est = el('dd', { 'data-fc': 'estimate' }, tx('Working it out…'));
  const time = el('dd', '', '…');
  const ctl = new AbortController();
  let models = {};
  const go = kit.button({ label: tx('Check the deck'), primary: true, key: 'fc-go', disabled: true, onClick: () => { s.close(); sendHosted(deck, slides, 'deck', models); } });
  const s = kit.sheet({
    title: tx('Check the whole deck with EVES'),
    content: el('div', { class: 'dfc-confirm' },
      el('p', '', tx('EVES (Eden’s verification and evaluation system) asks several models about each slide’s statements, checks the ones they disagree on against the web, and grades each one. Nothing has been checked yet.')),
      el('dl', { class: 'dfc-est' },
        el('dt', '', tx('Slides')), el('dd', '', String(slides.length)),
        el('dt', '', tx('Estimated cost')), est,
        el('dt', '', tx('Takes about')), time),
      el('p', { class: 'dsh-hint' }, tx('One EVES check per slide, like one EVES reply each. The result is kept with this version of the deck.'))),
    actions: [kit.button({ label: tx('Cancel'), quiet: true, onClick: () => s.close() }), go],
    onClose: () => ctl.abort(),
  });
  try {
    const list = await Promise.all(slides.map((k) => postJSON('/api/chat/eves/estimate', { prompt: H.hostedPrompt(deck, k).prompt, settings: routeSettings(), mode: 'on' }, { signal: ctl.signal, timeout: 20_000 }).catch(() => null)));
    const e = H.hostedEstimate(list, usdWords);
    models = Object.fromEntries(slides.map((k, j) => [k, list[j] && Array.isArray(list[j].lanes) ? list[j].lanes.filter((l) => l && l.model).map((l) => ({ model: l.model, ...(l.effort ? { effort: l.effort } : {}) })) : null]).filter(([, m]) => m && m.length)); // what was priced is what runs
    est.textContent = e.slides ? e.words : tx('Couldn’t be worked out');
    const secs = list.reduce((n, x) => n + (x && Number.isFinite(Number(x.latencyS)) ? Number(x.latencyS) : 0), 0);
    time.textContent = secs ? secondsWords(secs) : tx('a minute a slide');
    go.disabled = !e.slides;
    if (e.slides) requestAnimationFrame(() => go.focus());
  } catch { est.textContent = tx('Couldn’t be worked out'); }
}

// ── Fix with sources ──

async function fixClaim(claim) {
  const c = context();
  const deck = c.deck;
  if (!deck || busyAi() || !F.canFix(claim)) return;
  const value = deck.slides[claim.slide] && (await import('./deck-ai-model.js')).fieldValue(deck.slides[claim.slide], claim.path);
  if (typeof value !== 'string') { c.toast(tx('That text isn’t on the slide any more')); return; }
  const { sources, ns } = F.addSources(deck, claim.sources);
  if (!ns.length) { c.toast(tx('No source to cite')); return; }
  const p = F.fixPrompt(claim, value, ns);
  const r = await modelJob({
    title: tx('Fix with sources'), system: p.system, user: p.user,
    make: (reply) => F.applyFix(deck, claim, reply, ns, sources),
    show: (fix) => el('div', { class: 'dai-diff' },
      el('div', { class: 'dai-was' }, el('span', { class: 'dai-tag' }, tx('Now')), el('p', '', fix.before)),
      el('div', { class: 'dai-now' }, el('span', { class: 'dai-tag' }, tx('Corrected from the sources')), el('p', { 'data-ai-result': '' }, fix.after)),
      el('ul', { class: 'dfc-srcs' }, ...ns.map((n) => { const s = sources.find((x) => x.n === n); return s ? el('li', '', `[${n}] `, el('a', { href: s.url, target: '_blank', rel: 'noopener noreferrer' }, s.title)) : null; }))),
    warn: () => ['Check the new wording against the sources before you accept: EVES checked the claim, the rewrite is the model’s.'],
  });
  if (!r) return;
  const now = context().deck;
  if (!now || JSON.stringify(now.slides[claim.slide]) !== JSON.stringify(deck.slides[claim.slide])) { c.toast(tx('The slide changed while Eden was working. Try again.')); return; }
  const old = resultNow(c.conv);
  c.commit(r.deck, { toastText: tx('Claim fixed and cited') });
  const conv = c.conv, vs = versions(conv), v = vs.at(-1);
  if (old && v) { v.factCheck = F.carryResult(old, deck, r.deck, { fixed: claim.id }); saveConversation(conv); afterChange(); }
}

// ── drawing ──

/** check-anything (the Mac's server), else hosted EVES (askeden.com), never in the iPhone app. */
const local = () => { try { return evesCheckAvailable(); } catch { return false; } };
const hosted = () => { if (IN_APP_SHELL) return false; try { return evesAvailable(); } catch { return false; } };
const available = () => local() || hosted();

function pill(claim) {
  const v = F.VERDICTS[claim.verdict] || F.VERDICTS.unverified;
  return el('span', { class: `dfc-pill t-${v.tone}${claim.fixed ? ' fixed' : ''}` }, el('span', { 'aria-hidden': 'true' }, claim.fixed ? '✓' : v.mark), tx(claim.fixed ? 'Fixed' : v.word));
}
function claimRow(claim, { showSlide = false } = {}) {
  const box = el('details', { class: 'dfc-claim', 'data-verdict': claim.verdict },
    el('summary', '', pill(claim), el('span', { class: 'dfc-ct' }, showSlide && claim.slide >= 0 ? `${tx('Slide')} ${claim.slide + 1}: ${claim.text}` : claim.text)));
  const v = F.VERDICTS[claim.verdict] || F.VERDICTS.unverified;
  box.append(el('p', { class: 'dfc-why' }, tx(v.said), claim.reason ? ` ${claim.reason}` : ''));
  if (claim.sources && claim.sources.length) box.append(el('ul', { class: 'dfc-srcs' }, ...claim.sources.map((s) => el('li', '', el('a', { href: s.url, target: '_blank', rel: 'noopener noreferrer' }, s.title || s.site), s.quote ? el('q', '', s.quote) : null))));
  else if (claim.verdict !== 'not_a_claim') box.append(el('p', { class: 'dsh-hint' }, tx('No sources for this one.')));
  if (F.canFix(claim)) box.append(kit.button({ label: tx('Fix with sources'), small: true, icon: 'wand', key: `fc-fix-${claim.id}`, onClick: () => fixClaim(claim) }));
  else if (claim.path === 'chart' || /^(stats|table|diagram)\.\d+$/.test(claim.path)) { if (claim.verdict !== 'supported' && claim.verdict !== 'not_a_claim') box.append(el('p', { class: 'dsh-hint' }, tx('Edit the data on the slide to fix this one.'))); }
  return box;
}
function badgeEl(result) {
  const b = F.badgeOf(result);
  if (!b) return null;
  return el('p', { class: `dfc-badge t-${b.tone}`, role: 'status' }, icon('check', 14), tx(b.text), result.costUSD ? el('span', { class: 'dfc-cost' }, ` · ${result.costUSD < 0.01 ? '<$0.01' : `$${result.costUSD.toFixed(2)}`}`) : null);
}
const offNote = () => el('p', { class: 'dsh-hint' }, tx('EVES checking isn’t switched on for this Eden yet.'));
const spinner = (t) => el('p', { class: 'dai-wait', role: 'status' }, el('span', { class: 'dai-spin', 'aria-hidden': 'true' }), t, ' ', kit.button({ label: tx('Stop'), small: true, quiet: true, onClick: () => running && running.ctl.abort() }));

registerInspector({
  id: 'eves-check-slide', tab: 'format', title: 'Check facts', order: 95, when: (s) => s.kind !== 'element',
  render: (ctx) => {
    const i = ctx.selection.slide;
    if (!ctx.deck || !ctx.deck.slides[i]) return null;
    if (!available()) return offNote();
    const r = resultNow(ctx.conv);
    const mine = F.claimsOn(r, i);
    const checked = r && (r.scope === 'deck' || (r.slides || []).includes(i));
    return el('div', { class: 'dfc-sec' },
      running ? spinner(running.total > 1 ? `${tx('EVES is checking slide')} ${Math.min(running.total, running.done + 1)} ${tx('of')} ${running.total}…` : running.scope === 'deck' ? tx('EVES is checking the deck…') : tx('EVES is checking…')) : kit.button({ label: checked ? tx('Check this slide again') : tx('Check facts on this slide'), icon: 'check', key: 'fc-slide', onClick: () => checkSlide(i) }),
      checked && !mine.length ? el('p', { class: 'dsh-hint' }, tx('No factual claims found on this slide.')) : null,
      ...mine.map((cl) => claimRow(cl)));
  },
});
registerInspector({
  id: 'eves-check-deck', tab: 'document', title: 'Check facts', order: 15,
  render: (ctx) => {
    if (!ctx.deck) return null;
    if (!available()) return offNote();
    const r = resultNow(ctx.conv);
    const flagged = r ? r.claims.filter((cl) => !cl.fixed && cl.verdict !== 'supported' && cl.verdict !== 'not_a_claim') : [];
    return el('div', { class: 'dfc-sec' },
      r ? badgeEl(r) : el('p', { class: 'dsh-hint' }, tx('EVES checks each factual claim on your slides against web sources.')),
      running ? spinner(running.total > 1 ? `${tx('EVES is checking slide')} ${Math.min(running.total, running.done + 1)} ${tx('of')} ${running.total}…` : tx('EVES is checking…')) : kit.button({ label: r && r.scope === 'deck' ? tx('Check the whole deck again…') : tx('Check the whole deck…'), icon: 'check', key: 'fc-deck', onClick: checkDeck }),
      ...flagged.map((cl) => claimRow(cl, { showSlide: true })));
  },
});
const menuItems = (ctx) => (available() && ctx.deck ? [{ label: tx('Check facts on this slide'), icon: 'check', disabled: !!running, run: () => checkSlide(Number.isInteger(ctx.index) ? ctx.index : ctx.selection.slide) }] : []);
registerContextMenu({ id: 'eves-slide', target: 'slide', order: 70, items: menuItems });
registerContextMenu({ id: 'eves-thumb', target: 'thumb', order: 70, items: menuItems });

// the deck badge in the toolbar (re-registered when its words change; the same id replaces it)
let badgeText = null;
function drawBadge() {
  const r = available() ? resultNow() : null;
  const b = r ? F.badgeOf(r) : null;
  const text = running ? 'Checking…' : b ? b.text : '';
  if (text === badgeText) return;
  badgeText = text;
  registerTool({
    id: 'eves-badge', group: 'collab', order: 5, icon: 'check', label: tx(running ? 'Checking…' : b ? `${r.claims.filter((x) => x.verdict !== 'not_a_claim').length} ${tx('checked')}` : ''),
    title: tx(text), when: () => !!text, run: (ctx) => ctx.openInspector('document'),
  });
}

// claims marked on the slide: the frame underlines each box with its verdict's colour and word (deck-shell-frame.js)
function postMarks() {
  const c = context();
  const r = available() ? resultNow(c.conv) : null;
  const marks = r ? r.claims.filter((cl) => cl.slide >= 0 && cl.path && cl.verdict !== 'not_a_claim').map((cl) => ({ index: cl.slide, path: cl.path, tone: cl.fixed ? 'ok' : (F.VERDICTS[cl.verdict] || F.VERDICTS.unverified).tone, word: tx(cl.fixed ? 'Fixed' : (F.VERDICTS[cl.verdict] || F.VERDICTS.unverified).word) })) : [];
  c.post({ type: 'deck-marks', marks: marks.slice(0, 120) });
}
function afterChange() { drawBadge(); postMarks(); context().refresh(); }
onSelection(() => drawBadge());
// a newly drawn frame (an edit, another version) gets the marks again
addEventListener('message', (e) => {
  const f = context().frame();
  if (!f || e.source !== f.contentWindow || !e.data || e.data.type !== 'deck-ready') return;
  drawBadge(); postMarks();
});
