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
  Promise.resolve(b.getBootSound()).then((on) => { sw.checked = on !== false; sw.disabled = false; }).catch(() => { sw.disabled = false; });
  sw.addEventListener('change', () => {
    Promise.resolve(b.setBootSound(sw.checked)).catch(() => {});
    if (onChange) onChange(sw.checked);
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
