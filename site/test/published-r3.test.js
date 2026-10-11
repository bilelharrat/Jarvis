// Round-3 bug-sweep fixes for artifacts and published pages on askeden.com (askeden/docs/bug-sweep/
// r3-ask-eden-canvas-docs.md, "Fixes (round 3)"): a refresh meta is made inert (AV3-1), the
// declarative-shadow-root rule touches only real <template> tags (AV3-3), the artifact CSP has
// form-action / base-uri (defence in depth). The guard text itself is checked against askeden's
// copy in askeden src/__tests__/canvas-sweep-r3.test.ts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ARTIFACT_CSP, RTC_GUARD, inertHtml, withRtcGuard } from '../src/eden/web.js';

test('AV3-1: a refresh or dns-prefetch-control meta is made inert, however it is spelled', () => {
  for (const [input, out] of [
    ['<meta http-equiv="refresh" content="0;url=//y.example">', '<meta data-http-equiv="refresh" content="0;url=//y.example">'],
    ['<META HTTP-EQUIV=REFRESH CONTENT="0;URL=http://x.example">', '<META data-http-equiv=REFRESH CONTENT="0;URL=http://x.example">'],
    ['<meta content="a>b" http-equiv=\'Re&#102;resh\'>', '<meta content="a>b" data-http-equiv=\'Re&#102;resh\'>'],
    ['<meta/http-equiv=refresh/content=0;url=//x>', '<meta/data-http-equiv=refresh/content=0;url=//x>'],
    ['<meta http-equiv="x-dns-prefetch-control" content="on">', '<meta data-http-equiv="x-dns-prefetch-control" content="on">'],
  ]) assert.equal(inertHtml(input), out, input);
  const page = '<!doctype html><meta http-equiv="refresh" content="0;url=//y.example"><p>x';
  assert.equal(withRtcGuard(page), `<!doctype html>${RTC_GUARD}<meta data-http-equiv="refresh" content="0;url=//y.example"><p>x`);
  const keep = '<meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="content-type" content="text/html">';
  assert.equal(inertHtml(keep), keep, 'other metas are kept');
  assert.match(RTC_GUARD, /http-equiv/, 'the guard handles metas a script adds');
});

test('AV3-3: shadowrootmode outside a real <template> tag is left alone', () => {
  for (const h of [
    '<pre>Use &lt;template shadowrootmode=open&gt; or elem.shadowrootmode = x</pre>',
    '<script>el.shadowrootmode = "open"; var s = "shadowrootmode=closed";</script>',
    '<div title="shadowrootmode=open">x</div><x-template shadowrootmode=open></x-template>',
  ]) assert.equal(inertHtml(h), h, h);
  assert.equal(inertHtml('<template title="a>b" shadowrootmode=open>'), '<template title="a>b" data-shadowrootmode=open>');
});

test('ARTIFACT_CSP: no forms, no <base>, framed only by askeden.com', () => {
  assert.match(ARTIFACT_CSP, /form-action 'none'/);
  assert.match(ARTIFACT_CSP, /base-uri 'none'/);
  assert.match(ARTIFACT_CSP, /frame-ancestors 'self'/);
});
