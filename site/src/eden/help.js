// askeden.com's Help (askeden repo web/help; ROADMAP "Help Center"):
//
//   /help, /help/<file>, /help/img/<file>   the public Help page and the FAQ with its pictures
//                                           (public/help, copied from web/help by
//                                           scripts/sync-eden.mjs). Signed out too: people who
//                                           can't sign in still get help. Strict CSP.
//   POST /api/help/ask                      Ask Help: answers grounded in the FAQ, signed in only
//
// Ask Help is free to the person and kept apart from everything of theirs: it never touches the
// account's allowance, usage or conversations, and nothing of it is stored (a screenshot goes to
// the model once and is dropped). What caps it, each a Worker var with a default from
// web/help/help-core.js HELP_DEFAULTS:
//   HELP_DAILY_MESSAGES      questions per account a day (30), and four times that per network
//   HELP_DAILY_SCREENSHOTS   screenshots per account a day (5), likewise per network
//   HELP_DAILY_BUDGET_USD    Eden's own spend on Help a day, everyone together ($5); each
//                            question reserves its worst case (max_tokens is small)
//   HELP_MAX_TOKENS          the longest answer (700)
//   HELP_MODEL               the model (claude-haiku-4-5), on ANTHROPIC_API_KEY
// plus EDEN_RATE (`help:<account>`, 20 a minute). The day's counts live in VoiceQuota objects of
// their own (`help-messages`, `help-screenshots`, `help-budget`): that class is a generic daily
// check-and-add (worker.js), so Help needs no new Durable Object or migration. Days are UTC.
//
// A question with no matching FAQ page is answered "I'm not sure" without asking the model.
// The screenshot is untrusted (provenance.ts, bundled in vendor/google.js): the model is told
// so, any text the page read off it is wrapped, and its metadata is stripped again here.

import { limited } from '../accounts/index.js';
import { serviceAiReady, serviceFallback, serviceFetch } from '../accounts/service-ai.js';
import { ApiError } from '../accounts/util.js';
import { currentSession } from './session.js';
import { crossSite, json, page, problem, sameOrigin, withHeaders } from './web.js';
import { createLedger } from './vendor/google.js';
import {
  FAQ,
  HELP_DEFAULTS,
  HELP_FILES,
  HelpRequestError,
  INDEX,
  checkAnswer,
  ground,
  helpSystem,
  notSureReply,
  parseHelpBody,
  stripImageMetadata,
  toBase64,
  worstCaseUSD,
} from './vendor/help.js';
// the French FAQ (web/help/faq.fr.json), when the bundle has it: a namespace read, so an older bundle still builds
import * as helpBundle from './vendor/help.js';

const ANTHROPIC = 'https://api.anthropic.com/v1/messages';

/** The public Help page: its own script and stylesheet, its pictures, nothing else; never framed. */
export const HELP_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const FILES = new Set(HELP_FILES);
const MAX_BODY = 8 * 1024 * 1024; // a 5 MB screenshot as base64, and the rest
const NETWORK_FACTOR = 4; // a household or office shares a network
const DEFAULT_ASK = 'What’s wrong in this screenshot, and how do I fix it?';
const DEFAULT_ASK_FR = 'Qu’est-ce qui ne va pas sur cette capture d’écran, et comment le résoudre\u00a0?';

const positive = (value, fallback) => {
  const n = Number(value);
  return value !== undefined && value !== '' && Number.isFinite(n) && n > 0 ? n : fallback;
};

export function helpConfig(env = {}) {
  return {
    messages: Math.floor(positive(env.HELP_DAILY_MESSAGES, HELP_DEFAULTS.messagesPerDay)),
    screenshots: Math.floor(positive(env.HELP_DAILY_SCREENSHOTS, HELP_DEFAULTS.screenshotsPerDay)),
    budgetUSD: positive(env.HELP_DAILY_BUDGET_USD, HELP_DEFAULTS.budgetUSDPerDay),
    maxTokens: Math.min(2000, Math.floor(positive(env.HELP_MAX_TOKENS, HELP_DEFAULTS.maxTokens))),
    model: String(env.HELP_MODEL || HELP_DEFAULTS.model),
  };
}

// ── the page ──

