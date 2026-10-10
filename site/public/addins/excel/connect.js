// Ask Eden for Excel: the Connect dialog's first page (/addins/excel/connect.html?state=…&code_challenge=…).
// Office opens its dialog here, on the add-in's own domain, with Office.js loaded, so the dialog keeps
// what it needs to talk back to the pane when it later lands on /addins/excel/connected (Microsoft's
// documented way to sign in through a dialog). Then it goes on to the consent page, /eden/connect.
(function () {
  const X = globalThis.EdenExcel;
  const t = X.wordsFor(navigator.language);
  document.documentElement.lang = t.lang;
  const say = (title, lead) => {
    document.getElementById('title').textContent = title;
    document.getElementById('lead').textContent = lead;
  };
  say(t('landingConnecting'), t('landingWait'));
  const next = X.startTarget(location.search, location.origin);
  if (!next) return say(t('landingNot'), t('landingBad'));
  let gone = false;
  const go = () => {
    if (gone) return;
    gone = true;
    location.replace(next);
  };
  if (globalThis.Office && typeof Office.onReady === 'function') Office.onReady(go);
  setTimeout(go, 1500); // Office.js slow or missing: go anyway
})();
