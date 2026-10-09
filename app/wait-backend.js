// Waiting for the backend to answer /health after it is started (main.js). A first start after installing is slow on a
// PC: Windows (and any antivirus) checks every file of the engine the first time it is read. So it is waited for, with a
// word now and then for the window to say, for as long as the engine is alive and the time allowed lasts.
'use strict';

const http = require('http');

// [after this many ms of waiting, what the window says once]. %LOG% is the app's own log, named by main.js.
const SLOW_WORDS = [
  [12000, 'Still starting. The first start after installing takes a minute or two, while Windows checks the new files.'],
  [45000, 'Still starting. Windows is still checking the files; this only happens the first time.'],
  [120000, 'Still starting, and slower than usual. If it never opens, %LOG% says what it did.'],
];

/**
 * Resolves once /health answers 200 on the port; rejects with { exited: true } when the engine is gone (the caller
 * that saw it exit has already said what is happening), or with an error once timeoutMs has passed.
 * port and running are asked each time: they change when the engine is started again.
 */
function waitForHealth({ port, running, timeoutMs, words = SLOW_WORDS, say = () => {}, note = () => {}, get = http.get, now = Date.now, later = setTimeout }) {
  const started = now();
  const said = new Set();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = get({ host: '127.0.0.1', port: port(), path: '/health', timeout: 1000 }, (res) => {
        res.resume();
        if (res.statusCode === 200) {
          note(`the engine answers after ${((now() - started) / 1000).toFixed(1)} s`);
          resolve();
        } else retry();
      });
      req.on('error', retry);
      req.on('timeout', () => req.destroy());
    };
    const retry = () => {
      if (!running()) return reject(Object.assign(new Error('backend exited'), { exited: true }));
      const waited = now() - started;
      if (waited > timeoutMs) return reject(new Error('backend took too long to start'));
      for (const [after, text] of words) {
        if (waited > after && !said.has(after)) {
          said.add(after);
          note(`still waiting for the engine (${Math.round(waited / 1000)} s)`);
          say(text);
        }
      }
      later(attempt, 400);
    };
    attempt();
  });
}

module.exports = { waitForHealth, SLOW_WORDS };
