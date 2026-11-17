// EVES for the Creative Suite (docs/creative-api.md §6), as askeden.com has it: the live site's. It takes the place of
// src/creative/eves.js (main's, which says EVES isn't there) when scripts/deploy-creative-overlay.sh lays the suite over
// the live working copy, which runs hosted EVES (eden/eves.js). Same exports.
//
// askeden.com's own rules, unchanged: EVES runs when askeden.com has at least two models on its keys (eden/chat.js meta
// `eves`), on any plan, held and paid on the account's own allowance like any askeden.com turn (eves.js asks the account
// object for `allow-ai` and `hold-ai`). The app's token isn't a device token, so those two become the token's own
// creative ops (creative/ops.js: the same allowAi and holdAi, and the suite's CREATIVE_TURNS); `get` says no owner (the
// owner-only modes, EVES_STRONG "owner" and the Gemma judge, stay off in the suite); anything else EVES might ask with it
// is refused. Calls without a device (`spend`, `release-ai`) go through as they are.

import { ApiError } from '../accounts/util.js';
import { MAX_BODY, compareLanes, compareModels, creditFactor, hostedConfig, inputEstimate, messageText, parseSend, readBody as chatReadBody, routeSettings, routed, systemPrompt } from '../eden/chat.js';
import { hostedEves } from '../eden/eves.js';
import { hostedFor, narrowFor } from '../eden/providers.js';
import { APPS } from './turn.js';

export const EVES_HERE = true;
export const EVES = { bodyBytes: 256 * 1024, chars: 20_000 };
const EVES_DEVICE = 'creative-scoped'; // never a real device: evesEnv answers every op it marks
const KINDS = { captions: 'captions', transcript: 'transcript' };
const FEW = 'EVES needs at least two models on askeden.com, and it has fewer right now.';

/** askeden.com's own pool for EVES, on its keys only (never anyone's own): what chat.js meta counts. */
const evesPool = (env, request) => hostedFor(env, null, hostedConfig(env), request);

/** GET /api/creative/me's `eves`, by askeden.com's rule (eden/chat.js meta: at least two models). */
export async function evesStatus(env, request) {
  const cfg = await evesPool(env, request);
  return cfg.models.length >= 2 ? { available: true } : { available: false, why: FEW };
}

/** The request checked: { app, kind, text, language }. */
export function parseEves(body) {
  for (const key of Object.keys(body)) if (!['app', 'kind', 'text', 'language'].includes(key)) throw new ApiError(400, 'bad_request', `eves: unknown key ${JSON.stringify(key.slice(0, 40))}`);
  if (!Object.hasOwn(APPS, body.app)) throw new ApiError(400, 'bad_request', `app is one of ${Object.keys(APPS).join(', ')}`);
  if (!Object.hasOwn(KINDS, body.kind)) throw new ApiError(400, 'bad_request', 'kind is captions or transcript');
  if (typeof body.text !== 'string' || !body.text.trim()) throw new ApiError(400, 'bad_request', 'text is needed');
  if (body.text.length > EVES.chars) throw new ApiError(413, 'too_long', `At most ${EVES.chars.toLocaleString('en-US')} characters at a time: check it in parts.`);
  if (body.language !== undefined && (typeof body.language !== 'string' || !/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(body.language))) throw new ApiError(400, 'bad_request', 'language is a BCP 47 tag, like en or es');
  return { app: body.app, kind: body.kind, text: body.text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim(), language: body.language || '' };
}

/** What EVES is asked: check the text, don't rewrite it. */
export function evesPrompt({ app, kind, text, language }) {
  return [
    `Check the names, places, dates, numbers and facts in these ${KINDS[kind]} from a ${APPS[app] === 'Scorsese' ? 'video' : 'project'} in ${APPS[app]}.`,
    'List each one that is wrong or doubtful: quote it, give the correct version, and say why in a few words. If they all check out, say so. Don’t rewrite the text, and don’t comment on style or spelling that isn’t a name.',
    language ? `The text is in ${language}; answer in the same language.` : '',
    `"""\n${text.replace(/"""/g, '"‘"')}\n"""`,
  ].filter(Boolean).join('\n\n');
}

const scoped = (who, extra = {}) => ({ id: who.id, secret: who.secret, ...extra });
const OBJECT = 'https://account'; // the Account object's ops, as accounts/index.js call() addresses them

/** The site's env for EVES on the app's token (above). */
function evesEnv(env, who) {
  const ns = env.ACCOUNTS;
  const forward = (stub, op, body) => stub.fetch(`${OBJECT}/${op}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return {
    ...env,
    ACCOUNTS: {
      idFromName: (name) => ns.idFromName(name),
      get(id) {
        const stub = ns.get(id);
        return {
          async fetch(input, init) {
            const req = input instanceof Request ? input : new Request(input, init);
            if (req.headers.get('x-jarvis-device') !== EVES_DEVICE) return stub.fetch(req);
            const op = new URL(req.url).pathname.slice(1);
            const body = await req.json().catch(() => ({}));
            if (op === 'allow-ai') return forward(stub, 'creative-allow', scoped(who));
            if (op === 'hold-ai') return forward(stub, 'creative-hold', scoped(who, { usd: body.usd }));
            if (op === 'get') return Response.json({ identities: [] });
            return Response.json({ error: 'Not for the Creative Suite.', code: 'forbidden' }, { status: 403 });
          },
        };
      },
    },
  };
}

/** POST /api/creative/eves once the token is checked (api.js): EVES's own events, passed through. */
export async function creativeEves(request, env, ctx, who, readBody, sameApp) {
  const body = parseEves(sameApp(await readBody(EVES.bodyBytes), who));
  const cfg = await evesPool(env, request);
  if (cfg.models.length < 2) throw new ApiError(503, 'not_set_up', FEW);
  const inner = new Request('https://askeden.com/api/chat/eves', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'EdenCreative' },
    body: JSON.stringify({ messages: [{ role: 'user', content: evesPrompt(body) }], mode: 'on', settings: {} }),
    signal: request.signal,
  });
  const helpers = { readBody: chatReadBody, MAX_BODY, compareModels, parseSend, narrowFor, systemPrompt, inputEstimate, messageText, routeSettings, compareLanes, creditFactor, routed };
  return hostedEves(inner, evesEnv(env, who), ctx, { account: who.account, token: { device: EVES_DEVICE, secret: 'scoped' } }, cfg, helpers);
}
