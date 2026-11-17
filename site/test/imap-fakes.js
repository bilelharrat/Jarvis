// Fake IMAP and SMTP servers for Eden Mail's IMAP mailboxes (test/mail-imap.test.js), behind a fake
// cloudflare:sockets `connect` (env.MAIL_SOCKETS). Enough of RFC 3501 / 5321 for what mail-imap.js
// sends; nothing here touches a network.
import { imapTokenize } from '../src/eden/imap.js';

const enc = new TextEncoder();
const dec = new TextDecoder();
const latin1 = (b) => { let s = ''; for (const x of b) s += String.fromCharCode(x); return s; };
const bytesOf = (s) => { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 255; return b; };

/** A socket pair end the client uses: readable gets what the server says, writable feeds the server. */
function socketFor(session) {
  let ctrl;
  const readable = new ReadableStream({ start(c) { ctrl = c; } });
  const sock = {
    readable,
    writable: new WritableStream({ write(chunk) { session.input(chunk instanceof Uint8Array ? chunk : enc.encode(String(chunk))); } }),
    say(text) { try { ctrl.enqueue(typeof text === 'string' ? bytesOf(text) : text); } catch { /* closed */ } },
    async close() { try { ctrl.close(); } catch { /* closed */ } session.closed = true; },
    startTls() { session.tls = true; const next = socketFor(session); session.sock = next; return next; },
    opened: Promise.resolve(),
    closed: new Promise(() => {}),
  };
  return sock;
}

