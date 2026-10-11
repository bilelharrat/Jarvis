// GET /api/chat/build on askeden.com: one stamp for the whole deployed Eden page (askeden
// web/chat/page-update.js), so a page left open (the iPhone app keeps its web view for days) asks once
// whether Eden changed instead of a HEAD for every script and stylesheet (iOS sweep AI9). The Mac's
// server answers the same route from its files (askeden src/chat/build-stamp.ts); here it's a hash of
// the synced files' content hashes (scripts/sync-eden.mjs: EDEN_BUILD, written into the pages too), so it
// changes with any file and only then: the same deploy gives every isolate the same stamp.
import * as manifest from './manifest.js';
import { buildOf, stampOf } from './build-stamp.js';

// stampOf and buildOf live in build-stamp.js (no manifest there), so the sync computes the pages' stamp the same way.
export { stampOf, buildOf };

let cached = null;
/**
 * This deploy's stamp: the one the sync wrote into the pages (EDEN_BUILD, their <meta name="eden-build">, so
 * page-update compares with the build the page was made from: AW2-1), else (a sync before it) the hashes'.
 */
export const edenBuild = () => (cached ??= typeof manifest.EDEN_BUILD === 'string' && manifest.EDEN_BUILD ? manifest.EDEN_BUILD : buildOf(manifest.EDEN_HASHES));

/** The pages' import map hashes for their CSP (none before a sync that writes them). */
export const edenScriptHashes = () => (Array.isArray(manifest.EDEN_SCRIPT_HASHES) ? manifest.EDEN_SCRIPT_HASHES : []);
