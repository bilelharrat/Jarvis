// Which app this is: J.A.R.V.I.S., Eden Code (the coding app split out of it), or J.A.R.V.I.S.
// Daredevil. All are this one folder (main.js, the features, the same Python backend); they differ
// in name, in window and in what they start.
//
//   - J.A.R.V.I.S. (the default): the voice assistant, with Eden Code one click away.
//   - Eden Code: Eden Code alone, in its own window and Dock icon, in Ask Eden's look. No
//     microphone, no global shortcuts, no menu bar item: it runs its backend with
//     JARVIS_PROFILE=code, or shares the one J.A.R.V.I.S. is already running
//     (backend-share.js).
//   - J.A.R.V.I.S. Daredevil: J.A.R.V.I.S. for people who are blind or have low vision, as an app of its
//     own (the Windows download of that name). The same program, data and settings as J.A.R.V.I.S.:
//     it opens in screen-reader mode, in yellow on black, under its own name, so installing one
//     over the other changes the edition and nothing else.
//
// Eden Code is chosen by EDEN_CODE=1 (npm run start:eden-code), by --eden-code, or by the
// flavor.json the Eden Code build bakes in (scripts/eden-code/package.js); Daredevil by
// DAREDEVIL=1, --daredevil, or the flavor.json scripts/release/windows.js --daredevil bakes in.
'use strict';

const fs = require('fs');
const path = require('path');

const FLAVORS = {
  jarvis: {
    id: 'jarvis',
    name: 'J.A.R.V.I.S.',
    title: 'J.A.R.V.I.S.',
    logName: 'Jarvis',
    appUserModelId: 'com.askeden.jarvis.win', // Windows: the installer's appId, which toasts are shown under
    socketApp: 'jarvis', // what its window says on the socket (server.APPS)
    query: '',
    edition: '', // what the backend and the page are told (JARVIS_EDITION, ?edition=)
    background: { dark: '#111317', light: '#f4f0e8' },
    size: { width: 1280, height: 840, minWidth: 760, minHeight: 620 },
    profile: 'full',
  },
  daredevil: {
    id: 'daredevil',
    name: 'J.A.R.V.I.S. Daredevil',
    title: 'J.A.R.V.I.S. Daredevil',
    logName: 'Jarvis', // J.A.R.V.I.S.'s logs and data folder: it is the same program
    appUserModelId: 'com.askeden.jarvis.win', // J.A.R.V.I.S.'s too: one app to Windows, so one replaces the other
    userDataName: 'J.A.R.V.I.S.', // …and its Electron profile (window place, the one-at-a-time lock), so never two at once
    socketApp: 'jarvis',
    query: 'edition=daredevil', // the page opens in screen-reader mode and yellow on black from its first paint
    edition: 'daredevil',
    background: { dark: '#000000', light: '#000000' }, // black either way: the window never flashes white
    size: { width: 1280, height: 840, minWidth: 760, minHeight: 620 },
    profile: 'full',
  },
  'eden-code': {
    id: 'eden-code',
    name: 'Eden Code',
    title: 'Eden Code',
    logName: 'Eden Code',
    appUserModelId: 'com.askeden.edencode.win',
    socketApp: 'eden-code',
    query: 'app=code', // the page in Eden Code's shape (server.eden_code_page)
    edition: '',
    background: { dark: '#161618', light: '#f5f5f7' }, // Ask Eden's --bg
    size: { width: 1240, height: 820, minWidth: 720, minHeight: 560 },
    profile: 'code',
    // The app features (app/features/*.js) Eden Code needs; J.A.R.V.I.S. loads them all.
    features: new Set(['code-sessions.js', 'code-verify.js', 'design-match.js', 'platform.js', 'touchid.js', 'updates.js', 'video-proof.js']),
  },
};

function readBaked(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'flavor.json'), 'utf8')).flavor || ''; } catch { return ''; }
}

/** The flavor for this launch: { id, name, … } from FLAVORS. */
function resolveFlavor({ env = process.env, argv = process.argv, dir = __dirname } = {}) {
  if (env.EDEN_CODE === '1' || argv.includes('--eden-code')) return FLAVORS['eden-code'];
  if (env.DAREDEVIL === '1' || argv.includes('--daredevil')) return FLAVORS.daredevil;
  const baked = readBaked(dir);
  return FLAVORS[baked] || FLAVORS.jarvis;
}

module.exports = { FLAVORS, resolveFlavor };
