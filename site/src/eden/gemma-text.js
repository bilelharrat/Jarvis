// The Gemma claim judge on raw source text, BEFORE EVES's own web evidence check (eves.js checkEvidence).
//
//   GEMMA_TEXT_MODE   off (default) | shadow | owner          [vars]   (separate from GEMMA_JUDGE_MODE, which is unchanged)
//   uses the same GEMMA_JUDGE_URL / GEMMA_JUDGE_KEY / GEMMA_JUDGE_SECRET as gemma-judge.js
//
// The text: the search providers in this tree hand EVES only titles and URLs (Gemini groundingChunks.web = uri/title,
// OpenAI url_citation = url/title, Claude citations_delta: the vendored parser keeps url/title only), so no provider
// snippet is available yet; the text is a Worker fetch of the answer lanes' first 1–3 cited pages, started as soon as a
// lane's citations are in (so it runs while EVES extracts and judges claims): in parallel, 2.5 s, 1.5 MB per page,
// public http(s) hosts only (every redirect hop checked again), HTML → text here (no new dependency). Gemini's citations
// are vertexaisearch grounding-redirect links, which the core's hydrateCitedSnippets refuses (long path tokens), so the
// redirect is followed here instead. Failed, blocked, paywalled, non-HTML or near-empty pages are skipped. Page text goes to the judge only as `page` (the
// judge server picks the key sentences, as calibrated); it is never put into any model prompt.
//
// Per claim, before checkEvidence:
//   owner (owner accounts, GEMMA_TEXT_MODE=owner): the claim's paid web check waits for the judge, at most for what is
//          left of the 2.5 s page budget plus 2 s for the judge (in practice the pages are in long before the claims).
//          "supported"/"contradicted" at the frozen thresholds → that claim's EVES web check is skipped. Anything else
//          (escalate, no pages, cold judge, timeout, 429/5xx, bad JSON, time-sensitive claim) → EVES as today.
//   shadow (everyone else in both modes, and owner accounts in shadow): EVES runs exactly as today, at the same moment;
//          the judge runs beside it in the background and the log says what would have been skipped and the saving.
// Time-sensitive claims (current, latest, newest, now, today, prices…) never settle on the judge alone.
// The iPhone and Edu apps (UA EdenApp/ or EdenEdu/) never reach this: no page fetch, no judge call, no ping.
// Log line: {"evt":"gemma_text", claim hash, source, pages, bytes, gemma, eves, used, ms_saved_est, usd_saved_est}. No user text.

import { APP_UA, claimHash, judge, judgeCreds, judgeIsWarm, ping } from './gemma-judge.js';

const MODES = new Set(['off', 'shadow', 'owner']);
export const PAGE_BUDGET_MS = 2_500;
export const TEXT_JUDGE_MS = 2_000;
const BATCH_MS = 25;
const MAX_JUDGE_ITEMS = 64; // server.py limit
export const PAGE_MAX_BYTES = 1_500_000;
const PAGE_MAX_CHARS = 120_000; // server.py takes up to 400 kB per page; keeps a 3-page claim well under a megabyte
const PAGE_MIN_CHARS = 400; // shorter is a paywall, a consent wall or an error page
const MAX_PAGES = 3;
const SETTLED = new Set(['supported', 'contradicted']);
// the judge's calibrated claim types (repjudge/frozen_hf/config.json thresholds); anything else is sent as "fact",
// or "number" (the stricter support threshold) when it has digits
const KINDS = new Set(['date', 'entity', 'fact', 'number', 'premise', 'quote']);
// A grounded Gemini call (the eval's HALLUC_GROUNDED_CALL_USD): the hosted cost counter doesn't include it
export const SEARCH_FEE_EST_USD = 0.021;
const TIME_SENSITIVE =
  /\b(?:current(?:ly)?|latest|newest|most recent|recent(?:ly)?|now|nowadays|today|tonight|tomorrow|yesterday|this (?:week|month|year|season|quarter)|so far|to date|as of|still|upcoming|ongoing|price[sd]?|pricing|costs?|priced|cheapest|stock price|share price|exchange rate|interest rate|weather|forecast|standings)\b|[$€£¥]\s?\d/i;

export const isTimeSensitive = (...texts) => texts.some((t) => typeof t === 'string' && TIME_SENSITIVE.test(t));

export function gemmaTextMode(env, request) {
  if (request && APP_UA.test(request.headers.get('user-agent') || '')) return 'off';
  if (!judgeCreds(env)) return 'off';
  const m = String(env.GEMMA_TEXT_MODE ?? 'off').trim().toLowerCase();
  return MODES.has(m) ? m : 'off';
}

