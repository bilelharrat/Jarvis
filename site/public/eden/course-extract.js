// Eden for Education: a course file's text, page by page or slide by slide, read in the browser
// (courses.js sends only the text to askeden.com; the file itself never leaves this device).
//
//   PDF          pdf.js (pdfjs.min.mjs, Apache-2.0, loaded on first use) → "page N"
//   PowerPoint   .pptx is a zip: ppt/slides/slideN.xml, each <a:t> run → "slide N"
//   Word         .docx is a zip: word/document.xml paragraphs, ~2,000 characters a part → "section N"
//   Text         .txt / .md, ~2,000 characters a part → "section N"
//   EPUB         a zip of XHTML chapters: the spine's order (META-INF/container.xml → the OPF), each
//                chapter by its own title, a long one in ~2,000-character parts → "ch. 3: Cell Membranes";
//                a copy-protected (DRM) book can't be read and says so
//
// Scanned PDFs (pictures of pages) have no text to read: the result is empty and the page says so.

const PART = 2000;

export function kindOf(name) {
  const ext = String(name).toLowerCase().split('.').pop();
  return { pdf: 'pdf', pptx: 'slides', docx: 'doc', txt: 'text', md: 'text', markdown: 'text', epub: 'epub' }[ext] || null;
}

/** { kind, parts: [{ loc, text }] } for a File; throws a readable Error for what it can't read. */
export async function extractFile(file) {
  const kind = kindOf(file.name);
  if (!kind) throw new Error('Eden reads PDF, EPUB, PowerPoint (.pptx), Word (.docx), and text or Markdown files.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (kind === 'pdf') return { kind, ...(await pdfParts(bytes)) };
  if (kind === 'text') return { kind, parts: chunk(new TextDecoder().decode(bytes).split(/\n\s*\n/)) };
  if (kind === 'epub') return { kind, parts: await epubParts(bytes) };
  const zip = await unzip(bytes);
  if (kind === 'slides') {
    const slides = [...zip.keys()].map((k) => /^ppt\/slides\/slide(\d+)\.xml$/.exec(k)).filter(Boolean).sort((a, b) => a[1] - b[1]);
    return { kind, parts: slides.map((m) => ({ loc: `slide ${m[1]}`, text: xmlText(zip.get(m[0]), 'a:p', 'a:t') })).filter((p) => p.text) };
  }
  const doc = zip.get('word/document.xml');
  if (!doc) throw new Error('That Word file couldn’t be read.');
  return { kind, parts: chunk(xmlText(doc, 'w:p', 'w:t').split('\n')) };
}

/** A zip without its central directory (a file cut off at the end, which Apple Books still opens):
 * each local entry read in turn from its own header; one that's itself cut off ends the list. */
async function scanLocal(bytes, want) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const names = new TextDecoder();
  const out = new Map();
  let at = 0;
  const nextSig = (from) => { for (let i = from; i + 4 <= bytes.length; i++) if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && ((bytes[i + 2] === 3 && bytes[i + 3] === 4) || (bytes[i + 2] === 1 && bytes[i + 3] === 2))) return i; return -1; };
  while (at + 30 <= bytes.length && view.getUint32(at, true) === 0x04034b50) {
    const flags = view.getUint16(at + 6, true), method = view.getUint16(at + 8, true);
    let size = view.getUint32(at + 18, true);
    const nameLen = view.getUint16(at + 26, true), extraLen = view.getUint16(at + 28, true);
    const name = names.decode(bytes.subarray(at + 30, at + 30 + nameLen));
    const start = at + 30 + nameLen + extraLen;
    let end;
    if (flags & 8 && !size) { // sizes in a descriptor after the data: up to the next header
      const n = nextSig(start);
      end = n < 0 ? bytes.length : n;
      if (end - start >= 16 && view.getUint32(end - 16, true) === 0x08074b50) end -= 16;
      else if (end - start >= 12) end -= 12;
    } else end = start + size;
    if (end > bytes.length) break; // this entry is the one that was cut off
    if (want(name)) {
      const data = bytes.subarray(start, end);
      try {
        const raw = method === 0 ? data : method === 8 ? new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer()) : null;
        if (raw) out.set(name, new TextDecoder().decode(raw));
      } catch { /* a damaged entry: skip it */ }
    }
    if (flags & 8 && !size) { const n = nextSig(end); if (n < 0) break; at = n; } else at = end + (flags & 8 ? (view.getUint32(end, true) === 0x08074b50 ? 16 : 12) : 0);
  }
  if (!out.size) throw new Error('That file isn’t a valid document (it should be a zip inside).');
  return out;
}

