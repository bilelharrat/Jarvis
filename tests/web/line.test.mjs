// The Twilio Function that answers the Jarvis number (src/jarvis/twilio/line.js), run here
// as Twilio runs it: handler(context, event, callback), with Sync faked in memory. A caller
// can always leave a message; booking offers only open times, and a pick is noted in Sync
// before the caller hears it's theirs. node --test tests/web/
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const https = require('node:https');

// Sync as the Function sees it: the availability document and the picks list.
const sync = { doc: null, items: [], down: false, writeFails: false, requests: [] };
https.request = (options, onResponse) => {
  const req = new EventEmitter();
  let body = '';
  req.write = (chunk) => { body += chunk; };
  req.destroy = (err) => req.emit('error', err);
  req.end = () => {
    sync.requests.push({ method: options.method, path: options.path, body, auth: options.auth });
    let status = 200;
    let out = {};
    const path = options.path.replace(/^\/v1\/Services\/IS123/, '');
    if (sync.down) status = 500;
    else if (options.method === 'GET' && path === '/Documents/availability') {
      if (sync.doc) out = { data: sync.doc }; else status = 404;
    } else if (options.method === 'GET' && path.startsWith('/Lists/picks/Items')) {
      out = { items: sync.items.map((data, index) => ({ index, data })) };
    } else if (options.method === 'POST' && path === '/Lists/picks/Items') {
      if (sync.writeFails) status = 503;
      else sync.items.push(JSON.parse(new URLSearchParams(body).get('Data')));
    }
    const res = new EventEmitter();
    res.statusCode = status;
    setImmediate(() => {
      onResponse(res);
      res.emit('data', JSON.stringify(out));
      res.emit('end');
    });
  };
  return req;
};

const source = require('node:fs').readFileSync(new URL('../../src/jarvis/twilio/line.js', import.meta.url), 'utf8');
const mod = { exports: {} };
new Function('exports', 'require', 'module', source.replace('__SYNC__', 'IS123'))(mod.exports, require, mod);
const { handler } = mod.exports;

const CONTEXT = { ACCOUNT_SID: 'AC1', AUTH_TOKEN: 'secret', DOMAIN_NAME: 'jarvis-line-1-line.twil.io', PATH: '/call' };
const HOUR = 3600 * 1000;
const at = (hours) => new Date(Date.now() + hours * HOUR).toISOString();

function slots(n, from = 24) {
  return Array.from({ length: n }, (_, i) => ({ start: at(from + i * 5), said: `Time ${i + 1}` }));
}

function reset(doc) {
  Object.assign(sync, { doc, items: [], down: false, writeFails: false, requests: [] });
}

function call(event) {
  return new Promise((resolve, reject) => {
    handler(CONTEXT, { CallSid: 'CA1', From: '+14155550123', To: '+16504182384', ...event }, (err, body) => {
      if (err) reject(err); else resolve(typeof body === 'string' ? body : body.body);
    });
  });
}

// TwiML is XML: every & in it is an entity (the step URLs carry several parameters).
function wellFormed(xml) {
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?><Response>'), xml);
  assert.ok(xml.endsWith('</Response>'), xml);
  assert.doesNotMatch(xml, /&(?!amp;|lt;|gt;|quot;)/);
}

test('with times open, the caller hears who they reached and can press 1 or leave a message', async () => {
  reset({ owner: 'Bilel', booking: true, slots: slots(4) });
  const xml = await call({});
  wellFormed(xml);
  assert.match(xml, /Hello, you've reached Jarvis, Bilel's AI assistant\. To book a time to meet Bilel, press 1 now\. Or, please leave a message for Bilel after the tone\./);
  assert.match(xml, /<Gather input="dtmf" numDigits="1"[^>]*action="https:\/\/jarvis-line-1-line\.twil\.io\/call\?step=choose"/);
  assert.match(xml, /<\/Gather><Record maxLength="180"/); // no key pressed: the message
  assert.equal(sync.requests[0].auth, 'AC1:secret');
});

