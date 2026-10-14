// Electron's fuses in every build (app/scripts/release/fuses.js, audit S7): no run-as-Node,
// NODE_OPTIONS or --inspect, no extra file: powers, and an app.asar that's checked and the only
// thing loaded. Flipped by the real @electron/fuses into a stand-in Electron binary (its fuse
// wire only): nothing is packaged, signed or notarized. node --test tests/web/
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const fuses = require('../../app/scripts/release/fuses.js');
const real = require('../../app/node_modules/@electron/fuses');
const { FuseV1Options: F } = real;
const FuseState = { ENABLE: 49, DISABLE: 48 }; // (as @electron/fuses' constants.d.ts has them)
const read = (p) => fs.readFileSync(new URL(`../../app/${p}`, import.meta.url), 'utf8');

// A packaged-looking .app whose Electron Framework is just a fuse wire, every fuse on (as Electron ships most of them).
function fakeApp({ asar }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fuses-'));
  const app = path.join(dir, 'J.A.R.V.I.S.app');
  const framework = path.join(app, 'Contents', 'Frameworks', 'Electron Framework.framework');
  fs.mkdirSync(framework, { recursive: true });
  fs.mkdirSync(path.join(app, 'Contents', 'Resources'), { recursive: true });
  if (asar) fs.writeFileSync(path.join(app, 'Contents', 'Resources', 'app.asar'), 'asar');
  const wire = Buffer.concat([Buffer.from('header'), Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'), Buffer.from([1, 9]), Buffer.alloc(9, FuseState.ENABLE), Buffer.from('rest')]);
  fs.writeFileSync(path.join(framework, 'Electron Framework'), wire);
  return { app, binary: path.join(framework, 'Electron Framework') };
}
const flip = (target, config) => real.flipFuses(target, { ...config, resetAdHocDarwinSignature: false }); // (no codesign on a stand-in)

test('a Mac release: run-as-Node, NODE_OPTIONS, --inspect and file: extras off; app.asar checked and the only app', async () => {
  const { app } = fakeApp({ asar: true });
  const seen = [];
  assert.deepEqual(await fuses.flipMacApp(app, { flipFuses: (t, c) => { seen.push(c); return flip(t, c); } }), { asar: true });
  assert.equal(seen[0].resetAdHocDarwinSignature, true, 'the arm64 binary stays runnable until it’s signed');
  const wire = await real.getCurrentFuseWire(app);
  assert.equal(wire[F.RunAsNode], FuseState.DISABLE);
  assert.equal(wire[F.EnableNodeOptionsEnvironmentVariable], FuseState.DISABLE);
  assert.equal(wire[F.EnableNodeCliInspectArguments], FuseState.DISABLE);
  assert.equal(wire[F.GrantFileProtocolExtraPrivileges], FuseState.DISABLE);
  assert.equal(wire[F.EnableEmbeddedAsarIntegrityValidation], FuseState.ENABLE);
  assert.equal(wire[F.OnlyLoadAppFromAsar], FuseState.ENABLE);
  assert.equal(wire[F.LoadBrowserProcessSpecificV8Snapshot], FuseState.ENABLE, 'what it doesn’t name stays as it was');
  assert.equal(seen[0][F.EnableCookieEncryption], true, 'cookies encrypted on disk (A6)');
});

test('the owner’s own install (no app.asar) keeps loading its folder, with the rest still off', async () => {
  const { app } = fakeApp({ asar: false });
  assert.deepEqual(await fuses.flipMacApp(app, { flipFuses: flip }), { asar: false });
  const wire = await real.getCurrentFuseWire(app);
  assert.equal(wire[F.RunAsNode], FuseState.DISABLE);
  assert.equal(wire[F.OnlyLoadAppFromAsar], FuseState.ENABLE, 'untouched (as Electron ships it)');
  assert.equal(fuses.fuseConfig({ asar: false })[F.OnlyLoadAppFromAsar], undefined);
  await assert.rejects(fuses.flipMacApp(path.join(os.tmpdir(), 'no-such.app'), { flipFuses: flip }), /no app/);
});

test('Windows: electron-builder’s electronFuses say the same', () => {
  assert.deepEqual(fuses.windowsFuses(), {
    runAsNode: false, enableNodeOptionsEnvironmentVariable: false, enableNodeCliInspectArguments: false, grantFileProtocolExtraPrivileges: false,
    enableCookieEncryption: true, enableEmbeddedAsarIntegrityValidation: true, onlyLoadAppFromAsar: true,
  });
});

test('every packaging path flips them before it signs', () => {
  const dist = read('scripts/release/dist.js');
  const flipAt = dist.indexOf('await flipMacApp(app)');
  assert.ok(flipAt > 0 && flipAt < dist.indexOf('signApp(app, {'), 'dist.js: fuses, then signing');
  const finish = read('scripts/finish-app.sh');
  const fuseLine = finish.indexOf('release/fuses.js" "$APP"');
  assert.ok(fuseLine > 0 && fuseLine < finish.indexOf('codesign --force'), 'finish-app.sh (npm run package, package:eden-code): fuses, then codesign');
  assert.match(read('scripts/release/windows.js'), /electronFuses: windowsFuses\(\),/);
  assert.match(read('package.json'), /"@electron\/fuses": "\^1\.8\.0"/);
});

test('the Ask Eden app flips them too, before it signs, and never runs itself as plain Node (A6)', async () => {
  const build = read('eden/build.js');
  const flipAt = build.indexOf('await flipMacApp(app)');
  assert.ok(flipAt > 0 && flipAt < build.indexOf('if (identity) signApp(app, identity)'), 'eden/build.js: fuses, then signing');
  assert.ok(flipAt < build.indexOf("execFileSync('codesign', ['--force', '--deep', '--sign', '-', app]"), 'the ad hoc build too');
  const main = read('eden/main.js');
  assert.doesNotMatch(main, /ELECTRON_RUN_AS_NODE/, 'RunAsNode is off in the app: Eden’s server is a utilityProcess');
  assert.match(main, /utilityProcess\.fork\(entry, \['--port', String\(EDEN_PORT\)\]/);
  // Its engine gets Touch ID's proof key on stdin, as the main app's does (proof-pipe.js).
  assert.match(main, /how\.env\[proofPipe\.ENV\] = proofPipe\.ENV_VALUE;/);
  assert.match(main, /proofPipe\.attach\(child, keys,/);
  assert.match(build, /'proof-pipe\.js'.*'features\/touchid\.js'/);
  // With RunAsNode off, the real fuse wire of a stand-in says so.
  const { app } = fakeApp({ asar: false });
  await fuses.flipMacApp(app, { flipFuses: flip });
  assert.equal((await real.getCurrentFuseWire(app))[F.RunAsNode], FuseState.DISABLE);
});
