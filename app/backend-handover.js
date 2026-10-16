// What an Eden app does when its data is already owned by a running backend (main.js
// openOnBackend, and the exit-75 path in restartBackend). Only one backend may own the data
// folder (server.serve's lock), which is right; an app that finds it owned opens on that
// backend instead of refusing. The rules, all here so they're tested without an app:
//
// - No live record (backend-share.js discover: none, its process gone, or not answering
//   after its start): this app starts its own.
// - A live record with this app's PROTOCOL: open the window on it (?app=<socketApp> on the
//   socket, so server.APPS / hub.window_joined count it).
//   Profiles: a "code" backend (Eden Code or Ask Eden started it: no microphone, none of the
//   owner's personal sources) serves Eden Code at once; an Eden Secretary or Daredevil
//   window joining it upgrades it to "full" in place (hub.window_joined: voice, briefings,
//   personal loops), with no restart. "full" serves every app. So no app ever needs to
//   restart the engine for its profile; a full backend is never taken down to code.
// - Another PROTOCOL (an older backend, one from before backend.json was the backend's own,
//   or a newer one): the owner chooses, "Use the running one" or "Restart Eden's engine with
//   this version". Restarting asks the old one to stop gently through its own way of stopping
//   (stopPlan / stopOwner below), waits until it has, then starts this app's.
// - The lock is held and nothing usable says by whom (exit 75): the window names who holds it
//   (the app among the holder's parents, or a terminal's `jarvis serve`) and offers one click
//   that stops it gently and goes on: never "find the terminal yourself".
//
// Stopping is never a blind kill: a backend that speaks this PROTOCOL is asked over its own
// /share/shutdown (with its token; it ends with 76, HANDED_OVER, and its app then opens on the
// new one instead of restarting it). An older one's app is asked to quit (SIGTERM to an
// Electron app is its own Quit: before-quit runs and it stops its engine as it always does);
// a terminal's `jarvis serve` gets the SIGTERM its Ctrl-C would. Each only once the process
// was checked to be what it's said to be (describeHolder), and only on the owner's click.
'use strict';

const path = require('path');
const { execFileSync } = require('child_process');
const share = require('./backend-share');

const HANDED_OVER = 76; // share_record.HANDED_OVER: the backend stopped for a newer one
const STOP_WAIT = 30_000; // how long a gentle stop is waited for

/** What to do with what discover() found: { action: 'start' } | { action: 'connect',
 * upgrade } (upgrade: a code backend that this app's window will wake to full, in place) |
 * { action: 'ask', reason: 'older' | 'newer', record }. me: { protocol, profile }. */
function decide(found, me) {
  if (!found) return { action: 'start' };
  const theirs = Number(found.protocol) || 0;
  const mine = Number(me.protocol) || share.PROTOCOL;
  if (theirs !== mine) return { action: 'ask', reason: theirs < mine ? 'older' : 'newer', record: found };
  return { action: 'connect', upgrade: found.profile === 'code' && me.profile === 'full' };
}

/** The question for 'ask': the native dialog's options (main.js shows it). Button 0 opens on
 * the running one (the default, and what Escape does), 1 restarts it with this version. */
function choiceDialog(found, reason, me) {
  const owner = share.appName(found.app);
  const theirs = found.version ? `version ${found.version}` : 'an older version';
  const legacy = !(Number(found.protocol) > 0);
  const message = reason === 'newer'
    ? `${owner} is running a newer version of Eden's engine than ${me.name}.`
    : `${owner} is running ${theirs} of Eden's engine, older than ${me.name}'s.`;
  const detail = [
    reason === 'newer'
      ? `${me.name} may not work fully on it. Updating ${me.name} is the better fix.`
      : `${me.name} may not work fully on it.`,
    legacy && found.launcher
      ? `Restarting it quits ${owner} first (that version can't hand its engine over), then starts this version for both.`
      : 'Restarting it stops the running engine gently, then starts this version; any app on it reconnects.',
  ].join(' ');
  return {
    type: 'question',
    message,
    detail,
    buttons: ['Use the running one', "Restart Eden's engine with this version"],
    defaultId: 0,
    cancelId: 0,
  };
}

