// A packaged Jarvis.app can't find this repo from inside its bundle, so record where the
// Python backend lives before packaging.
const fs = require('fs');
const path = require('path');

const home = path.resolve(__dirname, '..', '..');
fs.writeFileSync(path.join(__dirname, '..', 'jarvis-home.json'), JSON.stringify({ path: home }, null, 2));
console.log(`Backend: ${home}`);
