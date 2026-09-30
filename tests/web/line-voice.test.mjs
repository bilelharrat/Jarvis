// The Jarvis number in JARVIS's own voice (src/jarvis/twilio/line.js): with the Mac's cloud
// voice in the service's variables, every line is a <Play> of the Function's voice step,
// which voices it and sends back the phone's WAV. When the voice service fails, the caller
// hears a moment's silence, never an error, and Twilio's voice reads the call for a while.
// (That the audio is the Mac's own is held in tests/test_line_voice.py.) node --test tests/web/
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const https = require('node:https');

// Sync (the availability and voice-down documents) and the voice service, faked.
const sync = { doc: null, down: null, broken: false, requests: [] };
const tts = { statuses: [], requests: [] };
https.request = (options, onResponse) => {
  const req = new EventEmitter();
  let body = '';
  req.write = (chunk) => { body += chunk; };
  req.destroy = (err) => req.emit('error', err);
  req.end = () => {
    let status = 200;
    let out = '{}';
    if (options.host === 'sync.twilio.com') {
      sync.requests.push({ method: options.method, path: options.path, body });
      const path = options.path.replace(/^\/v1\/Services\/IS123/, '');
      const form = new URLSearchParams(body);
      if (sync.broken && path.startsWith('/Documents/talk-')) {
        status = 500;
      } else if (options.method === 'GET' && path === '/Documents/availability') {
        if (sync.doc) out = JSON.stringify({ data: sync.doc }); else status = 404;
      } else if (options.method === 'GET' && path === '/Documents/voice-down') {
        if (sync.down) out = JSON.stringify({ data: sync.down.data }); else status = 404;
      } else if (options.method === 'POST' && path === '/Documents' && form.get('UniqueName') === 'voice-down') {
        if (sync.down) status = 409;
        else sync.down = { data: JSON.parse(form.get('Data')), ttl: form.get('Ttl') };
      } else if (options.method === 'POST' && path === '/Documents/voice-down') {
        sync.down = { data: JSON.parse(form.get('Data')), ttl: form.get('Ttl') };
      } else if (options.method === 'GET' && path.startsWith('/Lists/picks/Items')) {
        out = JSON.stringify({ items: [] });
      }
    } else {
      tts.requests.push({ host: options.host, path: options.path, headers: options.headers, body: JSON.parse(body) });
      status = tts.statuses.length ? tts.statuses.shift() : 200;
      out = status === 200 ? Buffer.alloc(4800 * 2, 0x10) : '{"message":"no"}'; // 0.2 s at 24 kHz
    }
    const res = new EventEmitter();
    res.statusCode = status;
    setImmediate(() => {
      onResponse(res);
      res.emit('data', out);
      res.emit('end');
    });
  };
  return req;
};

const source = require('node:fs').readFileSync(new URL('../../src/jarvis/twilio/line.js', import.meta.url), 'utf8');
const mod = { exports: {} };
new Function('exports', 'require', 'module', source.replace('__SYNC__', 'IS123'))(mod.exports, require, mod);
const { handler } = mod.exports;

const PLAIN = { ACCOUNT_SID: 'AC1', AUTH_TOKEN: 'secret', DOMAIN_NAME: 'jarvis-line-1-line.twil.io', PATH: '/call' };
const VOICED = { ...PLAIN, VOICE_PROVIDER: 'fish', VOICE_KEY: 'fish-key', VOICE_ID: 'jarvis-voice', VOICE_MODEL: 's2.1-pro', VOICE_EFFECT: '1' };

function reset(doc) {
  Object.assign(sync, { doc, down: null, broken: false, requests: [] });
  Object.assign(tts, { statuses: [], requests: [] });
}

function call(event, context = VOICED) {
  return new Promise((resolve, reject) => {
    handler(context, { CallSid: 'CA1', From: '+14155550123', To: '+16504182384', Direction: 'inbound', ...event }, (err, body) => {
      if (err) reject(err); else resolve(body);
    });
  });
}

// What each <Play> in a call's script says, and in which voice.
function played(xml) {
  return [...xml.matchAll(/<Play>([^<]*)<\/Play>/g)].map(([, at]) => {
    const u = new URL(at.replace(/&amp;/g, '&'));
    assert.equal(`${u.origin}${u.pathname}`, 'https://jarvis-line-1-line.twil.io/call');
    assert.equal(u.searchParams.get('step'), 'voice');
    return { v: u.searchParams.get('v'), say: u.searchParams.get('say') };
  });
}

function wellFormed(xml) {
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?><Response>'), xml);
  assert.ok(xml.endsWith('</Response>'), xml);
  assert.doesNotMatch(xml, /&(?!amp;|lt;|gt;|quot;)/);
}

test("with the Mac's cloud voice, callers hear it, not Twilio's", async () => {
  reset({ owner: 'Bilel', booking: false });
  const xml = await call({});
  wellFormed(xml);
  assert.doesNotMatch(xml, /<Say/);
  const lines = played(xml);
  assert.deepEqual(lines.map((l) => l.say), [
    "Hello, you've reached Jarvis, Bilel's AI assistant. Please leave a message for Bilel after the tone.",
    "I didn't hear a message. Goodbye.",
  ]);
  assert.match(xml, /<\/Play><Record [^>]*\/><Play>/); // the tone comes after the greeting
  assert.ok(lines[0].v && lines.every((l) => l.v === lines[0].v));
});