// Per isolate: what a skipped web check would have cost, learnt from the ones that ran (a skipped one has no numbers)
const avg = { ms: 7_000, usd: 0.004 + SEARCH_FEE_EST_USD };
export function resetGemmaText() {
  avg.ms = 7_000;
  avg.usd = 0.004 + SEARCH_FEE_EST_USD;
}
const learn = (ms, usd) => {
  avg.ms = Math.round(avg.ms * 0.8 + ms * 0.2);
  avg.usd = avg.usd * 0.8 + usd * 0.2;
};
const r4 = (x) => Math.round(x * 10_000) / 10_000;

/** Redirect targets are checked again here (the first URL already passed the core's rules): public http(s) names only. */
function publicUrl(raw, base) {
  let u;
  try {
    u = new URL(raw, base);
  } catch {
    return null;
  }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password) return null;
  if (u.port && u.port !== '80' && u.port !== '443') return null;
  const h = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!h.includes('.') || h.startsWith('[') || /^[\d.]+$/.test(h) || /^0x/i.test(h)) return null;
  if (/(?:^|\.)(?:localhost|local|localdomain|internal|intranet|private|corp|home|lan|arpa|onion|test|invalid|example|alt)$/.test(h)) return null;
  return u;
}

/** GET one page: at most 3 redirects, 1.5 MB, HTML or plain text only. Resolves { status, text, bytes }; never throws. */
export async function fetchPage(url, { timeoutMs = PAGE_BUDGET_MS, signal } = {}) {
  const t = AbortSignal.timeout(timeoutMs);
  const sig = signal && typeof AbortSignal.any === 'function' ? AbortSignal.any([t, signal]) : t;
  let at = publicUrl(url);
  try {
    for (let hop = 0; at && hop <= 3; hop++) {
      const r = await fetch(at.href, { headers: { accept: 'text/html,application/xhtml+xml,text/plain;q=0.8', 'user-agent': 'Mozilla/5.0 (compatible; EdenFactCheck/1.0; +https://askeden.com)' }, redirect: 'manual', signal: sig });
      if (r.status >= 300 && r.status < 400) {
        const next = r.headers.get('location');
        if (r.body) await r.body.cancel().catch(() => undefined);
        at = next ? publicUrl(next, at) : null;
        continue;
      }
      const type = r.headers.get('content-type') || '';
      if (!r.ok || !r.body || (type && !/text\/html|application\/xhtml|text\/plain/i.test(type))) {
        if (r.body) await r.body.cancel().catch(() => undefined);
        return { status: r.ok ? 415 : r.status, text: '', bytes: 0 };
      }
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let bytes = 0;
      let text = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const room = PAGE_MAX_BYTES - bytes;
        const chunk = value.byteLength > room ? value.subarray(0, room) : value;
        bytes += chunk.byteLength;
        text += dec.decode(chunk, { stream: true });
        if (bytes >= PAGE_MAX_BYTES) {
          await reader.cancel().catch(() => undefined);
          break;
        }
      }
      return { status: r.status, text: text + dec.decode(), bytes };
    }
  } catch {
    // timeout, stopped, network: the page is skipped
  }
  return { status: 0, text: '', bytes: 0 };
}

const GROUNDING_REDIRECT = /^https:\/\/vertexaisearch\.cloud\.google\.com\/grounding-api-redirect\/[A-Za-z0-9_=-]+$/;
// A link that looks like it carries a token or someone's data (long query values, e-mail addresses) is not fetched
const tokenish = (u) => [...u.searchParams.values()].some((v) => v.length >= 40 || /@/.test(v)) || /@/.test(u.pathname);

/** The first 3 distinct fetchable cited URLs, in the order the provider gave them. */
export function pickUrls(citations, max = MAX_PAGES) {
  const out = [];
  const seen = new Set();
  for (const c of Array.isArray(citations) ? citations : []) {
    if (!c || typeof c.url !== 'string') continue;
    const u = publicUrl(c.url.trim());
    if (!u || u.href.length > 2048) continue;
    if (!GROUNDING_REDIRECT.test(u.href) && tokenish(u)) continue;
    const k = u.href.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ title: typeof c.title === 'string' ? c.title.slice(0, 200) : '', url: u.href });
    if (out.length >= max) break;
  }
  return out;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…' };
/** HTML → plain text: scripts, styles and markup out; block ends become line breaks (the judge splits on them). */
export function htmlToText(html, max = PAGE_MAX_CHARS) {
  const t = String(html ?? '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg|head|nav|footer|form)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<\/?(?:p|div|section|article|li|ul|ol|tr|table|h[1-6]|br|hr|dd|dt|blockquote|pre|main|header|aside|figcaption|caption|td|th)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] === '#') {
        const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(n) && n > 31 && n < 0x110000 ? String.fromCodePoint(n) : ' ';
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t\f\v\r\u00a0]+/g, ' ')
    .replace(/ *\n[\s]*/g, '\n')
    .trim();
  return t.length > max ? t.slice(0, max) : t;
}