/** An EPUB's chapters, in reading order, each by its title (a long chapter in parts). */
async function epubParts(bytes) {
  const zip = await unzip(bytes, (n) => /\.(x?html?|xml|opf|ncx)$/i.test(n));
  if (zip.has('META-INF/encryption.xml') && /EncryptedData/.test(zip.get('META-INF/encryption.xml')) && !/font/i.test(zip.get('META-INF/encryption.xml'))) {
    throw new Error('This EPUB is copy-protected (DRM), so its text can’t be read. Use a DRM-free copy, or a PDF of the pages you may share.');
  }
  const xml = (t) => new DOMParser().parseFromString(t, 'application/xml');
  const container = zip.get('META-INF/container.xml');
  const opfPath = container ? (xml(container).querySelector('rootfile') || {}).getAttribute?.('full-path') : [...zip.keys()].find((k) => k.endsWith('.opf'));
  const opf = opfPath && zip.get(opfPath);
  if (!opf) throw new Error('That EPUB couldn’t be read (no table of contents inside).');
  const base = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
  const doc = xml(opf);
  const items = new Map([...doc.getElementsByTagName('item')].map((i) => [i.getAttribute('id'), i.getAttribute('href')]));
  const spine = [...doc.getElementsByTagName('itemref')].map((r) => items.get(r.getAttribute('idref'))).filter(Boolean);
  const resolve = (href) => { const parts = (base + decodeURIComponent(href.split('#')[0])).split('/'); const out = []; for (const p of parts) { if (p === '..') out.pop(); else if (p && p !== '.') out.push(p); } return out.join('/'); };
  const parts = [];
  let n = 0;
  for (const href of spine) {
    const page = zip.get(resolve(href));
    if (!page) continue;
    const html = new DOMParser().parseFromString(page, /<html[^>]+xmlns/i.test(page) ? 'application/xhtml+xml' : 'text/html');
    if (html.querySelector('parsererror')) continue;
    for (const x of html.querySelectorAll('script, style, nav[epub\\:type="toc"], aside[epub\\:type="footnote"]')) x.remove();
    const body = html.body || html.documentElement;
    const paras = [...body.querySelectorAll('h1, h2, h3, h4, p, li, blockquote, td, figcaption, pre, dt, dd')].map((e) => e.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const text = paras.length ? paras : [body.textContent.replace(/\s+/g, ' ').trim()].filter(Boolean);
    if (!text.join('').trim() || text.join(' ').length < 40) continue; // covers, blank pages
    n++;
    const head = body.querySelector('h1, h2, h3');
    const title = (head && head.textContent.replace(/\s+/g, ' ').trim()) || (html.querySelector('title') || {}).textContent || '';
    const label = `ch. ${n}${title && title.length <= 60 ? `: ${title.trim()}` : ''}`.slice(0, 38);
    const pieces = chunk(text);
    pieces.forEach((p, i) => parts.push({ loc: pieces.length > 1 ? `${label}`.slice(0, 32) + ` (${i + 1})` : label, text: p.text }));
  }
  return parts;
}

/** Paragraphs → parts of about PART characters, "section N". */
function chunk(paras) {
  const parts = [];
  let cur = '';
  for (const p of paras.map((x) => x.trim()).filter(Boolean)) {
    if (cur && cur.length + p.length > PART) { parts.push(cur); cur = ''; }
    cur = cur ? `${cur}\n${p}` : p;
  }
  if (cur) parts.push(cur);
  return parts.map((text, i) => ({ loc: `section ${i + 1}`, text }));
}

/** The text of an Office XML part: one line per paragraph (para tag), runs (run tag) joined. */
function xmlText(xml, para, run) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  return [...doc.getElementsByTagName(para)].map((p) => [...p.getElementsByTagName(run)].map((r) => r.textContent).join('')).filter((t) => t.trim()).join('\n');
}

async function pdfParts(bytes) {
  const pdfjs = await import('./pdfjs.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('./pdfjs.worker.min.mjs', import.meta.url).href;
  const pdf = await pdfjs.getDocument({ data: bytes, isEvalSupported: false }).promise;
  const parts = [];
  const scanned = []; // pages with (almost) no text: pictures of pages, for scannedParts()
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const content = await page.getTextContent();
    const text = content.items.map((it) => it.str + (it.hasEOL ? '\n' : ' ')).join('').replace(/[ \t]+/g, ' ').trim();
    if (text.length >= 20) parts.push({ loc: `page ${n}`, text });
    else scanned.push(n);
  }
  await pdf.destroy();
  return { parts, scanned };
}

/** Pictures of a PDF's pages (JPEG, base64, at most 1600 px wide), for reading scanned pages on askeden.com. */
export async function pageImages(file, pages) {
  const pdfjs = await import('./pdfjs.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('./pdfjs.worker.min.mjs', import.meta.url).href;
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false }).promise;
  const out = [];
  for (const n of pages) {
    const page = await pdf.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.min(2, 1600 / base.width) });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    out.push({ loc: `page ${n}`, data: canvas.toDataURL('image/jpeg', 0.8).split(',')[1] });
  }
  await pdf.destroy();
  return out;
}

/** The XML entries of a zip (.pptx, .docx): Map name → text. Stored and deflated entries only. */
async function unzip(bytes, want = (name) => /^(ppt\/slides\/slide\d+|word\/document)\.xml$/.test(name)) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) return scanLocal(bytes, want); // no index at the end (a download cut short): read it piece by piece
  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  const out = new Map();
  const names = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (view.getUint32(at, true) !== 0x02014b50) break;
    const method = view.getUint16(at + 10, true);
    const size = view.getUint32(at + 20, true);
    const nameLen = view.getUint16(at + 28, true), extraLen = view.getUint16(at + 30, true), commentLen = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = names.decode(bytes.subarray(at + 46, at + 46 + nameLen));
    at += 46 + nameLen + extraLen + commentLen;
    if (!want(name)) continue;
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = bytes.subarray(start, start + size);
    const raw = method === 0 ? data : method === 8 ? new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer()) : null;
    if (raw) out.set(name, new TextDecoder().decode(raw));
  }
  return out;
}
