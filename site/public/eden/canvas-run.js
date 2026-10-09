// Running the canvas's code (canvas-model.js says where each language runs). JavaScript and
// Python run in this browser, in runner.html framed hidden here (an opaque-origin sandbox, its
// own CSP); other languages go to Eden's cloud runner (POST /api/chat/run), which says when it
// isn't set up. Nothing about a run is logged or kept.

import { apiUrl, postJSON } from './api.js';
import { LIMITS, checkRun } from './canvas-model.js';

let frame = null, ready = null, current = null, seq = 0;

function runnerFrame() {
  if (frame && frame.isConnected) return ready;
  frame = document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.setAttribute('aria-hidden', 'true');
  frame.title = 'Code runner';
  frame.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden';
  frame.src = apiUrl('/runner.html');
  ready = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('The runner didn’t load.')), 15000);
    const on = (e) => { if (e.source === frame.contentWindow && e.data && e.data.type === 'ready') { clearTimeout(t); resolve(); } };
    window.addEventListener('message', on);
  });
  document.body.append(frame);
  return ready;
}

window.addEventListener('message', (e) => {
  if (!frame || e.source !== frame.contentWindow || !current) return;
  const d = e.data || {};
  if (d.id !== current.id) return;
  if (d.type === 'started') { current.started = performance.now(); current.on.status(''); }
  else if (d.type === 'status') current.on.status(String(d.text || ''));
  else if (d.type === 'out') current.on.out(d.stream === 'stderr' ? 'stderr' : 'stdout', String(d.text || ''));
  else if (d.type === 'exit') finish(Number(d.code) || 0, d.reason);
});

function finish(code, reason) {
  const r = current;
  if (!r) return;
  current = null;
  clearTimeout(r.backstop);
  r.on.exit({ code, ms: Math.round(performance.now() - (r.started || r.t0)), reason });
}

/**
 * Run code: on = { out(stream, text), status(text), exit({ code, ms, reason }) }.
 * Returns false (after on.exit with why) when the run can't start.
 */
export async function run({ lang, code, stdin }, on) {
  stop();
  const ok = checkRun({ lang, code, stdin });
  if (!ok.ok) { on.out('stderr', `${ok.why}\n`); on.exit({ code: 2, ms: 0, reason: 'refused' }); return false; }
  const id = ++seq;
  current = { id, on, t0: performance.now() };
  if (ok.runner === 'cloud') return cloudRun(id, { lang, code, stdin }, on);
  try { await runnerFrame(); } catch (e) { killFrame(); on.out('stderr', `${e.message}\n`); finish(1); return false; } // drop the frame so the next Run tries a fresh one (a rejected `ready` would be reused)
  if (!current || current.id !== id) return false;
  // a backstop if the runner itself stops answering (its own limit is LIMITS.timeMs after start; Python loads first)
  current.backstop = setTimeout(() => { if (current && current.id === id) { killFrame(); on.out('stderr', 'The runner stopped answering.\n'); finish(124, 'timeout'); } }, LIMITS.timeMs + 60000);
  frame.contentWindow.postMessage({ type: 'run', id, lang: ok.runner, code, stdin: stdin || '', timeMs: LIMITS.timeMs }, '*');
  return true;
}

async function cloudRun(id, body, on) {
  on.status('Running in the cloud…');
  try {
    const r = await postJSON('/api/chat/run', body);
    if (!current || current.id !== id) return false;
    on.status('');
    if (r.stdout) on.out('stdout', r.stdout);
    if (r.stderr) on.out('stderr', r.stderr);
    current.started = performance.now() - (Number(r.ms) || 0);
    finish(Number(r.exitCode) || 0, r.reason);
  } catch (e) {
    if (!current || current.id !== id) return false;
    on.status('');
    on.out('stderr', `${e.message}\n`);
    finish(e.status === 503 ? 0 : 1, e.status === 503 ? 'unavailable' : 'error');
  }
  return true;
}

function killFrame() { if (frame) frame.remove(); frame = null; ready = null; }

/** Stop the run in progress, if any. */
export function stop() {
  if (!current) return false;
  if (frame && frame.contentWindow) frame.contentWindow.postMessage({ type: 'stop' }, '*');
  finish(130, 'stopped');
  return true;
}
export const running = () => Boolean(current);
