// Mock mode (?mock=1) for EVES (eves.js, docs/verify/README.md "EVES API"): POST /api/chat/eves/estimate, POST /api/chat/eves
// (the stream: `eves`, `eves_stage`, lane-tagged work, `checks`, `verdict`, the final answer as lane "final", `verification`,
// `end`) and POST /api/chat/eves/stop, answered in the browser with pretend models, so the switch, the chip's price, the
// progress, the badge and its detail can be tried without a server. The mock does not search or judge anything: three lanes
// answer, two give one year and the third another, the pretend judge picks lane 0, and the pretend evidence backs the two.
// URL switches: none; a question with "fail" in it fails the third lane halfway (a partial failure, shown inline), as in
// compare's mock. Nothing here is stored.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

const runs = new Map(); // id → { lanes, stopped: Set<number | 'judge'> }
const RISKY = /\b(dose|dosage|legal|lawsuit|tax|taxes|invest\w*|how many|what year|which year|percent\w*|is (?:it|this|that) true|verify|statistics?)\b/i;

const costOf = (l) => Math.round(l.costUSD * 1e6) / 1e6;
const laneInfo = (l, i) => ({ lane: i, model: l.model, modelName: l.modelName, provider: l.provider, effort: l.effort, effortLabel: l.effortLabel || `${l.effort} effort`, via: l.via, costUSD: costOf(l), quality: l.quality, latencyS: l.latencyS });
const lastUser = (body) => String(([...(body.messages || [])].reverse().find((m) => m.role === 'user') || {}).content || body.prompt || '');

/** What the three pretend models say: two agree on the year, the third differs. */
function laneText(i, q) {
  const topic = q.replace(/\s+/g, ' ').trim().slice(0, 70);
  const year = i === 2 ? '1887' : '1889';
  return `For “${topic}”: the short answer is yes, and it dates from **${year}**.\n\nMost sources describe it the same way; the year is the detail worth checking.`;
}
const FINAL = (q) => `For “${q.replace(/\s+/g, ' ').trim().slice(0, 70)}”: the short answer is yes, and it dates from **1889**.\n\nTwo of the three models gave 1889 and the web evidence agrees; the third said 1887, which Eden struck.`;

const piece = (text, size = 18) => {
  const out = [];
  let cur = '';
  for (const w of text.split(/(\s+)/)) { cur += w; if (cur.length >= size) { out.push(cur); cur = ''; } }
  if (cur) out.push(cur);
  return out;
};

/**
 * `plan(body)` is mock.js's compareLanesMock: { lanes, synthesis } in the compare shapes (the synthesis slot is the judge here).
 * → a Response, or null when the path is not EVES's.
 */
