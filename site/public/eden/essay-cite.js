// Citation formatting for the essay writer, without the page (src/__tests__/essay-cite.test.ts):
// a source (a book, a journal article, a web page, or a reference typed in full) as a
// reference-list entry and as an in-text citation, in MLA 9, APA 7 (student papers), Chicago 17
// (notes and bibliography) and Harvard (Cite Them Right).
//
// Output is a list of segments, { t } for plain text and { t, i: true } for italics, so the page
// can draw italics without building HTML from what the person typed. Titles, names and publishers
// keep the capitalisation and spelling they were typed with; only punctuation, order, initials,
// dates, page dashes and DOIs are rewritten.
//
// A source is { id, type, authors, title, container, publisher, place, edition, year, month, day,
// volume, issue, pages, doi, url, accessed, text }, all strings. type is 'book', 'article',
// 'website' or 'other'. authors has one author per line: "Last, First Middle" for a person, and a
// line without a comma for a group ("World Health Organization"). container is the journal
// (article) or the website's name (website). month and day are numbers ('' when unknown),
// accessed is 'YYYY-MM-DD'. For 'other', text is the whole reference as typed and is used as is.

const MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MON_MLA = ['Jan.', 'Feb.', 'Mar.', 'Apr.', 'May', 'June', 'July', 'Aug.', 'Sept.', 'Oct.', 'Nov.', 'Dec.'];
const TITLES = { mla: 'Works Cited', apa: 'References', chicago: 'Bibliography', harvard: 'Reference list' };
const TYPES = ['book', 'article', 'website', 'other'];
const ORDINAL_WORDS = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10 };

