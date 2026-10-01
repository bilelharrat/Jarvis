// WhatsApp for Jarvis: the owner's own account, linked as one of its devices the way WhatsApp
// Web is (on the phone: Settings → Linked devices). Run by src/jarvis/features/whatsapp.py,
// one per Jarvis, it speaks JSON lines: events on stdout, requests on stdin ({req, type, …},
// each answered by {type: "result", req, ok, …}). It ends when stdin does.
//
//   node bridge.mjs <auth folder>
//
// Events: qr {qr, image}, status {state: connecting | open | reconnecting | logged_out |
// replaced | link_expired, me?, code?}, chats {chats, update?}, contacts {contacts},
// lids {map: [[lid, pn]…]}, messages {messages, live}.
// Requests: send {to, text}, send_file {to, path, name, mimetype, caption}, check {phone},
// logout. A message Jarvis sends gets an id made here first, and each message of its own
// comes back marked jarvis: true, so its chat channel never reads its own words as the owner's.
//
// Jarvis stays offline on the account (markOnlineOnConnect: false), so the phone keeps
// getting its notifications. Nothing here reads a message aloud or sends one on its own:
// every send is a request from Jarvis, after the owner said yes to its exact text.

import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  generateMessageID,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import { readFile } from 'node:fs/promises';
import pino from 'pino';
import QRCode from 'qrcode';
import readline from 'node:readline';

import { brief, chatOf, contactOf, norm } from './lib.mjs';

const AUTH = process.argv[2];
if (!AUTH) {
  process.stderr.write('usage: node bridge.mjs <auth folder>\n');
  process.exit(2);
}

const logger = pino({ level: 'error' }, pino.destination(2)); // stdout is the JSON channel
const BATCH = 300; // messages per line: a history sync can carry thousands
const RETRY_MS = [2000, 5000, 15000, 30000, 60000];

function out(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

const own = new Set(); // ids of what Jarvis sent, newest last
function ours(id) {
  own.add(id);
  while (own.size > 500) own.delete(own.values().next().value);
  return id;
}

function sendMessages(list, live) {
  const messages = (list || []).map((m) => brief(m, own)).filter(Boolean);
  for (let i = 0; i < messages.length; i += BATCH) {
    out({ type: 'messages', live, messages: messages.slice(i, i + BATCH) });
  }
}

function sendLids(mappings) {
  const map = (mappings || [])
    .map((m) => [norm(m && m.lid), norm(m && m.pn)])
    .filter(([lid, pn]) => lid && pn);
  if (map.length) out({ type: 'lids', map });
}

let sock = null;
let open = false;
let attempt = 0;

async function connect() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH);
  let version;
  try {
    ({ version } = await fetchLatestBaileysVersion());
  } catch {
    // the built-in version then
  }
  sock = makeWASocket({
    auth: state,
    ...(version ? { version } : {}),
    logger,
    browser: Browsers.macOS('Desktop'),
    markOnlineOnConnect: false,
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
    getMessage: async () => undefined,
  });
  const ev = sock.ev;
  ev.on('creds.update', saveCreds);
  ev.on('connection.update', async (update) => {
    if (update.qr) {
      let image = null;
      try {
        image = await QRCode.toDataURL(update.qr, { margin: 1, width: 264 });
      } catch {
        // the raw code still goes; the window can say to try again
      }
      out({ type: 'qr', qr: update.qr, image });
    }
    if (update.connection === 'connecting') out({ type: 'status', state: 'connecting' });
    if (update.connection === 'open') {
      open = true;
      attempt = 0;
      const user = sock.user || {};
      out({ type: 'status', state: 'open', me: { id: norm(user.id), lid: norm(user.lid), name: user.name || user.notify || null } });
      try {
        const groups = await sock.groupFetchAllParticipating();
        const chats = Object.values(groups || {}).map((g) => ({ id: norm(g.id), name: g.subject || null })).filter((c) => c.id);
        if (chats.length) out({ type: 'chats', chats, update: true });
      } catch {
        // group names come with their messages instead
      }
    }
    if (update.connection === 'close') {
      open = false;
      const code = update.lastDisconnect && update.lastDisconnect.error && update.lastDisconnect.error.output
        ? update.lastDisconnect.error.output.statusCode
        : undefined;
      if (code === DisconnectReason.loggedOut) {
        out({ type: 'status', state: 'logged_out', code });
        process.exit(0);
      }
      if (code === DisconnectReason.connectionReplaced) {
        out({ type: 'status', state: 'replaced', code }); // another copy linked with these keys
        process.exit(0);
      }
      if (!state.creds.me && code === DisconnectReason.timedOut) {
        out({ type: 'status', state: 'link_expired', code }); // no one scanned the codes
        process.exit(0);
      }
      out({ type: 'status', state: 'reconnecting', code });
      const wait = code === DisconnectReason.restartRequired ? 0 : RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)];
      attempt += 1;
      setTimeout(() => connect().catch(fatal), wait);
    }
  });
  ev.on('messaging-history.set', ({ chats, contacts, messages, lidPnMappings }) => {
    sendLids(lidPnMappings);
    const cs = (contacts || []).map(contactOf).filter(Boolean);
    if (cs.length) out({ type: 'contacts', contacts: cs });
    const ch = (chats || []).map(chatOf).filter(Boolean);
    if (ch.length) out({ type: 'chats', chats: ch });
    sendMessages(messages, false);
  });
  ev.on('lid-mapping.update', (mapping) => sendLids([mapping]));
  ev.on('chats.upsert', (chats) => {
    const ch = (chats || []).map(chatOf).filter(Boolean);
    if (ch.length) out({ type: 'chats', chats: ch });
  });
  ev.on('chats.update', (updates) => {
    const ch = (updates || []).map(chatOf).filter(Boolean);
    if (ch.length) out({ type: 'chats', chats: ch, update: true });
  });
  ev.on('groups.update', (updates) => {
    const ch = (updates || []).filter((g) => g && g.subject).map((g) => ({ id: norm(g.id), name: g.subject })).filter((c) => c.id);
    if (ch.length) out({ type: 'chats', chats: ch, update: true });
  });
  const contacts = (list) => {
    const cs = (list || []).map(contactOf).filter(Boolean);
    if (cs.length) out({ type: 'contacts', contacts: cs });
  };
  ev.on('contacts.upsert', contacts);
  ev.on('contacts.update', contacts);
  ev.on('messages.upsert', ({ messages, type }) => sendMessages(messages, type === 'notify'));
}