/**
 * The page most likely to hold the claim: most of the claim's words and numbers found in it (a cheap filter; the judge
 * server still picks the sentences). One page per claim is how the judge was calibrated, and keeps it inside 2 s
 * (two pages timed out in the paid check).
 */
export function bestPages(claim, pages) {
  const toks = [...new Set((String(claim).toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}.,'-]*/gu) || []).map((t) => t.replace(/[.,'-]+$/, '')).filter((t) => t.length > 3 || /\d/.test(t)))];
  if (!toks.length || pages.length < 2) return pages.slice(0, 1);
  const scored = pages.map((p) => {
    const low = p.text.toLowerCase();
    return { p, s: toks.filter((t) => low.includes(t)).length / toks.length };
  });
  scored.sort((a, b) => b.s - a.s);
  return [scored[0].p];
}

const kindFor = (kind, claim) => (KINDS.has(kind) ? kind : /\d/.test(claim) ? 'number' : 'fact');

/** Several pages' verdicts for one claim: settled only when at least one page settles it and none says the opposite. */
export function combine(verdicts) {
  const s = verdicts.includes('supported');
  const c = verdicts.includes('contradicted');
  return s && !c ? 'supported' : c && !s ? 'contradicted' : 'escalate';
}

/** checkEvidence's result shape for a claim the judge settled (no page text in it: the page is untrusted). */
export function textVerdict(verdict, pages) {
  return {
    verdict,
    summary: verdict === 'supported' ? 'Eden’s claim judge read the cited page and it confirms this.' : 'Eden’s claim judge read the cited page and it says otherwise.',
    sources: pages.slice(0, 3).map((p) => ({ title: p.title || p.url, url: p.url })),
    costUSD: 0,
    gemmaText: true,
  };
}

/**
 * A turn's raw-text judge, or null when it is off for this request (mode off, app UA, judge secrets missing).
 * whoIsOwner: () => Promise<boolean>, asked only in owner mode.
 */
