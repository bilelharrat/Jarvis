// One engine for every Eden app: what an app does when its data is already owned
// (app/backend-handover.js, app/backend-share.js), with fakes for every process and socket.
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const share = require('../../app/backend-share.js');
const handover = require('../../app/backend-handover.js');

const temp = () => mkdtempSync(path.join(tmpdir(), 'handover-'));
const TOKEN = 'cd'.repeat(24);
const ME = { protocol: share.PROTOCOL, profile: 'code', name: 'Eden Code' };

// A record as the backend writes it (share_record.py).
function record(dir, fields = {}) {
  const body = { protocol: 1, version: '0.1.0', port: 51234, pid: 4242, token: TOKEN, profile: 'full', app: 'ask-eden', launcher: 4241, started: 1_000, ...fields };
  writeFileSync(path.join(dir, share.FILE), JSON.stringify(body), { mode: 0o600 });
  chmodSync(path.join(dir, share.FILE), 0o600);
  return body;
}

test('the protocol here is the backend\'s (share_record.PROTOCOL)', () => {
  const py = readFileSync(new URL('../../src/jarvis/share_record.py', import.meta.url), 'utf8');
  assert.equal(Number(/^PROTOCOL = (\d+)$/m.exec(py)[1]), share.PROTOCOL);
  assert.equal(Number(/^HANDED_OVER = (\d+)$/m.exec(py)[1]), handover.HANDED_OVER);
});

// ── deciding ──

test('no record: this app starts its own', () => {
  assert.deepEqual(handover.decide(null, ME), { action: 'start' });
});

test('a live record of the same protocol: the window opens on it', () => {
  assert.deepEqual(handover.decide({ protocol: 1, profile: 'full' }, ME), { action: 'connect', upgrade: false });
  assert.deepEqual(handover.decide({ protocol: 1, profile: 'code' }, ME), { action: 'connect', upgrade: false });
});

test('profiles: a code backend serves Eden Secretary too, woken to full in place (no restart)', () => {
  const secretary = { protocol: share.PROTOCOL, profile: 'full' };
  assert.deepEqual(handover.decide({ protocol: 1, profile: 'code' }, secretary), { action: 'connect', upgrade: true });
  // full serves everyone: never taken down to code
  assert.deepEqual(handover.decide({ protocol: 1, profile: 'full' }, ME), { action: 'connect', upgrade: false });
});

test('another protocol: the owner is asked, older or newer', () => {
  const legacy = { port: 1, token: TOKEN, app: 'ask-eden', launcher: 4241 }; // an app wrote it: no protocol
  assert.deepEqual(handover.decide(legacy, ME), { action: 'ask', reason: 'older', record: legacy });
  const newer = { protocol: share.PROTOCOL + 1, version: '9.0.0', app: 'jarvis' };
  assert.equal(handover.decide(newer, ME).reason, 'newer');
});

test('the question names the owner and offers both ways, the running one by default', () => {
  const asked = handover.choiceDialog({ app: 'ask-eden', launcher: 4241 }, 'older', ME);
  assert.match(asked.message, /^Ask Eden is running an older version of Eden's engine, older than Eden Code's\.$/);
  assert.deepEqual(asked.buttons, ['Use the running one', "Restart Eden's engine with this version"]);
  assert.equal(asked.defaultId, 0);
  assert.equal(asked.cancelId, 0);
  assert.match(asked.detail, /quits Ask Eden first/); // an old one can't hand its engine over
  const newer = handover.choiceDialog({ app: 'jarvis', protocol: 2, version: '2.0.0' }, 'newer', ME);
  assert.match(newer.message, /Eden Secretary is running a newer version/);
  assert.match(newer.detail, /Updating Eden Code is the better fix/);
  assert.match(newer.detail, /stops the running engine gently/);
});

// ── finding it ──

test('a backend\'s own record is read with what it says of itself', () => {
  const dir = temp();
  record(dir, { released: 99 });
  assert.deepEqual(share.read(dir), {
    port: 51234, pid: 4242, token: TOKEN, app: 'ask-eden', launcher: 4241,
    protocol: 1, version: '0.1.0', profile: 'full', started: 1_000, released: 99,
  });
  // a terminal's token (token_urlsafe) is a token too
  record(dir, { token: 'Ab-_'.repeat(8) });
  assert.equal(share.read(dir).token, 'Ab-_'.repeat(8));
});

