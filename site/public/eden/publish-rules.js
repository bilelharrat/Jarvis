// Publishing's pure parts (no DOM, no imports; tested by src/__tests__/publish.test.ts): the
// standalone HTML file Eden saves when publishing isn't available here, and its name.

/** askeden.com keeps pages up to this size (site/src/accounts/published.js PUBLISHED.bytes). */
export const PUBLISH_MAX_BYTES = 2 * 1024 * 1024;

// The saved file keeps an artifact's isolation where a <meta> can: its own inline scripts and
// styles run; it can't load or send anything (no network, no forms, no base).
export const STANDALONE_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; base-uri 'none'; form-action 'none'";

const escapeText = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// First in the saved page too, as in every artifact page (src/chat/artifacts.ts RTC_GUARD): CSP
// can't stop WebRTC, so its constructors are gone before the page's own scripts run.
export const RTC_GUARD = '<script>(()=>{for(const k of["RTCPeerConnection","webkitRTCPeerConnection","RTCDataChannel"])try{Object.defineProperty(window,k,{value:undefined,writable:false,configurable:false})}catch{}})()</script>';

/**
 * The page as a file that opens anywhere (a fragment gets a document around it), with the CSP and
 * RTC_GUARD first in <head>. Only a <head> (or <html>) with nothing but a doctype before it counts:
 * a "<head>" inside an earlier comment or script must not take the CSP with it (it would be inert
 * there); otherwise they go first in the document, right after a leading doctype.
 */
export function standaloneHtml(html, title = 'Eden page') {
  const first = `<meta http-equiv="Content-Security-Policy" content="${STANDALONE_CSP}">${RTC_GUARD}`;
  let doc = String(html || '');
  if (!/<html[\s>]|<!doctype/i.test(doc)) doc = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeText(title)}</title></head><body>${doc}</body></html>`;
  const plain = (before, html) => new RegExp(`^\\s*(?:<!doctype[^>]*>\\s*)?${html ? '(?:<html(?:\\s[^>]*)?>\\s*)?' : ''}$`, 'i').test(before);
  const head = /<head(?:\s[^>]*)?>/i.exec(doc);
  if (head && plain(doc.slice(0, head.index), true)) return doc.slice(0, head.index + head[0].length) + `\n${first}` + doc.slice(head.index + head[0].length);
  const root = /<html(?:\s[^>]*)?>/i.exec(doc);
  if (!head && root && plain(doc.slice(0, root.index), false)) return doc.slice(0, root.index + root[0].length) + `<head>${first}</head>` + doc.slice(root.index + root[0].length);
  const lead = /^(?:\s|<!--[\s\S]*?-->)*<!doctype[^>]*>/i.exec(doc);
  return lead ? doc.slice(0, lead[0].length) + first + doc.slice(lead[0].length) : first + doc;
}

/** "Tip calculator" → "tip-calculator.html" */
export function pageFileName(title) {
  const slug = String(title || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ').trim().replace(/[\s-]+/g, '-').slice(0, 60).replace(/-+$/, '');
  return `${slug || 'eden-page'}.html`;
}

export const byteSize = (s) => new TextEncoder().encode(String(s)).length;
