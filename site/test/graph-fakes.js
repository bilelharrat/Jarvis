// A fake Microsoft (sign-in + the bits of Graph mail Eden uses) for test/mail-graph.test.js. In memory;
// enough $filter, $search (KQL), $orderby, $top/$skip, $batch and MIME drafts to behave like Outlook.
import { gmailHeaders, parseMessage, snippetOf } from '../src/eden/mime.js';
import { b64url } from '../src/accounts/util.js';

export const MS_CLIENT_ID = '00000000-1111-2222-3333-444444444444';
export const TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad'; // Microsoft's consumer tenant id
const GRAPH = 'https://graph.microsoft.com/v1.0';
const WK = ['inbox', 'sentitems', 'drafts', 'archive', 'deleteditems', 'junkemail'];

const msIdToken = (claims) => `${b64url(new TextEncoder().encode('{"alg":"none"}'))}.${b64url(new TextEncoder().encode(JSON.stringify({ iss: `https://login.microsoftonline.com/${TENANT}/v2.0`, aud: MS_CLIENT_ID, tid: TENANT, ...claims })))}.sig`;
const addr = (s) => { const m = /^\s*(?:"?([^"<]*?)"?\s*)?<([^>]+)>\s*$/.exec(s || ''); return m ? { emailAddress: { name: m[1] || m[2], address: m[2] } } : { emailAddress: { name: String(s).trim(), address: String(s).trim() } }; };
const addrs = (s) => (s ? String(s).split(',').map((x) => x.trim()).filter(Boolean).map(addr) : []);

export class FakeMicrosoft {
  constructor({ email = 'me@outlook.com', name = 'Sam Lee', scopes } = {}) {
    this.user = { email, name, oid: 'oid-1' };
    this.scopes = scopes || 'https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/User.Read openid profile email';
    this.folderIds = Object.fromEntries(WK.map((w) => [w, `F-${w}-AQMkADAwATM0MDAAMS1iNWUzLWZlMDQtMDACLTAwCgAuAAAD=`]));
    this.msgs = new Map();
    this.n = 0;
    this.conv = 0;
    this.access = new Map(); // access token → valid
    this.refresh = new Set(['unused']);
    this.nAccess = 0;
    this.nRefresh = 0;
    this.tokenCalls = [];
    this.calls = [];
    this.sent = [];
    this.fetch = (url, init = {}) => this.handle(String(url), init);
  }

  newId(kind = 'msg') {
    // shaped like Graph's ids: bytes as base64 with "-" and "_" and its "=" padding
    const n = ++this.n;
    return Buffer.concat([Buffer.from('000900000000001d8403116a6611cd9bc800aa002f845a0dfbff', 'hex'), Buffer.from(`${kind}-${n}`)]).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
  }
  /** Puts a MIME message in a folder (inbox by default); returns its Graph id. */
  add(raw, { folder = 'inbox', isRead = false, flagged = false, received = Date.now(), convOf } = {}) {
    const node = parseMessage(raw);
    const h = Object.fromEntries(gmailHeaders(node.headers).map((x) => [x.name.toLowerCase(), x.value]));
    const replyTo = (/<[^>]+>/.exec(h['in-reply-to'] || '') || [])[0];
    const parent = replyTo ? [...this.msgs.values()].find((m) => m.internetMessageId === replyTo) : null;
    const id = this.newId();
    const at = new Date(received).toISOString().replace(/\.\d{3}Z$/, 'Z');
    this.msgs.set(id, {
      id,
      raw,
      conversationId: convOf || (parent ? parent.conversationId : this.newId('conv')),
      parentFolderId: this.folderIds[folder],
      subject: h.subject || '',
      from: h.from ? addr(h.from) : null,
      sender: h.from ? addr(h.from) : null,
      toRecipients: addrs(h.to),
      ccRecipients: addrs(h.cc),
      bccRecipients: addrs(h.bcc),
      replyTo: [],
      receivedDateTime: at,
      sentDateTime: at,
      lastModifiedDateTime: at,
      bodyPreview: snippetOf(node),
      isRead,
      isDraft: folder === 'drafts',
      flag: { flagStatus: flagged ? 'flagged' : 'notFlagged' },
      hasAttachments: /multipart\/mixed/i.test(h['content-type'] || ''),
      internetMessageId: h['message-id'] || `<${id.slice(-8)}@outlook.com>`,
    });
    return id;
  }
  in(folder) { return [...this.msgs.values()].filter((m) => m.parentFolderId === this.folderIds[folder]); }
  find(pred) { return [...this.msgs.values()].find(pred); }
  touch(m) { m.lastModifiedDateTime = new Date(Date.now() + ++this.n * 1000).toISOString(); }