const imapDate = (ms) => { const d = new Date(ms); const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']; const p = (n) => String(n).padStart(2, '0'); return `${p(d.getUTCDate())}-${M[d.getUTCMonth()]}-${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`; };
const headerPart = (raw) => { const i = raw.search(/\r\n\r\n/); return i < 0 ? `${raw}\r\n\r\n` : raw.slice(0, i + 4); };
const textPart = (raw) => { const i = raw.search(/\r\n\r\n/); return i < 0 ? '' : raw.slice(i + 4); };
const headerValue = (raw, name) => { const m = new RegExp(`^${name}:\\s*(.*(?:\\r\\n[ \\t].*)*)`, 'im').exec(headerPart(raw)); return m ? m[1].replace(/\r\n[ \t]+/g, ' ') : ''; };

/**
 * One IMAP account: folders of messages ({ uid, flags: Set, raw (binary string), internal ms }).
 * `users`: login names that work; `password`; `caps`. Counts logins in `logins`.
 */
export class FakeImap {
  constructor({ users, password, folders = ['INBOX', 'Sent Messages', 'Drafts', 'Archive', 'Deleted Messages', 'Junk'], specialUse = false, caps = 'IMAP4rev1 SASL-IR AUTH=PLAIN UIDPLUS MOVE' }) {
    this.users = users;
    this.password = password;
    this.caps = caps;
    this.logins = [];
    this.commands = [];
    this.box = {};
    let v = 1700000000;
    for (const f of folders) this.box[f] = { uidvalidity: v++, uidnext: 1, msgs: [], special: specialUse ? ({ 'Sent Messages': '\\Sent', Drafts: '\\Drafts', Archive: '\\Archive', 'Deleted Messages': '\\Trash', Junk: '\\Junk' })[f] || '' : '' };
  }
  add(folder, raw, { flags = [], internal = Date.now() } = {}) {
    const b = this.box[folder];
    const m = { uid: b.uidnext++, flags: new Set(flags), raw: typeof raw === 'string' ? raw : latin1(raw), internal };
    b.msgs.push(m);
    return m;
  }
  find(folder, pred) { return this.box[folder].msgs.find(pred); }
  session() {
    const s = { srv: this, closed: false, buf: new Uint8Array(0), selected: null, authed: false, pendingLiteral: null };
    s.sock = socketFor(s);
    s.input = (bytes) => { const b = new Uint8Array(s.buf.length + bytes.length); b.set(s.buf); b.set(bytes, s.buf.length); s.buf = b; this.pump(s); };
    s.sock.say(`* OK [CAPABILITY ${this.caps}] Fake IMAP ready\r\n`);
    return s.sock;
  }
  pump(s) {
    for (;;) {
      if (s.pendingLiteral) {
        const p = s.pendingLiteral;
        if (!p.got) {
          if (s.buf.length < p.n) return;
          p.parts.push(s.buf.slice(0, p.n));
          s.buf = s.buf.subarray(p.n);
          p.got = true;
        }
        const rest = this.line(s);
        if (rest === null) return;
        s.pendingLiteral = null;
        this.handle(s, p.head, p.parts, rest);
        continue;
      }
      const line = this.line(s);
      if (line === null) return;
      const lit = /\{(\d+)\}$/.exec(line);
      if (lit) {
        s.pendingLiteral = { head: line.slice(0, lit.index), n: Number(lit[1]), parts: [], got: false };
        s.sock.say('+ Ready\r\n');
        continue;
      }
      this.handle(s, line, [], '');
    }
  }
  line(s) {
    for (let i = 0; i + 1 < s.buf.length; i++) if (s.buf[i] === 13 && s.buf[i + 1] === 10) { const l = latin1(s.buf.subarray(0, i)); s.buf = s.buf.subarray(i + 2); return l; }
    return null;
  }
  handle(s, head, lits, rest) {
    const say = (t) => s.sock.say(t);
    const [tag, ...words] = head.split(' ');
    const cmdLine = words.join(' ');
    const cmd = (words[0] || '').toUpperCase();
    const uidCmd = cmd === 'UID' ? (words[1] || '').toUpperCase() : null;
    this.commands.push(cmd === 'LOGIN' || cmd === 'AUTHENTICATE' ? cmd : `${cmd}${uidCmd ? ` ${uidCmd}` : ''}`);
    const ok = (t = 'done') => say(`${tag} OK ${t}\r\n`);
    const no = (t) => say(`${tag} NO ${t}\r\n`);
    const tok = imapTokenize(cmdLine.replace(/^\S+\s*/, '') + (lits.length ? ` \u00000\u0000${rest}` : ''), lits.map((l) => l));
    const folder = (name) => this.box[name];
    switch (cmd) {
      case 'CAPABILITY': say(`* CAPABILITY ${this.caps}\r\n`); return ok();
      case 'LOGIN': case 'AUTHENTICATE': {
        let user, pass;
        if (cmd === 'LOGIN') [user, pass] = tok;
        else { const plain = latin1(Uint8Array.from(atob(tok[1]), (c) => c.charCodeAt(0))); [, user, pass] = dec.decode(bytesOf(plain)).split('\0'); }
        this.logins.push(user);
        if (this.users.includes(user) && pass === this.password) { s.authed = true; return ok(`[CAPABILITY ${this.caps}] signed in`); }
        return no('[AUTHENTICATIONFAILED] Authentication failed.');
      }
      case 'LOGOUT': say('* BYE bye\r\n'); ok(); return;
    }
    if (!s.authed) return say(`${tag} BAD sign in first\r\n`);
    switch (cmd) {
      case 'LIST':
        for (const [name, b] of Object.entries(this.box)) say(`* LIST (\\HasNoChildren${b.special ? ` ${b.special}` : ''}) "/" "${name}"\r\n`);
        return ok();
      case 'CREATE': if (!this.box[tok[0]]) this.box[tok[0]] = { uidvalidity: 1800000000, uidnext: 1, msgs: [], special: '' }; return ok();
      case 'SELECT': case 'EXAMINE': {
        const b = folder(tok[0]);
        if (!b) return no('no such folder');
        s.selected = tok[0];
        say(`* ${b.msgs.length} EXISTS\r\n* OK [UIDVALIDITY ${b.uidvalidity}] ok\r\n* OK [UIDNEXT ${b.uidnext}] ok\r\n`);
        return ok(`[${cmd === 'SELECT' ? 'READ-WRITE' : 'READ-ONLY'}] selected`);
      }
      case 'STATUS': {
        const b = folder(tok[0]);
        if (!b) return no('no such folder');
        say(`* STATUS "${tok[0]}" (MESSAGES ${b.msgs.length} UIDNEXT ${b.uidnext} UIDVALIDITY ${b.uidvalidity} UNSEEN ${b.msgs.filter((m) => !m.flags.has('\\Seen')).length})\r\n`);
        return ok();
      }
      case 'APPEND': {
        const b = folder(tok[0]);
        if (!b) return no('[TRYCREATE] no such folder');
        const flags = Array.isArray(tok[1]) ? tok[1] : [];
        const raw = lits[0] ? latin1(lits[0]) : '';
        const m = this.add(tok[0], raw, { flags });
        return ok(`[APPENDUID ${b.uidvalidity} ${m.uid}] appended`);
      }
      case 'EXPUNGE': { const b = folder(s.selected); b.msgs = b.msgs.filter((m) => !m.flags.has('\\Deleted')); return ok(); }
      case 'UID': break;
      default: return say(`${tag} BAD unknown ${cmd}\r\n`);
    }
    const b = folder(s.selected);
    if (!b) return no('no folder selected');
    const args = tok.slice(1);
    const set = (spec) => String(spec).split(',').flatMap((r) => { const [a, z] = r.split(':').map(Number); return z ? Array.from({ length: z - a + 1 }, (_, i) => a + i) : [a]; });
    const pick = (spec) => { const want = new Set(set(spec)); return b.msgs.filter((m) => want.has(m.uid)); };
    switch (uidCmd) {
      case 'SEARCH': {
        let t = args;
        if (String(t[0]).toUpperCase() === 'CHARSET') t = t.slice(2);
        const text = (x) => (x instanceof Uint8Array ? dec.decode(x) : String(x)).toLowerCase();
        const match = (m, list) => {
          let i = 0;
          const one = () => {
            const k = list[i++];
            if (Array.isArray(k)) return match(m, k);
            const K = String(k).toUpperCase();
            const raw = dec.decode(bytesOf(m.raw)).toLowerCase();
            switch (K) {
              case 'ALL': return true;
              case 'UNSEEN': return !m.flags.has('\\Seen');
              case 'SEEN': return m.flags.has('\\Seen');
              case 'FLAGGED': return m.flags.has('\\Flagged');
              case 'TEXT': return raw.includes(text(list[i++]));
              case 'FROM': case 'TO': case 'CC': case 'SUBJECT': return headerValue(m.raw, K === 'SUBJECT' ? 'Subject' : K === 'FROM' ? 'From' : K === 'TO' ? 'To' : 'Cc').toLowerCase().includes(text(list[i++]));
              case 'HEADER': { const name = String(list[i++]); return headerValue(m.raw, name).toLowerCase().includes(text(list[i++])); }
              case 'SINCE': case 'BEFORE': i++; return true;
              case 'NOT': return !one();
              case 'OR': { const a = one(); const z = one(); return a || z; }
              default: return true;
            }
          };
          while (i < list.length) if (!one()) return false;
          return true;
        };
        say(`* SEARCH ${b.msgs.filter((m) => match(m, t)).map((m) => m.uid).join(' ')}\r\n`);
        return ok();
      }
      case 'FETCH': {
        const items = Array.isArray(args[1]) ? args[1].map(String) : [String(args[1])];
        const seq = (m) => b.msgs.indexOf(m) + 1;
        for (const m of pick(args[0])) {
          const parts = [`UID ${m.uid}`];
          const tail = [];
          for (const it of items) {
            const I = it.toUpperCase();
            if (I === 'FLAGS') parts.push(`FLAGS (${[...m.flags].join(' ')})`);
            else if (I === 'INTERNALDATE') parts.push(`INTERNALDATE "${imapDate(m.internal)}"`);
            else if (I === 'RFC822.SIZE') parts.push(`RFC822.SIZE ${m.raw.length}`);
            else if (I.startsWith('BODY.PEEK[')) {
              const sec = /^BODY\.PEEK\[([^\]]*)\](?:<(\d+)\.(\d+)>)?$/i.exec(it);
              let data = sec[1] === '' ? m.raw : sec[1].toUpperCase() === 'HEADER' ? headerPart(m.raw) : sec[1].toUpperCase() === 'TEXT' ? textPart(m.raw) : `Message-ID: ${headerValue(m.raw, 'Message-ID')}\r\n\r\n`;
              if (sec[2] !== undefined) data = data.slice(Number(sec[2]), Number(sec[2]) + Number(sec[3]));
              tail.push(`BODY[${sec[1]}]${sec[2] !== undefined ? `<${sec[2]}>` : ''} {${data.length}}\r\n${data}`);
            }
          }
          say(`* ${seq(m)} FETCH (${[...parts, ...tail].join(' ')})\r\n`);
        }
        return ok();
      }
      case 'STORE': {
        const [, mode, flags] = args;
        for (const m of pick(args[0])) for (const f of flags) { if (String(mode).startsWith('+')) m.flags.add(f); else m.flags.delete(f); }
        return ok();
      }
      case 'MOVE': case 'COPY': {
        const dest = folder(args[1]);
        if (!dest) return no('[TRYCREATE] no such folder');
        const from = [], to = [];
        for (const m of pick(args[0])) {
          const n = this.add(args[1], m.raw, { flags: [...m.flags].filter((f) => f !== '\\Deleted'), internal: m.internal });
          from.push(m.uid); to.push(n.uid);
          if (uidCmd === 'MOVE') b.msgs = b.msgs.filter((x) => x !== m);
        }
        say(`* OK [COPYUID ${dest.uidvalidity} ${from.join(',')} ${to.join(',')}] done\r\n`);
        return ok();
      }
      case 'EXPUNGE': { const want = new Set(set(args[0])); b.msgs = b.msgs.filter((m) => !(want.has(m.uid) && m.flags.has('\\Deleted'))); return ok(); }
      default: return say(`${tag} BAD unknown UID ${uidCmd}\r\n`);
    }
  }
}

