// Ask Eden for Excel: where the Connect dialog lands (/addins/excel/connected?code=…&state=…, or
// ?error=access_denied&state=…). It hands the code to the task pane two ways, and the pane takes the
// first that arrives, checks the state and redeems the code itself (with its PKCE verifier, which
// never leaves the pane):
//   - Office's messageParent (the Windows and Mac apps; Excel on the web when the dialog still has
//     its link to the pane);
//   - askeden.com's relay: POST /api/eden/relay { state, code }, which the pane polls for
//     (/api/eden/relay/take). Excel on the web reaches the pane only through window.opener, which a
//     sign-in page's cross-origin-opener-policy can cut; the relay doesn't need it. A code is
//     useless without the pane's verifier.
(function () {
  const X = globalThis.EdenExcel;
  const address = location.href;
  const params = new URLSearchParams(location.search);
  const failed = Boolean(params.get('error'));
  let t = X.wordsFor(navigator.language);
  document.documentElement.lang = t.lang;
  // The code is one-use and short-lived; still, keep it out of the address bar and history.
  try {
    history.replaceState(null, '', location.pathname);
  } catch {
    // not allowed here: harmless
  }
  const say = (title, lead) => {
    document.getElementById('title').textContent = title;
    document.getElementById('lead').textContent = lead;
  };
  say(t('landingConnecting'), t('landingWait'));

  let relayed = false;
  let sent = false;
  const done = () => say(failed ? t('landingNot') : t('landingConnected'), t('landingBack'));

  // The relay first (it works wherever the dialog runs), then messageParent.
  const relay = (async () => {
    const code = params.get('code');
    const state = params.get('state');
    if (failed || !code || !state) return;
    try {
      const res = await fetch('/api/eden/relay', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ state, code }) });
      relayed = res.ok || res.status === 409; // 409: already passed on
    } catch {
      relayed = false;
    }
  })();

  const send = () => {
    const ui = globalThis.Office && Office.context && Office.context.ui;
    if (!ui || typeof ui.messageParent !== 'function') return false;
    try {
      ui.messageParent(JSON.stringify({ type: 'eden-connected', url: address }));
      sent = true;
    } catch {
      sent = false;
    }
    return sent;
  };

  const settle = async () => {
    await relay;
    if (sent || relayed) done();
    else say(failed ? t('landingNot') : t('landingAlmost'), t('landingOpen'));
  };

  if (globalThis.Office && typeof Office.onReady === 'function') {
    Office.onReady(() => {
      if (globalThis.Office.context && Office.context.displayLanguage) t = X.wordsFor(Office.context.displayLanguage);
      relay.then(() => {
        send();
        settle();
      });
    });
  }
  setTimeout(() => {
    if (!sent) send();
    settle();
  }, 4000);
})();
