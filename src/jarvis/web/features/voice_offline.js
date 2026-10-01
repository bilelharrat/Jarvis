// Settings › Speaking › JARVIS (on this Mac) (local_voice.py, features/offline_voice.py):
// the offline voice's download (its size shown first, then progress), which of its voices
// speaks, and its removal. Shown while that provider is picked; the rest of the Speaking
// group is voice.js's. State is the "local" part of the "voice" event; the buttons send
// voice_local_download, voice_local_remove and voice_settings {voice_local}.
(() => {
  const F = window.jarvisFeatures;
  if (!F) return;
  const { el, send, t } = F;

  let state = null;  // the latest "voice" event

  function button(label, id, run, cls = 'btn') {
    const b = el('button', cls, label);
    b.type = 'button';
    b.id = id;
    b.addEventListener('click', run);
    return b;
  }

  const block = el('div', 'voice-offline');
  block.id = 'voice-offline';
  block.hidden = true;

  const about = el('p', 'small-status');
  about.id = 'voice-offline-about';
  about.textContent = 'A neural voice that runs on this Mac: no internet, no account. It speaks English; Chinese uses the Mac voice.';

  const pick = el('select');
  pick.id = 'voice-offline-select';
  pick.setAttribute('aria-label', 'Voice');
  pick.addEventListener('change', () => send({ type: 'voice_settings', changes: { voice_local: pick.value } }));
  const pickRow = el('div', 'row stack');
  const pickLabel = el('span');
  pickLabel.append(el('strong', '', 'Voice'));
  pickRow.append(pickLabel, pick);

  const getRow = el('div', 'row voice-offline-get');
  const size = el('small');
  size.id = 'voice-offline-size';
  const download = button('Download', 'voice-offline-download', () => { download.disabled = true; send({ type: 'voice_local_download' }); });
  getRow.append(size, download);
  const progress = el('progress');
  progress.id = 'voice-offline-progress';
  progress.max = 1;
  const progressNote = el('small', 'small-status');
  progressNote.id = 'voice-offline-progress-note';

  const remove = button('Remove the voice', 'voice-offline-remove', () => {
    if (remove.dataset.sure) { delete remove.dataset.sure; send({ type: 'voice_local_remove' }); return; }
    remove.dataset.sure = '1';
    remove.textContent = t('Remove it?');
  }, 'btn danger');

  const status = el('p', 'small-status');
  status.id = 'voice-offline-status';
  const error = el('p', 'small-status warn-line');
  error.id = 'voice-offline-error';
  error.setAttribute('role', 'alert');

  block.append(about, getRow, progress, progressNote, pickRow, status, remove, error);

  function mb(bytes) {
    return `${Math.max(0.1, bytes / 1e6).toFixed(bytes >= 1e7 ? 0 : 1)} MB`;
  }

  function place() {
    if (block.isConnected) return;
    const note = F.$('voice-provider-note');
    if (note) note.after(block);
  }

  function render() {
    const local = state && state.local;
    if (!local) return;
    block.hidden = state.provider !== 'local';
    const dl = local.downloading;
    getRow.hidden = local.ready || !!dl;
    download.hidden = !local.configured;
    download.disabled = false;
    size.textContent = !local.configured
      ? 'The offline voice isn’t set up in this build.'
      : `The voice is ${mb(local.size)} and stays on this Mac. It downloads once.`;
    progress.hidden = progressNote.hidden = !dl;
    if (dl) {
      progress.value = dl.total > 0 ? Math.min(1, dl.done / dl.total) : 0;
      progressNote.textContent = `Downloading… ${Math.round(progress.value * 100)}%`;
    }
    pickRow.hidden = !local.ready;
    if (document.activeElement !== pick) {
      pick.replaceChildren(...(local.voices || []).map((v) => {
        const o = el('option', '', v.name);
        o.value = v.id;
        o.selected = v.id === local.voice;
        return o;
      }));
    }
    remove.hidden = !local.ready || !!dl;
    if (!remove.dataset.sure) remove.textContent = t('Remove the voice');
    let note = '';
    if (local.ready && !local.on) note = 'Your persona’s own voice is speaking now.';
    else if (!local.ready && local.configured && !dl) note = 'Until it’s downloaded, the Mac voice speaks.';
    status.textContent = note;
    status.hidden = !note;
    error.textContent = local.error || '';
    error.hidden = !local.error;
  }

  F.on('voice', (ev) => { state = ev; place(); render(); }, { replay: true });
})();
