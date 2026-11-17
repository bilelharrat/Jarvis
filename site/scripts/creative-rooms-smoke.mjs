// A live check of creative rooms on the real runtime (docs/creative-rooms.md "Local test"):
//   npx wrangler dev -c wrangler.creative-rooms-dev.toml --port 8788 --ip 127.0.0.1    (one terminal)
//   node scripts/creative-rooms-smoke.mjs [http://127.0.0.1:8788]                    (another)
// Ana makes a room, invites maya@example.com and uploads a snapshot; Maya lists her rooms and connects; both send
// ops at once and must see one order; presence relays; a comment round-trips; Ana deletes the room and Maya's socket
// hears `deleted`. Only the fake dev people of wrangler.creative-rooms-dev.toml: nothing leaves this Mac.
import WebSocket from 'ws';

const BASE = (process.argv[2] || 'http://127.0.0.1:8788').replace(/\/+$/, '');
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: Boolean(ok), detail });

async function api(token, path, { method = 'GET', body, headers = {} } = {}) {
  const init = { method, headers: { authorization: `Bearer ${token}`, ...headers } };
  if (body instanceof Uint8Array) init.body = body;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['content-type'] = 'application/json';
  }
  return fetch(`${BASE}/api/creative/rooms${path}`, init);
}

/** One app's live line: its frames queued, waited on by test. */
class Line {
  constructor(token, id) {
    this.frames = [];
    this.waiters = [];
    this.closed = null;
    this.ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/api/creative/rooms/${id}/socket`, { headers: { authorization: `Bearer ${token}` } });
    this.ws.on('message', (data) => {
      this.frames.push(JSON.parse(String(data)));
      this.wake();
    });
    this.ws.on('close', (code) => {
      this.closed = code;
      this.wake();
    });
    this.open = new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
      this.ws.once('unexpected-response', (req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    });
  }
  wake() {
    for (const w of this.waiters.splice(0)) w();
  }
  send(msg) {
    this.ws.send(JSON.stringify(msg));
  }
  async until(test, ms = 8000) {
    const end = Date.now() + ms;
    for (;;) {
      const i = this.frames.findIndex(test);
      if (i >= 0) return this.frames.splice(i, 1)[0];
      if (Date.now() > end) throw new Error('timed out waiting for a frame');
      await new Promise((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 100);
      });
    }
  }
  async ops(n, ms = 10_000) {
    const out = [];
    while (out.length < n) out.push(await this.until((f) => f.t === 'op', ms));
    return out;
  }
}

function noise(n) {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 65536) crypto.getRandomValues(out.subarray(i, Math.min(n, i + 65536)));
  return out;
}

async function main() {
  const made = await api('dev-ana', '', { method: 'POST', body: { name: 'Smoke test' } });
  const { room } = await made.json();
  check('Ana makes a room', made.status === 201 && room && room.you.slot === 0, `status ${made.status}`);
  const id = room.id;

  const invited = await api('dev-ana', `/${id}/invite`, { method: 'POST', body: { email: 'maya@example.com', role: 'edit' } });
  const { member } = await invited.json();
  check('Ana invites maya@example.com', invited.status === 201 && member.status === 'pending' && member.slot === 1, `status ${invited.status}`);

  const bytes = noise(Math.floor(2.5 * 1024 * 1024)); // three 1 MiB chunks
  const put = await api('dev-ana', `/${id}/snapshot`, { method: 'PUT', body: bytes, headers: { 'x-seq': '0', 'x-hash': 'smoke-0', 'content-type': 'application/octet-stream' } });
  check('Ana uploads a 2.5 MiB snapshot', put.status === 200, `status ${put.status} ${put.status === 200 ? '' : await put.text()}`);

  const listed = await (await api('dev-maya', '')).json();
  check('Maya’s list shows the invite', (listed.rooms || []).some((r) => r.id === id && r.status === 'pending' && r.role === 'edit'), JSON.stringify(listed));

  const maya = new Line('dev-maya', id);
  await maya.open;
  const ana = new Line('dev-ana', id);
  await ana.open;
  check('both connect', true);
  ana.send({ t: 'hello', since: 0 });
  maya.send({ t: 'hello', since: 0 });
  const [wa, wm] = [await ana.until((f) => f.t === 'welcome'), await maya.until((f) => f.t === 'welcome')];
  check('Maya joined on her first connect, with her invite’s key', wm.you.key === member.key && wm.you.status === 'in' && wm.you.slot === 1, JSON.stringify(wm.you));
  check('no account ids on the line', !/acct-/.test(JSON.stringify([wa, wm])), 'an account id reached a member');
  const [anaKey, mayaKey] = [wa.you.key, wm.you.key];
  check('welcome carries the room and its snapshot', wa.room.snapshot && wa.room.snapshot.seq === 0 && wa.room.snapshot.bytes === bytes.length);

  const big = '{"clip":1152921504606846977,"tick":9007199254740993}';
  for (let i = 0; i < 15; i++) {
    ana.send({ t: 'op', id: `a${i}`, base: 0, label: `Ana ${i}`, op: big });
    maya.send({ t: 'op', id: `m${i}`, base: 0, label: `Maya ${i}`, op: big, ...(i === 3 ? { via: 'eden' } : {}) });
  }
  const [oa, om] = [await ana.ops(30), await maya.ops(30)];
  const order = (list) => list.map((f) => `${f.seq}:${f.id}`).join(',');
  check('both see the same 30 ops in the same order', order(oa) === order(om), `${order(oa).slice(0, 80)}… vs ${order(om).slice(0, 80)}…`);
  check('seq runs 1…30 with no gap', oa.every((f, i) => f.seq === i + 1));
  check('each sender got its own ops back', oa.filter((f) => f.by === anaKey).length === 15 && om.filter((f) => f.by === mayaKey).length === 15);
  check('the command came back byte for byte', oa.every((f) => f.op === big));
  check('Eden’s op is marked via eden', om.some((f) => f.id === 'm3' && f.via === 'eden'));

  ana.send({ t: 'presence', sequence: 1, playhead: 254016000000, selection: [7], lock: 7, doing: 'editing' });
  const p = await maya.until((f) => f.t === 'presence');
  check('presence relays to Maya', p.key === anaKey && p.slot === 0 && p.playhead === 254016000000 && p.lock === 7, JSON.stringify(p));

  maya.send({ t: 'comment', op: 'add', cid: 'smoke', sequence: 1, clip: 7, offset: 0, time: 254016000000, text: 'Tighten this', mentions: [anaKey] });
  const c = await ana.until((f) => f.t === 'comment');
  check('a comment round-trips', c.comment.text === 'Tighten this' && c.comment.by === mayaKey && c.cid === 'smoke', JSON.stringify(c));

  const got = await api('dev-maya', `/${id}/snapshot`);
  const back = new Uint8Array(await got.arrayBuffer());
  check('Maya downloads the same snapshot', got.status === 200 && got.headers.get('x-seq') === '0' && back.length === bytes.length && back.every((b, i) => b === bytes[i]), `status ${got.status}, ${back.length} bytes`);

  const gone = await api('dev-ana', `/${id}`, { method: 'DELETE' });
  check('Ana deletes the room', gone.status === 200, `status ${gone.status}`);
  const deleted = await maya.until((f) => f.t === 'deleted');
  check('Maya’s socket hears deleted', deleted.t === 'deleted');
  const after = await api('dev-maya', `/${id}`);
  const lists = await (await api('dev-maya', '')).json();
  check('the room is gone for everyone', after.status === 404 && !(lists.rooms || []).some((r) => r.id === id), `status ${after.status}`);
  for (const line of [ana, maya]) line.ws.close();
}

try {
  await main();
} catch (error) {
  check('the run finished', false, error && error.message);
}
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok || !r.detail ? '' : `  (${r.detail})`}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${failed ? 'FAIL' : 'PASS'}: ${results.length - failed}/${results.length} checks`);
process.exit(failed ? 1 : 0);
