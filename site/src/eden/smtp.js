// Sending through a mailbox's own SMTP server (iCloud, Yahoo, AOL, other servers; askeden ROADMAP Y2), on
// Cloudflare's TCP sockets: implicit TLS on 465, or STARTTLS on 587 (the upgrade is refused if the
// server doesn't offer it: never plain text). AUTH PLAIN, else LOGIN. One message per connection.
// Errors never quote the password or what was sent.

const smtpEnc = new TextEncoder();

export class SmtpError extends Error {
  /** code: auth | rejected | timeout | closed | protocol */
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

const smtpLatin1 = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  return s;
};
const smtpB64 = (s) => btoa(smtpLatin1(smtpEnc.encode(s)));

/** DATA's body: CRLF line ends, a "." doubled at the start of a line, ended by CRLF . CRLF. */
export function dotStuff(bytes) {
  const s = smtpLatin1(bytes).replace(/\r?\n/g, '\r\n').replace(/(^|\r\n)\./g, '$1..');
  const body = s.endsWith('\r\n') ? s : `${s}\r\n`;
  const out = new Uint8Array(body.length + 3);
  for (let i = 0; i < body.length; i++) out[i] = body.charCodeAt(i) & 255;
  out.set([46, 13, 10], body.length);
  return out;
}

/**
 * Sends `data` (the message's bytes) from `from` to `rcpt` through host:port. `security` is 'tls' (465)
 * or 'starttls' (587). Resolves with the server's last answer; throws SmtpError.
 */
export async function sendSmtp({ connect, host, port, security, user, pass, from, rcpt, data, timeoutMs = 30_000, helo = 'askeden.com' }) {
  if (!rcpt.length) throw new SmtpError('The email has no recipients.', 'rejected');
  let socket;
  try { socket = connect({ hostname: host, port }, { secureTransport: security === 'starttls' ? 'starttls' : 'on', allowHalfOpen: false }); }
  catch { throw new SmtpError(`Couldn’t reach ${host}.`, 'closed'); }
  let reader = socket.readable.getReader();
  let writer = socket.writable.getWriter();
  let buf = '';
  const withTimeout = (p) => {
    let t;
    return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new SmtpError(`${host} didn’t answer in time.`, 'timeout')), timeoutMs); })]).finally(() => clearTimeout(t));
  };
  /** One reply (all its lines): { code, lines }. */
  async function reply() {
    const lines = [];
    for (;;) {
      let i;
      while ((i = buf.indexOf('\r\n')) < 0) {
        const { value, done } = await withTimeout(reader.read());
        if (done) throw new SmtpError(`${host} closed the connection.`, 'closed');
        buf += smtpLatin1(value);
        if (buf.length > 1 << 20) throw new SmtpError('The mail server sent too much.', 'protocol');
      }
      const line = buf.slice(0, i);
      buf = buf.slice(i + 2);
      lines.push(line);
      if (!/^\d{3}-/.test(line)) return { code: Number(line.slice(0, 3)), lines };
    }
  }
  const send = (s) => withTimeout(writer.write(typeof s === 'string' ? smtpEnc.encode(s) : s));
  const expect = async (ok, what, code = 'rejected') => {
    const r = await reply();
    if (!ok.includes(r.code)) {
      const why = r.lines.map((l) => l.slice(4)).join(' ').replace(/\s+/g, ' ').slice(0, 200);
      throw new SmtpError(`${what}: ${why || r.code}`, code);
    }
    return r;
  };
  const ehlo = async () => {
    await send(`EHLO ${helo}\r\n`);
    const r = await expect([250], 'The mail server didn’t greet Eden');
    return new Set(r.lines.map((l) => l.slice(4).trim().toUpperCase()));
  };

  try {
    await expect([220], 'The mail server isn’t taking mail', 'protocol');
    let ext = await ehlo();
    if (security === 'starttls') {
      if (!ext.has('STARTTLS')) throw new SmtpError('This server won’t encrypt the connection, so Eden won’t send through it.', 'protocol');
      await send('STARTTLS\r\n');
      await expect([220], 'The mail server didn’t start encryption', 'protocol');
      reader.releaseLock();
      writer.releaseLock();
      socket = socket.startTls();
      reader = socket.readable.getReader();
      writer = socket.writable.getWriter();
      buf = '';
      ext = await ehlo();
    }
    const auth = [...ext].find((e) => e.startsWith('AUTH')) || '';
    try {
      if (/\bPLAIN\b/.test(auth) || !/\bLOGIN\b/.test(auth)) {
        await send(`AUTH PLAIN ${smtpB64(`\0${user}\0${pass}`)}\r\n`);
        await expect([235], 'auth', 'auth');
      } else {
        await send('AUTH LOGIN\r\n');
        await expect([334], 'auth', 'auth');
        await send(`${smtpB64(user)}\r\n`);
        await expect([334], 'auth', 'auth');
        await send(`${smtpB64(pass)}\r\n`);
        await expect([235], 'auth', 'auth');
      }
    } catch (e) {
      if (e instanceof SmtpError && e.code === 'auth') throw new SmtpError('The mail server didn’t accept that address and app password for sending.', 'auth');
      throw e;
    }
    if (data === null) return { code: 235 }; // a sign-in check only (adding an account)
    const utf8 = /[^\x00-\x7f]/.test(from) || rcpt.some((r) => /[^\x00-\x7f]/.test(r));
    await send(`MAIL FROM:<${from}>${utf8 && ext.has('SMTPUTF8') ? ' SMTPUTF8' : ''}${ext.has('8BITMIME') ? ' BODY=8BITMIME' : ''}\r\n`);
    await expect([250], 'The mail server refused the sender');
    for (const r of rcpt) {
      await send(`RCPT TO:<${r}>\r\n`);
      await expect([250, 251], `The mail server refused ${r}`);
    }
    await send('DATA\r\n');
    await expect([354], 'The mail server refused the message');
    await send(dotStuff(data));
    return await expect([250], 'The mail server refused the message');
  } finally {
    try { await send('QUIT\r\n'); } catch { /* closing anyway */ }
    try { reader.releaseLock(); writer.releaseLock(); await socket.close(); } catch { /* already closed */ }
  }
}