async function handle(req) {
  if (req.type === 'logout') {
    try {
      if (sock) await sock.logout();
    } finally {
      out({ type: 'result', req: req.req, ok: true });
      process.exit(0);
    }
  }
  if (!sock || !open) return { ok: false, error: 'not connected' };
  if (req.type === 'send') {
    const to = norm(String(req.to || ''));
    const text = String(req.text || '');
    if (!to || !text) return { ok: false, error: 'nothing to send' };
    const messageId = ours(generateMessageID());
    const sent = await sock.sendMessage(to, { text }, { messageId });
    return { ok: true, id: sent && sent.key ? sent.key.id : messageId };
  }
  if (req.type === 'send_file') {
    const to = norm(String(req.to || ''));
    const path = String(req.path || '');
    if (!to || !path) return { ok: false, error: 'nothing to send' };
    const document = await readFile(path);
    const messageId = ours(generateMessageID());
    const sent = await sock.sendMessage(to, {
      document,
      fileName: String(req.name || 'file'),
      mimetype: String(req.mimetype || 'application/octet-stream'),
      caption: String(req.caption || '') || undefined,
    }, { messageId });
    return { ok: true, id: sent && sent.key ? sent.key.id : messageId };
  }
  if (req.type === 'check') {
    const digits = String(req.phone || '').replace(/\D/g, '');
    if (!digits) return { ok: false, error: 'no number' };
    const found = (await sock.onWhatsApp(digits)) || [];
    const hit = found.find((r) => r && r.exists);
    return { ok: true, exists: Boolean(hit), jid: hit ? norm(hit.jid) : null };
  }
  return { ok: false, error: `unknown request ${req.type}` };
}

function fatal(err) {
  out({ type: 'status', state: 'error', error: String((err && err.message) || err) });
  process.exit(1);
}

const input = readline.createInterface({ input: process.stdin });
input.on('line', async (line) => {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  try {
    const result = await handle(req);
    out({ type: 'result', req: req.req, ...result });
  } catch (err) {
    out({ type: 'result', req: req.req, ok: false, error: String((err && err.message) || err) });
  }
});
input.on('close', () => process.exit(0));

if (process.env.JARVIS_WA_NO_CONNECT !== '1') connect().catch(fatal);
