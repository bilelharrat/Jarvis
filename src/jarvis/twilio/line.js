// J.A.R.V.I.S. answers calls to the owner's Twilio number ("the Jarvis number"): the caller
// leaves a message after the tone, or books one of the open times the Jarvis app last put in
// Twilio Sync. It runs on the owner's own Twilio account (a protected Function: only Twilio's
// own signed requests reach it), so calls are answered while the Mac is asleep or off.
//
// Made and deployed by the Jarvis app (src/jarvis/answering.py); changes made to it in the
// Twilio Console are overwritten the next time answering is turned on.
//
// What it keeps: nothing of its own. A message is Twilio's recording on the call; a time a
// caller picks goes in the Sync list "picks", which the Mac empties as it collects them.
'use strict';

const https = require('https');

const SYNC = '__SYNC__'; // the Sync service with the open times ("availability") and "picks"
const VOICE = 'Polly.Brian-Neural';
const LEAD = 60 * 60 * 1000; // a time closer than this isn't offered any more
const PAGE = 3; // times offered at once
const PICK_TTL = 14 * 24 * 3600; // a pick the Mac never collects goes on its own
// What Twilio sends as From when the caller withheld their number.
const WITHHELD = ['', '+266696687', '+86282452253', '+8656696', '+2562533', 'anonymous', 'restricted', 'unknown', 'private'];