  /** A sign-in's tokens (as Microsoft's token endpoint gives them). */
  grant(scopes = this.scopes) {
    const at = `ms-at-${++this.nAccess}`;
    const rt = `ms-rt-${++this.nRefresh}`;
    this.access.set(at, true);
    this.refresh.add(rt);
    return { token_type: 'Bearer', access_token: at, refresh_token: rt, expires_in: 3600, scope: scopes, id_token: msIdToken({ oid: this.user.oid, sub: 'pairwise-sub', preferred_username: this.user.email, name: this.user.name }) };
  }

  async handle(url, init) {
    const method = (init.method || 'GET').toUpperCase();
    const headers = init.headers || {};
    if (url === 'https://login.microsoftonline.com/common/oauth2/v2.0/token') {
      const form = new URLSearchParams(init.body);
      this.tokenCalls.push(Object.fromEntries(form));
      if (form.get('client_id') !== MS_CLIENT_ID || form.get('client_secret') !== 'ms-secret') return Response.json({ error: 'invalid_client' }, { status: 401 });
      if (form.get('grant_type') === 'authorization_code') {
        if (form.get('code') !== 'ms-code' || !form.get('code_verifier')) return Response.json({ error: 'invalid_grant' }, { status: 400 });
        return Response.json(this.grant());
      }
      if (form.get('grant_type') === 'refresh_token') {
        const rt = form.get('refresh_token');
        if (!this.refresh.has(rt)) return Response.json({ error: 'invalid_grant', error_description: 'AADSTS70000' }, { status: 400 });
        this.refresh.delete(rt); // rotated
        const g = this.grant();
        delete g.id_token;
        return Response.json(g);
      }
    }
    if (!url.startsWith(GRAPH)) throw new Error(`unexpected fetch ${method} ${url}`);
    const at = String(headers.authorization || '').replace(/^Bearer /, '');
    if (!this.access.get(at)) return Response.json({ error: { code: 'InvalidAuthenticationToken', message: 'Access token has expired.' } }, { status: 401 });
    this.calls.push({ method, url, prefer: headers.prefer });
    if (url === `${GRAPH}/$batch`) {
      const { requests } = JSON.parse(init.body);
      const responses = [];
      for (const r of requests) {
        const res = await this.graph(r.method, `${GRAPH}${r.url}`, r.body === undefined ? undefined : JSON.stringify(r.body), r.headers || {});
        const text = await res.text();
        responses.push({ id: r.id, status: res.status, body: text ? JSON.parse(text) : undefined });
      }
      return Response.json({ responses });
    }
    return this.graph(method, url, init.body, headers);
  }