test('the token: a record anyone else could read, or another user wrote, is not trusted', () => {
  const dir = temp();
  record(dir);
  assert.ok(share.read(dir));
  chmodSync(path.join(dir, share.FILE), 0o644);
  assert.equal(share.read(dir), null);
  assert.equal(share.private_({ mode: 0o100600, uid: 501 }, { platform: 'darwin', uid: 501 }), true);
  assert.equal(share.private_({ mode: 0o100640, uid: 501 }, { platform: 'darwin', uid: 501 }), false);
  assert.equal(share.private_({ mode: 0o100600, uid: 0 }, { platform: 'darwin', uid: 501 }), false);
  assert.equal(share.private_({ mode: 0o100666, uid: 0 }, { platform: 'win32', uid: -1 }), true);
});

test('a stale record (its process gone) names nothing; its app gone, neither, unless it let go', async () => {
  const dir = temp();
  record(dir);
  const alive = new Set([4241, 4242]);
  const opts = { isAlive: (pid) => alive.has(pid), isHealthy: async () => true, waitMs: 0 };
  assert.equal((await share.discover(dir, opts)).port, 51234);
  alive.delete(4242);
  assert.equal(await share.discover(dir, opts), null, 'its pid is gone: stale');
  alive.add(4242);
  alive.delete(4241);
  assert.equal(await share.discover(dir, opts), null, 'its app quit and it goes too');
  record(dir, { launcher: 0, released: 5 });
  assert.equal((await share.discover(dir, opts)).released, 5, 'released: it stays for the other windows');
  record(dir, { handover: 7 });
  alive.add(4241);
  assert.equal(await share.discover(dir, opts), null, 'handing over: stopping');
});

test('a backend still starting (no /health yet) is waited for, not raced', async () => {
  const dir = temp();
  let clock = 10_000;
  record(dir, { started: clock - 2_000 });
  let asked = 0;
  const found = await share.discover(dir, {
    isAlive: () => true,
    isHealthy: async () => { asked += 1; return asked >= 3; },
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    every: 500,
  });
  assert.equal(found.port, 51234);
  assert.equal(asked, 3);
  // one that started long ago and doesn't answer is not waited for
  record(dir, { started: clock - share.STARTING_GRACE - 1 });
  asked = 0;
  assert.equal(await share.discover(dir, { isAlive: () => true, isHealthy: async () => { asked += 1; return false; }, now: () => clock, sleep: async () => {} }), null);
  assert.equal(asked, 1);
  // and a starting one is given up on after waitMs
  record(dir, { started: clock });
  const t0 = clock;
  assert.equal(await share.discover(dir, { isAlive: () => true, isHealthy: async () => false, now: () => clock, sleep: async (ms) => { clock += ms; }, waitMs: 3_000 }), null);
  assert.ok(clock - t0 >= 3_000 && clock - t0 < 4_000);
});

// ── asking the backend (token handling) ──

function fakeBackend(answer) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ url: req.url, method: req.method, auth: req.headers.authorization, origin: req.headers.origin, body });
      const [status, json] = answer(req);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(json));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, port: server.address().port })));
}

test('release and shutdown carry the token as a bearer, never in the address, and no Origin', async () => {
  const fake = await fakeBackend((req) => (req.headers.authorization === `Bearer ${TOKEN}`
    ? [200, req.url === '/share/release' ? { ok: true, staying: true, windows: 1 } : { ok: true }]
    : [403, { ok: false }]));
  try {
    assert.equal(await share.release(fake.port, TOKEN, 'eden-code'), true);
    assert.equal(await share.shutdown(fake.port, TOKEN), true);
    assert.equal(await share.release(fake.port, 'wrong'.repeat(5), 'eden-code'), false);
    assert.equal(await share.shutdown(fake.port, 'wrong'.repeat(5)), false);
    const [rel, down] = fake.seen;
    assert.deepEqual([rel.url, rel.method, rel.origin, JSON.parse(rel.body)], ['/share/release', 'POST', undefined, { app: 'eden-code' }]);
    assert.equal(down.url, '/share/shutdown');
    for (const s of fake.seen) assert.ok(!s.url.includes(TOKEN));
  } finally {
    fake.server.close();
  }
});

