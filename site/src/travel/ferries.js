// Eden Travel's ferries: Ferryhopper's public MCP server (Streamable HTTP, JSON-RPC 2.0; it answers
// in text/event-stream with `data:` lines). No key. Off unless EDEN_FERRIES === "1".
//
// What the server offered on 2026-10-27 (initialize → tools/list, protocol 2025-06-18; it sent no
// mcp-session-id, but we pass one back if it ever does):
//   get_ports {}                                    → { ports: [{ name, countryName, code }] }
//   get_direct_connections_for_ports { portLocation } → { departurePort, connectedDestinations: { ports } }
//   get_disruptions { tripDate, country }           → { disruptions: [...] }
//   search_ferry_trips { legs: [{ departureLocation, arrivalLocation, departureDate }] (1–5) }
//     → { legs: [{ departurePort, arrivalPort, departureDate, options: [{ id, segments: [...] }] }] }
//   search_trips { departureLocation, arrivalLocation, date }  (marked deprecated by Ferryhopper)
//     → { foundDirectItinerariesForTrip: [{ segments, hasVehicles, hasPets, hasETicket, deepLink }] }
//   trip_details { tripId }                         → vessel, amenities, priced accommodation tiers
// Locations are names ("Piraeus"), not port codes. Prices are accommodation tiers in
// `expectedPrice.totalPriceInCents`, for one passenger (the deep links say passengers=1); the
// currency isn't stated anywhere in the output, so EUR is an assumption (Ferryhopper's default).
//
// Booking: the server calls itself one "for searching ferry trips and creating bookings", but no
// booking tool was listed on 2026-10-27. None is wired here. If one appears it would need passenger
// names (and likely contact details and payment), so it belongs behind an explicit confirm like
// rail.js's, after a review. Until then booking is Ferryhopper's own site, via the deepLink that
// search_trips returns (search_ferry_trips returns none, so we ask both and match).
//
// Everything the tools return is data: we keep only the fields above, as short plain strings,
// and never act on any text in it. Nothing is cached.

import { DATE, GroundError, journeyOption, text } from './ground.js';

export const FERRYHOPPER_MCP = 'https://mcp.ferryhopper.com/mcp';
const PROTOCOL = '2025-06-18';
const TIMEOUT = 10_000;
const SOURCE = 'Ferryhopper (MCP)';
const CURRENCY = 'EUR'; // assumed: the tool output carries no currency

/** The JSON-RPC messages in a text/event-stream body: every `data:` payload that parses. */
export function sseMessages(body) {
  const out = [];
  for (const event of String(body || '').split(/\r?\n\r?\n/)) {
    const data = event.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
    if (!data) continue;
    try { out.push(JSON.parse(data)); } catch { /* a keep-alive or a broken line: skip it */ }
  }
  return out;
}

