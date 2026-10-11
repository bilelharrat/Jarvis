// What every browser-facing part of askeden.com shares: security headers and Content
// Security Policies, cookies, and the same-origin rule for anything that changes something.

// Eden's page (docs/chat-api.md in the Model Router repo), plus: not framed by anyone.
export const EDEN_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; frame-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
// The sign-in page: its own script and stylesheet, nothing else.
export const SIGNIN_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
// /signin itself: that, plus Cloudflare Turnstile's script and challenge frame (accounts/turnstile.js),
// and its forms (Apple and Google with the Turnstile token) posting here and redirecting on to them.
export const SIGNIN_PAGE_CSP =
  "default-src 'none'; script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self' https://appleid.apple.com https://accounts.google.com; frame-ancestors 'none'";
// An artifact: its own inline scripts run in an opaque origin, with no network, no cookies,
// no storage and no way to the page (docs/chat-api.md), framed only by Eden itself.
// WebRTC is the one way out CSP can't close in Chrome (`webrtc 'block'` works only where a browser knows
// it), so every artifact page also starts with RTC_GUARD (withRtcGuard).
export const ARTIFACT_CSP =
  "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; form-action 'none'; base-uri 'none'; frame-ancestors 'self'; webrtc 'block'";
// The first script of every artifact and published page: WebRTC's constructors gone for good before the
// page's own code runs. A frame the page makes is another opaque origin with its own window, so the guard
// also puts itself first in every srcdoc (setter, setAttribute/Attr nodes, and a MutationObserver over the
// document and its shadow roots) and turns off declarative shadow roots, which would hide a frame from it;
// and it renames resource-hint rel tokens (dns-prefetch, preconnect, prefetch, prerender: Chrome resolves and
// connects whatever the CSP says) before a link is inserted, and refresh metas the same way. Same text as askeden src/chat/artifacts.ts
// RTC_GUARD, whose comment lists the paths and the residual (a separate origin for pages: TODO.md).
export const RTC_GUARD = String.raw`<script>(function g(){var W=window,O=Object,dp=O.defineProperty,gd=O.getOwnPropertyDescriptor,ap=Reflect.apply,k;for(k of["RTCPeerConnection","webkitRTCPeerConnection","RTCDataChannel"])try{dp(W,k,{value:undefined,writable:false,configurable:false})}catch(e){}try{var I=W.HTMLIFrameElement,E=W.Element,M=W.MutationObserver,N=W.Node,D=W.Document,F=W.DocumentFragment,SR=W.ShadowRoot,L=W.HTMLLinkElement,A=W.Attr,T=W.DOMTokenList,R=W.Range,WS=W.WeakSet;if(!I||!E||!M||!N||!F||!L||!A)return;var S="<script>("+g+")()<\/script>",IP=I.prototype,EP=E.prototype,NP=N.prototype,AP=A.prototype,SP=String.prototype,sw=SP.startsWith,sl=SP.slice,lc=SP.toLowerCase,cc=SP.charCodeAt,io=SP.indexOf,ex=RegExp.prototype.exec,PI=parseInt,FC=String.fromCharCode,nn=gd(NP,"nodeName").get,nt=gd(NP,"nodeType").get,ga=EP.getAttribute,sa=EP.setAttribute,sn=EP.setAttributeNS,eq=EP.querySelectorAll,fq=F.prototype.querySelectorAll,e1=EP.querySelector,f1=F.prototype.querySelector,fe=(gd(EP,"firstElementChild")||{}).get,MT=W.HTMLMetaElement,Q="iframe,link,meta",sd=gd(IP,"srcdoc"),nl=gd(NodeList.prototype,"length").get,ni=NodeList.prototype.item,rt=gd(MutationRecord.prototype,"target").get,ra=gd(MutationRecord.prototype,"addedNodes").get,ob=M.prototype.observe,an=gd(AP,"name").get,av=gd(AP,"value"),ao=gd(AP,"ownerElement").get,rl=new WS,wa=WS.prototype.add,wh=WS.prototype.has,TG=/<(?:template|meta)[\t\n\f\r \/>]/i,TS=/<(template|meta)(?=[\t\n\f\r \/>])/gi,FB=/([^\w-]|^)(shadowrootmode|http-equiv)(?=[\t\n\f\r ]*=)/gi,RF=/refresh|dns-prefetch/i,LK=/<link(?=[\s\/>])/i,LKS=/<link(?=[\s\/>])/gi,NR=/&#(?:x([0-9a-f]+)|([0-9]+));?/gi,HW=/prefetch|preconnect|prerender/i,HT=/(^|\s)(dns-prefetch|preconnect|prefetch|prerender)(?=\s|$)/gi,rx=function(r,s,f){var o="",j=0,m;r.lastIndex=0;while(m=ap(ex,r,[s])){o+=ap(sl,s,[j,m.index])+f(m);j=r.lastIndex}return o+ap(sl,s,[j])},dec=function(m){var n=m[1]?PI(m[1],16):PI(m[2],10);return n<128?FC(n):"?"},eqv=function(v){v=""+v;return ap(ex,RF,[v])&&!ap(sw,v,["off-"])?"off-"+v:v},tags=function(s){var n=s.length,b=8*n+4096,ed=O.create(null),hp,hn,hq,m,i,a,x,e,t,va,k,o="",j=0,c=function(p){return ap(cc,s,[p])},w=function(p){x=c(p);return x===32||x===9||x===10||x===12||x===13};TS.lastIndex=0;while(m=ap(ex,TS,[s])){i=TS.lastIndex;hp=O.create(null);hn=0;hq=0;for(;;){while(i<n&&(w(i)||x===47))i++;if(i>=n||c(i)===62)break;a=i++;while(i<n&&!w(i)&&x!==47&&x!==62&&x!==61)i++;t=ap(lc,ap(sl,s,[a,i]),[]);while(i<n&&w(i))i++;va="";if(c(i)===61){i++;while(i<n&&w(i))i++;x=c(i);if(x===34||x===39){e=ap(io,s,[x===34?'"':"'",i+1]);if(e<0)e=n;va=ap(sl,s,[i+1,e]);i=e+1}else{e=i;while(i<n&&!w(i)&&x!==62)i++;va=ap(sl,s,[e,i])}}if(m[1].length===4){if(t==="http-equiv"){hp[hn++]=a;if(ap(ex,RF,[rx(NR,va,dec)]))hq=1}}else if(t==="shadowrootmode")ed[a]="data-shadowrootmode"}if(hq)for(k=0;k<hn;k++)ed[hp[k]]="data-http-equiv";b-=i-TS.lastIndex;if(b<0)return rx(FB,s,function(m){return m[1]+"data-"+m[2]})}for(k in ed){o+=ap(sl,s,[j,+k])+ed[k];j=+k+ed[k].length-5}return o+ap(sl,s,[j])},html=function(v){v=""+v;if(ap(ex,TG,[v]))v=tags(v);if(ap(ex,LK,[v])&&ap(ex,HW,[rx(NR,v,dec)]))v=rx(LKS,v,function(){return"<link-off"});return v},add=function(v){v=html(v);return ap(sw,v,[S])?v:S+v},rel=function(v){return rx(HT,""+v,function(m){return m[1]+"x-"+m[2]})},nm=function(n){try{return ap(nn,n,[])}catch(e){return""}},fix=function(n){var x=nm(n),v,w;if(x==="IFRAME"){v=ap(ga,n,["srcdoc"]);if(v!==null&&(w=add(v))!==v)ap(sd.set,n,[w])}else if(x==="LINK"){v=ap(ga,n,["rel"]);if(v!==null&&(w=rel(v))!==v)ap(sa,n,["rel",w])}else if(x==="META"){v=ap(ga,n,["http-equiv"]);if(v!==null&&(w=eqv(v))!==v)ap(sa,n,["http-equiv",w])}},scan=function(n){var t,c,i,m;if(!n||typeof n!=="object")return;try{t=ap(nt,n,[])}catch(e){return}if(t===1){fix(n);if(fe&&ap(fe,n,[])===null||e1&&ap(e1,n,[Q])===null)return;c=ap(eq,n,[Q])}else if(t===11){if(f1&&ap(f1,n,[Q])===null)return;c=ap(fq,n,[Q])}else return;m=ap(nl,c,[]);for(i=0;i<m;i++)fix(ap(ni,c,[i]))},mo=new M(function(rs){for(var i=0;i<rs.length;i++){var a=ap(ra,rs[i],[]),j,m=ap(nl,a,[]);fix(ap(rt,rs[i],[]));for(j=0;j<m;j++)scan(ap(ni,a,[j]))}}),opts={childList:true,subtree:true,attributes:true,attributeFilter:["srcdoc","rel","http-equiv"]},watch=function(r){try{ap(ob,mo,[r,opts])}catch(e){}},wrap=function(o,n,f1,ix){var f=o&&o[n];if(typeof f==="function")o[n]=function(){var a=[],i;for(i=0;i<arguments.length;i++)a[i]=ix<0||i===ix?f1(arguments[i]):arguments[i];return ap(f,this,a)}},pre=function(o,n,ix){wrap(o,n,function(x){scan(x);return x},ix)},str=function(o,n,ix){wrap(o,n,html,ix)},acc=function(o,n,f1){var d=o&&gd(o,n);if(d&&d.set)dp(o,n,{get:d.get,set:function(v){ap(d.set,this,[f1(v,this)])},enumerable:d.enumerable,configurable:true})},attr=function(o,n,v){n=ap(lc,""+n,[]);var x=nm(o);return n==="srcdoc"&&x==="IFRAME"?add(v):n==="rel"&&x==="LINK"?rel(v):n==="http-equiv"&&x==="META"?eqv(v):v};dp(IP,"srcdoc",{get:function(){var v=ap(sd.get,this,[]);return ap(sw,v,[S])?ap(sl,v,[S.length]):v},set:function(v){ap(sd.set,this,[add(v)])},enumerable:true,configurable:true});acc(L.prototype,"rel",rel);if(MT)acc(MT.prototype,"httpEquiv",eqv);EP.setAttribute=function(n,v){n=""+n;return ap(sa,this,[n,attr(this,n,v)])};EP.setAttributeNS=function(s,n,v){n=""+n;return ap(sn,this,[s,n,attr(this,n,v)])};acc(AP,"value",function(v,a){var o=ap(ao,a,[]);return o?attr(o,ap(an,a,[]),v):v});var san=function(o,x){try{ap(av.set,x,[attr(o,ap(an,x,[]),ap(av.get,x,[]))])}catch(e){}};var sAN=EP.setAttributeNode,sANS=EP.setAttributeNodeNS;EP.setAttributeNode=function(x){san(this,x);return ap(sAN,this,[x])};if(sANS)EP.setAttributeNodeNS=function(x){san(this,x);return ap(sANS,this,[x])};if(T){var rg=gd(L.prototype,"relList");if(rg&&rg.get)dp(L.prototype,"relList",{get:function(){var l=ap(rg.get,this,[]);ap(wa,rl,[l]);return l},enumerable:true,configurable:true});var tok=function(n,ix){var f=T.prototype[n];if(typeof f==="function")T.prototype[n]=function(){var a=[],i,h=ap(wh,rl,[this]);for(i=0;i<arguments.length;i++)a[i]=h&&(ix<0||i===ix)?rel(arguments[i]):arguments[i];return ap(f,this,a)}};tok("add",-1);tok("toggle",0);tok("replace",1);var tv=gd(T.prototype,"value");if(tv&&tv.set)dp(T.prototype,"value",{get:tv.get,set:function(v){ap(tv.set,this,[ap(wh,rl,[this])?rel(v):v])},enumerable:true,configurable:true})}for(k of["appendChild","insertBefore","replaceChild"])pre(NP,k,0);for(k of["append","prepend","replaceChildren","before","after","replaceWith"]){pre(EP,k,-1);pre(F.prototype,k,-1);if(D)pre(D.prototype,k,-1)}pre(EP,"insertAdjacentElement",1);if(R){pre(R.prototype,"insertNode",0);pre(R.prototype,"surroundContents",0)}acc(EP,"innerHTML",html);acc(EP,"outerHTML",html);str(EP,"insertAdjacentHTML",1);str(EP,"setHTMLUnsafe",0);str(EP,"setHTML",0);if(SR){acc(SR.prototype,"innerHTML",html);str(SR.prototype,"setHTMLUnsafe",0);str(SR.prototype,"setHTML",0)}if(D){str(D,"parseHTMLUnsafe",0);str(D,"parseHTML",0);str(D.prototype,"write",-1);str(D.prototype,"writeln",-1);acc(D.prototype,"body",function(v){scan(v);return v})}var as=EP.attachShadow;if(as)EP.attachShadow=function(o){var r=ap(as,this,[o]);watch(r);return r};watch(document)}catch(e){}})()</script>`;
/**
 * A page's HTML with what RTC_GUARD can't see turned inert (it acts at parse time): declarative shadow roots
 * (data-shadowrootmode), refresh / x-dns-prefetch-control metas (data-http-equiv: a refresh to another host is
 * resolved and connected before the sandbox blocks it) and, when a resource hint could be in it (numeric
 * character references decoded first), every <link> tag (<link-off>). <template>/<meta> start tags are read
 * as the HTML tokenizer reads them, so the words in text, scripts or other attributes stay. Same code as
 * askeden's inertHtml (src/chat/artifacts.ts, whose comment explains it) and web/chat/publish-rules.js (tests check).
 */