/** /help and its files, or null for a path that isn't Help's. */
export async function helpPage(request, env, path) {
  if (path !== '/help' && !path.startsWith('/help/')) return null;
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
  const name = path === '/help' ? 'index.html' : path.slice('/help/'.length);
  // who's asking, for the page's Ask Help tab: always 200, so a signed-out visitor's console stays clean
  if (name === 'session.json') {
    const { session } = await currentSession(request, env).catch(() => ({ session: null }));
    return json({ where: session ? 'askeden' : 'signed-out' });
  }
  if (!FILES.has(name)) return null; // back home (worker.js)
  // the folder's own address for its index (the assets layer sends /help/index.html on to /help/)
  const asset = await env.ASSETS.fetch(new Request(new URL(name === 'index.html' ? '/help/' : `/help/${name}`, request.url), request));
  if (name === 'index.html') return page(asset, HELP_CSP, { cache: 'public, max-age=0, must-revalidate' });
  return withHeaders(asset, {
    'cache-control': name.startsWith('img/') ? 'public, max-age=86400' : 'public, no-cache',
    'x-content-type-options': 'nosniff',
    'cross-origin-resource-policy': 'same-origin',
  });
}

// ── Ask Help ──

export async function helpApi(request, env, ctx, path) {
  try {
    if (path !== '/api/help/ask') throw new ApiError(404, 'not_found', 'No such thing here.');
    if (request.method !== 'POST') throw new ApiError(405, 'bad_request', 'POST a JSON body to /api/help/ask', { allow: 'POST' });
    if (crossSite(request) || !sameOrigin(request)) throw new ApiError(403, 'forbidden', 'Only askeden.com’s own pages may do that.');
    if (!/^application\/json\b/i.test(request.headers.get('content-type') || '')) throw new ApiError(415, 'bad_request', 'Send JSON (content-type: application/json).');
    if (!env.ACCOUNTS) throw new ApiError(503, 'not_set_up', 'Help’s chat isn’t set up here yet. The Help pages above still work.');
    const { session } = await currentSession(request, env);
    if (!session) throw new ApiError(401, 'signed_out', 'Sign in to ask Help. The Help pages work without signing in.');
    await limited(env, 'EDEN_RATE', `help:${session.account}`);
    return json(await ask(request, env, session));
  } catch (error) {
    if (error instanceof ApiError) return problem(error.status, error.message, error.code, error.headers);
    if (error instanceof HelpRequestError) return problem(error.status, error.message, error.code);
    console.error('help failed', error && error.stack);
    return problem(500, 'Help had a problem on the server. Try again, or write to support@askeden.com.', 'server');
  }
}

async function readBody(request) {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY) throw new ApiError(413, 'too_big', 'That screenshot is too big (5 MB at most). Crop it, or send a smaller one.');
  const text = await request.text();
  if (text.length > MAX_BODY) throw new ApiError(413, 'too_big', 'That screenshot is too big (5 MB at most). Crop it, or send a smaller one.');
  try {
    return JSON.parse(text || '{}');
  } catch {
    throw new ApiError(400, 'bad_request', 'Send a JSON object.');
  }
}

/** Takes `n` from a daily VoiceQuota object (worker.js): { ok, left }. Without the binding (tests of other parts), unlimited. */
async function take(env, object, key, network, n, perKey, everyone = 1e15) {
  if (!env.VOICE_QUOTA) return { ok: true, left: null };
  const stub = env.VOICE_QUOTA.get(env.VOICE_QUOTA.idFromName(object));
  const answer = await stub.fetch('https://quota/take', {
    method: 'POST',
    body: JSON.stringify({ install: key, network, chars: n, limits: { install: perKey, network: perKey * NETWORK_FACTOR, everyone } }),
  });
  const v = await answer.json();
  return { ok: Boolean(v.ok), which: v.which, left: typeof v.left === 'number' ? v.left : null };
}