test('without booking, or with Sync down, it is a plain voicemail', async () => {
  reset({ owner: 'Bilel', booking: false, slots: slots(3) });
  let xml = await call({});
  wellFormed(xml);
  assert.doesNotMatch(xml, /Gather/);
  assert.match(xml, /Please leave a message for Bilel after the tone\.<\/Say><Record /);
  reset(null);
  sync.down = true;
  xml = await call({});
  wellFormed(xml);
  assert.match(xml, /Hello, you've reached Jarvis, an AI assistant\. Please leave a message after the tone\.<\/Say><Record /);
});

test('a caller who withheld their number is asked for one, and offered no times', async () => {
  reset({ owner: 'Bilel', booking: true, slots: slots(3) });
  const xml = await call({ From: '+266696687' });
  assert.doesNotMatch(xml, /press 1/);
  assert.match(xml, /with a number to reach you/);
});

test('pressing 1 reads the open times, three at a time, skipping soon and picked ones', async () => {
  const open = [
    { start: at(0.5), said: 'Too soon' },
    ...slots(5),
  ];
  reset({ owner: 'Bilel', booking: true, slots: open });
  sync.items.push({ event: 'pick', call: 'CA0', from: '+14155550999', start: open[2].start, said: 'Time 2' });
  let xml = await call({ step: 'choose', Digits: '1' });
  wellFormed(xml);
  assert.match(xml, /Bilel has these times open\. For Time 1, press 1\. For Time 3, press 2\. For Time 4, press 3\. For other times, press 9\. To leave a message instead, press 0\./);
  assert.doesNotMatch(xml, /Too soon|Time 2/);
  const action = xml.match(/action="([^"]+step=pick[^"]+)"/)[1].replace(/&amp;/g, '&');
  const offered = new URL(action).searchParams.get('o').split('|');
  assert.deepEqual(offered, [open[1].start, open[3].start, open[4].start]);
  xml = await call({ step: 'pick', Digits: '9', page: '0', o: offered.join('|') });
  assert.match(xml, /Here are some other times\. For Time 5, press 1\. For other times, press 9\./);
  assert.match(xml, /<Redirect>[^<]*step=slots&amp;page=1&amp;tries=1<\/Redirect>/); // no key: asked once more
});

test('a pick is noted in Sync before the caller hears it, then they give their name', async () => {
  const open = slots(3);
  reset({ owner: 'Bilel', booking: true, slots: open });
  const o = open.map((s) => s.start).join('|');
  const xml = await call({ step: 'pick', Digits: '2', page: '0', o });
  wellFormed(xml);
  assert.equal(sync.items.length, 1);
  assert.deepEqual(
    { ...sync.items[0], at: undefined },
    { call: 'CA1', from: '+14155550123', event: 'pick', start: open[1].start, said: 'Time 2', at: undefined }
  );
  const write = sync.requests.find((r) => r.method === 'POST');
  assert.equal(new URLSearchParams(write.body).get('ItemTtl'), String(14 * 24 * 3600));
  assert.match(xml, /Time 2\. After the tone, please say your name and what you'd like to meet about/);
  assert.match(xml, /<Record maxLength="60"[^>]*action="[^"]*step=booked&amp;said=Time\+2"/);
  assert.match(xml, /I've passed that to Bilel\. Once it's confirmed, I'll call you back at this number\./);
});

test('a time picked by someone else meanwhile is gone; the menu comes again', async () => {
  const open = slots(3);
  reset({ owner: 'Bilel', booking: true, slots: open });
  sync.items.push({ event: 'pick', call: 'CA9', from: '+14155550999', start: open[0].start, said: 'Time 1' });
  const xml = await call({ step: 'pick', Digits: '1', page: '0', o: open.map((s) => s.start).join('|') });
  assert.match(xml, /that time has just gone\.<\/Say><Redirect>[^<]*step=slots/);
  assert.equal(sync.items.length, 1);
});

test("if the pick can't be noted, the caller is asked for a message instead of told it's booked", async () => {
  const open = slots(3);
  reset({ owner: 'Bilel', booking: true, slots: open });
  sync.writeFails = true;
  const xml = await call({ step: 'pick', Digits: '1', page: '0', o: open.map((s) => s.start).join('|') });
  wellFormed(xml);
  assert.match(xml, /something went wrong on my side\. Please leave a message after the tone\.<\/Say><Record maxLength="180"/);
  assert.doesNotMatch(xml, /passed that|booked/);
});

test('a caller already waiting on a time is told so; 0 leaves a message about times', async () => {
  reset({ owner: 'Bilel', booking: true, slots: slots(3), waiting: { '+14155550123': 'Thursday, October 8th, at 2 PM' } });
  let xml = await call({ step: 'choose', Digits: '1' });
  assert.match(xml, /You've already asked for Thursday, October 8th, at 2 PM, and Bilel will confirm it with you\./);
  reset({ owner: 'Bilel', booking: true, slots: slots(3) });
  xml = await call({ step: 'pick', Digits: '0', page: '0', o: '' });
  assert.equal(sync.items[0].event, 'wants_time');
  assert.match(xml, /with some times that suit you, after the tone/);
});

test('with no times left, the caller leaves a message with times that suit them', async () => {
  reset({ owner: 'Bilel', booking: true, slots: [{ start: at(-2), said: 'Gone' }] });
  const xml = await call({ step: 'choose', Digits: '1' });
  assert.match(xml, /no open times I can offer just now/);
  assert.equal(sync.items[0].event, 'wants_time');
});

test('booked without asking: the caller hears they are booked', async () => {
  reset({ owner: 'Bilel', booking: true, autobook: true, slots: slots(3) });
  const xml = await call({ step: 'booked', said: 'Time 1', RecordingUrl: 'x' });
  wellFormed(xml);
  assert.match(xml, /You're booked with Bilel for Time 1\. If anything changes, call this number and leave a message\. Goodbye\.<\/Say><Hangup\/>/);
});

test("the message's end thanks them, or says nothing was heard", async () => {
  reset({ owner: 'Bilel' });
  assert.match(await call({ step: 'left', RecordingDuration: '12' }), /I'll pass your message to Bilel\. Goodbye\./);
  assert.match(await call({ step: 'left', RecordingDuration: '0' }), /I didn't hear a message/);
});

test('names and times are escaped for XML', async () => {
  reset({ owner: 'Ann & <Co>', booking: true, slots: [{ start: at(30), said: 'Mon "late"' }] });
  const xml = await call({ step: 'choose', Digits: '1' });
  wellFormed(xml);
  assert.match(xml, /Ann &amp; &lt;Co&gt; has these times open\. For Mon &quot;late&quot;, press 1\./);
});

test("in Twilio's runtime the answer goes out as text/xml", async () => {
  class Response {
    constructor() { this.headers = {}; }
    appendHeader(k, v) { this.headers[k] = v; }
    setBody(b) { this.body = b; }
  }
  globalThis.Twilio = { Response };
  try {
    reset({ owner: 'Bilel' });
    const response = await new Promise((resolve) => handler(CONTEXT, { From: '+14155550123' }, (_e, r) => resolve(r)));
    assert.ok(response instanceof Response);
    assert.equal(response.headers['Content-Type'], 'text/xml');
    assert.match(response.body, /<Record /);
  } finally {
    delete globalThis.Twilio;
  }
});
