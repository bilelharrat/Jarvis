// Signs the Windows update list (askeden.com/windows/latest.json) with the owner's Ed25519 key,
// so the Windows apps trust it (app/win-update.js, audit S8):
//   node scripts/release/sign-feed.js <entries.json> [--installers <folder>] [--out <latest.json>]
//   node scripts/release/sign-feed.js --public     prints the public key for win-update.js's FEED_PUBLIC_KEY
// entries.json is the unsigned list ({ jarvis: {version, size, file, sha256?}, daredevil: {…}, … }).
// With --installers, each entry's size and SHA-256 are read from its installer in that folder
// (by its file name); otherwise each must already say them. The output is the signed list:
// the entries as they are signed (the exact text in "signed"), its Ed25519 signature, and the
// same entries at the top level, unsigned, for copies older than signing (they never read
// "signed"; new ones read nothing else).
//
// The private key lives only in the owner's login Keychain, as a generic password: service
// "Eden Windows update feed", account "ed25519", its value the key's PKCS#8 DER as base64. The
// owner makes it once, on the Mac that publishes:
//   openssl genpkey -algorithm ed25519 -outform DER | base64 | tr -d '\n' > /tmp/k && \
//     security add-generic-password -s "Eden Windows update feed" -a ed25519 -w "$(cat /tmp/k)" && rm -P /tmp/k
// then runs --public and puts what it prints into FEED_PUBLIC_KEY. Nothing here makes a key.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { entryFor } = require('../../win-update');

const SERVICE = 'Eden Windows update feed';
const ACCOUNT = 'ed25519';

// The private key, from the Keychain (macOS asks the owner to allow it). Throws in words.
function keychainKey(run = execFileSync) {
  let text = '';
  try {
    text = String(run('/usr/bin/security', ['find-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).trim();
  } catch {
    throw new Error(`No "${SERVICE}" key in the Keychain (account ${ACCOUNT}). See the top of sign-feed.js for how to make it.`);
  }
  return keyFrom(text);
}

// A private key from the Keychain's text: PKCS#8 DER as base64 (or PEM).
function keyFrom(text) {
  const given = String(text || '').trim();
  const key = given.startsWith('-----BEGIN')
    ? crypto.createPrivateKey(given)
    : crypto.createPrivateKey({ key: Buffer.from(given, 'base64'), format: 'der', type: 'pkcs8' });
  if (key.asymmetricKeyType !== 'ed25519') throw new Error(`the Keychain's key is ${key.asymmetricKeyType}, not Ed25519`);
  return key;
}

// The public half, as win-update.js's FEED_PUBLIC_KEY takes it (32 bytes, base64url).
function publicKeyOf(privateKey) {
  return crypto.createPublicKey(privateKey).export({ format: 'jwk' }).x;
}

// A file's size and SHA-256.
function measure(file) {
  const data = fs.readFileSync(file);
  return { size: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') };
}

// The signed list for entries. Each entry is checked as the app will read it (entryFor), so a
// list the app would refuse is never published.
function signFeed(entries, privateKey, { installers = '' } = {}) {
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw new Error('the entries must be an object of flavors');
  const filled = {};
  for (const [flavor, entry] of Object.entries(entries)) {
    const e = { version: entry.version, size: entry.size, file: entry.file, sha256: entry.sha256 };
    if (installers) Object.assign(e, measure(path.join(installers, path.basename(String(entry.file || '')))));
    filled[flavor] = e;
  }
  const signed = JSON.stringify(filled);
  const signature = crypto.sign(null, Buffer.from(signed, 'utf8'), privateKey).toString('base64');
  const feed = JSON.stringify({ ...filled, signed, signature });
  const publicKey = publicKeyOf(privateKey);
  for (const flavor of Object.keys(filled)) entryFor(feed, flavor, { publicKey }); // throws on anything the app won't take
  return feed;
}

function parseArgs(argv) {
  const args = { input: '', installers: '', out: '', public: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--public') args.public = true;
    else if (a === '--installers') args.installers = argv[++i] || '';
    else if (a === '--out') args.out = argv[++i] || '';
    else if (!a.startsWith('--') && !args.input) args.input = a;
    else throw new Error(`unknown option ${a}`);
  }
  if (!args.public && !args.input) throw new Error('usage: sign-feed.js <entries.json> [--installers <folder>] [--out <latest.json>] | --public');
  return args;
}

function main(argv = process.argv.slice(2), { readKey = keychainKey, write = (file, text) => fs.writeFileSync(file, text), print = (line) => console.log(line) } = {}) {
  const args = parseArgs(argv);
  const key = readKey();
  if (args.public) { print(publicKeyOf(key)); return null; }
  const entries = JSON.parse(fs.readFileSync(args.input, 'utf8'));
  const feed = signFeed(entries, key, { installers: args.installers });
  if (args.out) { write(args.out, `${feed}\n`); print(`signed ${Object.keys(entries).join(', ')} into ${args.out}`); } else print(feed);
  return feed;
}

module.exports = { main, signFeed, keyFrom, keychainKey, publicKeyOf, parseArgs, SERVICE, ACCOUNT };

if (require.main === module) {
  try { main(); } catch (err) { console.error(err.message); process.exit(1); }
}
