// Publishing's pure parts (no DOM, no imports; tested by src/__tests__/publish.test.ts): the
// standalone HTML file Eden saves when publishing isn't available here, and its name.

/** askeden.com keeps pages up to this size (site/src/accounts/published.js PUBLISHED.bytes). */
export const PUBLISH_MAX_BYTES = 2 * 1024 * 1024;

// The saved file keeps an artifact's isolation where a <meta> can: its own inline scripts and
// styles run; it can't load or send anything (no network, no forms, no base).
export const STANDALONE_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; base-uri 'none'; form-action 'none'";

const escapeText = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** The page as a file that opens anywhere (a fragment gets a document around it), with the CSP first in <head>. */
export function standaloneHtml(html, title = 'Eden page') {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${STANDALONE_CSP}">`;
  let doc = String(html || '');
  if (!/<html[\s>]|<!doctype/i.test(doc)) doc = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeText(title)}</title></head><body>${doc}</body></html>`;
  const head = /<head(?:\s[^>]*)?>/i;
  if (head.test(doc)) return doc.replace(head, (m) => `${m}\n${meta}`);
  const root = /<html(?:\s[^>]*)?>/i;
  if (root.test(doc)) return doc.replace(root, (m) => `${m}<head>${meta}</head>`);
  return doc.replace(/<!doctype[^>]*>/i, (m) => `${m}<head>${meta}</head>`);
}

/** "Tip calculator" → "tip-calculator.html" */
export function pageFileName(title) {
  const slug = String(title || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ').trim().replace(/[\s-]+/g, '-').slice(0, 60).replace(/-+$/, '');
  return `${slug || 'eden-page'}.html`;
}

export const byteSize = (s) => new TextEncoder().encode(String(s)).length;