test('release says "stays" only when the backend says so; an old backend or none means no', async () => {
  const fake = await fakeBackend(() => [404, { detail: 'Not Found' }]); // a backend from before /share
  try {
    assert.equal(await share.release(fake.port, TOKEN, 'jarvis'), false);
  } finally {
    fake.server.close();
  }
  const fake2 = await fakeBackend(() => [200, { ok: true, staying: false }]);
  try {
    assert.equal(await share.release(fake2.port, TOKEN, 'jarvis'), false);
  } finally {
    fake2.server.close();
  }
  assert.equal(await share.release(1, TOKEN, 'jarvis', { timeoutMs: 300 }), false); // nothing listening
});

// ── who holds it, and stopping it gently ──

const PS = {
  700: { ppid: 600, command: '/Applications/Ask Eden.app/Contents/Resources/backend/python/bin/python3 -m jarvis serve --port 6000' },
  600: { ppid: 1, command: '/Applications/Ask Eden.app/Contents/MacOS/Ask Eden' },
  800: { ppid: 790, command: '/Users/me/repo/.venv/bin/python3 /Users/me/repo/.venv/bin/jarvis serve --port 8000' },
  790: { ppid: 780, command: '/opt/homebrew/bin/uv run jarvis serve --port 8000' },
  780: { ppid: 770, command: '-zsh' },
  770: { ppid: 1, command: '/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal' },
  900: { ppid: 890, command: 'python3 -m jarvis serve' },
  890: { ppid: 1, command: '/Applications/Eden Code.app/Contents/Frameworks/Eden Code Helper.app/Contents/MacOS/Eden Code Helper' },
  950: { ppid: 1, command: '/usr/bin/something-else' },
};
const ps = (pid) => PS[pid] || null;

test('the holder is described by the app above it, never a helper', () => {
  assert.deepEqual(handover.describeHolder(700, { ps }), { pid: 700, engine: true, appPath: '/Applications/Ask Eden.app', appName: 'Ask Eden', appPid: 600 });
  const helper = handover.describeHolder(900, { ps });
  assert.equal(helper.appPid, 0);
  assert.equal(handover.describeHolder(12345, { ps }), null);
});

test('a terminal is never the app to quit: its jarvis serve is stopped instead', () => {
  const held = handover.describeHolder(800, { ps });
  assert.deepEqual(held, { pid: 800, engine: true, appPath: '', appName: '', appPid: 0 }); // a shell stood between
  assert.equal(handover.stopPlan({ holder: held }).how, 'stop');
  assert.equal(handover.stopPlan({ holder: held }).pid, 800);
  // and with its record (a protocol backend from a terminal): its own shutdown
  const plan = handover.stopPlan({ record: { protocol: 1, app: 'terminal', port: 8000, token: TOKEN, pid: 800 } });
  assert.equal(plan.how, 'shutdown');
  assert.equal(plan.label, 'Stop that engine and continue');
});

test('the stop plan: a protocol backend is asked over its own shutdown; an old app is quit; else nothing', () => {
  const rec = { protocol: 1, app: 'ask-eden', port: 6000, token: TOKEN, pid: 700 };
  assert.deepEqual(handover.stopPlan({ record: rec }), { how: 'shutdown', port: 6000, token: TOKEN, pid: 700, owner: 'Ask Eden', label: "Quit Ask Eden's engine and continue" });
  const legacyHolder = handover.describeHolder(700, { ps });
  assert.deepEqual(handover.stopPlan({ record: { app: 'ask-eden', port: 6000, token: TOKEN, pid: 700 }, holder: legacyHolder }),
    { how: 'quit-app', pid: 600, waitPid: 700, owner: 'Ask Eden', label: 'Quit Ask Eden and continue' });
  assert.deepEqual(handover.stopPlan({ holder: { pid: 900, engine: true, appPid: 0, appName: '' } }),
    { how: 'stop', pid: 900, owner: 'a `jarvis serve` in a terminal', label: 'Stop that engine and continue' });
  assert.equal(handover.stopPlan({ holder: { pid: 950, engine: false, appPid: 0, appName: '' } }), null);
  assert.equal(handover.stopPlan({}), null);
});