export function inertHtml(html) {
  const tags = (s) => {
    const n = s.length, at = /<(template|meta)(?=[\t\n\f\r />])/gi, edits = new Map();
    const ws = (i) => { const c = s.charCodeAt(i); return c === 32 || c === 9 || c === 10 || c === 12 || c === 13; };
    const ref = (v) => v.replace(/&#(?:x([0-9a-f]+)|([0-9]+));?/gi, (_m, x, d) => { const c = x ? parseInt(x, 16) : parseInt(d, 10); return c < 128 ? String.fromCharCode(c) : '?'; });
    let budget = 8 * n + 4096, m;
    while ((m = at.exec(s))) {
      const meta = m[1].length === 4, equiv = [];
      let i = at.lastIndex, off = false;
      for (;;) { // the tokenizer's before-attribute-name … attribute-value states
        while (i < n && (ws(i) || s[i] === '/')) i++;
        if (i >= n || s[i] === '>') break;
        const from = i++;
        while (i < n && !ws(i) && !'/>='.includes(s[i])) i++;
        const name = s.slice(from, i).toLowerCase();
        while (i < n && ws(i)) i++;
        let value = '';
        if (s[i] === '=') {
          i++;
          while (i < n && ws(i)) i++;
          if (s[i] === '"' || s[i] === "'") { let e = s.indexOf(s[i], i + 1); if (e < 0) e = n; value = s.slice(i + 1, e); i = e + 1; }
          else { const v = i; while (i < n && !ws(i) && s[i] !== '>') i++; value = s.slice(v, i); }
        }
        if (meta) { if (name === 'http-equiv') { equiv.push(from); if (/refresh|dns-prefetch/i.test(ref(value))) off = true; } }
        else if (name === 'shadowrootmode') edits.set(from, 'data-shadowrootmode');
      }
      if (off) for (const from of equiv) edits.set(from, 'data-http-equiv'); // every copy: a later duplicate would take over
      budget -= i - at.lastIndex;
      if (budget < 0) return s.replace(/([^\w-]|^)(shadowrootmode|http-equiv)(?=[\t\n\f\r ]*=)/gi, '$1data-$2');
    }
    let out = '', j = 0;
    for (const [from, name] of [...edits].sort((a, b) => a[0] - b[0])) { out += s.slice(j, from) + name; j = from + name.length - 5; } // "data-" + the old name
    return out + s.slice(j);
  };
  let s = String(html ?? '');
  if (/<(?:template|meta)[\t\n\f\r />]/i.test(s)) s = tags(s);
  if (!/<link(?=[\s/>])/i.test(s)) return s;
  const decoded = s.replace(/&#(?:x([0-9a-f]+)|([0-9]+));?/gi, (_m, x, d) => { const n = x ? parseInt(x, 16) : parseInt(d, 10); return n < 128 ? String.fromCharCode(n) : '?'; });
  return /prefetch|preconnect|prerender/i.test(decoded) ? s.replace(/<link(?=[\s/>])/gi, '<link-off') : s;
}
/** The page made inert (inertHtml) with RTC_GUARD first: right after a leading doctype (kept: standards mode), else at the very start. */
export function withRtcGuard(html) {
  const s = inertHtml(html);
  const lead = /^(?:\s|<!--[\s\S]*?-->)*<!doctype[^>]*>/i.exec(s);
  return lead ? s.slice(0, lead[0].length) + RTC_GUARD + s.slice(lead[0].length) : RTC_GUARD + s;
}
// A tab's own visit to an artifact or published page gets this shell, which frames the page with the
// artifact sandbox (no allow-top-navigation) under frame-src 'self': shown top-level, a page could
// redirect visitors or draw a form on askeden.com and send what they type out by navigating (CSP has no
// rule for that). The frame's own request (Sec-Fetch-Dest: iframe) gets the page. A separate user-content
// domain would be stronger still (TODO.md, owner's decision).
export const SHELL_CSP =
  "default-src 'none'; frame-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const escAttr = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
/** The shell page framing `src` (a same-origin path). */
export function framedShell(src, title = 'Eden page') {
  const t = escAttr(String(title || 'Eden page').slice(0, 200));
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${t}</title>`
    + '<style>html,body{margin:0;height:100%;background:#fff}iframe{display:block;border:0;width:100%;height:100%}</style></head>'
    + `<body><iframe sandbox="allow-scripts" src="${escAttr(src)}" title="${t}" referrerpolicy="no-referrer"></iframe></body></html>`;
}
/** A tab's own visit (not a frame, not a fetch). */
export const topLevelVisit = (request) => request.headers.get('sec-fetch-dest') === 'document';
// The code canvas's runner (Eden's runner.html): an opaque-origin sandbox whose runs are Web
// Workers; its only network is cdn.jsdelivr.net for Pyodide (Python in WebAssembly); framing it is harmless (static, no secrets).
export const RUNNER_CSP =
  "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob: https://cdn.jsdelivr.net; worker-src blob:; connect-src https://cdn.jsdelivr.net; style-src 'unsafe-inline'; img-src data:; webrtc 'block'";
// The code canvas's live UI preview for React (Eden's app-frame.html): the runner's opaque-origin sandbox plus
// forms (submit events only: form-action 'none'); its only network is esm.sh (React and the packages the code
// imports), cdn.jsdelivr.net (Tailwind) and Google Fonts; no other images or requests, so code Eden writes can't
// carry a chat out in an address. Same as askeden src/chat/artifacts.ts.
export const APP_CSP =
  "sandbox allow-scripts allow-forms; default-src 'none'; script-src 'unsafe-inline' blob: https://esm.sh https://cdn.jsdelivr.net; connect-src https://esm.sh https://cdn.jsdelivr.net; style-src 'unsafe-inline' https://esm.sh https://cdn.jsdelivr.net https://fonts.googleapis.com; font-src data: https://fonts.gstatic.com https://cdn.jsdelivr.net; img-src data: blob: https://esm.sh https://cdn.jsdelivr.net; media-src data: blob:; form-action 'none'; base-uri 'none'; webrtc 'block'";
// The spreadsheet canvas's Google Picker popup (askeden web/chat/sheet-picker.html, Q15): Google's Picker script and
// frames on a page of its own, so Eden's page keeps its 'self'-only policy. Same as askeden src/chat/sheet-routes.ts.
export const SHEET_PICKER_CSP =
  "default-src 'self'; script-src 'self' https://apis.google.com https://*.gstatic.com; frame-src https://docs.google.com https://drive.google.com https://content.googleapis.com https://accounts.google.com; connect-src 'self' https://*.googleapis.com https://*.google.com; style-src 'self' 'unsafe-inline' https://*.gstatic.com https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: https://*.gstatic.com https://*.googleusercontent.com https://*.google.com; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
// The J.A.R.V.I.S. landing page (/download, /jarvis): its inline script and styles, and Google Fonts.
export const LANDING_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

const BASELINE = {
  'strict-transport-security': 'max-age=31536000',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
};

const PAGE = {
  'x-frame-options': 'DENY',
  'referrer-policy': 'same-origin',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
};

/**
 * The response with these headers set (a copy: fetched and redirect responses have fixed
 * headers). A WebSocket upgrade is returned as it is.
 */
export function withHeaders(response, headers) {
  if (response.status === 101 || response.webSocket) return response;
  const out = new Response(response.body, response);
  for (const [name, value] of Object.entries(headers)) {
    if (value === null) out.headers.delete(name);
    else out.headers.set(name, value);
  }
  return out;
}

/** Every answer: HSTS, nosniff, a referrer policy (unless the route chose its own). */
export function baseline(response) {
  if (response.status === 101 || response.webSocket) return response;
  const missing = Object.entries(BASELINE).filter(([name]) => !response.headers.has(name));
  return missing.length ? withHeaders(response, Object.fromEntries(missing)) : response;
}

// Eden's own page may use the microphone (dictation, talk mode), asked for only on a click;
// every other page keeps it off, and no frame gets it.
export const EDEN_PERMISSIONS = 'camera=(), microphone=(self), geolocation=(), payment=(), usb=()';

/** A page's headers: its CSP, no framing, no caching, the browser features it doesn't use off. */
export function page(response, csp, { cache = 'no-store', permissions } = {}) {
  return withHeaders(response, { ...PAGE, ...(permissions ? { 'permissions-policy': permissions } : {}), 'content-security-policy': csp, 'cache-control': cache });
}

// ── cookies ──
//
// __Host- cookies: Secure, Path=/, no Domain, so only this exact host (askeden.com or www.)
// ever gets them. All HttpOnly: no script, Eden's included, can read them.

export const SESSION_COOKIE = '__Host-eden';
export const LINK_COOKIE = '__Host-eden-link';
export const APPLE_COOKIE = '__Host-eden-apple';

export function cookies(request) {
  const out = {};
  for (const part of String(request.headers.get('cookie') || '').split(';')) {
    const at = part.indexOf('=');
    if (at < 0) continue;
    const name = part.slice(0, at).trim();
    if (name && !(name in out)) out[name] = part.slice(at + 1).trim();
  }
  return out;
}

/** A Set-Cookie value. `sameSite` Strict unless said; `maxAge` 0 clears it. */
export function cookie(name, value, { maxAge, sameSite = 'Strict' } = {}) {
  const parts = [`${name}=${value}`, 'Path=/', 'Secure', 'HttpOnly', `SameSite=${sameSite}`];
  if (maxAge !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(maxAge))}`);
  return parts.join('; ');
}

export const clearCookie = (name, sameSite = 'Strict') => cookie(name, '', { maxAge: 0, sameSite });

// ── who may ask ──

/** Origin header is this very origin (a page of this site sent it). */
export function sameOrigin(request) {
  const origin = request.headers.get('origin');
  return Boolean(origin) && origin === new URL(request.url).origin;
}

/**
 * The rule for every /api request that changes something (POST, PUT, PATCH, DELETE) and for
 * the relay's WebSocket upgrade: an Origin, when a browser sends one, must be this site's.
 * The apps send none; any other page (or a sandboxed frame's "null") is refused.
 */
export function foreignOrigin(request) {
  const origin = request.headers.get('origin');
  if (origin === null) return false;
  return origin !== new URL(request.url).origin;
}

/** Fetch metadata says another site made the browser send this. */
export const crossSite = (request) => (request.headers.get('sec-fetch-site') || '') === 'cross-site';

export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  });
}

/** Eden's error shape ({ error }, as the page reads it) with a code for machines. */
export const problem = (status, error, code, headers = {}) => json({ error, code }, status, headers);