const resetsAt = () => ({ 'retry-after': String(Math.max(60, Math.ceil((Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`) + 86_400_000 - Date.now()) / 1000))) });

async function ask(request, env, session) {
  const cfg = helpConfig(env);
  const req = parseHelpBody(await readBody(request));
  const network = `ip:${request.headers.get('cf-connecting-ip') || 'unknown'}`;
  const account = `a:${session.account}`;

  // the day's questions and screenshots, per account (and per network, so new accounts don't multiply them)
  const asked = await take(env, 'help-messages', account, network, 1, cfg.messages);
  if (!asked.ok) throw new ApiError(429, 'help_limit', `That’s today’s ${cfg.messages} Help questions. They start again at midnight UTC. The Help pages and Contact support still work.`, resetsAt());
  let shotsLeft = null;
  if (req.image) {
    const shot = await take(env, 'help-screenshots', account, network, 1, cfg.screenshots);
    if (!shot.ok) throw new ApiError(429, 'help_screenshots', `That’s today’s ${cfg.screenshots} screenshots for Help. Describe the problem in words instead, or try again tomorrow.`, resetsAt());
    shotsLeft = shot.left;
  }
  const left = { messages: asked.left, screenshots: shotsLeft };

  // French pages for a French page (the client sends lang: 'fr'); English otherwise
  const fr = req.lang === 'fr' && helpBundle.FAQ_FR && helpBundle.INDEX_FR;
  const faq = fr ? helpBundle.FAQ_FR : FAQ;
  const lang = fr ? 'fr' : 'en';
  const g = ground(faq, fr ? helpBundle.INDEX_FR : INDEX, { question: req.question, history: req.history, imageText: req.imageText, image: Boolean(req.image) });
  const pages = g.entries.map((e) => ({ id: e.id, q: e.q }));
  if (!g.sure) return { ...notSureReply(faq, g.results), pages, model: null, left };

  // the screenshot and the text read off it are untrusted (provenance): marked, wrapped, never instructions
  const ledger = createLedger();
  if (req.question) ledger.trusted(req.question);
  const content = [];
  if (req.image) {
    ledger.mark('image', 'Screenshot attached to Help');
    const clean = stripImageMetadata(req.image.bytes);
    content.push({ type: 'image', source: { type: 'base64', media_type: req.image.mime, data: toBase64(clean.bytes) } });
  }
  if (req.imageText) content.push({ type: 'text', text: ledger.untrusted('image', req.imageText, { title: 'Text read from the screenshot' }) });
  content.push({ type: 'text', text: req.question || (fr ? DEFAULT_ASK_FR : DEFAULT_ASK) });
  const system = [helpSystem({ entries: g.entries, catalog: g.catalog, surface: 'web', lang }), ledger.notice()].filter(Boolean).join('\n\n');
  const messages = [...req.history.map((m) => ({ role: m.role, content: m.content })), { role: 'user', content }];

  // Eden's own budget for Help (not the person's allowance): the worst case, reserved up front
  const worst = worstCaseUSD({ model: cfg.model, system, question: req.question + req.imageText, history: req.history, images: req.image ? 1 : 0, maxTokens: cfg.maxTokens });
  const budget = await take(env, 'help-budget', 'all', 'all', Math.ceil(worst * 1e6), 1e15, Math.round(cfg.budgetUSD * 1e6));
  if (!budget.ok) throw new ApiError(503, 'help_busy', 'Help’s chat is resting for today. The Help pages still work, and Contact support reaches a person.', resetsAt());
  if (!serviceAiReady(env)) throw new ApiError(503, 'not_set_up', 'Help’s chat isn’t set up here yet. The Help pages above still work.');

  // No Anthropic key: the service's Gemini or OpenAI answers instead (service-ai.js).
  const fallback = serviceFallback(env);
  const reply = await callModel(env, request, { model: fallback ? fallback.model : cfg.model, max_tokens: cfg.maxTokens, system, messages });
  const checked = checkAnswer(reply.text, g.allowed, { lang });
  return { ...checked, pages, model: cfg.model, left };
}

/**
 * The model's answer (not streamed: Help answers are short). HELP_MODEL_BASE points it at a fake
 * Anthropic for local QA, only on a local host and to a loopback http address.
 */
async function callModel(env, request, payload) {
  let upstream;
  try {
    upstream = await serviceFetch(env, payload, { signal: request.signal, url: modelUrl(env, request) });
  } catch {
    throw new ApiError(502, 'upstream', 'Help couldn’t reach its model just now. Try again in a moment.');
  }
  if (upstream.status === 429 || upstream.status === 529) throw new ApiError(503, 'busy', 'Help is busy right now. Try again in a moment.');
  if (!upstream.ok) throw new ApiError(502, 'upstream', 'Help couldn’t answer just now. Try again in a moment.');
  const body = await upstream.json().catch(() => ({}));
  const text = (Array.isArray(body.content) ? body.content : []).filter((b) => b && b.type === 'text').map((b) => b.text).join('');
  if (body.stop_reason === 'refusal') return { text: '' };
  return { text };
}

export function modelUrl(env, request) {
  const base = String(env.HELP_MODEL_BASE || '').replace(/\/+$/, '');
  if (!base) return ANTHROPIC;
  const local = (h) => h === 'localhost' || h.endsWith('.localhost') || h === '127.0.0.1' || h === '[::1]';
  try {
    const target = new URL(base);
    if (local(new URL(request.url).hostname) && local(target.hostname) && target.protocol === 'http:') return `${base}/v1/messages`;
  } catch {
    // below
  }
  return ANTHROPIC;
}
