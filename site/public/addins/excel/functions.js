// Ask Eden for Excel: the =EDEN.ASK(prompt, [range]) cell function. It runs in the add-in's shared
// runtime (the task pane's page, manifest.xml), so it uses the token the pane saved and the pane can
// show how many answers it asked for. Answers are cached by (prompt + the range's values), in memory
// and in localStorage, so a recalculation doesn't ask (or bill the included AI) again. At most
// PARALLEL asks run at once, and at most `cap` per session until the person allows more in the pane.
(function (root) {
  const X = root.EdenExcel;
  const PARALLEL = 4;
  const SESSION_CAP = 100;
  const RETRIES = [1500, 4000]; // waits before asking again after "slow down" or a network hiccup

  const memory = new Map(); // cache key → answer
  const inFlight = new Map(); // cache key → promise (the same cell asked twice while waiting)
  const waiting = [];
  const listeners = new Set();
  let running = 0;
  let used = 0;
  let cap = SESSION_CAP;
  let needConnect = 0; // asks that failed for want of a connection (the pane recalculates them after Connect)

  const state = () => ({ used, cap, needConnect, saved: X.cacheCount(), running, queued: waiting.length });
  const changed = () => {
    for (const fn of listeners) {
      try {
        fn(state());
      } catch {
        // a listener's own problem
      }
    }
  };

  /** An error Excel shows in the cell (#N/A, #VALUE!), with its message on hover. */
  function fail(message, kind = 'notAvailable') {
    const CF = root.CustomFunctions;
    if (CF && CF.Error && CF.ErrorCode) return new CF.Error(CF.ErrorCode[kind] || CF.ErrorCode.notAvailable, String(message).slice(0, 255));
    return new Error(message);
  }

  async function slot(job) {
    if (running >= PARALLEL) await new Promise((go) => waiting.push(go));
    running += 1;
    try {
      return await job();
    } finally {
      running -= 1;
      const next = waiting.shift();
      if (next) next();
    }
  }

  const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

  async function post(token, body) {
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetch('/api/eden/sheet', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      } catch {
        res = null;
      }
      const status = res ? res.status : 0;
      if ((status === 0 || status === 429 || status === 502) && attempt < RETRIES.length) {
        await sleep(RETRIES[attempt]);
        continue;
      }
      return res;
    }
  }

  /** =EDEN.ASK(prompt, [range]): Eden's short answer, as text. */
  async function ask(prompt, range) {
    const question = String(prompt ?? '').trim();
    if (!question) throw fail('Type a question first, e.g. =EDEN.ASK("Which month sold most?", A1:B13).', 'invalidValue');
    const grid = Array.isArray(range) && range.length ? range.map((row) => (Array.isArray(row) ? row : [row]).map((v) => X.cellOf(v))) : null;
    const values = grid && X.hasData(grid) ? grid : null;
    const key = X.cacheKey(question, values);
    if (memory.has(key)) return memory.get(key);
    const saved = X.cacheGet(undefined, key);
    if (saved !== null) {
      memory.set(key, saved);
      return saved;
    }
    if (inFlight.has(key)) return inFlight.get(key);

    const token = (root.EdenPane && root.EdenPane.token && root.EdenPane.token()) || X.readToken();
    if (!token) {
      needConnect += 1;
      changed();
      throw fail('Connect Ask Eden first: on the Home tab press Ask Eden, then Connect.');
    }
    const built = X.sheetBody({ action: 'cell', instruction: question, sheet: values ? { values } : null });
    if (built.error) throw fail(built.error, 'invalidValue');
    if (used >= cap) throw fail(`Ask Eden paused after ${cap} cell answers this session, to save your included AI. Press “Allow more” in the Ask Eden pane.`);
    used += 1;
    changed();

    const job = slot(async () => {
      const res = await post(token, built.body);
      if (!res) throw fail(X.errorWords(0).words);
      if (!res.ok) {
        let info = {};
        try {
          info = await res.json();
        } catch {
          info = {};
        }
        const err = X.errorWords(res.status, info.code, info.error);
        if (err.connect) {
          X.forgetToken();
          needConnect += 1;
          if (root.EdenPane && root.EdenPane.signedOut) root.EdenPane.signedOut();
        }
        throw fail(err.plan ? `${err.words} See your plan at askeden.com/account.` : err.words);
      }
      const answer = X.cellAnswer(await res.text());
      memory.set(key, answer);
      X.cachePut(undefined, key, answer);
      return answer;
    });
    inFlight.set(key, job);
    try {
      return await job;
    } finally {
      inFlight.delete(key);
      changed();
    }
  }

  root.EdenCells = {
    ask,
    state,
    onChange: (fn) => listeners.add(fn),
    allowMore(n = SESSION_CAP) {
      cap = used + n;
      changed();
    },
    clearSaved() {
      memory.clear();
      const n = X.cacheClear();
      changed();
      return n;
    },
    /** Called after Connect: how many cells were waiting for it (and resets the count). */
    takeNeedConnect() {
      const n = needConnect;
      needConnect = 0;
      return n;
    },
  };

  try {
    if (root.CustomFunctions && typeof root.CustomFunctions.associate === 'function') root.CustomFunctions.associate('ASK', ask);
  } catch {
    // not in Excel (a browser preview): the pane still works
  }
})(globalThis);