export function gemmaTextSession(request, env, ctx, whoIsOwner, { fetcher = fetchPage } = {}) {
  const mode = gemmaTextMode(env, request);
  if (mode === 'off') return null;
  const ownerP = mode === 'owner' ? Promise.resolve().then(whoIsOwner).then(Boolean, () => false) : Promise.resolve(false);
  ownerP.catch(() => undefined);
  const wait = (p) => {
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(p);
  };
  let pagesP = null;
  let settledPages = null;
  let deadline = 0;

  /** The text for one claim within the budget: [{ title, url, text }] (may be empty). */
  const pagesFor = async () => {
    if (!pagesP) return [];
    const left = deadline - Date.now();
    if (left <= 0) return settledPages ?? [];
    let timer;
    const late = new Promise((resolve) => {
      timer = setTimeout(() => resolve(settledPages ?? []), left);
    });
    try {
      return await Promise.race([pagesP, late]);
    } finally {
      clearTimeout(timer);
    }
  };

  /** Gemma on the pages, bounded. Resolves { verdict, pages, ms, error? }; never throws. */
  const preJudge = async (claim, kind, signal) => {
    const t0 = Date.now();
    const pages = await pagesFor();
    if (!pages.length) return { verdict: null, pages, ms: Date.now() - t0, error: pagesP ? 'no_text' : 'no_sources' };
    if (!judgeIsWarm()) {
      ping(env, ctx);
      return { verdict: null, pages, ms: Date.now() - t0, error: 'cold' };
    }
    const type = kindFor(kind, claim);
    const best = bestPages(claim, pages);
    const r = await send(best.map((p, k) => ({ id: String(k), claim: claim.slice(0, 1000), type, page: p.text })));
    if (!r.ok) return { verdict: null, pages: best, ms: Date.now() - t0, error: r.error };
    const byId = new Map(r.results.map((x) => [String(x && x.id), x]));
    const per = best.map((_, k) => (byId.get(String(k)) || {}).verdict);
    const verdict = combine(per);
    const used = best.filter((_, k) => per[k] === verdict);
    return { verdict, pages: used.length ? used : best, ms: Date.now() - t0, config: r.config };
  };

  // Claims that reach the judge within BATCH_MS of each other share one POST (one container, one round trip)
  let queue = null;
  const flush = async (q) => {
    const all = [];
    q.forEach((e, i) => e.items.forEach((it) => all.push({ ...it, id: `${i}.${it.id}` })));
    const r = await judge(env, all.slice(0, MAX_JUDGE_ITEMS), undefined, TEXT_JUDGE_MS - BATCH_MS, { coolOnTimeout: false });
    q.forEach((e, i) => {
      if (!r.ok) e.resolve(r);
      else e.resolve({ ...r, results: r.results.filter((x) => x && String(x.id).startsWith(`${i}.`)).map((x) => ({ ...x, id: String(x.id).slice(String(i).length + 1) })) });
    });
  };
  const send = (items) =>
    new Promise((resolve) => {
      if (!queue) {
        const q = (queue = []);
        setTimeout(() => {
          queue = null;
          flush(q).catch(() => q.forEach((e) => e.resolve({ ok: false, error: 'failed', ms: 0 })));
        }, BATCH_MS);
      }
      queue.push({ items, resolve });
    });

  const report = async (o) => {
    try {
      const pages = o.pages || [];
      console.log(
        JSON.stringify({
          evt: 'gemma_text',
          mode: o.live ? 'owner' : 'shadow',
          claim: await claimHash(o.claim),
          kind: o.kind || null,
          ts: o.ts,
          source: pages.length ? 'fetch' : 'none',
          pages: pages.length,
          bytes: pages.reduce((n, p) => n + (p.bytes || 0), 0),
          gemma: o.verdict ?? null,
          ...(o.error ? { error: o.error } : {}),
          eves: o.eves ?? null,
          agree: o.eves ? o.verdict === o.eves : null,
          would_skip: o.wouldSkip,
          used: o.used,
          gemma_ms: o.ms,
          ms_saved_est: o.msSaved,
          usd_saved_est: o.usdSaved,
        }),
      );
    } catch {
      // logging never breaks a turn
    }
  };

  return {
    mode,
    /** A lane's citations: the first call starts fetching up to 3 pages (in parallel, 2.5 s); later calls are ignored. */
    addSources(citations) {
      if (pagesP || !Array.isArray(citations) || !citations.length) return;
      const urls = pickUrls(citations);
      if (!urls.length) return;
      deadline = Date.now() + PAGE_BUDGET_MS + 100;
      pagesP = Promise.all(
        urls.map(async (c) => {
          const r = await Promise.resolve()
            .then(() => fetcher(c.url, { timeoutMs: PAGE_BUDGET_MS }))
            .catch(() => null);
          if (!r || r.status < 200 || r.status >= 300 || typeof r.text !== 'string') return null;
          const text = htmlToText(r.text);
          return text.length >= PAGE_MIN_CHARS ? { title: c.title, url: c.url, text, bytes: r.bytes || 0 } : null;
        }),
      ).then((xs) => (settledPages = xs.filter(Boolean)));
      wait(pagesP);
    },
    /**
     * One claim's evidence. runEves() is EVES's own checkEvidence for it, started exactly as today unless an owner
     * account's claim was settled by the judge first. Resolves checkEvidence's result shape; never rejects more than
     * runEves itself does.
     */
    async check({ claim, kind, sentence, signal }, runEves) {
      let live = false;
      try {
        live = await ownerP;
      } catch {
        live = false;
      }
      const text = typeof claim === 'string' ? claim.trim() : '';
      if (!text) return runEves();
      const ts = isTimeSensitive(text, sentence);
      const timed = async () => {
        const t0 = Date.now();
        const v = await runEves();
        const ms = Date.now() - t0;
        if (v && v.verdict !== 'unresolved') learn(ms, (v.costUSD || 0) + SEARCH_FEE_EST_USD);
        return { v, ms };
      };
      if (!live || ts) {
        // EVES as today, at the same moment; the judge beside it, logged only
        const evesP = timed();
        const bg = Promise.all([preJudge(text, kind, undefined), evesP.catch(() => null)])
          .then(([g, e]) => {
            const wouldSkip = !ts && SETTLED.has(g.verdict);
            return report({
              live,
              claim: text,
              kind,
              ts,
              ...g,
              eves: e && e.v ? e.v.verdict : null,
              wouldSkip,
              used: false,
              msSaved: wouldSkip && e ? Math.max(0, e.ms - g.ms) : 0,
              usdSaved: wouldSkip && e && e.v ? r4((e.v.costUSD || 0) + SEARCH_FEE_EST_USD) : 0,
            });
          })
          .catch(() => undefined);
        wait(bg);
        return (await evesP).v;
      }
      // owner: the judge first, bounded; EVES as today when it doesn't settle
      let g;
      try {
        g = await preJudge(text, kind, signal);
      } catch {
        g = { verdict: null, pages: [], ms: 0, error: 'failed' };
      }
      if (SETTLED.has(g.verdict) && !(signal && signal.aborted)) {
        wait(report({ live, claim: text, kind, ts, ...g, eves: 'skipped', wouldSkip: true, used: true, msSaved: Math.max(0, avg.ms - g.ms), usdSaved: r4(avg.usd) }));
        return textVerdict(g.verdict, g.pages);
      }
      const e = await timed();
      wait(report({ live, claim: text, kind, ts, ...g, eves: e.v ? e.v.verdict : null, wouldSkip: false, used: false, msSaved: -g.ms, usdSaved: 0 }));
      return e.v;
    },
  };
}
