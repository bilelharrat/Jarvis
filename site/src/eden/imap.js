// A small IMAP4rev1 client for Eden Mail's iCloud, Yahoo, AOL and other mailboxes (askeden ROADMAP Y2),
// on Cloudflare's TCP sockets (`connect` from cloudflare:sockets, passed in). Implicit TLS on 993 only.
// One connection per Worker request: open, sign in, a few commands, log out (no IDLE; see the plan).
//
// Only what Eden Mail needs: CAPABILITY, LOGIN / AUTHENTICATE PLAIN, LIST, SELECT/EXAMINE, STATUS,
// UID SEARCH / FETCH / STORE / MOVE (or COPY + \Deleted + EXPUNGE) / EXPUNGE, APPEND, CREATE, LOGOUT.
// The password goes to the server and nowhere else: errors never quote a command or the password.

const imapEnc = new TextEncoder();
const MAX_RESPONSE = 48 * 1024 * 1024; // one message read in full is capped well before this (mail-imap.js)

export class ImapError extends Error {
  /** code: auth (wrong password: stop, ask the owner) | no | bad | timeout | closed | protocol */
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

/** An IMAP quoted string (CR/LF/NUL can't be in one: callers use a literal for those). */
export function imapQuote(s) {
  const t = String(s);
  if (/[\r\n\0]/.test(t)) throw new ImapError('That text can’t be sent to the mail server.', 'protocol');
  return `"${t.replace(/[\\"]/g, '\\$&')}"`;
}

/** A Uint8Array that also remembers it was a literal (parsed responses keep bytes as bytes). */
const imapConcat = (a, b) => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
};
const imapLatin1 = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  return s;
};

/**
 * A response line with its literals in tokens: atoms (strings, with any [...] section kept whole), quoted
 * strings (strings), literals (Uint8Array), NIL (null) and parenthesized lists (arrays).
 */
export function imapTokenize(text, lits = []) {
  let i = 0;
  const parse = () => {
    const out = [];
    while (i < text.length) {
      const c = text[i];
      if (c === ' ') { i++; continue; }
      if (c === ')') { i++; return out; }
      if (c === '(') { i++; out.push(parse()); continue; }
      if (c === '"') {
        let s = '';
        i++;
        while (i < text.length && text[i] !== '"') { if (text[i] === '\\') i++; s += text[i++]; }
        i++;
        out.push(s);
        continue;
      }
      if (c === '\u0000') {
        const end = text.indexOf('\u0000', i + 1);
        out.push(lits[Number(text.slice(i + 1, end))]);
        i = end + 1;
        continue;
      }
      let s = '';
      let depth = 0;
      while (i < text.length) {
        const d = text[i];
        if (d === '[') depth++;
        else if (d === ']') depth--;
        else if (depth === 0 && (d === ' ' || d === '(' || d === ')')) break;
        s += d;
        i++;
      }
      out.push(s === 'NIL' ? null : s);
    }
    return out;
  };
  return parse();
}

/** FETCH data items → { UID, FLAGS, INTERNALDATE, 'RFC822.SIZE', 'BODY[...]', … }. */
function fetchItems(list) {
  const out = {};
  for (let k = 0; k + 1 < list.length; k += 2) out[String(list[k]).toUpperCase().replace(/<\d+>$/, '')] = list[k + 1];
  return out;
}

/**
 * Opens a connection and reads the greeting. `connect(address, options)` is cloudflare:sockets'.
 * Returns the client; call `login` next.
 */