  async graph(method, url, body, headers) {
    const u = new URL(url);
    const p = decodeURIComponent(u.pathname.replace('/v1.0', ''));
    const q = u.searchParams;
    let m;
    if (p === '/me' && method === 'GET') return Response.json({ mail: this.user.email, userPrincipalName: this.user.email, displayName: this.user.name });
    if ((m = /^\/me\/mailFolders\/(\w+)$/.exec(p)) && method === 'GET') {
      if (!WK.includes(m[1])) return Response.json({ error: { code: 'ErrorItemNotFound' } }, { status: 404 });
      const id = this.folderIds[m[1]];
      if (q.get('$select') === 'id') return Response.json({ id });
      const list = this.in(m[1]);
      return Response.json({ id, totalItemCount: list.length, unreadItemCount: list.filter((x) => !x.isRead).length });
    }
    if ((m = /^\/me(?:\/mailFolders\/(\w+))?\/messages$/.exec(p)) && method === 'GET') {
      let list = m[1] ? this.in(m[1]) : [...this.msgs.values()];
      const filter = q.get('$filter');
      const search = q.get('$search');
      if (filter && search) return Response.json({ error: { code: 'ErrorInvalidUrlQuery', message: 'filter and search together' } }, { status: 400 });
      if (filter) list = list.filter((x) => filter.split(' and ').every((c) => this.cond(x, c)));
      if (search) list = list.filter((x) => this.kql(x, search.replace(/^"|"$/g, '').replace(/\\"/g, '"')));
      const order = q.get('$orderby') || '';
      if (order && filter && !order.startsWith('receivedDateTime') && !order.startsWith('lastModifiedDateTime')) return Response.json({ error: { code: 'InefficientFilter' } }, { status: 400 });
      if (order.startsWith('receivedDateTime') && filter && !filter.startsWith('receivedDateTime')) return Response.json({ error: { code: 'InefficientFilter', message: 'The restriction or sort order is too complex for this operation.' } }, { status: 400 });
      const key = order.startsWith('lastModifiedDateTime') ? 'lastModifiedDateTime' : 'receivedDateTime';
      list.sort((a, b) => Date.parse(b[key]) - Date.parse(a[key]));
      const top = Number(q.get('$top')) || 10;
      const skip = Number(q.get('$skip')) || 0;
      const page = list.slice(skip, skip + top).map(({ raw, ...rest }) => rest);
      const next = skip + top < list.length ? (() => { const n = new URL(url); n.searchParams.set('$skip', String(skip + top)); return n.toString(); })() : null;
      return Response.json({ value: page, ...(next ? { '@odata.nextLink': next } : {}) });
    }
    if (p === '/me/messages' && method === 'POST') {
      if (headers['content-type'] !== 'text/plain') return Response.json({ error: { code: 'UnableToDeserializePostBody' } }, { status: 400 });
      const raw = Buffer.from(String(body), 'base64').toString('latin1');
      const id = this.add(raw, { folder: 'drafts', isRead: true });
      const { raw: _, ...rest } = this.msgs.get(id);
      return Response.json(rest, { status: 201 });
    }
    if ((m = /^\/me\/messages\/([^/]+)(\/\$value|\/move|\/send|\/permanentDelete)?$/.exec(p))) {
      const x = this.msgs.get(m[1]);
      if (!x) return Response.json({ error: { code: 'ErrorItemNotFound', message: 'The specified object was not found in the store.' } }, { status: 404 });
      const { raw, ...rest } = x;
      if (!m[2] && method === 'GET') return Response.json(rest);
      if (m[2] === '/$value' && method === 'GET') return new Response(Buffer.from(raw, 'latin1'));
      if (!m[2] && method === 'PATCH') {
        const b = JSON.parse(body);
        if (b.isRead !== undefined) x.isRead = b.isRead;
        if (b.flag) x.flag = { flagStatus: b.flag.flagStatus };
        this.touch(x);
        return Response.json(rest);
      }
      if (m[2] === '/move' && method === 'POST') {
        const dest = JSON.parse(body).destinationId;
        if (!this.folderIds[dest]) return Response.json({ error: { code: 'ErrorInvalidIdMalformed' } }, { status: 400 });
        if (x.parentFolderId === this.folderIds[dest]) return Response.json({ error: { code: 'ErrorMoveCopyFailed', message: 'same folder' } }, { status: 400 });
        x.parentFolderId = this.folderIds[dest];
        this.touch(x);
        return Response.json({ ...rest, parentFolderId: x.parentFolderId }, { status: 201 });
      }
      if (m[2] === '/send' && method === 'POST') {
        if (x.parentFolderId !== this.folderIds.drafts) return Response.json({ error: { code: 'ErrorInvalidOperation' } }, { status: 400 });
        this.sent.push({ id: x.id, raw: x.raw, to: x.toRecipients, cc: x.ccRecipients, bcc: x.bccRecipients });
        x.parentFolderId = this.folderIds.sentitems;
        x.isDraft = false;
        this.touch(x);
        return new Response(null, { status: 202 });
      }
      if (m[2] === '/permanentDelete' && method === 'POST') { this.msgs.delete(m[1]); return new Response(null, { status: 204 }); }
      if (!m[2] && method === 'DELETE') { x.parentFolderId = this.folderIds.deleteditems; return new Response(null, { status: 204 }); }
    }
    throw new Error(`fake Graph doesn't do ${method} ${p}`);
  }

  cond(x, c) {
    let m;
    if ((m = /^receivedDateTime (ge|lt) (\S+)$/.exec(c))) return m[1] === 'ge' ? Date.parse(x.receivedDateTime) >= Date.parse(m[2]) : Date.parse(x.receivedDateTime) < Date.parse(m[2]);
    if ((m = /^isRead eq (true|false)$/.exec(c))) return x.isRead === (m[1] === 'true');
    if ((m = /^hasAttachments eq (true|false)$/.exec(c))) return x.hasAttachments === (m[1] === 'true');
    if ((m = /^flag\/flagStatus (eq|ne) 'flagged'$/.exec(c))) return (x.flag.flagStatus === 'flagged') === (m[1] === 'eq');
    if ((m = /^conversationId eq '(.+)'$/.exec(c))) return x.conversationId === m[1];
    throw new Error(`fake Graph doesn't filter on ${c}`);
  }

  /** Enough KQL: key:value, "phrases", NOT, OR (any group whose every term matches). */
  kql(x, s) {
    const terms = s.match(/NOT\s+\S+:"[^"]*"|NOT\s+"[^"]*"|NOT\s+\S+|\S+:"[^"]*"|"[^"]*"|\S+/g) || [];
    const groups = [[]];
    for (const t of terms) { if (t === 'OR') groups.push([]); else groups[groups.length - 1].push(t); }
    const text = (v) => String(v || '').toLowerCase();
    const who = (r) => (r ? `${r.emailAddress.name} ${r.emailAddress.address}` : '');
    const one = (t) => {
      const neg = t.startsWith('NOT ');
      const body = neg ? t.slice(4).trim() : t;
      const km = /^(\w+):(.*)$/.exec(body);
      const key = km ? km[1].toLowerCase() : '';
      const val = text((km ? km[2] : body).replace(/^"|"$/g, ''));
      let hit;
      if (key === 'from') hit = text(who(x.from)).includes(val);
      else if (key === 'to') hit = text(x.toRecipients.map(who).join(' ')).includes(val);
      else if (key === 'cc') hit = text(x.ccRecipients.map(who).join(' ')).includes(val);
      else if (key === 'subject') hit = text(x.subject).includes(val);
      else if (key === 'hasattachments') hit = String(x.hasAttachments) === val;
      else hit = text(`${x.subject} ${x.bodyPreview} ${who(x.from)}`).includes(val);
      return neg ? !hit : hit;
    };
    return groups.some((g) => g.length && g.every(one));
  }
}

/** A plain MIME message (Latin-1 string) as a mail client would send it. */
export function msMail({ from = 'Ana <ana@example.com>', to = 'me@outlook.com', subject = 'Hello', body = 'Hi there', id, inReplyTo, date = 'Fri, 6 Nov 2026 10:00:00 +0000' } = {}) {
  return [`From: ${from}`, `To: ${to}`, `Subject: ${subject}`, `Date: ${date}`, `Message-ID: ${id || `<${Math.random().toString(36).slice(2)}@example.com>`}`, ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`, `References: ${inReplyTo}`] : []), 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', '', body, ''].join('\r\n');
}