/** One process as ps tells it: { ppid, command }, or null when it's gone or not ours. */
function psOf(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  try {
    const out = execFileSync('/bin/ps', ['-o', 'ppid=,command=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 }).trim();
    const m = /^(\d+)\s+(.*)$/s.exec(out);
    return m ? { ppid: Number(m[1]), command: m[2] } : null;
  } catch {
    return null;
  }
}

const ENGINE_RE = /(?:^|[\s/])jarvis\s+serve\b|-m\s+jarvis\s+serve\b/;
const APP_RE = /^(\/.*?\.app)\/Contents\/MacOS\/[^/]+(?:\s|$)/;
// What may stand between an app and its engine: uv, Python, jarvis itself. Anything else (a
// shell) means a terminal started it, and the Terminal is never the app to quit.
const WRAPPER_RE = /(?:^|\/)(?:uv|uvx|python[\d.]*|jarvis)(?:\s|$)/;

/** Who holds the data folder: { pid, engine (it is a `jarvis serve`), appPath, appName,
 * appPid } — the app is the first parent that is an .app's own executable (never a helper:
 * those live under Contents/Frameworks), with only uv or Python between them (a shell between
 * means a terminal started it: no app). null when the process is gone. */
function describeHolder(pid, { ps = psOf, depth = 6 } = {}) {
  const me = ps(pid);
  if (!me) return null;
  const out = { pid, engine: ENGINE_RE.test(me.command), appPath: '', appName: '', appPid: 0 };
  let current = me;
  for (let i = 0; i < depth && current && current.ppid > 1; i += 1) {
    const ppid = current.ppid;
    current = ps(ppid);
    if (!current) break;
    const m = APP_RE.exec(current.command);
    if (m && !current.command.includes('/Contents/Frameworks/')) {
      out.appPath = m[1];
      out.appName = path.basename(m[1], '.app');
      out.appPid = ppid;
      break;
    }
    if (!WRAPPER_RE.test(current.command)) break; // a shell, or anything else: not an app's
  }
  return out;
}

/** The pid that holds the data folder's lock, as the backend wrote it (jsonstore.claim_folder). */
function lockHolder(dataDir, { read = (f) => require('fs').readFileSync(f, 'utf8') } = {}) {
  try {
    const pid = Number(String(read(path.join(dataDir, 'backend.lock'))).trim().split(/\s+/)[0]);
    return Number.isInteger(pid) && pid > 1 ? pid : 0;
  } catch {
    return 0;
  }
}

/** How to stop the owner gently, and what the button says: { how, label, owner, pid, ... }
 * or null (nothing to stop that we can tell is an Eden engine). record: a live backend.json
 * (discover), holder: describeHolder of the lock's pid. Ask Eden's engine says "Quit Ask
 * Eden's engine and continue"; an older app that can't hand over says "Quit <app>". */
function stopPlan({ record, holder }) {
  if (record && Number(record.protocol) >= 1) {
    const owner = share.appName(record.app);
    return {
      how: 'shutdown', port: record.port, token: record.token, pid: record.pid, owner,
      label: record.app === 'terminal' ? 'Stop that engine and continue' : `Quit ${owner}'s engine and continue`,
    };
  }
  if (holder && holder.appPid && holder.appName) {
    return { how: 'quit-app', pid: holder.appPid, waitPid: holder.pid, owner: holder.appName, label: `Quit ${holder.appName} and continue` };
  }
  if (holder && holder.engine) {
    return { how: 'stop', pid: holder.pid, owner: 'a `jarvis serve` in a terminal', label: 'Stop that engine and continue' };
  }
  return null;
}

/** What the window says when the data is held (exit 75), naming the owner. */
function heldMessage(plan, me, holderPid = 0) {
  if (plan) return `${plan.owner === 'a `jarvis serve` in a terminal' ? 'A `jarvis serve` in a terminal' : plan.owner} is using your Eden data, so ${me.name} can't start its own engine.`;
  return `Another program${holderPid ? ` (process ${holderPid})` : ''} is using your Eden data, so ${me.name} can't start its own engine. Quit it, then open ${me.name} again.`;
}

/** Stops the owner as the plan says and waits until its engine is gone: true once it is. */
async function stopOwner(plan, { shutdown = share.shutdown, kill = process.kill.bind(process), alive = share.alive, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now, waitMs = STOP_WAIT } = {}) {
  if (!plan) return false;
  const engine = plan.waitPid || plan.pid;
  if (plan.how === 'shutdown') {
    if (!(await shutdown(plan.port, plan.token))) {
      try { kill(plan.pid, 'SIGTERM'); } catch { /* gone already */ } // (it answered as ours: its own stop, as a quit sends)
    }
  } else {
    try { kill(plan.pid, 'SIGTERM'); } catch { /* gone already */ }
  }
  const until = now() + waitMs;
  while (alive(engine)) {
    if (now() >= until) return false;
    await sleep(250);
  }
  return true;
}

module.exports = { HANDED_OVER, STOP_WAIT, choiceDialog, decide, describeHolder, heldMessage, lockHolder, psOf, stopOwner, stopPlan };
