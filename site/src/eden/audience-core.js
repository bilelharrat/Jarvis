// The audience room's rules (Eden Slides live polls, Q&A and follow-along), pure: no DOM, no network, no clock of
// its own. One copy runs on the Mac's server (src/chat/audience.ts loads this file) and one on askeden.com
// (JARVIS V1/site/src/eden/audience-core.js, a byte-for-byte copy its test checks).
//
// Who's who: the presenter holds the room's owner token (the server keeps only its hash); each phone gets a voter id
// when it joins (no account, no name unless they type one). What the audience writes and what the presenter shows
// are opaque strings here: on askeden.com they are sealed in the page with the key in the link's #fragment
// (`requireSealed`), so the server counts votes and upvotes without reading a word.
//
// One thread at a time (Node, a Durable Object), so counts can't race: a voter's vote is a map entry, last one wins.

export const AUD = {
  voters: 2000, questions: 300, perVoterQuestions: 10, body: 4000, name: 40, options: 6,
  deckChars: 3_000_000, view: 60, idleMs: 24 * 3600e3,
  bucket: { size: 20, perSec: 1 }, // a voter's actions
  joinBucket: { size: 40, perSec: 0.5 }, // joins from one network (a classroom behind one address joins at once)
};
export const ROOM_ID = /^[A-Za-z0-9_-]{22}$/;
export const VOTER_ID = /^[A-Za-z0-9_-]{22}$/;
const LIVE_ID = /^[A-Za-z0-9_-]{6,16}$/;
const SEALED = /^\{"v":1,"iv":"[A-Za-z0-9_-]{16}","ct":"[A-Za-z0-9_-]{1,8000}"\}$/;

export class AudienceError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}
const fail = (code, message, status) => { throw new AudienceError(code, message, status); };

function bucket(map, key, conf, now) {
  let b = map.get(key);
  if (!b) { b = { n: conf.size, at: now }; map.set(key, b); }
  b.n = Math.min(conf.size, b.n + ((now - b.at) / 1000) * conf.perSec);
  b.at = now;
  if (b.n < 1) return false;
  b.n -= 1;
  return true;
}
const cleanName = (v) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, '').replace(/\s+/g, ' ').trim().slice(0, AUD.name) : '');

/**
 * A room. `opts`: { id, ownerHash, now: () => ms, newId: () => 22-char id, requireSealed }.
 * Methods throw AudienceError; every change calls the listeners.
 */
