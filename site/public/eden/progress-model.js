// Regular chat's activity thread. Pure: only recorded turn data, no DOM, clock or imports.
const measured = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const text = (s) => String(s || '').trim();
const duration = (ms) => ms < 1000 ? `${Math.round(ms)} ms` : `${Math.round(ms / 1000)}s`;
const cost = (n) => `$${n === 0 ? '0' : n < 0.01 ? n.toFixed(4) : n.toFixed(2)}`;
const SOURCE_LABELS = {
  mail: 'Email', web: 'Web page', search: 'Web search', file: 'File', attachment: 'Attached file', image: 'Image',
  screen: 'Screen text', meeting: 'Meeting transcript', calendar: 'Calendar event', note: 'Note', memory: 'Memory',
  brief: 'Brief', browser: 'Browser page', tool: 'Tool output', reply: 'Earlier reply', context: 'Attached context', recall: 'Earlier chat',
};
function sourceName(s) {
  const kind = SOURCE_LABELS[s && s.kind] || 'Content';
  const t = text(s && s.title);
  if (!t || t.toLowerCase() === kind.toLowerCase()) return kind;
  return t.toLowerCase().startsWith(`${kind.toLowerCase()}:`) ? t : `${kind}: ${t}`;
}
export function provenanceSummary(provenance) {
  if (!provenance || !provenance.tainted) return '';
  const sources = Array.isArray(provenance.sources) ? provenance.sources : [];
  if (!sources.length) return '';
  const kinds = [...new Set(sources.map((s) => SOURCE_LABELS[s && s.kind] || 'content'))];
  const what = sources.length === 1 ? sourceName(sources[0]) : `${sources.length} sources: ${kinds.slice(0, 3).join(', ')}${kinds.length > 3 ? '…' : ''}`;
  return `Read from outside: ${what}`;
}

export function progressView(node, now) {
  if (!node || node.role !== 'assistant' || (node.eves && !node.eves.skipped)) return null;
  const parts = node.parts || [];
  const answer = parts.some((p) => p.type === 'text' && text(p.text));
  const aborted = node.finish === 'aborted';
  const failed = Boolean(node.error);
  const live = Boolean(node.streaming && !aborted && !failed);
  const interrupted = aborted || failed;
  const thinking = Boolean(text(node.thinking) || (live && node.thinkingLive));
  const reasoning = Boolean(live && thinking && (node.thinkingLive || !answer));
  const tools = parts.filter((p) => p.type === 'tool');
  const sources = node.citations || [];
  const rows = [];
  const warnings = [];
  const add = (id, label, status) => rows.push({ id, text: label, status });
  const unfinished = live ? 'active' : 'stopped';
  const route = node.route;
  const vault = Boolean(
    (route && Array.isArray(route.notes) && route.notes.some((n) => /EVES (?:Immutable |Verified )?Vault/i.test(n))) ||
    (node.verification && node.verification.label && /EVES (?:Immutable |Verified )?Vault/i.test(node.verification.label.text || '')),
  );
  if (vault) {
    add('vault', 'Matched in EVES Verified Vault', 'done');
  } else if (route) {
    const name = text(route.modelName || route.model);
    const effort = text(route.effortLabel || (route.effort && `${route.effort} effort`));
    add('route', ['Routed', name, effort].filter(Boolean).join(' · '), 'done');
  }
  const cached = node.usage && measured(node.usage.cachedInputTokens) ? node.usage.cachedInputTokens
    : route && measured(route.cachedInputTokens) ? route.cachedInputTokens : 0;
  if (cached > 0) add('cache', `${cached} cached input tokens reused`, 'done');
  const prov = provenanceSummary(node.provenance);
  if (prov) add('provenance', prov, 'done');
  for (const [i, part] of parts.entries()) {
    if (part.type === 'tool') {
      const name = text(part.name) || 'Tool';
      const input = part.input || {};
      const target = text(input.query || input.url || input.file_path || input.path || input.command || input.pattern);
      const error = part.result && part.result.ok === false;
      const status = part.result ? error ? 'stopped' : 'done' : unfinished;
      add(`tool:${part.id || i}`, `${name}${target ? ` · ${target.slice(0, 160)}` : ''}${error ? ' · Failed' : ''}`, status);
      if (error) warnings.push(`${name} failed${part.result.output ? `: ${text(part.result.output)}` : ''}`);
    } else if (part.type === 'mac') {
      const error = part.state === 'failed';
      add(`mac:${part.id || i}`, text(part.label || part.tool) || 'Mac context', error ? 'stopped' : part.state === 'done' ? 'done' : unfinished);
      if (error) warnings.push(text(part.error) || 'Mac context failed');
    }
  }
  // A requested search is not proof of sources found. Keep it distinct from tool activity.
  const searched = sources.length > 0 || tools.some((p) => p.name === 'WebSearch' && p.result && p.result.ok === true);
  if (node.autoSearched || node.mode === 'search' || sources.length) {
    const searching = live && !answer && !searched;
    add('search', sources.length ? `${sources.length} web source${sources.length === 1 ? '' : 's'} returned`
      : searched ? 'Searched web' : searching ? 'Searching web…' : 'Search · no sources returned',
    searched ? 'done' : searching ? 'active' : interrupted ? 'stopped' : 'skipped');
  }
  if (thinking) {
    const status = reasoning ? 'active' : interrupted && !answer ? 'stopped' : 'done';
    const label = status === 'active' ? 'Reasoning…' : status === 'stopped' ? 'Reasoning stopped' : 'Reasoned';
    add('reasoning', `${label}${measured(node.thinkMs) && node.thinkMs > 0 ? ` · ${duration(node.thinkMs)}` : ''}`, status);
  }
  if (answer) add('answer', interrupted ? 'Reply interrupted' : live ? 'Writing reply…' : 'Answered', interrupted ? 'stopped' : live ? 'active' : 'done');
  if (node.error) warnings.push(text(node.error));
  if (node.finish === 'length') warnings.push('Reply reached the model’s output limit.');
  for (const fallback of node.fallbacks || []) if (text(fallback)) warnings.push(text(fallback));
  if (!rows.length && !live && !interrupted && !warnings.length) return null;
  if (!rows.length && live) add('waiting', 'Waiting for reply…', 'active');
  const active = rows.find((r) => r.status === 'active' && r.id !== 'answer');
  const phase = !live ? 'over' : active && active.id !== 'waiting' ? 'work' : answer ? 'answer' : 'work';
  const title = failed ? 'Reply failed' : aborted ? 'Stopped' : !live ? vault ? 'Verified from EVES Vault' : answer ? 'Answered' : 'Activity ended'
    : active ? active.text : answer ? 'Writing reply…' : 'Waiting for reply…';
  const end = live ? now : node.doneAt;
  const elapsed = measured(node.startedAt) && measured(end) && end >= node.startedAt ? duration(end - node.startedAt) : '';
  const usage = node.usage;
  const actual = usage && measured(usage.costUSD);
  const estimate = route && measured(route.costUSD);
  const meta = actual ? `${cost(usage.costUSD)}${usage.notional ? ' · Subscription: not billed' : live ? ' so far' : ' actual cost'}`
    : estimate ? `Estimated ${cost(route.costUSD)}` : '';
  const trace = [
    route && text(route.rationale) ? `Routing rationale: ${text(route.rationale)}` : '',
    text(node.thinking),
  ].filter(Boolean).join('\n\n');
  return { rows, title, phase, elapsed, meta, warning: warnings.join('\n'), canStop: live, trace };
}