test('without a cloud voice, Twilio reads the call as before', async () => {
  reset({ owner: 'Bilel', booking: false });
  const xml = await call({}, PLAIN);
  assert.match(xml, /<Say voice="Polly\.Brian-Neural">Hello, you've reached Jarvis/);
  assert.doesNotMatch(xml, /<Play>/);
  assert.ok(!sync.requests.some((r) => r.path.endsWith('/voice-down')));
});

test('a conversation speaks in the voice, and the caller can still talk over it', async () => {
  reset({ owner: 'Bilel', talk: true });
  const xml = await call({}, { ...VOICED, ANTHROPIC_API_KEY: 'sk-ant-test' });
  wellFormed(xml);
  assert.match(xml, /<Gather input="speech"[^>]*><Play>[^<]+<\/Play><\/Gather>/);
  assert.equal(played(xml)[0].say, "Hello, you've reached Jarvis, Bilel's AI assistant. This call is transcribed. How can I help you?");
});

test("what's said is unescaped for the voice, and long lines go in pieces at sentence ends", async () => {
  const long = Array.from({ length: 12 }, (_, i) => `This is sentence number ${i + 1} of what Jarvis says.`).join(' ');
  reset({ owner: `Ann & <Co> ${long}`, booking: false });
  const lines = played(await call({ step: 'left', RecordingDuration: '12' }));
  const said = lines.map((l) => l.say);
  assert.ok(said.length > 1 && said.every((p) => p.length <= 300), said.join('\n'));
  assert.ok(said.slice(0, -1).every((p) => /[.!?]$/.test(p)));
  assert.equal(said.join(' '), `Thank you. I'll pass your message to Ann & <Co> ${long}. Goodbye.`);
});

test('a new voice or effect is a new address, so Twilio never plays the old one from its cache', async () => {
  reset({ owner: 'Bilel' });
  const [a] = played(await call({}));
  const [b] = played(await call({}, { ...VOICED, VOICE_EFFECT: '' }));
  const [c] = played(await call({}, { ...VOICED, VOICE_ID: 'another' }));
  assert.equal(a.say, b.say);
  assert.equal(new Set([a.v, b.v, c.v]).size, 3);
});

test('the voice step voices the line and sends the phone its WAV, kept by Twilio', async () => {
  reset(null);
  class Response {
    constructor() { this.headers = {}; }
    appendHeader(k, v) { this.headers[k] = v; }
    setBody(b) { this.body = b; }
  }
  globalThis.Twilio = { Response };
  try {
    const response = await call({ step: 'voice', v: 'x', say: 'At your service.' });
    assert.equal(response.headers['Content-Type'], 'audio/wav');
    assert.equal(response.headers['Cache-Control'], 'max-age=86400');
    const wav = response.body;
    assert.equal(response.headers['Content-Length'], String(wav.length));
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    assert.equal(wav.readUInt32LE(24), 8000);
    assert.ok(wav.length > 44 + 1000); // 0.2 s voiced, with the effect's room after it
  } finally {
    delete globalThis.Twilio;
  }
  assert.equal(tts.requests.length, 1);
  assert.equal(tts.requests[0].body.text, 'At your service.');
});

test('a refused voice (key, credit) is silence, and Twilio reads calls for an hour', async () => {
  reset({ owner: 'Bilel', booking: false });
  tts.statuses = [402];
  const wav = await call({ step: 'voice', v: 'x', say: 'Hello.' });
  assert.equal(wav.readUInt32LE(40), 2 * 2000); // a quarter second of silence
  assert.ok(wav.subarray(44).every((b) => b === 0));
  assert.equal(tts.requests.length, 1); // not tried again: it said no
  assert.equal(sync.down.ttl, '3600');
  assert.ok(Date.parse(sync.down.data.until) > Date.now() + 3500 * 1000);
  const xml = await call({});
  assert.match(xml, /<Say voice="Polly\.Brian-Neural">Hello, you've reached Jarvis/);
  assert.doesNotMatch(xml, /<Play>/);
});

test('a blip is tried again; failing twice, Twilio reads calls for a couple of minutes', async () => {
  reset(null);
  tts.statuses = [503];
  let wav = await call({ step: 'voice', v: 'x', say: 'Hello.' });
  assert.equal(tts.requests.length, 2);
  assert.ok(wav.subarray(44).some((b) => b !== 0)); // the second time, voiced
  assert.equal(sync.down, null);
  tts.statuses = [503, 500];
  wav = await call({ step: 'voice', v: 'x', say: 'Hello.' });
  assert.ok(wav.subarray(44).every((b) => b === 0));
  assert.equal(sync.down.ttl, '120');
  // Written over when it's there already.
  tts.statuses = [401];
  await call({ step: 'voice', v: 'x', say: 'Hello.' });
  assert.equal(sync.down.ttl, '3600');
});

test("once the time's up, the voice comes back", async () => {
  reset({ owner: 'Bilel', booking: false });
  sync.down = { data: { until: new Date(Date.now() - 1000).toISOString() } };
  assert.match(await call({}), /<Play>/);
});

test('without a voice, the voice step asks no one and is silence', async () => {
  reset(null);
  const wav = await call({ step: 'voice', v: 'x', say: 'Hello.' }, PLAIN);
  assert.ok(wav.subarray(44).every((b) => b === 0));
  assert.equal(tts.requests.length, 0);
});

test('when a step fails, the caller still hears the voice ask for a message', async () => {
  reset({ owner: 'Bilel', talk: true });
  sync.broken = true; // the conversation can't be read: the step throws
  const xml = await call({ step: 'talk', t: 'CA1', SpeechResult: 'Hello?' }, { ...VOICED, ANTHROPIC_API_KEY: 'sk-ant-test' });
  wellFormed(xml);
  assert.equal(played(xml)[0].say, 'Sorry, something went wrong on my side. Please leave a message after the tone.');
  assert.match(xml, /<Record /);
});