/** One SMTP server: accepts `users` with `password`; records sent messages in `sent` and sign-ins in `logins`. */
export class FakeSmtp {
  constructor({ users, password, starttls = false }) {
    this.users = users;
    this.password = password;
    this.starttls = starttls;
    this.sent = [];
    this.logins = [];
  }
  session() {
    const srv = this;
    const s = { closed: false, tls: !this.starttls, text: '', inData: false, data: '', env: { from: null, rcpt: [] }, authed: false, authLogin: null };
    s.sock = socketFor(s);
    const say = (t) => s.sock.say(t);
    s.input = (bytes) => {
      s.text += latin1(bytes);
      for (;;) {
        if (s.inData) {
          const end = s.text.indexOf('\r\n.\r\n');
          if (end < 0) return;
          s.data += s.text.slice(0, end + 2);
          s.text = s.text.slice(end + 5);
          s.inData = false;
          srv.sent.push({ from: s.env.from, rcpt: [...s.env.rcpt], data: s.data.replace(/(^|\r\n)\.\./g, '$1.') });
          s.env = { from: null, rcpt: [] };
          s.data = '';
          say('250 2.0.0 queued\r\n');
          continue;
        }
        const i = s.text.indexOf('\r\n');
        if (i < 0) return;
        const line = s.text.slice(0, i);
        s.text = s.text.slice(i + 2);
        const C = line.split(' ')[0].toUpperCase();
        if (s.authLogin) {
          s.authLogin.push(atob(line));
          if (s.authLogin.length === 1) { say('334 UGFzc3dvcmQ6\r\n'); continue; }
          const [u, p] = s.authLogin; s.authLogin = null; srv.logins.push(u);
          if (srv.users.includes(u) && p === srv.password) { s.authed = true; say('235 ok\r\n'); } else say('535 5.7.8 Authentication failed\r\n');
          continue;
        }
        if (C === 'EHLO') say(`250-fake.smtp\r\n${srv.starttls && !s.tls ? '250-STARTTLS\r\n' : ''}250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n`);
        else if (C === 'STARTTLS') say('220 2.0.0 go ahead\r\n');
        else if (!s.tls) say('530 5.7.0 Must issue a STARTTLS command first\r\n');
        else if (C === 'AUTH' && /PLAIN/i.test(line)) {
          const [, u, p] = new TextDecoder().decode(Uint8Array.from(atob(line.split(' ')[2]), (c) => c.charCodeAt(0))).split('\0');
          srv.logins.push(u);
          if (srv.users.includes(u) && p === srv.password) { s.authed = true; say('235 ok\r\n'); } else say('535 5.7.8 Authentication failed\r\n');
        } else if (C === 'AUTH') { s.authLogin = []; say('334 VXNlcm5hbWU6\r\n'); }
        else if (!s.authed && C !== 'QUIT') say('530 5.7.0 Authentication required\r\n');
        else if (C === 'MAIL') { s.env.from = /<([^>]*)>/.exec(line)[1]; say('250 ok\r\n'); }
        else if (C === 'RCPT') { s.env.rcpt.push(/<([^>]*)>/.exec(line)[1]); say('250 ok\r\n'); }
        else if (C === 'DATA') { s.inData = true; say('354 go\r\n'); }
        else if (C === 'QUIT') say('221 bye\r\n');
        else say('500 what\r\n');
      }
    };
    say('220 fake.smtp ESMTP\r\n');
    return s.sock;
  }
}

/** A `connect` for env.MAIL_SOCKETS: hostname → a server ({ imap, smtp } by host); records what was opened. */
export function fakeConnect(servers, opened = []) {
  return ({ hostname, port }, options = {}) => {
    opened.push({ hostname, port, secureTransport: options.secureTransport });
    const srv = servers[`${hostname}:${port}`];
    if (!srv) throw new Error(`no fake server at ${hostname}:${port}`);
    return srv.session();
  };
}

/** A simple message (binary string) for the fake folders. */
export function mail({ from = 'Ana <ana@example.com>', to = 'me@icloud.com', subject = 'Hello', body = 'Hi there', id = `<${Math.random().toString(36).slice(2)}@example.com>`, date = 'Fri, 6 Nov 2026 10:00:00 +0000', extra = '' } = {}) {
  return `From: ${from}\r\nTo: ${to}\r\nSubject: ${subject}\r\nDate: ${date}\r\nMessage-ID: ${id}\r\n${extra}MIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n`;
}