export function createRoom(opts, saved = null) {
  const { id, ownerHash, now, newId, requireSealed = false } = opts;
  if (!ROOM_ID.test(id || '')) fail('bad', 'Bad room id.');
  const voters = new Set(saved && Array.isArray(saved.voters) ? saved.voters.filter((v) => VOTER_ID.test(v)) : []);
  const polls = new Map(); // poll id → { n, locked, votes: Map(voter → option) }
  const questions = new Map(); // question id → { id, qa, voter, body, name, at, ups: Set, hidden, answered }
  let show = { k: 0, total: 0, live: null }; // the slide on screen and what the audience sees of it
  let deck = ''; // the follow-along slides (opaque)
  let deckV = 0, v = 1, last = now(), closed = false;
  const buckets = new Map(), joins = new Map();
  const listeners = new Set();
  if (saved) {
    for (const p of saved.polls || []) if (LIVE_ID.test(p.id)) polls.set(p.id, { n: p.n, locked: !!p.locked, votes: new Map((p.votes || []).filter(([vid, o]) => voters.has(vid) && Number.isInteger(o) && o >= 0 && o < p.n)) });
    for (const q of saved.questions || []) questions.set(q.id, { ...q, ups: new Set(q.ups || []) });
    if (saved.show) show = saved.show;
    deck = typeof saved.deck === 'string' ? saved.deck : '';
    deckV = saved.deckV || 0; v = saved.v || 1; last = saved.last || last; closed = !!saved.closed;
  }
  const changed = (what = 'state') => { v++; last = now(); for (const f of listeners) { try { f(what); } catch { /* a listener's own problem */ } } };
  const body = (s, max = AUD.body) => {
    if (typeof s !== 'string' || !s) fail('bad', 'Nothing to send.');
    if (s.length > max) fail('too-big', 'That is too long.', 413);
    if (requireSealed && !SEALED.test(s)) fail('bad', 'Send it sealed.');
    return s;
  };
  const open = () => { if (closed) fail('closed', 'This presentation has ended.', 410); };
  const voter = (vid) => {
    open();
    if (typeof vid !== 'string' || !voters.has(vid)) fail('unknown-voter', 'Join again.', 401);
    if (!bucket(buckets, vid, AUD.bucket, now())) fail('rate', 'Slow down a little.', 429);
    return vid;
  };

  const room = {
    id,
    get version() { return v; },
    get closed() { return closed; },
    get idle() { return now() - last > AUD.idleMs; },
    /** Constant-time check of an owner token's hash. */
    owner(hash) {
      const a = String(hash || ''), b = String(ownerHash || '');
      let d = a.length ^ b.length;
      for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
      return d === 0 && b.length > 0;
    },
    /** A phone joins: its voter id. `net` names its network (an address), for the join limit. */
    join(net = '') {
      open();
      if (!bucket(joins, String(net).slice(0, 64), AUD.joinBucket, now())) fail('rate', 'Too many phones joined from here at once. Try again in a moment.', 429);
      if (voters.size >= AUD.voters) fail('full', 'This room is full.', 409);
      let vid = newId();
      while (voters.has(vid)) vid = newId();
      voters.add(vid);
      last = now();
      return { voter: vid };
    },
    /** The audience's actions: vote, ask, up (upvote or take it back). */
    act(vid, m) {
      voter(vid);
      if (!m || typeof m !== 'object') fail('bad', 'Bad request.');
      if (m.t === 'vote') {
        const p = polls.get(m.poll);
        if (!p) fail('no-poll', 'That poll isn’t open.', 404);
        if (p.locked) fail('locked', 'Voting on this poll has closed.', 409);
        if (m.option === null) { if (p.votes.delete(vid)) changed(); return { ok: true }; }
        if (!Number.isInteger(m.option) || m.option < 0 || m.option >= p.n) fail('bad', 'Pick one of the options.');
        if (p.votes.get(vid) !== m.option) { p.votes.set(vid, m.option); changed(); }
        return { ok: true };
      }
      if (m.t === 'ask') {
        if (!show.live || show.live.kind !== 'qa' || show.live.id !== m.qa) fail('no-qa', 'Questions aren’t open right now.', 409);
        const text = body(m.body);
        const mine = [...questions.values()].filter((q) => q.voter === vid && q.qa === m.qa).length;
        if (mine >= AUD.perVoterQuestions) fail('too-many', `You can ask ${AUD.perVoterQuestions} questions.`, 409);
        if (questions.size >= AUD.questions) fail('full', 'This room has all the questions it can hold.', 409);
        const q = { id: newId(), qa: m.qa, voter: vid, body: text, name: cleanName(m.name), at: now(), ups: new Set(), hidden: false, answered: false };
        questions.set(q.id, q);
        changed();
        return { ok: true, id: q.id };
      }
      if (m.t === 'up') {
        const q = questions.get(m.q);
        if (!q || q.hidden) fail('no-question', 'That question isn’t here.', 404);
        if (q.voter === vid) fail('own', 'That one is yours.', 409);
        const had = q.ups.has(vid);
        if (m.on === false ? had : !had) { if (had) q.ups.delete(vid); else q.ups.add(vid); changed(); }
        return { ok: true, up: q.ups.has(vid) };
      }
      if (m.t === 'me') { // what this phone did (after a reload)
        const vote = {};
        for (const [pid, p] of polls) if (p.votes.has(vid)) vote[pid] = p.votes.get(vid);
        const ups = [], asked = [];
        for (const q of questions.values()) { if (q.ups.has(vid)) ups.push(q.id); if (q.voter === vid) asked.push(q.id); }
        return { vote, ups, asked };
      }
      fail('bad', 'Unknown action.');
    },
    /** The presenter's actions (the transport has checked the owner token). */
    control(m) {
      if (!m || typeof m !== 'object') fail('bad', 'Bad request.');
      if (m.t === 'close') { if (!closed) { closed = true; changed('closed'); } return { ok: true }; }
      open();
      if (m.t === 'show') { // the slide on screen: { k, total, live: null | { kind: 'poll', id, n, body } | { kind: 'qa', id, body } }
        const k = Number.isInteger(m.k) && m.k >= 0 && m.k < 1000 ? m.k : 0;
        const total = Number.isInteger(m.total) && m.total > 0 && m.total <= 1000 ? m.total : 0;
        let live = null;
        const l = m.live;
        if (l && typeof l === 'object' && LIVE_ID.test(l.id || '')) {
          if (l.kind === 'poll') {
            if (!Number.isInteger(l.n) || l.n < 2 || l.n > AUD.options) fail('bad', 'A poll has 2 to 6 options.');
            const p = polls.get(l.id);
            if (!p) polls.set(l.id, { n: l.n, locked: false, votes: new Map() });
            else if (p.n !== l.n) { p.n = l.n; for (const [vid, o] of p.votes) if (o >= l.n) p.votes.delete(vid); } // options changed
            live = { kind: 'poll', id: l.id, body: body(l.body) };
          } else if (l.kind === 'qa') live = { kind: 'qa', id: l.id, body: body(l.body) };
        }
        show = { k, total, live };
        changed();
        return { ok: true };
      }
      if (m.t === 'lock' || m.t === 'reset') {
        const p = polls.get(m.poll);
        if (!p) fail('no-poll', 'No such poll.', 404);
        if (m.t === 'lock') p.locked = m.locked !== false; else { p.votes.clear(); p.locked = false; }
        changed();
        return { ok: true };
      }
      if (m.t === 'hide' || m.t === 'answered') {
        const q = questions.get(m.q);
        if (!q) fail('no-question', 'No such question.', 404);
        q[m.t === 'hide' ? 'hidden' : 'answered'] = m.on !== false;
        changed();
        return { ok: true };
      }
      if (m.t === 'deck') { // the follow-along slides (sent once, again after an edit)
        if (typeof m.body !== 'string' || m.body.length > AUD.deckChars) fail('too-big', 'These slides are too big to follow along.', 413);
        if (requireSealed && m.body && !/^\{"v":1,"iv":"[A-Za-z0-9_-]{16}","ct":"[A-Za-z0-9_-]+"\}$/.test(m.body)) fail('bad', 'Send it sealed.');
        deck = m.body;
        deckV++;
        changed('deck');
        return { ok: true, deckV };
      }
      fail('bad', 'Unknown action.');
    },
    /** What a phone (or, with `owner`, the presenter) sees now. */
    view({ owner = false } = {}) {
      let live = null;
      if (show.live) {
        live = { ...show.live };
        if (live.kind === 'poll') {
          const p = polls.get(live.id);
          const counts = new Array(p.n).fill(0);
          for (const o of p.votes.values()) counts[o]++;
          Object.assign(live, { counts, votes: p.votes.size, locked: p.locked });
        } else {
          const list = [...questions.values()].filter((q) => q.qa === live.id && (owner || !q.hidden))
            .sort((a, b) => b.ups.size - a.ups.size || a.at - b.at)
            .slice(0, owner ? AUD.questions : AUD.view)
            .map((q) => ({ id: q.id, body: q.body, ...(q.name ? { name: q.name } : {}), up: q.ups.size, at: q.at, ...(q.answered ? { answered: true } : {}), ...(owner && q.hidden ? { hidden: true } : {}) }));
          live.questions = list;
        }
      }
      return { v, k: show.k, total: show.total, live, deckV, closed, ...(owner ? { people: voters.size } : {}) };
    },
    deck: () => ({ deckV, body: deck }),
    on(f) { listeners.add(f); return () => listeners.delete(f); },
    /** Everything, for storage (a Durable Object). */
    save() {
      return {
        voters: [...voters], v, last, closed, show, deck, deckV,
        polls: [...polls].map(([pid, p]) => ({ id: pid, n: p.n, locked: p.locked, votes: [...p.votes] })),
        questions: [...questions.values()].map((q) => ({ ...q, ups: [...q.ups] })),
      };
    },
  };
  return room;
}
