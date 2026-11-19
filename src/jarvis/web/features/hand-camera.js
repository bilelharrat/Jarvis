// The hand panel's Camera menu: which of the Mac's cameras hand control watches (a webcam
// on a stand sees your hands better than the laptop's own). features/hand_camera.py keeps
// the pick by name in prefs.features.hand_camera; cameras.js opens it, or the Mac's default
// when it's "" or the camera isn't plugged in. Picking one while hand control is on starts
// it again on that camera. The menu lists the cameras again when one is plugged in or out.
(function (root) {
  'use strict';
  const F = root.jarvisFeatures;
  if (!F) return;
  /* global handsOn, startHandControl, stopHandControl */
  const media = root.navigator && root.navigator.mediaDevices;
  let wanted = '';
  let select = null;

  function setWanted(name) {
    wanted = typeof name === 'string' ? name : '';
    root.jarvisHandCamera = wanted;
  }

  async function names() {
    try {
      const seen = [];
      for (const d of await media.enumerateDevices()) {
        if (d && d.kind === 'videoinput' && d.label && !seen.includes(d.label)) seen.push(d.label);
      }
      return seen;
    } catch (_err) {
      return [];
    }
  }

  function option(value, text) {
    const o = root.document.createElement('option');
    o.value = value;
    o.textContent = text;
    return o;
  }

  let retries = 0;

  async function fill() {
    if (!build()) return;
    const found = await names();
    const options = [option('', 'Default camera')];
    for (const name of found) options.push(option(name, name));
    if (wanted && !found.includes(wanted)) options.push(option(wanted, `${wanted} (not connected)`));
    select.replaceChildren(...options);
    select.value = wanted;
    // A name only shows once the camera is allowed and open: the panel shows just before it
    // opens, so a list without names is asked for again a moment later (a few times).
    const panel = F.$('hand-panel');
    if (!found.length && panel && !panel.hidden && retries < 3) {
      retries += 1;
      root.setTimeout(fill, 1500);
    }
  }

  function build() {
    if (select) return true;
    const panel = F.$('hand-panel');
    if (!panel || !media) return false;
    const row = F.el('label', 'hand-camera');
    row.append(F.el('span', 'hand-camera-label', 'Camera'));
    select = root.document.createElement('select');
    select.setAttribute('aria-label', 'Camera for hand control');
    select.addEventListener('change', () => {
      setWanted(select.value);
      F.send({ type: 'feature_prefs', changes: { hand_camera: wanted } });
      // On the new camera now: hand control opens its camera when it starts.
      if (typeof handsOn !== 'undefined' && handsOn && typeof stopHandControl === 'function' && typeof startHandControl === 'function') {
        stopHandControl();
        startHandControl();
      }
    });
    row.append(select);
    panel.append(row);
    // The panel shows when hand control starts: the cameras' names are there by then
    // (the camera is allowed), so the list is made again each time it shows.
    new root.MutationObserver(() => {
      if (panel.hidden) return;
      retries = 0;
      fill();
    }).observe(panel, { attributes: true, attributeFilter: ['hidden'] });
    if (typeof media.addEventListener === 'function') media.addEventListener('devicechange', () => fill());
    return true;
  }

  // The settings come in the backend's hello when the window connects (app.js renders
  // ev.prefs from it) and as a prefs event when they change afterwards: both count.
  function onPrefs(p) {
    if (!p || typeof p !== 'object') return;
    setWanted((p.features && p.features.hand_camera) || '');
    fill();
  }
  F.on('hello', (ev) => onPrefs(ev && ev.prefs), { replay: true });
  F.on('prefs', onPrefs, { replay: true });
  fill(); // the menu is there from the start, on the Mac's default until the settings say
})(typeof window !== 'undefined' ? window : globalThis);