function esc(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function say(text) {
  return `<Say voice="${VOICE}">${esc(text)}</Say>`;
}

function respond(...parts) {
  return `<Response>${parts.join('')}</Response>`;
}

function withheld(from) {
  return WITHHELD.includes(String(from || '').trim().toLowerCase());
}

// One Sync request with the account's own credentials (the service includes them).
function sync(context, method, path, form) {
  return new Promise((resolve, reject) => {
    const body = form ? new URLSearchParams(form).toString() : '';
    const headers = { Accept: 'application/json' };
    if (form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = https.request(
      {
        host: 'sync.twilio.com',
        path: `/v1/Services/${SYNC}${path}`,
        method,
        headers,
        auth: `${context.ACCOUNT_SID}:${context.AUTH_TOKEN}`,
        timeout: 4000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode >= 400) {
            const err = new Error(`Sync said ${res.statusCode}`);
            err.status = res.statusCode;
            reject(err);
            return;
          }
          try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('Sync took too long')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// The open times and how to answer, as the Mac last published them ({} when unreachable).
async function availability(context) {
  try {
    const doc = await sync(context, 'GET', '/Documents/availability');
    return doc && doc.data && typeof doc.data === 'object' ? doc.data : {};
  } catch (err) {
    console.error('availability', err.message);
    return {};
  }
}

// Times callers have picked that the Mac hasn't collected yet.
async function picked(context) {
  try {
    const page = await sync(context, 'GET', '/Lists/picks/Items?PageSize=100');
    return (page.items || []).map((item) => item.data || {});
  } catch (err) {
    console.error('picks', err.message);
    return [];
  }
}

async function note(context, event, data) {
  await sync(context, 'POST', '/Lists/picks/Items', {
    Data: JSON.stringify({ call: event.CallSid, from: event.From, at: new Date().toISOString(), ...data }),
    ItemTtl: String(PICK_TTL),
  });
}

function owner(doc) {
  return String(doc.owner || '').trim();
}

function offerable(doc, picks, from) {
  if (!doc.booking || !Array.isArray(doc.slots) || withheld(from)) return [];
  const taken = new Set(picks.filter((p) => p.event === 'pick').map((p) => p.start));
  const soon = Date.now() + LEAD;
  return doc.slots.filter(
    (s) => s && s.start && s.said && Date.parse(s.start) > soon && !taken.has(s.start)
  );
}

// A time this caller already asked for and is waiting on ("" when none).
function waiting(doc, picks, from) {
  const mine = picks.find((p) => p.event === 'pick' && p.from === from && Date.parse(p.start) > Date.now());
  if (mine) return mine.said || '';
  const earlier = doc.waiting && typeof doc.waiting === 'object' ? doc.waiting[from] : '';
  return typeof earlier === 'string' ? earlier : '';
}

function url(context, step, params) {
  const query = new URLSearchParams({ step, ...(params || {}) }).toString();
  return `https://${context.DOMAIN_NAME}${context.PATH || '/call'}?${query}`;
}

// The message: up to three minutes after the tone; # or hanging up ends it.
function record(context, kind) {
  return (
    `<Record maxLength="180" timeout="7" playBeep="true" trim="trim-silence" finishOnKey="#" ` +
    `action="${esc(url(context, 'left', { kind }))}"/>` +
    say("I didn't hear a message. Goodbye.") +
    '<Hangup/>'
  );
}

async function answer(context, event) {
  const doc = await availability(context);
  const name = owner(doc);
  const open = doc.booking ? offerable(doc, await picked(context), event.From) : [];
  const hello = `Hello, you've reached Jarvis, ${name ? `${name}'s` : 'an'} AI assistant.`;
  const leave = withheld(event.From)
    ? 'leave a message after the tone, with a number to reach you.'
    : `leave a message${name ? ` for ${name}` : ''} after the tone.`;
  if (!open.length) return respond(say(`${hello} Please ${leave}`), record(context, 'message'));
  const menu = `${hello} To book a time to meet ${name || 'them'}, press 1 now. Or, please ${leave}`;
  return respond(
    `<Gather input="dtmf" numDigits="1" timeout="3" action="${esc(url(context, 'choose'))}">${say(menu)}</Gather>`,
    record(context, 'message')
  );
}

async function choose(context, event) {
  if (event.Digits === '1') return slots(context, event, 0, 0);
  return respond(say('Please leave your message after the tone.'), record(context, 'message'));
}

// A message instead of a time: the Mac hears the caller wanted to find one.
async function wantsTime(context, event, words) {
  try {
    await note(context, event, { event: 'wants_time' });
  } catch (err) {
    console.error('wants_time', err.message);
  }
  return respond(say(words), record(context, 'wants_time'));
}

async function slots(context, event, page, tries) {
  const doc = await availability(context);
  const picks = await picked(context);
  const name = owner(doc);
  const already = waiting(doc, picks, event.From);
  if (already) {
    return respond(
      say(`You've already asked for ${already}, and ${name || 'they'} will confirm it with you. ` +
        'If there is anything else, please leave a message after the tone.'),
      record(context, 'message')
    );
  }
  const open = offerable(doc, picks, event.From);
  if (!open.length) {
    return wantsTime(context, event,
      `I'm sorry, there are no open times I can offer just now. Please leave a message with a ` +
      `few times that suit you, and ${name || 'they'} will get back to you.`);
  }
  const pages = Math.ceil(open.length / PAGE);
  const at = ((page % pages) + pages) % pages;
  const shown = open.slice(at * PAGE, at * PAGE + PAGE);
  let words = at > 0 ? 'Here are some other times.' : name ? `${name} has these times open.` : 'These times are open.';
  shown.forEach((s, i) => { words += ` For ${s.said}, press ${i + 1}.`; });
  if (pages > 1) words += ' For other times, press 9.';
  words += ' To leave a message instead, press 0.';
  const offered = shown.map((s) => s.start).join('|');
  const again = tries < 1
    ? `<Redirect>${esc(url(context, 'slots', { page: String(at), tries: String(tries + 1) }))}</Redirect>`
    : say('Let me take a message instead.') + record(context, 'wants_time');
  return respond(
    `<Gather input="dtmf" numDigits="1" timeout="8" action="${esc(url(context, 'pick', { page: String(at), o: offered }))}">${say(words)}</Gather>`,
    again
  );
}

async function pick(context, event) {
  const page = parseInt(event.page, 10) || 0;
  const digit = String(event.Digits || '');
  if (digit === '0') {
    return wantsTime(context, event, 'Please leave your message, with some times that suit you, after the tone.');
  }
  if (digit === '9') return slots(context, event, page + 1, 0);
  const offered = String(event.o || '').split('|').filter(Boolean);
  const chosen = /^[1-9]$/.test(digit) ? offered[Number(digit) - 1] : undefined;
  if (!chosen) {
    return respond(say("Sorry, I didn't catch that."),
      `<Redirect>${esc(url(context, 'slots', { page: String(page), tries: '1' }))}</Redirect>`);
  }
  const doc = await availability(context);
  const slot = offerable(doc, await picked(context), event.From).find((s) => s.start === chosen);
  if (!slot) {
    return respond(say("I'm sorry, that time has just gone."),
      `<Redirect>${esc(url(context, 'slots', { page: '0', tries: '1' }))}</Redirect>`);
  }
  // Noted before the caller hears it's theirs; if it can't be, the handler takes a message.
  await note(context, event, { event: 'pick', start: slot.start, said: slot.said });
  return respond(
    say(`${slot.said}. After the tone, please say your name and what you'd like to meet about, then press the pound key.`),
    `<Record maxLength="60" timeout="5" playBeep="true" trim="trim-silence" finishOnKey="#" action="${esc(url(context, 'booked', { said: slot.said }))}"/>`,
    closing(doc, slot.said)
  );
}

// What a caller who picked a time hears last.
function closing(doc, said) {
  const name = owner(doc) || 'them';
  const words = doc.autobook
    ? `Thank you. You're booked with ${name}${said ? ` for ${said}` : ''}. If anything changes, call this number and leave a message. Goodbye.`
    : `Thank you. I've passed that to ${name}. Once it's confirmed, I'll call you back at this number. Goodbye.`;
  return say(words) + '<Hangup/>';
}

async function booked(context, event) {
  return respond(closing(await availability(context), String(event.said || '')));
}

async function left(context, event) {
  if (event.RecordingDuration === '0') return respond(say("I didn't hear a message. Goodbye."), '<Hangup/>');
  const name = owner(await availability(context));
  return respond(say(`Thank you. I'll pass your message to ${name || 'them'}. Goodbye.`), '<Hangup/>');
}

async function slotsStep(context, event) {
  return slots(context, event, parseInt(event.page, 10) || 0, parseInt(event.tries, 10) || 0);
}

const STEPS = { answer, choose, slots: slotsStep, pick, booked, left };

function reply(callback, xml) {
  const body = `<?xml version="1.0" encoding="UTF-8"?>${xml}`;
  if (typeof Twilio !== 'undefined' && Twilio.Response) {
    const response = new Twilio.Response();
    response.appendHeader('Content-Type', 'text/xml');
    response.setBody(body);
    callback(null, response);
    return;
  }
  callback(null, body);
}

exports.handler = async function handler(context, event, callback) {
  const step = Object.prototype.hasOwnProperty.call(STEPS, event.step) ? event.step : 'answer';
  try {
    reply(callback, await STEPS[step](context, event));
  } catch (err) {
    // Whatever went wrong, the caller can still leave a message.
    console.error(step, err && err.message);
    reply(callback, respond(say('Sorry, something went wrong on my side. Please leave a message after the tone.'), record(context, 'message')));
  }
};