test('the held message names the owner, never "find the terminal"', () => {
  const plan = handover.stopPlan({ record: { protocol: 1, app: 'ask-eden', port: 1, token: TOKEN, pid: 2 } });
  assert.equal(handover.heldMessage(plan, ME), "Ask Eden is using your Eden data, so Eden Code can't start its own engine.");
  assert.match(handover.heldMessage(null, ME, 950), /process 950/);
});

test('the lock names its holder (jsonstore.claim_folder writes the pid)', () => {
  const dir = temp();
  assert.equal(handover.lockHolder(dir), 0);
  writeFileSync(path.join(dir, 'backend.lock'), '4242\n');
  assert.equal(handover.lockHolder(dir), 4242);
  writeFileSync(path.join(dir, 'backend.lock'), 'nonsense');
  assert.equal(handover.lockHolder(dir), 0);
});

test('stopping waits until the engine is gone, and says when it never went', async () => {
  let clock = 0;
  const live = new Set([700, 600]);
  const sent = [];
  const deps = {
    kill: (pid, sig) => { sent.push([pid, sig]); if (pid === 600) live.delete(700); },
    alive: (pid) => live.has(pid),
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
    shutdown: async () => { sent.push(['shutdown']); return true; },
  };
  // an old app: asked to quit (its own Quit), its engine waited for
  assert.equal(await handover.stopOwner({ how: 'quit-app', pid: 600, waitPid: 700 }, deps), true);
  assert.deepEqual(sent, [[600, 'SIGTERM']]);
  // a protocol backend: its shutdown, no signal at all
  sent.length = 0;
  live.add(4242);
  const going = { ...deps, shutdown: async () => { sent.push(['shutdown']); live.delete(4242); return true; } };
  assert.equal(await handover.stopOwner({ how: 'shutdown', port: 1, token: TOKEN, pid: 4242 }, going), true);
  assert.deepEqual(sent, [['shutdown']]);
  // shutdown refused (not answering it): its own stop, as a quit sends
  sent.length = 0;
  live.add(4242);
  const refused = { ...deps, shutdown: async () => false, kill: (pid, sig) => { sent.push([pid, sig]); live.delete(pid); } };
  assert.equal(await handover.stopOwner({ how: 'shutdown', port: 1, token: TOKEN, pid: 4242 }, refused), true);
  assert.deepEqual(sent, [[4242, 'SIGTERM']]);
  // never goes: false after the wait
  live.add(1234);
  clock = 0;
  assert.equal(await handover.stopOwner({ how: 'stop', pid: 1234 }, { ...deps, kill: () => {}, waitMs: 2_000 }), false);
  assert.ok(clock >= 2_000);
  assert.equal(await handover.stopOwner(null, deps), false);
});

// ── main.js and Ask Eden wire it up ──

test('main.js opens on the owner, asks on another version, offers the fix on 75, and lets go on quit', () => {
  const main = readFileSync(new URL('../../app/main.js', import.meta.url), 'utf8');
  assert.match(main, /handover\.decide\(found, \{ protocol: share\.PROTOCOL, profile: FLAVOR\.profile \}\)/);
  assert.match(main, /if \(code === 75\) \{ dataHeld\(\); return; \}/);
  assert.match(main, /if \(code === handover\.HANDED_OVER\) \{ openOnHandedOver\(\); return; \}/);
  assert.match(main, /share\.release\(port, TOKEN, FLAVOR\.socketApp\)/);
  assert.doesNotMatch(main, /Quit it, then open \$\{FLAVOR\.name\} again\.`\s*:/); // the old dead end
  assert.doesNotMatch(main, /jarvis serve` in a terminal, or one that hasn/);
  const shell = readFileSync(new URL('../../app/features/shell.js', import.meta.url), 'utf8');
  assert.match(shell, /if \(ctx\.holdingQuit && ctx\.holdingQuit\(\)\) return;/);
  const eden = readFileSync(new URL('../../app/eden/main.js', import.meta.url), 'utf8');
  assert.doesNotMatch(eden, /share\.advertise\(/);
  assert.match(eden, /JARVIS_LAUNCHER_APP = 'ask-eden'/);
  assert.match(eden, /share\.release\(port, token, 'ask-eden'\)/);
  assert.match(eden, /ws\?token=\$\{token\}&app=ask-eden/);
});
