// Ask Eden for Excel: where the Connect dialog lands (/addins/excel/connected?code=…&state=…, or
// ?error=access_denied&state=…). It hands the address to the task pane, which checks the state and
// redeems the code itself (with its PKCE verifier, which never leaves the pane), then closes this.
(function () {
  const address = location.href;
  const params = new URLSearchParams(location.search);
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
  if (params.get('error')) say('Not connected', 'You can close this window and go back to Excel.');

  let sent = false;
  const send = () => {
    const ui = globalThis.Office && Office.context && Office.context.ui;
    if (!ui || typeof ui.messageParent !== 'function') return false;
    ui.messageParent(JSON.stringify({ type: 'eden-connected', url: address }));
    sent = true;
    if (!params.get('error')) say('Connected', 'Going back to Excel…');
    return true;
  };

  if (globalThis.Office && typeof Office.onReady === 'function') Office.onReady(() => send());
  setTimeout(() => {
    if (!sent && !send()) say(params.get('error') ? 'Not connected' : 'Almost there', 'Open Ask Eden from Excel’s Home tab and press Connect there. You can close this window.');
  }, 4000);
})();