const str = (v) => (v == null ? '' : String(v).replace(/\s+/g, ' ').trim());
const I = (t) => ({ t, i: true });
const styleOf = (style) => (TITLES[str(style).toLowerCase()] ? str(style).toLowerCase() : 'mla');
const same = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
// The period a piece needs at its end: none when it already ends in . ? or !
const endP = (t) => (/[.?!]$/.test(t) ? '' : '.');
const period = (t) => (t ? t + endP(t) : '');
// The comma after a quoted title, which a closing ? or ! replaces.
const comma = (t) => (/[?!]$/.test(t) ? '' : ',');
const stripArticle = (t) => t.replace(/^(?:a|an|the)\s+(?=\S)/i, '');
const noScheme = (u) => u.replace(/^https?:\/\//i, '');

/** Segments from a list of strings and italic segments: drops empties, merges neighbours, trims the ends. */
function segs(parts) {
  const out = [];
  for (const p of parts) {
    if (!p) continue;
    const g = typeof p === 'string' ? { t: p } : p;
    if (!g.t) continue;
    const last = out[out.length - 1];
    if (last && !!last.i === !!g.i) last.t += g.t;
    else out.push(g.i ? { t: g.t, i: true } : { t: g.t });
  }
  while (out.length && !(out[0].t = out[0].t.replace(/^\s+/, ''))) out.shift();
  while (out.length && !(out[out.length - 1].t = out[out.length - 1].t.replace(/\s+$/, ''))) out.pop();
  return out;
}

/**
 * Authors from the source's authors text, one per line. A line with a comma is a person
 * ("Last, First Middle"); a line without one is a group, kept as written.
 * @param {string} text
 * @returns {Array<{last: string, first: string} | {org: string}>}
 */
export function parseAuthors(text) {
  return String(text == null ? '' : text).split(/\r?\n/).map(str).filter(Boolean).map((line) => {
    const k = line.indexOf(',');
    if (k < 0) return { org: line };
    const last = line.slice(0, k).trim();
    const first = line.slice(k + 1).trim();
    return last ? { last, first } : { org: first };
  });
}

// "John Quincy" -> "J. Q." (APA, sep ' ') or "J.Q." (Harvard, sep ''); "Jean-Paul" -> "J.-P."
function initials(first, sep) {
  return first.split(/[\s.]+/).filter(Boolean)
    .map((w) => w.split('-').filter(Boolean).map((p) => Array.from(p)[0].toUpperCase() + '.').join('-'))
    .join(sep);
}
const invName = (a) => a.org || (a.first ? `${a.last}, ${a.first}` : a.last);
const fwdName = (a) => a.org || (a.first ? `${a.first} ${a.last}` : a.last);
const iniName = (sep) => (a) => {
  if (a.org) return a.org;
  const ini = initials(a.first, sep);
  return ini ? `${a.last}, ${ini}` : a.last;
};
const shortName = (a) => a.org || a.last;

function mlaAuthors(list) {
  if (list.length === 1) return invName(list[0]);
  if (list.length === 2) return `${invName(list[0])}, and ${fwdName(list[1])}`;
  return `${invName(list[0])}, et al.`;
}
function apaAuthors(list) {
  const n = list.map(iniName(' '));
  if (n.length === 1) return n[0];
  if (n.length <= 20) return `${n.slice(0, -1).join(', ')}, & ${n[n.length - 1]}`;
  return `${n.slice(0, 19).join(', ')}, . . . ${n[n.length - 1]}`;
}
function chicagoAuthors(list) {
  if (list.length === 1) return invName(list[0]);
  if (list.length === 2) return `${invName(list[0])}, and ${fwdName(list[1])}`;
  if (list.length <= 10) return [invName(list[0]), ...list.slice(1, -1).map(fwdName)].join(', ') + `, and ${fwdName(list[list.length - 1])}`;
  return [invName(list[0]), ...list.slice(1, 7).map(fwdName)].join(', ') + ', et al.';
}
function harvardAuthors(list) {
  const n = list.map(iniName(''));
  if (n.length === 1) return n[0];
  if (n.length === 2) return `${n[0]} and ${n[1]}`;
  if (n.length === 3) return `${n[0]}, ${n[1]} and ${n[2]}`;
  return `${n[0]} et al.`;
}

// The names in an in-text citation or short note.
function citeNames(style, list) {
  const n = list.map(shortName);
  if (!n.length) return '';
  if (n.length === 1) return n[0];
  const and = style === 'apa' ? '&' : 'and';
  if (n.length === 2) return `${n[0]} ${and} ${n[1]}`;
  if (n.length === 3 && style === 'harvard') return `${n[0]}, ${n[1]} and ${n[2]}`;
  if (n.length === 3 && style === 'chicago') return `${n[0]}, ${n[1]}, and ${n[2]}`;
  return `${n[0]} et al.`;
}

/** "doi:10.1/x", "https://doi.org/10.1/x" or "10.1/x" -> "https://doi.org/10.1/x" */
function doiUrl(d) {
  const raw = str(d);
  const x = raw.replace(/^(?:https?:\/\/)?(?:dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '');
  return /^10\.\S+$/.test(x) ? `https://doi.org/${x}` : raw;
}
const pageRange = (p) => str(p).replace(/\s*(?:--|[-‐‑‒–])\s*/g, '–');
const isRange = (p) => /[–,]/.test(p);

function ordinal(n) {
  const t = n % 100, u = n % 10;
  return n + (t >= 11 && t <= 13 ? 'th' : u === 1 ? 'st' : u === 2 ? 'nd' : u === 3 ? 'rd' : 'th');
}
// "2", "2nd", "2nd ed.", "second edition" -> "2nd"; a first edition is left out; "Revised" -> "Rev."
function editionWord(e) {
  const x = str(e).replace(/\s*\b(?:edition|edn|ed)\.?$/i, '').trim();
  if (!x) return '';
  const m = /^(\d+)(?:st|nd|rd|th)?$/i.exec(x);
  const n = m ? Number(m[1]) : ORDINAL_WORDS[x.toLowerCase()] || 0;
  if (n) return n === 1 ? '' : ordinal(n);
  return /^rev(?:ised|\.)?$/i.test(x) ? 'Rev.' : x;
}

function intOf(v, lo, hi) {
  const n = Number(str(v));
  return Number.isInteger(n) && n >= lo && n <= hi ? n : 0;
}
function accessedOf(v) {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(str(v));
  if (!m) return null;
  const mo = intOf(m[2], 1, 12), d = intOf(m[3], 1, 31);
  return mo && d ? { y: m[1], m: mo, d } : null;
}
// 5 Mar. 2021 / Mar. 2021 / 2021
const mlaDate = (y, m, d) => (y ? [m && d ? String(d) : '', m ? MON_MLA[m - 1] : '', y].filter(Boolean).join(' ') : '');
// March 5, 2021 / March 2021 / 2021
const mdyDate = (y, m, d) => (y ? (m ? `${MON[m - 1]}${d ? ` ${d},` : ''} ${y}` : y) : '');
// 5 March 2021
const dmyDate = (a) => `${a.d} ${MON[a.m - 1]} ${a.y}`;

function fieldsOf(src) {
  const o = src || {};
  let type = str(o.type).toLowerCase();
  if (!TYPES.includes(type)) type = str(o.text) && !str(o.title) ? 'other' : 'book';
  const month = intOf(o.month, 1, 12);
  const pages = pageRange(o.pages);
  return {
    type,
    authors: parseAuthors(o.authors),
    title: str(o.title),
    container: str(o.container),
    publisher: str(o.publisher),
    place: str(o.place),
    edition: editionWord(o.edition),
    year: str(o.year),
    month,
    day: month ? intOf(o.day, 1, 31) : 0,
    volume: str(o.volume),
    issue: str(o.issue),
    pages,
    range: isRange(pages),
    doi: o.doi ? doiUrl(o.doi) : '',
    url: str(o.url),
    accessed: accessedOf(o.accessed),
    text: str(o.text),
  };
}

const soleOrg = (x) => (x.authors.length === 1 && x.authors[0].org) || '';
// MLA starts with the title when a group is both the author and the publisher (or the website).
const mlaAuthorList = (x) => {
  const org = soleOrg(x);
  return org && (same(org, x.publisher) || same(org, x.container)) ? [] : x.authors;
};

function mla(x) {
  const P = [];
  const authors = mlaAuthorList(x);
  if (authors.length) P.push(period(mlaAuthors(authors)) + ' ');
  const quoted = x.title ? `"${x.title}${endP(x.title)}" ` : '';
  const loc = x.doi || (x.url ? noScheme(x.url) : '');
  // The container (journal, website) and the elements after it, as one sentence.
  const container = (name, rest) => {
    const tail = rest.filter(Boolean).join(', ');
    if (name) P.push(I(name), (tail ? `, ${tail}` : '') + endP(tail || name) + ' ');
    else if (tail) P.push(period(tail) + ' ');
  };
  if (x.type === 'book') {
    if (x.title) P.push(I(x.title), endP(x.title) + ' ');
    const rest = [x.edition && `${x.edition} ed.`, x.publisher, x.year].filter(Boolean).join(', ');
    P.push(period(rest) + ' ', period(loc));
  } else if (x.type === 'article') {
    P.push(quoted);
    container(x.container, [
      x.volume && `vol. ${x.volume}`, x.issue && `no. ${x.issue}`, mlaDate(x.year, x.month, x.day),
      x.pages && `${x.range ? 'pp.' : 'p.'} ${x.pages}`,
    ]);
    P.push(period(loc));
  } else {
    P.push(quoted);
    const pub = x.publisher && !same(x.publisher, x.container) ? x.publisher : '';
    container(x.container, [pub, mlaDate(x.year, x.month, x.day), loc]);
    if (!x.year && x.accessed) P.push(`Accessed ${mlaDate(x.accessed.y, x.accessed.m, x.accessed.d)}.`);
  }
  return P;
}

function apa(x) {
  const P = [];
  const org = soleOrg(x);
  const date = x.type === 'website'
    ? (x.year ? `(${x.year}${x.month ? `, ${MON[x.month - 1]}${x.day ? ` ${x.day}` : ''}` : ''}).` : '(n.d.).')
    : (x.year ? `(${x.year}).` : '(n.d.).');
  const title = !x.title ? [] : x.type === 'article' ? [period(x.title)]
    : x.edition && x.type === 'book' ? [I(x.title), ` (${x.edition} ed.).`] : [I(x.title), endP(x.title)];
  if (x.authors.length) P.push(period(apaAuthors(x.authors)) + ' ', date + ' ', ...title, ' ');
  else P.push(...title, ' ', date + ' ');
  const loc = x.doi || x.url;
  if (x.type === 'book') {
    if (x.publisher && !same(org, x.publisher)) P.push(period(x.publisher) + ' ');
  } else if (x.type === 'article') {
    if (x.container) {
      P.push(I(x.container + (x.volume ? `, ${x.volume}` : '')));
      P.push((x.issue ? `(${x.issue})` : '') + (x.pages ? `, ${x.pages}` : '') + '. ');
    }
  } else if (x.container && !same(org, x.container)) {
    P.push(period(x.container) + ' ');
  }
  P.push(loc);
  return P;
}

function chicago(x) {
  const P = [];
  if (x.authors.length) P.push(period(chicagoAuthors(x.authors)) + ' ');
  const loc = x.doi || x.url;
  if (x.type === 'book') {
    if (x.title) P.push(I(x.title), endP(x.title) + ' ');
    if (x.edition) P.push(`${x.edition} ed. `);
    const pub = x.place && x.publisher ? `${x.place}: ${x.publisher}` : x.publisher || x.place;
    P.push(period([pub, x.year || 'n.d.'].filter(Boolean).join(', ')) + ' ');
  } else if (x.type === 'article') {
    if (x.title) P.push(`"${x.title}${endP(x.title)}" `);
    const date = x.year ? (x.month ? `${MON[x.month - 1]} ${x.year}` : x.year) : 'n.d.';
    // Journal 77, no. 1 (2007): 81-112. (a comma after the journal when there's no volume)
    const vi = [x.volume, x.issue && `no. ${x.issue}`].filter(Boolean).join(', ');
    const rest = `${vi ? `${vi} ` : ''}(${date})${x.pages ? `: ${x.pages}` : ''}. `;
    if (x.container) P.push(I(x.container), (!x.volume && x.issue ? ', ' : ' ') + rest);
    else P.push(rest);
  } else {
    if (x.title) P.push(`"${x.title}${endP(x.title)}" `);
    const site = x.container || x.publisher;
    if (site) P.push(period(site) + ' ');
    if (x.year) P.push(period(mdyDate(x.year, x.month, x.day)) + ' ');
    else if (x.accessed) P.push(`Accessed ${mdyDate(x.accessed.y, x.accessed.m, x.accessed.d)}. `);
  }
  P.push(period(loc));
  return P;
}

function harvard(x) {
  const P = [];
  const date = `(${x.year || 'no date'})`;
  const has = x.authors.length > 0;
  if (has) P.push(`${harvardAuthors(x.authors)} ${date} `);
  const avail = x.doi ? `Available at: ${x.doi}.`
    : x.url ? `Available at: ${x.url}${x.accessed ? ` (Accessed: ${dmyDate(x.accessed)})` : ''}.` : '';
  if (x.type === 'article') {
    if (x.title) P.push(has ? `'${x.title}', ` : `'${x.title}' ${date} `);
    else if (!has) P.push(`${date} `);
    const rest = [x.volume ? x.volume + (x.issue ? `(${x.issue})` : '') : x.issue && `(${x.issue})`,
      x.pages && `${x.range ? 'pp.' : 'p.'} ${x.pages}`].filter(Boolean).join(', ');
    if (x.container) P.push(I(x.container), (rest ? `, ${rest}` : '') + '. ');
    else if (rest) P.push(period(rest) + ' ');
  } else {
    if (x.title) P.push(I(x.title), has ? endP(x.title) + ' ' : ` ${date} `);
    else if (!has) P.push(`${date} `);
    if (x.type === 'book') {
      if (x.edition) P.push(`${x.edition} edn. `);
      const pub = x.place && x.publisher ? `${x.place}: ${x.publisher}` : x.publisher || x.place;
      if (pub) P.push(period(pub) + ' ');
    }
  }
  P.push(avail);
  return P;
}

const FORMAT = { mla, apa, chicago, harvard };

/**
 * One source as an entry in the reference list.
 * @param {'mla'|'apa'|'chicago'|'harvard'} style
 * @param {object} src the source (see the header)
 * @returns {Array<{t: string, i?: true}>} segments; i marks italics
 */
export function formatReference(style, src) {
  const x = fieldsOf(src);
  // as typed, with *italic* or _italic_ (a pasted reference keeps its italic titles: T20a) set in italics
  if (x.type === 'other') return segs(x.text.split(/(\*[^*\n]+\*|_[^_\n]+_)/).map((p) => (/^([*_]).+\1$/.test(p) ? { t: p.slice(1, -1), i: true } : p)));
  if (!x.title && !x.authors.length) return [];
  return segs(FORMAT[styleOf(style)](x));
}

const SMALL = /^(?:a|an|the|and|or|of|in|on|at|to|for|with|by|from)$/i;
/**
 * First four words of the main title (before a colon or a closing ? or !), without a leading
 * A/An/The, and without an article or preposition left dangling at the end ("Sleep and Memory in"
 * -> "Sleep and Memory").
 */
function shortTitle(title) {
  const main = str(title).split(/:\s|(?<=[?!])\s/)[0];
  const words = stripArticle(main).split(' ').slice(0, 4);
  while (words.length > 1 && SMALL.test(words[words.length - 1].replace(/[,;:.]+$/, ''))) words.pop();
  return words.join(' ').replace(/[,;:.]+$/, '');
}
// For 'other': the reference's first word, without quotes, a leading article or trailing punctuation.
function leadWord(text) {
  const w = stripArticle(str(text).replace(/^["'“‘(\[*_]+/, '')).split(' ')[0] || '';
  return w.replace(/[,.;:"'”’)\]*_]+$/, '');
}

/**
 * An in-text citation: parenthetical for MLA, APA and Harvard; for Chicago the text of a
 * shortened footnote (no parentheses, ending with a period).
 * @param {'mla'|'apa'|'chicago'|'harvard'} style
 * @param {object} src the source
 * @param {{page?: string}} [opts] page or page range cited
 * @returns {Array<{t: string, i?: true}>}
 */
export function inText(style, src, opts = {}) {
  const st = styleOf(style);
  const x = fieldsOf(src);
  const page = pageRange(opts && opts.page);
  const pp = page ? `, ${isRange(page) ? 'pp.' : 'p.'} ${page}` : '';
  let year = x.year;
  let names;
  if (x.type === 'other') {
    names = leadWord(x.text);
    if (!year) year = (/\b(1[5-9]\d\d|20\d\d)\b/.exec(x.text) || [])[1] || '';
  } else {
    names = citeNames(st, st === 'mla' ? mlaAuthorList(x) : x.authors);
  }
  const short = shortTitle(x.title);
  if (!names && !short) return [];
  const italicTitle = x.type === 'book' || (x.type === 'website' && st !== 'mla' && st !== 'chicago') || st === 'harvard';
  if (st === 'mla') {
    const pg = page ? ` ${page}` : '';
    if (names) return segs([`(${names}${pg})`]);
    return segs(['(', italicTitle ? I(short) : `"${short}"`, `${pg})`]);
  }
  if (st === 'apa' || st === 'harvard') {
    const yr = year || (st === 'apa' ? 'n.d.' : 'no date');
    if (names) return segs([`(${names}, ${yr}${pp})`]);
    if (italicTitle) return segs(['(', I(short), `, ${yr}${pp})`]);
    return segs([`("${short}${comma(short)}" ${yr}${pp})`]);
  }
  // Chicago shortened note: Author, Short Title, page.
  const lead = names ? `${names}, ` : '';
  if (x.type === 'other' || !short) return segs([`${names}${page ? `, ${page}` : ''}.`]);
  if (x.type === 'book') return segs([lead, I(short), page ? `, ${page}.` : endP(short)]);
  return segs([lead, page ? `"${short}${comma(short)}" ${page}.` : `"${short}${endP(short)}"`]);
}

/**
 * The sources in reference-list order: by the first author's surname (or group, or the title
 * without a leading A/An/The when there is no author), then by year for APA and Harvard (undated
 * first), or by title for MLA and Chicago, as those guides order one author's works.
 * @param {'mla'|'apa'|'chicago'|'harvard'} style
 * @param {object[]} sources
 * @returns {object[]} a new array
 */
export function sortReferences(style, sources) {
  const st = styleOf(style);
  const coll = new Intl.Collator('en', { sensitivity: 'base', numeric: true });
  const keyed = (sources || []).map((src, n) => {
    const x = fieldsOf(src);
    const authors = st === 'mla' ? mlaAuthorList(x) : x.authors;
    const title = stripArticle(x.title.replace(/^["'“‘]+/, ''));
    const lead = x.type === 'other' ? stripArticle(x.text.replace(/^["'“‘*_]+/, ''))
      : authors.length ? authors.map((a) => a.org || `${a.last} ${a.first}`).join(' \u0001 ') : title;
    const y = parseInt(x.year, 10);
    return { src, n, lead, title, year: Number.isFinite(y) ? y : -Infinity, full: plainText(formatReference(st, src)) };
  });
  const byYear = st === 'apa' || st === 'harvard';
  keyed.sort((a, b) => coll.compare(a.lead, b.lead)
    || (byYear ? a.year - b.year || coll.compare(a.title, b.title) : coll.compare(a.title, b.title) || a.year - b.year)
    || coll.compare(a.full, b.full) || a.n - b.n);
  return keyed.map((k) => k.src);
}

/**
 * Segments as one plain string.
 * @param {Array<{t: string}>} segments
 * @returns {string}
 */
export function plainText(segments) {
  return (segments || []).map((s) => s.t).join('');
}

/**
 * The heading of the reference list in a style.
 * @param {'mla'|'apa'|'chicago'|'harvard'} style
 * @returns {'Works Cited'|'References'|'Bibliography'|'Reference list'}
 */
export function refsTitle(style) {
  return TITLES[styleOf(style)];
}
