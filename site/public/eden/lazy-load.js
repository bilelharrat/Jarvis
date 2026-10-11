// A module loaded on first use (askeden opt2-ae-web), with a retry that can work: the browser keeps a failed module
// import for the page's life under that address, so asking for the same one again failed at once (AC2-7, the same
// as mail-lazy.js's mail-bundle). After a failure the next try asks under a new address (`?retry=n`): a new fetch.
// On askeden.com the first try goes through the page's import map (the module's versioned address); a retry's address
// isn't in the map, so it's fetched with `no-cache`, and the modules it imports still come from the map. A second
// failure while online offers a reload: a module that failed inside it stays failed until the page reloads.
//
// lazyModule('./x.js', (m) => { m.initX(...); return m; }) → load(): the same promise for every caller once it loaded;
// `init` runs once, on the module that loaded (it isn't fetched again when only `init` threw); load.ready() and load.now()
// answer synchronously (for a stand-in's "is it open?" that must not load anything).

import { toast } from './util.js';

const online = () => !(typeof navigator !== 'undefined' && navigator.onLine === false);
export const retryAddress = (spec, n) => (n ? `${new URL(spec, import.meta.url).href}?retry=${n}` : spec);

export function lazyModule(spec, init = (m) => m, { what = 'that part of Eden', quiet = false } = {}) {
  let p = null;
  let mod = null; // the module, once fetched (init may still have failed)
  let attempt = 0;
  let done = false;
  let out = null; // what init returned, once it ran
  const load = () => (p ??= (mod ? Promise.resolve(mod) : import(retryAddress(spec, attempt)).then((m) => (mod = m), (e) => { attempt += 1; throw e; }))
    .then(init)
    .then((m) => { done = true; out = m; return m; }, (e) => {
      p = null;
      if (!quiet) {
        if (attempt > 1 && online()) toast(`Couldn’t load ${what} (${e.message}). Reload the page to try again.`, { label: 'Reload', run: () => location.reload() });
        else toast(`Couldn’t load ${what}: ${e.message}`);
      }
      throw e;
    }));
  /** True once the module is loaded and its init ran. */
  load.ready = () => done;
  /** What init returned (the module), once ready; else null. */
  load.now = () => out;
  return load;
}