/** A small MCP client: initialize (once per client), tools/list, tools/call. */
export function mcpClient(url, { fetch: fetcher = globalThis.fetch, name = 'Ferryhopper' } = {}) {
  let session = null; // the mcp-session-id, if the server hands one out
  let ready = null;
  let nextId = 1;
  const post = async (message) => {
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    if (message.method !== 'initialize') headers['mcp-protocol-version'] = PROTOCOL;
    if (session) headers['mcp-session-id'] = session;
    let res;
    try {
      res = await fetcher(url, { method: 'POST', headers, body: JSON.stringify(message), signal: AbortSignal.timeout(TIMEOUT) });
    } catch {
      throw new GroundError('unavailable', `${name} did not answer in time.`);
    }
    if (res.status === 429) throw new GroundError('rate_limited', `${name} is over its rate limit for now.`);
    if (res.status === 404 && session) throw new GroundError('unavailable', `${name} ended the session.`);
    if (!res.ok) throw new GroundError('unavailable', `${name} answered ${res.status}.`);
    const sid = res.headers && res.headers.get && res.headers.get('mcp-session-id');
    if (sid && /^[\x21-\x7e]{1,200}$/.test(sid)) session = sid;
    if (!('id' in message)) return null; // a notification: 202, no body
    const type = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
    const body = await res.text();
    let messages;
    if (type.includes('text/event-stream')) messages = sseMessages(body);
    else {
      try { messages = [JSON.parse(body)]; } catch { messages = []; }
    }
    const reply = messages.flat().find((m) => m && m.id === message.id);
    if (!reply) throw new GroundError('unavailable', `${name} sent no answer.`);
    if (reply.error) {
      // -32602 is JSON-RPC's "invalid params": our request, not their outage
      throw new GroundError(reply.error.code === -32602 ? 'bad_request' : 'unavailable', `${name}: ${text(reply.error.message) || 'error'}.`);
    }
    return reply.result;
  };
  const request = (method, params) => post({ jsonrpc: '2.0', id: nextId++, method, ...(params ? { params } : {}) });
  const init = () => {
    ready = ready || (async () => {
      await request('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'eden-travel', version: '1.0' } });
      await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    })().catch((e) => { ready = null; throw e; });
    return ready;
  };
  return {
    async listTools() {
      await init();
      const out = await request('tools/list');
      return Array.isArray(out && out.tools) ? out.tools : [];
    },
    /** A tool's structuredContent (the tool's JSON); a tool-level error throws. */
    async callTool(tool, args = {}) {
      await init();
      const out = await request('tools/call', { name: tool, arguments: args });
      if (!out || out.isError) {
        const said = out && Array.isArray(out.content) ? out.content.map((c) => (c && c.type === 'text' ? c.text : '')).join(' ') : '';
        throw new GroundError(/not found|no (ports?|trips?|results?)/i.test(said) ? 'not_found' : 'bad_request', `${name}: ${text(said) || 'the tool failed'}.`);
      }
      if (!out.structuredContent || typeof out.structuredContent !== 'object') throw new GroundError('unavailable', `${name} sent no data.`);
      return out.structuredContent;
    },
  };
}

const plain = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

// Only ever a link onto Ferryhopper's own site.
export function safeFerryhopperUrl(u, adults = 1) {
  try {
    const url = new URL(String(u));
    if (url.protocol !== 'https:' || !(url.hostname === 'ferryhopper.com' || url.hostname.endsWith('.ferryhopper.com'))) return null;
    // the link is priced for passengers=1; carry the party size when the link has that parameter
    if (url.searchParams.has('passengers') && adults > 1) url.searchParams.set('passengers', String(adults));
    return url.toString();
  } catch {
    return null;
  }
}

const cheapestCents = (seg) => {
  const prices = (Array.isArray(seg.accommodations) ? seg.accommodations : []).map((a) => a && a.expectedPrice && a.expectedPrice.totalPriceInCents).filter((c) => Number.isFinite(c) && c >= 0);
  return prices.length ? Math.min(...prices) : null;
};

/** One search_ferry_trips option → a journey option (price: the cheapest tier on each segment, × adults). */
export function ferryOption(opt, { adults = 1, bookUrl = null, checkedAt }) {
  const segs = Array.isArray(opt && opt.segments) ? opt.segments.filter((s) => s && typeof s === 'object') : [];
  if (!segs.length) return null;
  const first = segs[0];
  const last = segs[segs.length - 1];
  const cents = segs.map(cheapestCents);
  const operators = [...new Set(segs.map((s) => text((s.marketingCompany && s.marketingCompany.name) || (s.ownerCompany && s.ownerCompany.name))).filter(Boolean))];
  return journeyOption({
    mode: 'ferry',
    provider: 'ferryhopper',
    id: opt.id,
    from: { name: first.departurePort && first.departurePort.name, code: first.departurePort && first.departurePort.code },
    to: { name: last.arrivalPort && last.arrivalPort.name, code: last.arrivalPort && last.arrivalPort.code },
    depart: first.departureDateTime,
    arrive: last.arrivalDateTime,
    duration_min: null,
    operator: operators.join(' + ') || null,
    price: cents.every((c) => c !== null) ? { amount: (cents.reduce((a, b) => a + b, 0) * adults) / 100, currency: CURRENCY } : null,
    price_kind: 'indicative',
    book_url: bookUrl,
    vessel: text(first.vessel && first.vessel.name),
    legs: segs.length,
    source: SOURCE,
    checked_at: checkedAt,
  });
}

// search_trips' itineraries keyed by first departure time + vessel, to find each option's deep link.
const linkKey = (seg) => `${seg && seg.departureDateTime}|${plain(seg && seg.vessel && seg.vessel.name)}`;

/** Ferries, or null when EDEN_FERRIES isn't "1". */
export function ferriesFor(env = {}, { fetch: fetcher = globalThis.fetch, now = () => Date.now(), url = FERRYHOPPER_MCP } = {}) {
  if (env.EDEN_FERRIES !== '1') return null;
  const stamp = () => new Date(now()).toISOString();
  const client = () => mcpClient(url, { fetch: fetcher }); // a fresh session per lookup: nothing kept
  return {
    mode: 'ferry',
    /** Ports whose name, country or code matches: [{ name, code, country, source, checked_at }]. */
    async ports(query) {
      const q = plain(query).trim();
      if (q.length < 2 || q.length > 100) throw new GroundError('bad_request', 'Give a port or place name.');
      const out = await client().callTool('get_ports', {});
      const at = stamp();
      return (Array.isArray(out.ports) ? out.ports : [])
        .filter((p) => p && [p.name, p.countryName, p.code].some((v) => plain(v).includes(q)))
        .slice(0, 20)
        .map((p) => ({ name: text(p.name), code: text(p.code, 40), country: text(p.countryName), source: SOURCE, checked_at: at }));
    },
    /** One-way sailings on a day: journey options, indicative prices. */
    async search({ from, to, date, adults = 1 } = {}) {
      const a = Number(adults);
      if (!text(from) || !text(to) || String(from).length > 100 || String(to).length > 100) throw new GroundError('bad_request', 'from and to are port or place names.');
      if (!DATE.test(String(date || ''))) throw new GroundError('bad_request', 'date must be YYYY-MM-DD.');
      if (!Number.isInteger(a) || a < 1 || a > 9) throw new GroundError('bad_request', 'adults must be 1 to 9.');
      const mcp = client();
      const out = await mcp.callTool('search_ferry_trips', { legs: [{ departureLocation: text(from, 100), arrivalLocation: text(to, 100), departureDate: date }] });
      const leg = Array.isArray(out.legs) ? out.legs[0] : null;
      const options = leg && Array.isArray(leg.options) ? leg.options : [];
      // the deep links come only from the older tool; a miss there leaves book_url null, not the search failed
      const links = new Map();
      if (options.length) {
        try {
          const old = await mcp.callTool('search_trips', { departureLocation: text(from, 100), arrivalLocation: text(to, 100), date });
          for (const it of Array.isArray(old.foundDirectItinerariesForTrip) ? old.foundDirectItinerariesForTrip : []) {
            const link = it && safeFerryhopperUrl(it.deepLink, a);
            if (link && Array.isArray(it.segments) && it.segments[0]) links.set(linkKey(it.segments[0]), link);
          }
        } catch { /* no links this time */ }
      }
      const at = stamp();
      return options.slice(0, 30).map((o) => ferryOption(o, { adults: a, bookUrl: links.get(linkKey(o && o.segments && o.segments[0])) || null, checkedAt: at })).filter(Boolean);
    },
  };
}
