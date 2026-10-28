#!/usr/bin/env node
// Re-checks Eden Travel's card rates (src/travel/cards.js) against the issuers' own pages: each page is rendered in
// headless Chrome and must still say every phrase in the card's `says`. All found: with --write, the card's `checked`
// date moves to today. Any missing: the card is listed with the page's rate lines, for a person to read and fix by
// hand (rates are never rewritten from a page by this script). Exit 1 when any card needs a person.
//
//   node scripts/check-card-rates.mjs [--write]
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CARDS } from '../src/travel/cards.js';

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const FILE = fileURLToPath(new URL('../src/travel/cards.js', import.meta.url));
const write = process.argv.includes('--write');
const today = new Date().toISOString().slice(0, 10);

// as cards.js's own `plain`, so a phrase there matches the page however it is marked up
const plain = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[®™℠]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
export const pageText = (html) => html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/&[a-z]+;|&#\d+;/g, ' ');

function render(url, profile) {
  return execFileSync(CHROME, ['--headless=new', '--disable-gpu', `--user-data-dir=${profile}`, '--virtual-time-budget=15000', '--dump-dom', url], { encoding: 'utf8', timeout: 90_000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
}

const profile = mkdtempSync(join(tmpdir(), 'card-rates-'));
const needs = [];
let src = readFileSync(FILE, 'utf8');
try {
  for (const c of CARDS) {
    let text = '';
    try { text = plain(pageText(render(c.source, profile))); } catch (e) { needs.push(c.name); console.log(`✗ ${c.name}: the page did not load (${e.message.split('\n')[0]})`); continue; }
    const missing = (c.says || []).filter((p) => !text.includes(plain(p)));
    if (!c.says || !c.says.length) { needs.push(c.name); console.log(`✗ ${c.name}: no phrases to check (add says: in cards.js)`); continue; }
    if (missing.length) {
      needs.push(c.name);
      console.log(`✗ ${c.name}: the page no longer says:\n${missing.map((m) => `    “${m}”`).join('\n')}\n  its rate lines now:`);
      for (const m of new Set(text.match(/.{0,50}\b\d+(\.\d+)?x\b.{0,70}/g) || [])) console.log(`    ${m}`);
      continue;
    }
    console.log(`✓ ${c.name}: all ${c.says.length} rates still on ${c.source}`);
    if (write) src = src.replace(`source: '${c.source}', checked: '${c.checked}'`, `source: '${c.source}', checked: '${today}'`);
  }
} finally {
  rmSync(profile, { recursive: true, force: true });
}
if (write) writeFileSync(FILE, src);
if (needs.length) { console.log(`\n${needs.length} card(s) need a person to re-read the issuer’s page: ${needs.join(', ')}`); process.exit(1); }
