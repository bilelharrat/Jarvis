// Ask Eden for Excel's own files (public/addins/excel/, its source: they live only here): the task
// pane, the sign-in return page, the cell functions and the add-in manifest, served from askeden.com.
//
//   /addins/excel/manifest.xml   what Excel (or Microsoft's store) installs
//   /addins/excel/*.html         the task pane and /addins/excel/connected (the Office dialog's last
//                                page): Office.js from Microsoft's CDN, framed only by Office's hosts
//                                (Excel on the web shows the pane in a frame; the Mac and Windows
//                                apps open it in their own web view)
//   /addins/excel/*.js|css|json|png   their scripts, styles, the functions' metadata and icons
//
// Nothing here reads a session: the pane signs in through /eden/connect (client "excel", ask.js) and
// keeps its own scoped token.

import { page, withHeaders } from './web.js';

const OFFICE_JS = 'https://appsforoffice.microsoft.com';
// Where Excel on the web frames the pane (Office for the web, OneDrive, SharePoint, Teams), and the US
// government clouds' hosts (GCC High: *.office365.us, *.sharepoint.us) and microsoft365.com. frame-ancestors
// checks every ancestor, so a host missing here blocks the pane there.
const OFFICE_FRAMES = 'https://*.officeapps.live.com https://*.office.com https://*.office365.com https://*.sharepoint.com https://*.live.com https://*.microsoft.com https://*.cloud.microsoft https://*.microsoft365.com https://*.office365.us https://*.sharepoint.us';
export const ADDIN_CSP = `default-src 'none'; script-src 'self' ${OFFICE_JS}; style-src 'self' 'unsafe-inline'; img-src 'self' data: ${OFFICE_JS}; font-src 'self' data:; connect-src 'self' ${OFFICE_JS}; frame-src ${OFFICE_JS}; base-uri 'none'; form-action 'none'; frame-ancestors 'self' ${OFFICE_FRAMES}`;

const TYPES = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  png: 'image/png',
  svg: 'image/svg+xml',
};

/** The response for an /addins/excel/ path, or null when it isn't one. */
export async function addinFile(request, env, path) {
  if (!path.startsWith('/addins/excel/') && path !== '/addins/excel') return null;
  // /addins/excel (no slash): the pane's relative lib.js, taskpane.js and .css would miss; go to /addins/excel/.
  const url = new URL(request.url);
  if (url.pathname === '/addins/excel') return new Response(null, { status: 301, headers: { location: `/addins/excel/${url.search}`, 'cache-control': 'public, max-age=3600' } });
  let name = path === '/addins/excel' ? 'taskpane.html' : path.slice('/addins/excel/'.length);
  if (name === '' || name === 'taskpane') name = 'taskpane.html';
  if (name === 'connected') name = 'connected.html';
  if (!/^[a-z0-9-]+(\/[a-z0-9-]+)?\.(html|js|css|json|xml|png|svg)$/.test(name)) return null;
  const ext = name.split('.').pop();
  const assetPath = `/addins/excel/${name}`.replace(/\.html$/, '');
  const asset = await env.ASSETS.fetch(new Request(new URL(ext === 'html' ? assetPath : `/addins/excel/${name}`, request.url), { method: 'GET' }));
  if (asset.status === 404) return null;
  if (ext === 'html') {
    // The pane may be framed by Office's hosts only; no X-Frame-Options (it can't list them).
    // connected.html arrives with a live connect code in its address: no cache keeps it. COOP unsafe-none:
    // Office on the web's dialog talks to its pane through window.opener.
    const cache = name === 'connected.html' ? 'no-store' : 'public, max-age=300';
    return withHeaders(page(asset, ADDIN_CSP, { cache }), { 'x-frame-options': null, 'cross-origin-opener-policy': 'unsafe-none', 'content-type': TYPES.html });
  }
  // Office reads the manifest and the functions' metadata from its own servers and apps.
  const shared = ext === 'xml' || ext === 'json' || ext === 'png' || ext === 'svg';
  return withHeaders(asset, {
    'content-type': TYPES[ext],
    'cache-control': 'public, max-age=300',
    'x-content-type-options': 'nosniff',
    ...(shared ? { 'access-control-allow-origin': '*', 'cross-origin-resource-policy': 'cross-origin' } : {}),
  });
}