export async function openImap({ connect, host, port = 993, timeoutMs = 25_000 }) {
  let socket;
  try { socket = connect({ hostname: host, port }, { secureTransport: 'on', allowHalfOpen: false }); }
  catch { throw new ImapError(`Couldn’t reach ${host}.`, 'closed'); }
  const reader = socket.readable.getReader();
  const writer = socket.writable.getWriter();
  let buf = new Uint8Array(0);
  let closed = false;
  let tag = 0;
  const caps = new Set();

  const withTimeout = (p) => {
    let t;
    return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new ImapError(`${host} didn’t answer in time.`, 'timeout')), timeoutMs); })]).finally(() => clearTimeout(t));
  };
  async function more() {
    const { value, done } = await withTimeout(reader.read());
    if (done) { closed = true; throw new ImapError(`${host} closed the connection.`, 'closed'); }
    buf = buf.length ? imapConcat(buf, value) : value;
    if (buf.length > MAX_RESPONSE) throw new ImapError('The mail server sent more than Eden reads at once.', 'protocol');
  }
  async function readLine() {
    for (;;) {
      for (let i = 0; i + 1 < buf.length; i++) {
        if (buf[i] === 13 && buf[i + 1] === 10) {
          const line = imapLatin1(buf.subarray(0, i));
          buf = buf.subarray(i + 2);
          return line;
        }
      }
      await more();
    }
  }
  async function readBytes(n) {
    while (buf.length < n) await more();
    const out = buf.slice(0, n);
    buf = buf.subarray(n);
    return out;
  }
  /** One response line with any literals it carries: { text (literals as \0n\0), lits }. */
  async function readResponse() {
    let text = '';
    const lits = [];
    for (;;) {
      const line = await readLine();
      const m = /\{(\d+)\+?\}$/.exec(line);
      if (!m) return { text: text + line, lits };
      text += `${line.slice(0, m.index)}\u0000${lits.length}\u0000`;
      lits.push(await readBytes(Number(m[1])));
    }
  }
  const write = (data) => withTimeout(writer.write(typeof data === 'string' ? imapEnc.encode(data) : data));
  const noteCaps = (text) => {
    const m = /\[CAPABILITY ([^\]]+)\]/i.exec(text) || /^\* CAPABILITY (.+)$/i.exec(text);
    if (m) { caps.clear(); for (const c of m[1].trim().split(/\s+/)) caps.add(c.toUpperCase()); }
  };

  /**
   * Runs one command. `parts`: strings and Uint8Array literals, sent in order (a literal waits for the
   * server's "+"). Returns { untagged: [{ text, lits }], text } on OK; throws ImapError on NO/BAD.
   */
  async function run(parts, { secret = false } = {}) {
    if (closed) throw new ImapError(`${host} closed the connection.`, 'closed');
    const t = `E${++tag}`;
    const list = Array.isArray(parts) ? parts : [parts];
    let line = `${t} `;
    for (const p of list) {
      if (p instanceof Uint8Array) {
        await write(`${line}{${p.length}}\r\n`);
        line = '';
        for (;;) {
          const r = await readResponse();
          if (r.text.startsWith('+')) break;
          if (r.text.startsWith(`${t} `)) throw new ImapError(`The mail server refused: ${r.text.slice(t.length + 1).replace(/^(NO|BAD)\s*/i, '').slice(0, 200)}`, 'no');
        }
        await write(p);
      } else line += p;
    }
    await write(`${line}\r\n`);
    const untagged = [];
    for (;;) {
      const r = await readResponse();
      if (r.text.startsWith('+')) {
        // a continuation we didn't ask for (e.g. AUTHENTICATE without SASL-IR): cancel it
        await write('*\r\n');
        continue;
      }
      if (r.text.startsWith(`${t} `)) {
        const rest = r.text.slice(t.length + 1);
        noteCaps(rest);
        const status = rest.split(' ')[0].toUpperCase();
        if (status === 'OK') return { untagged, text: rest };
        const why = rest.replace(/^(NO|BAD)\s*/i, '').replace(/^\[[^\]]*\]\s*/, '').slice(0, 200);
        if (secret || /\[(AUTHENTICATIONFAILED|AUTHORIZATIONFAILED)\]/i.test(rest)) throw new ImapError('The mail server didn’t accept that address and app password.', 'auth');
        throw new ImapError(`The mail server said: ${why || status}`, status === 'BAD' ? 'bad' : 'no');
      }
      if (r.text.startsWith('* ')) {
        noteCaps(r.text);
        if (/^\* BYE/i.test(r.text) && !/LOGOUT/i.test(list.join(''))) closed = true;
        untagged.push(r);
      }
    }
  }

  // the greeting
  const hello = await readResponse();
  if (!/^\* (OK|PREAUTH)/i.test(hello.text)) { try { await socket.close(); } catch { /* gone */ } throw new ImapError(`${host} isn’t answering as a mail server.`, 'protocol'); }
  noteCaps(hello.text);

  let selected = null;
  const client = {
    host,
    caps,
    get closed() { return closed; },
    run,
    async capability() { if (!caps.size) await run('CAPABILITY'); return caps; },
    /** Signs in: AUTHENTICATE PLAIN when offered (UTF-8 safe), else LOGIN. A refusal is ImapError 'auth'. */
    async login(user, pass) {
      await client.capability();
      if (caps.has('AUTH=PLAIN') && caps.has('SASL-IR')) {
        const plain = btoa(imapLatin1(imapEnc.encode(`\0${user}\0${pass}`)));
        await run(`AUTHENTICATE PLAIN ${plain}`, { secret: true });
      } else if (!caps.has('LOGINDISABLED')) {
        await run(`LOGIN ${imapQuote(user)} ${imapQuote(pass)}`, { secret: true });
      } else throw new ImapError('This server doesn’t allow signing in with a password.', 'auth');
      if (!caps.has('UIDPLUS') && !caps.has('MOVE')) await run('CAPABILITY').catch(() => undefined); // some send them only after login
    },
    /** LIST "" "*": [{ name, delim, flags (lowercased, e.g. '\\sent') }]. */
    async list() {
      const r = await run('LIST "" "*"');
      const out = [];
      for (const u of r.untagged) {
        if (!/^\* LIST /i.test(u.text)) continue;
        const [, , flags, delim, name] = imapTokenize(u.text, u.lits);
        const nm = name instanceof Uint8Array ? imapLatin1(name) : String(name ?? '');
        out.push({ name: nm, delim: delim ?? '', flags: (flags || []).map((f) => String(f).toLowerCase()) });
      }
      return out;
    },
    /** SELECT (or EXAMINE when read-only): { exists, uidvalidity, uidnext, highestmodseq }. */
    async select(name, { readOnly = false } = {}) {
      if (selected && selected.name === name && (!selected.readOnly || readOnly)) return selected.info; // read-write serves both
      const r = await run(`${readOnly ? 'EXAMINE' : 'SELECT'} ${imapQuote(name)}`);
      const info = { exists: 0, uidvalidity: 0, uidnext: 0, highestmodseq: null };
      for (const u of r.untagged) {
        let m;
        if ((m = /^\* (\d+) EXISTS/i.exec(u.text))) info.exists = Number(m[1]);
        if ((m = /\[UIDVALIDITY (\d+)\]/i.exec(u.text))) info.uidvalidity = Number(m[1]);
        if ((m = /\[UIDNEXT (\d+)\]/i.exec(u.text))) info.uidnext = Number(m[1]);
        if ((m = /\[HIGHESTMODSEQ (\d+)\]/i.exec(u.text))) info.highestmodseq = m[1];
      }
      selected = { name, readOnly, info };
      return info;
    },
    /** STATUS name (MESSAGES UIDNEXT UIDVALIDITY UNSEEN): numbers, without selecting it. */
    async status(name) {
      const r = await run(`STATUS ${imapQuote(name)} (MESSAGES UIDNEXT UIDVALIDITY UNSEEN${caps.has('CONDSTORE') ? ' HIGHESTMODSEQ' : ''})`);
      const out = {};
      for (const u of r.untagged) {
        if (!/^\* STATUS /i.test(u.text)) continue;
        const t = imapTokenize(u.text, u.lits);
        const list = t[t.length - 1] || [];
        for (let k = 0; k + 1 < list.length; k += 2) out[String(list[k]).toLowerCase()] = String(list[k + 1]);
      }
      return out;
    },
    /** UID SEARCH `criteria` (an IMAP search string; `literals` for UTF-8 terms) in the selected folder: UIDs, ascending. */
    async search(criteria, literals = []) {
      const parts = literals.length ? ['UID SEARCH CHARSET UTF-8 ', ...imapInterleave(criteria, literals)] : [`UID SEARCH ${criteria || 'ALL'}`];
      const r = await run(parts);
      const out = [];
      for (const u of r.untagged) {
        const m = /^\* SEARCH ?(.*)$/i.exec(u.text);
        if (m) for (const x of m[1].trim().split(/\s+/)) if (/^\d+$/.test(x)) out.push(Number(x));
      }
      return out.sort((a, b) => a - b);
    },
    /** UID FETCH set (items) → [{ UID, FLAGS, INTERNALDATE, 'RFC822.SIZE', 'BODY[...]' … }]. */
    async fetch(uids, items) {
      if (!uids.length) return [];
      const r = await run(`UID FETCH ${uids.join(',')} (${items})`);
      const out = [];
      for (const u of r.untagged) {
        if (!/^\* \d+ FETCH /i.test(u.text)) continue;
        const t = imapTokenize(u.text, u.lits);
        const data = fetchItems(t[t.length - 1] || []);
        if (data.UID !== undefined) out.push({ ...data, UID: Number(data.UID) });
      }
      return out;
    },
    /** UID STORE set ±FLAGS.SILENT (flags). */
    async store(uids, sign, flags) {
      if (!uids.length || !flags.length) return;
      await run(`UID STORE ${uids.join(',')} ${sign}FLAGS.SILENT (${flags.join(' ')})`);
    },
    /** Moves messages to `dest` (MOVE, else COPY + \Deleted + expunge of just those). Returns { [oldUid]: newUid } when the server says (UIDPLUS). */
    async move(uids, dest) {
      if (!uids.length) return {};
      const r = caps.has('MOVE') ? await run(`UID MOVE ${uids.join(',')} ${imapQuote(dest)}`) : await run(`UID COPY ${uids.join(',')} ${imapQuote(dest)}`);
      const map = copyUids([r.text, ...r.untagged.map((u) => u.text)].join('\n'));
      if (!caps.has('MOVE')) {
        await client.store(uids, '+', ['\\Deleted']);
        await client.expunge(uids);
      }
      return map;
    },
    /** Expunges just `uids` when the server can (UIDPLUS), else everything marked \Deleted in the folder. */
    async expunge(uids) {
      if (caps.has('UIDPLUS') && uids && uids.length) await run(`UID EXPUNGE ${uids.join(',')}`);
      else await run('EXPUNGE');
    },
    /** APPEND a message (bytes) with flags; its new UID when the server says (UIDPLUS), else null. */
    async append(name, flags, bytes) {
      const r = await run([`APPEND ${imapQuote(name)} (${flags.join(' ')}) `, bytes]);
      const m = /\[APPENDUID (\d+) (\d+)\]/i.exec(r.text);
      if (selected && selected.name === name) selected = null; // EXISTS changed: SELECT again next time
      return m ? { uidvalidity: Number(m[1]), uid: Number(m[2]) } : null;
    },
    async create(name) { await run(`CREATE ${imapQuote(name)}`); },
    async logout() {
      if (closed) return;
      try { await run('LOGOUT'); } catch { /* closing anyway */ }
      closed = true;
      try { reader.releaseLock(); writer.releaseLock(); await socket.close(); } catch { /* already closed */ }
    },
  };
  return client;
}

/** "criteria with \u0000n\u0000 marks" + literals → parts for run(). */
function imapInterleave(criteria, literals) {
  const out = [];
  let rest = criteria;
  for (let i = 0; i < literals.length; i++) {
    const mark = `\u0000${i}\u0000`;
    const at = rest.indexOf(mark);
    out.push(rest.slice(0, at), imapEnc.encode(literals[i]));
    rest = rest.slice(at + mark.length);
  }
  out.push(rest);
  return out;
}

/** [COPYUID v 1:3,7 20:22,25] → { 1:20, 2:21, 3:22, 7:25 }. */
export function copyUids(text) {
  const m = /\[COPYUID \d+ ([\d:,]+) ([\d:,]+)\]/i.exec(text || '');
  if (!m) return {};
  const expand = (s) => s.split(',').flatMap((r) => { const [a, b] = r.split(':').map(Number); return b ? Array.from({ length: Math.abs(b - a) + 1 }, (_, i) => (a <= b ? a + i : a - i)) : [a]; });
  const from = expand(m[1]), to = expand(m[2]);
  const out = {};
  from.forEach((u, i) => { if (to[i]) out[u] = to[i]; });
  return out;
}