export function evesMock(p, method, body, signal, plan) {
  if (!p.startsWith('/api/chat/eves') || method !== 'POST') return null;
  if (p === '/api/chat/eves/estimate') {
    const prompt = String(body.prompt || '').trim();
    if (!prompt) return json({ error: 'Type a prompt to estimate.' }, 400);
    const { lanes, synthesis } = plan({ prompt, settings: body.settings });
    const total = lanes.reduce((n, l) => n + l.costUSD, 0) + synthesis.costUSD + 0.01;
    const risky = RISKY.test(prompt);
    return json({
      risk: { level: risky ? 'elevated' : 'low', reasons: risky ? ['exact_number'] : [], eves: risky ? 'auto' : 'off' },
      lanes: lanes.map((l, i) => laneInfo(l, i)),
      judge: laneInfo(synthesis, 'judge'),
      evidence: { maxCalls: 2 },
      totalUSD: Math.round(total * 1e6) / 1e6,
      typicalUSD: Math.round((total - synthesis.costUSD - 0.01) * 1e6) / 1e6,
      latencyS: 14,
      independence: new Set(lanes.map((l) => l.provider)).size >= 3 ? 'full' : new Set(lanes.map((l) => l.provider)).size === 2 ? 'partial' : 'none',
      independenceNote: null,
      notes: ['Mock: no model is called.'],
    });
  }
  if (p === '/api/chat/eves/stop') {
    const run = runs.get(body.id);
    const lane = body.lane === 'judge' ? 'judge' : Number(body.lane);
    if (!run || !(lane === 'judge' || (lane >= 0 && lane < run.lanes))) return json({ error: 'That EVES run has finished.' }, 404);
    run.stopped.add(lane);
    return json({ ok: true });
  }
  if (p !== '/api/chat/eves') return json({ error: 'Not found' }, 404);

  const q = lastUser(body);
  if (!q.trim()) return json({ error: 'messages must end with a user message.' }, 400);
  const { lanes, synthesis } = plan({ prompt: q, settings: body.settings, models: Array.isArray(body.models) && body.models.length ? body.models.slice(0, 3) : undefined });
  const id = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');
  const run = { lanes: lanes.length, stopped: new Set() };
  runs.set(id, run);
  const fail = /fail/i.test(q);
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let aborted = false;
      const onAbort = () => { aborted = true; runs.delete(id); try { controller.error(new DOMException('The user aborted a request.', 'AbortError')); } catch { /* closed */ } };
      if (signal) { if (signal.aborted) return onAbort(); signal.addEventListener('abort', onAbort, { once: true }); }
      const put = (type, data) => { if (!aborted) controller.enqueue(enc.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)); };
      const wait = async (ms) => { await sleep(ms); return aborted; };
      if (await wait(200)) return;
      put('eves', {
        id, mode: body.mode === 'auto' ? 'auto' : 'on', lanes: lanes.map((l, i) => laneInfo(l, i)), judge: laneInfo(synthesis, 'judge'),
        independence: new Set(lanes.map((l) => l.provider)).size >= 3 ? 'full' : 'partial', independenceNote: null,
        estimate: { totalUSD: lanes.reduce((n, l) => n + l.costUSD, 0) + synthesis.costUSD + 0.01, typicalUSD: lanes.reduce((n, l) => n + l.costUSD, 0), latencyS: 14 }, privacy: false, notes: ['Mock: no model is called.'],
      });
      put('eves_stage', { stage: 'answering' });

      // the three lanes, each at its own pace; a stopped lane ends "aborted", a failing one errors halfway
      const results = lanes.map(() => ({ text: '', failed: false }));
      await Promise.all(lanes.map(async (l, i) => {
        await sleep(150 + i * 250);
        put('thinking', { lane: i, text: '' });
        const parts = piece(laneText(i, q));
        for (let k = 0; k < parts.length; k++) {
          await sleep(30 + i * 12);
          if (aborted) return;
          if (run.stopped.has(i)) { put('done', { lane: i, finish: 'aborted' }); return; }
          if (fail && i === 2 && k > parts.length / 2) { put('error', { lane: i, message: `${l.modelName} failed: the provider returned 503 (overloaded).` }); results[i].failed = true; return; }
          results[i].text += parts[k];
          put('text', { lane: i, text: parts[k] });
        }
        put('usage', { lane: i, inputTokens: Math.round(q.length / 4 + 40), outputTokens: Math.round(results[i].text.length / 4), reasoningTokens: 0, costUSD: costOf(l), notional: l.via === 'claude-cli' });
        put('done', { lane: i, finish: 'stop' });
      }));
      if (aborted) return;
      const usable = results.map((r, i) => (r.text && !r.failed && !run.stopped.has(i) ? i : -1)).filter((i) => i >= 0);
      if (usable.length < 2) { // nothing to compare: the lone answer, unchecked
        put('verdict', { winner: usable[0] ?? null, agreement: 'single', claims: [], corrections: [], skippedJudge: true, summary: 'Fewer than two models answered, so there was nothing to compare.', judgeCostUSD: 0, totalCostUSD: 0 });
        for (const part of piece(results[usable[0]]?.text || 'No model answered.')) { put('text', { lane: 'final', text: part }); if (await wait(25)) return; }
        put('done', { lane: 'final', finish: 'stop' });
        put('verification', { label: { kind: 'model_memory', text: 'Unverified: from the model’s memory', detail: 'Only one model answered, so EVES could not compare answers.', severity: 'info' }, findings: [] });
        put('end', {});
        runs.delete(id);
        if (!aborted) controller.close();
        return;
      }

      put('eves_stage', { stage: 'checking' });
      if (await wait(300)) return;
      put('checks', { findings: [{ check: 'number', status: 'pass', subject: '1889', detail: 'The number appears in two answers.' }] });
      put('eves_stage', { stage: 'judging' });
      if (await wait(500)) return;
      const judgeStopped = run.stopped.has('judge');
      const agree = usable.filter((i) => i !== 2);
      if (!judgeStopped) {
        put('eves_stage', { stage: 'evidence', detail: 'Checking the year on the web' });
        if (await wait(600)) return;
      }
      put('verdict', {
        winner: 0,
        agreement: 'majority',
        claims: [
          { id: 'c1', text: 'The answer is yes.', by: usable, against: [], status: 'agreed', verdict: 'supported' },
          { id: 'c2', text: 'It dates from 1889.', by: agree, against: usable.includes(2) ? [2] : [], status: usable.includes(2) ? 'disputed' : 'agreed', verdict: judgeStopped ? 'unresolved' : 'supported', ...(judgeStopped ? {} : { evidence: { summary: 'Mock evidence: reference pages give 1889.', sources: [{ title: 'Example encyclopedia', url: 'https://example.com/mock-evidence' }] } }) },
          ...(usable.includes(2) ? [{ id: 'c3', text: 'It dates from 1887.', by: [2], against: agree, status: 'unique', verdict: judgeStopped ? 'unresolved' : 'contradicted' }] : []),
        ],
        corrections: usable.includes(2) && !judgeStopped ? [{ claimId: 'c3', action: 'strike', replacement: '', reason: 'The web evidence gives 1889.' }] : [],
        skippedJudge: false,
        summary: judgeStopped ? 'The judge was stopped, so the disputed year is not settled.' : 'Two of three models gave 1889 and the evidence agrees.',
        judgeCostUSD: synthesis.costUSD,
        totalCostUSD: lanes.reduce((n, l) => n + l.costUSD, 0) + synthesis.costUSD + 0.01,
        notes: ['Mock: nothing was searched.'],
      });
      put('eves_stage', { stage: 'finalizing' });
      for (const part of piece(FINAL(q), 16)) {
        if (await wait(30)) return;
        put('text', { lane: 'final', text: part });
      }
      put('usage', { lane: 'final', inputTokens: 900, outputTokens: 70, reasoningTokens: 0, costUSD: synthesis.costUSD + 0.01, notional: false });
      put('done', { lane: 'final', finish: 'stop' });
      put('verification', {
        label: judgeStopped
          ? { kind: 'eves_disputed', text: 'Models disagreed', detail: 'The judge was stopped, so the disputed year was not settled.', severity: 'warn' }
          : { kind: 'eves_verified', text: `Checked by ${usable.length} models`, detail: 'Two models gave the same year and a web check agreed; one different year was struck.', severity: 'ok' },
        findings: [],
        added: { costUSD: synthesis.costUSD + 0.01, latencyMs: 2100, calls: 3 },
      });
      put('end', {});
      runs.delete(id);
      if (!aborted) controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
