// Artifact previews in mock mode (?mock=1). A blob: page inherits this page's CSP (script-src
// 'self'), so a preview's own scripts never ran there. Eden's server (this Mac's, or askeden.com
// when signed in) serves /artifact/<id> under the artifact sandbox's CSP, where they do: so the
// real POST /api/chat/artifact is asked first, and the blob is only for a page served without
// Eden's server (a static file server, a page opened from disk).

/** { url, served } for an artifact's HTML: the server's /artifact/<id> when it answers, else a blob: URL. */
export async function mockArtifact(html, { fetch: f = globalThis.fetch, url = '/api/chat/artifact', timeoutMs = 4000 } = {}) {
  const text = String(html || '');
  if (text && typeof f === 'function') {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await f(url, { method: 'POST', headers: { 'content-type': 'application/json', 'X-Jarvis-Chat': '1' }, body: JSON.stringify({ html: text }), signal: ctl.signal });
      const j = res.ok ? await res.json() : null;
      // only Eden's own answer: a path on this server, never another origin
      if (j && typeof j.url === 'string' && /^\/artifact\/[\w-]+$/.test(j.url)) return { url: j.url, served: true };
    } catch { /* no server (or not Eden's): the blob below */ }
    finally { clearTimeout(timer); }
  }
  return { url: URL.createObjectURL(new Blob([text], { type: 'text/html' })), served: false };
}
