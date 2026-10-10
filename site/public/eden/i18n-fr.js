// The French strings, gathered from one file per area of the app (see i18n.js). Loaded only
// when French is on. A part that fails to load is skipped, so the rest still translates.

const PARTS = ['shell', 'chat', 'mail', 'compose', 'calendar', 'account', 'voice', 'edu', 'server', 'extra', 'overrides'];

const loaded = await Promise.allSettled(PARTS.map((p) => import(`./i18n-fr-${p}.js`)));
export default loaded.flatMap((r, i) => {
  if (r.status === 'fulfilled') return [r.value.default];
  console.warn(`Eden: i18n-fr-${PARTS[i]}.js did not load`, r.reason);
  return [];
});
