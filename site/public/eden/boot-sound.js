// The boot-up sound of the desktop apps (Ask Eden for Mac and for Windows): a short sound as the app
// opens. The app keeps the choice (its preload's getBootSound / setBootSound), so it can be read before
// this page loads. On the web and on iPhone there's no sound and no switch.
import { el, toast } from './util.js';

const bridge = () => {
  const b = window.askEdenMac || window.askEdenWin;
  return b && typeof b.getBootSound === 'function' && typeof b.setBootSound === 'function' ? b : null;
};

export const hasBootSound = () => Boolean(bridge());

/** The switch, filled in from the app; null outside the desktop apps. */
function bootSoundSwitch(onChange) {
  const b = bridge();
  if (!b) return null;
  const sw = el('input', { type: 'checkbox', 'aria-label': 'Boot-up sound' });
  sw.checked = true;
  sw.disabled = true;
  // AC2-11: an app that never answers leaves the switch usable (on, the default) after 3 s, not greyed out for good
  const ready = setTimeout(() => { sw.disabled = false; }, 3000);
  Promise.resolve(b.getBootSound()).then((on) => { sw.checked = on !== false; }).catch(() => {}).finally(() => { clearTimeout(ready); sw.disabled = false; });
  sw.addEventListener('change', async () => {
    // AC2-11: the switch shows what the app saved: it answers with the value it kept (the old one when the write
    // failed); a refusal or a different value puts the switch back and says so, never "saved"
    const want = sw.checked;
    sw.disabled = true;
    let kept;
    try { kept = await b.setBootSound(want); } catch { kept = !want; }
    sw.disabled = false;
    if (typeof kept === 'boolean' && kept !== want) { sw.checked = kept; toast('Couldn’t save the boot-up sound. Try again.'); return; }
    if (onChange) onChange(want);
  });
  return el('label', 'switch', sw, el('span', 'tr'));
}

/** Settings › Appearance. */
export function bootSoundSettings() {
  const sw = bootSoundSwitch((on) => toast(on ? 'The boot-up sound plays when the app opens' : 'The app opens quietly'));
  if (!sw) return null;
  return el('div', 'set-sec', el('h3', '', 'Sound'),
    el('div', 'icard', el('div', 'prov', el('div', 'grow', el('div', 'p-n', 'Boot-up sound'), el('div', 'p-c', 'A short sound as the app opens. Turn it off to open quietly.')), sw)));
}

/** The welcome sheet (tour.js): the same choice, before the tour starts. */
export function bootSoundWelcomeRow() {
  const sw = bootSoundSwitch();
  if (!sw) return null;
  return el('div', 'icard tour-boot-sound', el('div', 'prov', el('div', 'grow', el('div', 'p-n', 'Boot-up sound'), el('div', 'p-c', 'A short sound as the app opens. You can change this any time in Settings › Appearance.')), sw));
}
