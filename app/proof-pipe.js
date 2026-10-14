// The app's own line to the backend it starts, for Touch ID's proofs (round 1 A1; the
// backend's side is src/jarvis/proof_pipe.py). The proofs (features/touchid.js makeProof) were
// signed under the backend's token, and the page has that token (its URL): a script in the
// window could sign a yes of its own. Now each backend this app starts gets a key of its own,
// fresh random, on its stdin, the one place nothing else can read: never its environment, a
// URL, backend.json or the log. The backend takes the pipe off its stdin at once, so nothing
// it starts inherits it.
//
// The pipe stays open for the other app's window on this backend (backend-share.js: that app
// didn't start it, so it has no key). Its window asks the backend, the backend asks here on
// its stdout ("<tag> ask <kind> <lang>", the tag fresh random too, so stray output a child of
// the backend prints is never taken for an ask), this app shows its own sheet (or its own
// dialog) and answers on the pipe: "proof <kind> <proof>", or "no <kind>".
'use strict';

const crypto = require('crypto');

const ENV = 'JARVIS_PROOF_PIPE';
// Round 2 (R2-16): the asks came on the backend's stdout, which goes to backend.log too, tag and
// all. Now they come on a pipe of their own, the backend's fd 3 (ENV '3'): spawn it with STDIO.
// Windows keeps them on stdout (ENV '1'): fd 3 can't be handed to a program that isn't Node.
const OWN_PIPE = process.platform !== 'win32';
const ENV_VALUE = OWN_PIPE ? '3' : '1';
const STDIO = OWN_PIPE ? ['pipe', 'pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'];

// A fresh key and tag for one backend.
function fresh() {
  return { key: crypto.randomBytes(32).toString('hex'), tag: crypto.randomBytes(16).toString('hex') };
}

// The first line on the backend's stdin.
const hello = ({ key, tag }) => `${key} ${tag}\n`;

// The answer to an ask: the proof made for it, or a no.
function answer(kind, proof) {
  if (!/^[a-z-]{1,32}$/.test(String(kind))) return '';
  return proof && /^[\w.-]{1,199}$/.test(proof) ? `proof ${kind} ${proof}\n` : `no ${kind}\n`;
}

// Reads the backend's stdout as it comes (chunks split anywhere) and calls onAsk(kind, lang)
// for each line that is an ask with this backend's tag. Gives the function to feed it with.
function asks(tag, onAsk) {
  let rest = '';
  const ask = new RegExp(`^${tag} ask ([a-z-]{1,32}) (en|zh)$`);
  return (chunk) => {
    rest += String(chunk);
    const lines = rest.split('\n');
    rest = lines.pop().slice(-4096); // (a line that never ends is never an ask)
    for (const line of lines) {
      const m = ask.exec(line.replace(/\r$/, ''));
      if (m) onAsk(m[1], m[2]);
    }
  };
}

// Starts the pipe on a backend just spawned with stdin a pipe: writes its hello, and answers
// each ask with prove(kind, lang) (a Promise of the proof, or '' for a no).
function attach(child, keys, prove) {
  if (!child || !child.stdin || !child.stdout) return;
  child.stdin.on('error', () => {}); // (the backend gone: nothing to tell it)
  child.stdin.write(hello(keys));
  const from = (child.stdio && child.stdio[3]) || child.stdout; // (its own pipe, else stdout)
  from.on('data', asks(keys.tag, async (kind, lang) => {
    let proof = '';
    try { proof = await prove(kind, lang); } catch { proof = ''; }
    const line = answer(kind, proof);
    if (line && child.stdin.writable) child.stdin.write(line);
  }));
}

module.exports = { ENV, ENV_VALUE, STDIO, fresh, hello, answer, asks, attach };
