// The deck room for real (workerd via `wrangler dev --local`, no login, nothing deployed): two Node clients with
// askeden's RoomClient (Node's own WebSocket) edit one deck, comment, see each other, reconnect, and get closed on revoke.
//   node test/deck-room-dev/e2e.mjs   (from JARVIS V1/site)
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const here = fileURLToPath(new URL('.', import.meta.url));
const ASKEDEN = new URL('../../../../askeden/web/chat/', import.meta.url);
const rc = await import(new URL('deck-room.js', ASKEDEN));
const cm = await import(new URL('deck-comments-model.js', ASKEDEN));
const pr = await import(new URL('deck-presence.js', ASKEDEN));
const PORT = 8797;
const dev = spawn(fileURLToPath(new URL('../../node_modules/.bin/wrangler', import.meta.url)), ['dev', '--local', '--port', String(PORT), '--config', `${here}wrangler.toml`, '--persist-to', `${here}.state`, '--show-interactive-dev-session=false'], { cwd: here, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' } });
let log = '';
dev.stdout.on('data', (d) => { log += d; }); dev.stderr.on('data', (d) => { log += d; });
const stop = () => { try { dev.kill('SIGTERM'); } catch { /* gone */ } };
process.on('exit', stop);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; ; i++) { try { await fetch(`http://127.0.0.1:${PORT}/`); break; } catch { if (i > 120) { console.log(log); throw new Error('wrangler dev did not start'); } await sleep(500); } }
const results = [];
const ok = (n, c, x = '') => { results.push(Boolean(c)); console.log(`${c ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`); };
const ROOM = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url');
const KEY = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
const deck = { title: 'Q3 review', slides: [{ layout: 'title', title: 'Q3 review', subtitle: 'Numbers' }, { layout: 'bullets', title: 'Wins', bullets: ['Revenue up'] }] };
const conv = (versions = []) => ({ id: 'c', deckRoom: { id: ROOM, key: KEY }, deckVersions: versions });
const st = { a: [], b: [] };
const client = (c, who, role) => new rc.RoomClient({ connect: () => new WebSocket(`ws://127.0.0.1:${PORT}/room/${ROOM}?role=${role}`, [rc.PROTOCOL]), key: KEY, getConv: () => c, onStatus: (s, d) => st[who].push(d ? `${s}:${d}` : s) });
try {
  const ana = conv([{ id: 'v1', at: 1000, kind: 'model', deck }]);
  const A = client(ana, 'a', 'owner');
  await sleep(800);
  ok('Ana connects as owner through workerd', st.a.includes('open:owner'), st.a.join());
  const bo = conv();
  const B = client(bo, 'b', 'collaborator');
  await sleep(800);
  ok('Bo connects and gets the deck Ana had', bo.deckVersions.length === 1 && bo.deckVersions[0].deck.slides[1].title === 'Wins', JSON.stringify(st.b));
  bo.deckVersions = [...bo.deckVersions, { id: 'v2', at: 2000, kind: 'edit', deck: { ...deck, slides: [deck.slides[0], { ...deck.slides[1], title: 'Wins (Bo)' }] } }];
  await B.push(bo); await sleep(500);
  ok('Bo’s edit reaches Ana', ana.deckVersions.at(-1).deck.slides[1].title === 'Wins (Bo)');
  ana.deckVersions.at(-1).deck.comments = cm.addComment([], { by: 'Ana', text: 'Good', anchor: { slide: 1 }, id: 'ca', now: 3000 });
  bo.deckVersions.at(-1).deck.comments = cm.addComment([], { by: 'Bo', text: 'Thanks', anchor: { slide: 1 }, id: 'cb', now: 3001 });
  await Promise.all([A.push(ana), B.push(bo)]); await sleep(800);
  const ids = (c) => cm.commentsOf(c).map((t) => t.id).sort().join();
  ok('comments made at once end up on both', ids(ana) === 'ca,cb' && ids(bo) === 'ca,cb', `${ids(ana)} | ${ids(bo)}`);
  const timers = { setInterval: () => 0, clearInterval: () => {} };
  const pa = new pr.Presence({ channel: A.channel, deck: ROOM, me: { id: 'tabAna', name: 'Ana' }, timers });
  const pb = new pr.Presence({ channel: B.channel, deck: ROOM, me: { id: 'tabBo', name: 'Bo' }, timers });
  await sleep(400); pb.set({ index: 1, k: 1, path: 'title' }); await sleep(400);
  const bLine = pa.list().find((p) => p.id === 'tabBo');
  ok('presence through the room: "Bo is editing slide 2"', bLine && pr.peerLine(bLine) === 'Bo is editing slide 2', bLine ? pr.peerLine(bLine) : 'none');
  B.socket.close(); await sleep(600); // Bo's socket drops (the client then reconnects by itself)
  ok('Ana sees Bo leave', !pa.list().some((p) => p.id === 'tabBo'));
  ana.deckVersions = [...ana.deckVersions, { id: 'v3', at: 4000, kind: 'edit', deck: { ...deck, title: 'Q3 final' } }];
  await A.push(ana);
  await sleep(2500);
  ok('Bo reconnects and catches up', st.b.filter((s) => s === 'open:collaborator').length >= 2 && bo.deckVersions.some((v) => v.id === 'v3'), st.b.join());
  // a viewer can't write
  const cy = conv(); const sc = [];
  const C = new rc.RoomClient({ connect: () => new WebSocket(`ws://127.0.0.1:${PORT}/room/${ROOM}?role=viewer`, [rc.PROTOCOL]), key: KEY, getConv: () => cy, onStatus: (s, d) => sc.push(d ? `${s}:${d}` : s) });
  await sleep(800);
  ok('a viewer sees the deck', cy.deckVersions.some((v) => v.id === 'v3'));
  const raw = new WebSocket(`ws://127.0.0.1:${PORT}/room/${ROOM}?role=viewer`, [rc.PROTOCOL]);
  const got = [];
  raw.onmessage = (e) => got.push(JSON.parse(e.data));
  await new Promise((r) => { raw.onopen = r; });
  raw.send(JSON.stringify({ t: 'version', id: 'v9', at: 9, enc: '{"v":1,"iv":"AAECAwQFBgcICQoL","ct":"eA"}' }));
  raw.send('x'.repeat(460_000));
  await sleep(500);
  ok('the room refuses a viewer’s edit and a message too big', got.some((m) => m.code === 'forbidden') && got.some((m) => m.code === 'too_big'), JSON.stringify(got.map((m) => m.code || m.t)));
  raw.close();
  // revoke
  await fetch(`http://127.0.0.1:${PORT}/room/${ROOM}/close`, { method: 'POST' });
  await sleep(800);
  ok('a revoke closes everyone for good', st.a.includes('closed:revoked') && sc.includes('closed:revoked'), `${st.a.slice(-2)} ${sc.slice(-2)}`);
  for (const x of [A, B, C, pa, pb]) x.close();
} finally {
  stop();
  await sleep(300);
  (await import('node:fs')).rmSync(`${here}.state`, { recursive: true, force: true }); (await import('node:fs')).rmSync(`${here}.wrangler`, { recursive: true, force: true });
}
console.log(`${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
