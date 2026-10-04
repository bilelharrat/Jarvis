// Usage: node shot.mjs <html-file> <out.png> [width] [height]
import { createRequire } from 'module';
const require = createRequire('/Users/bilelharrrat/Investment agent/Experimental-Reports-Update/frontend/package.json');
const { chromium } = require('playwright');
const [file, out, w = '1440', h = '900'] = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: +w, height: +h }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto('file://' + file);
await page.waitForTimeout(1200);
await page.screenshot({ path: out });
await browser.close();
if (errors.length) console.log('ERRORS:\n' + errors.join('\n')); else console.log('ok', out);
