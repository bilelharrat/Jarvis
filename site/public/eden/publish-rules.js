// Publishing's pure parts (no DOM, no imports; tested by src/__tests__/publish.test.ts): the
// standalone HTML file Eden saves when publishing isn't available here, and its name.

/** askeden.com keeps pages up to this size (site/src/accounts/published.js PUBLISHED.bytes). */
export const PUBLISH_MAX_BYTES = 2 * 1024 * 1024;

// The saved file keeps an artifact's isolation where a <meta> can: its own inline scripts and
// styles run; it can't load or send anything (no network, no forms, no base).
export const STANDALONE_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; base-uri 'none'; form-action 'none'";

const escapeText = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// First in the saved page too, as in every artifact page: the same RTC_GUARD and inertHtml as
// src/chat/artifacts.ts (whose comment explains them) and askeden.com's site/src/eden/web.js; tests check
// every copy is the same (src/__tests__/canvas-sweep-r3.test.ts). A saved file has no sandbox, so this is
// all the page gets beyond the CSP meta: WebRTC gone (in frames it makes too), resource hints, refresh
// metas and declarative shadow roots made inert.
export const RTC_GUARD = String.raw`<script>(function g(){var W=window,O=Object,dp=O.defineProperty,gd=O.getOwnPropertyDescriptor,ap=Reflect.apply,k;for(k of["RTCPeerConnection","webkitRTCPeerConnection","RTCDataChannel"])try{dp(W,k,{value:undefined,writable:false,configurable:false})}catch(e){}try{var I=W.HTMLIFrameElement,E=W.Element,M=W.MutationObserver,N=W.Node,D=W.Document,F=W.DocumentFragment,SR=W.ShadowRoot,L=W.HTMLLinkElement,A=W.Attr,T=W.DOMTokenList,R=W.Range,WS=W.WeakSet;if(!I||!E||!M||!N||!F||!L||!A)return;var S="<script>("+g+")()<\/script>",IP=I.prototype,EP=E.prototype,NP=N.prototype,AP=A.prototype,SP=String.prototype,sw=SP.startsWith,sl=SP.slice,lc=SP.toLowerCase,cc=SP.charCodeAt,io=SP.indexOf,ex=RegExp.prototype.exec,PI=parseInt,FC=String.fromCharCode,nn=gd(NP,"nodeName").get,nt=gd(NP,"nodeType").get,ga=EP.getAttribute,sa=EP.setAttribute,sn=EP.setAttributeNS,eq=EP.querySelectorAll,fq=F.prototype.querySelectorAll,e1=EP.querySelector,f1=F.prototype.querySelector,fe=(gd(EP,"firstElementChild")||{}).get,MT=W.HTMLMetaElement,Q="iframe,link,meta",sd=gd(IP,"srcdoc"),nl=gd(NodeList.prototype,"length").get,ni=NodeList.prototype.item,rt=gd(MutationRecord.prototype,"target").get,ra=gd(MutationRecord.prototype,"addedNodes").get,ob=M.prototype.observe,an=gd(AP,"name").get,av=gd(AP,"value"),ao=gd(AP,"ownerElement").get,rl=new WS,wa=WS.prototype.add,wh=WS.prototype.has,TG=/<(?:template|meta)[\t\n\f\r \/>]/i,TS=/<(template|meta)(?=[\t\n\f\r \/>])/gi,FB=/([^\w-]|^)(shadowrootmode|http-equiv)(?=[\t\n\f\r ]*=)/gi,RF=/refresh|dns-prefetch/i,LK=/<link(?=[\s\/>])/i,LKS=/<link(?=[\s\/>])/gi,NR=/&#(?:x([0-9a-f]+)|([0-9]+));?/gi,HW=/prefetch|preconnect|prerender/i,HT=/(^|\s)(dns-prefetch|preconnect|prefetch|prerender)(?=\s|$)/gi,rx=function(r,s,f){var o="",j=0,m;r.lastIndex=0;while(m=ap(ex,r,[s])){o+=ap(sl,s,[j,m.index])+f(m);j=r.lastIndex}return o+ap(sl,s,[j])},dec=function(m){var n=m[1]?PI(m[1],16):PI(m[2],10);return n<128?FC(n):"?"},eqv=function(v){v=""+v;return ap(ex,RF,[v])&&!ap(sw,v,["off-"])?"off-"+v:v},tags=function(s){var n=s.length,b=8*n+4096,ed=O.create(null),hp,hn,hq,m,i,a,x,e,t,va,k,o="",j=0,c=function(p){return ap(cc,s,[p])},w=function(p){x=c(p);return x===32||x===9||x===10||x===12||x===13};TS.lastIndex=0;while(m=ap(ex,TS,[s])){i=TS.lastIndex;hp=O.create(null);hn=0;hq=0;for(;;){while(i<n&&(w(i)||x===47))i++;if(i>=n||c(i)===62)break;a=i++;while(i<n&&!w(i)&&x!==47&&x!==62&&x!==61)i++;t=ap(lc,ap(sl,s,[a,i]),[]);while(i<n&&w(i))i++;va="";if(c(i)===61){i++;while(i<n&&w(i))i++;x=c(i);if(x===34||x===39){e=ap(io,s,[x===34?'"':"'",i+1]);if(e<0)e=n;va=ap(sl,s,[i+1,e]);i=e+1}else{e=i;while(i<n&&!w(i)&&x!==62)i++;va=ap(sl,s,[e,i])}}if(m[1].length===4){if(t==="http-equiv"){hp[hn++]=a;if(ap(ex,RF,[rx(NR,va,dec)]))hq=1}}else if(t==="shadowrootmode")ed[a]="data-shadowrootmode"}if(hq)for(k=0;k<hn;k++)ed[hp[k]]="data-http-equiv";b-=i-TS.lastIndex;if(b<0)return rx(FB,s,function(m){return m[1]+"data-"+m[2]})}for(k in ed){o+=ap(sl,s,[j,+k])+ed[k];j=+k+ed[k].length-5}return o+ap(sl,s,[j])},html=function(v){v=""+v;if(ap(ex,TG,[v]))v=tags(v);if(ap(ex,LK,[v])&&ap(ex,HW,[rx(NR,v,dec)]))v=rx(LKS,v,function(){return"<link-off"});return v},add=function(v){v=html(v);return ap(sw,v,[S])?v:S+v},rel=function(v){return rx(HT,""+v,function(m){return m[1]+"x-"+m[2]})},nm=function(n){try{return ap(nn,n,[])}catch(e){return""}},fix=function(n){var x=nm(n),v,w;if(x==="IFRAME"){v=ap(ga,n,["srcdoc"]);if(v!==null&&(w=add(v))!==v)ap(sd.set,n,[w])}else if(x==="LINK"){v=ap(ga,n,["rel"]);if(v!==null&&(w=rel(v))!==v)ap(sa,n,["rel",w])}else if(x==="META"){v=ap(ga,n,["http-equiv"]);if(v!==null&&(w=eqv(v))!==v)ap(sa,n,["http-equiv",w])}},scan=function(n){var t,c,i,m;if(!n||typeof n!=="object")return;try{t=ap(nt,n,[])}catch(e){return}if(t===1){fix(n);if(fe&&ap(fe,n,[])===null||e1&&ap(e1,n,[Q])===null)return;c=ap(eq,n,[Q])}else if(t===11){if(f1&&ap(f1,n,[Q])===null)return;c=ap(fq,n,[Q])}else return;m=ap(nl,c,[]);for(i=0;i<m;i++)fix(ap(ni,c,[i]))},mo=new M(function(rs){for(var i=0;i<rs.length;i++){var a=ap(ra,rs[i],[]),j,m=ap(nl,a,[]);fix(ap(rt,rs[i],[]));for(j=0;j<m;j++)scan(ap(ni,a,[j]))}}),opts={childList:true,subtree:true,attributes:true,attributeFilter:["srcdoc","rel","http-equiv"]},watch=function(r){try{ap(ob,mo,[r,opts])}catch(e){}},wrap=function(o,n,f1,ix){var f=o&&o[n];if(typeof f==="function")o[n]=function(){var a=[],i;for(i=0;i<arguments.length;i++)a[i]=ix<0||i===ix?f1(arguments[i]):arguments[i];return ap(f,this,a)}},pre=function(o,n,ix){wrap(o,n,function(x){scan(x);return x},ix)},str=function(o,n,ix){wrap(o,n,html,ix)},acc=function(o,n,f1){var d=o&&gd(o,n);if(d&&d.set)dp(o,n,{get:d.get,set:function(v){ap(d.set,this,[f1(v,this)])},enumerable:d.enumerable,configurable:true})},attr=function(o,n,v){n=ap(lc,""+n,[]);var x=nm(o);return n==="srcdoc"&&x==="IFRAME"?add(v):n==="rel"&&x==="LINK"?rel(v):n==="http-equiv"&&x==="META"?eqv(v):v};dp(IP,"srcdoc",{get:function(){var v=ap(sd.get,this,[]);return ap(sw,v,[S])?ap(sl,v,[S.length]):v},set:function(v){ap(sd.set,this,[add(v)])},enumerable:true,configurable:true});acc(L.prototype,"rel",rel);if(MT)acc(MT.prototype,"httpEquiv",eqv);EP.setAttribute=function(n,v){n=""+n;return ap(sa,this,[n,attr(this,n,v)])};EP.setAttributeNS=function(s,n,v){n=""+n;return ap(sn,this,[s,n,attr(this,n,v)])};acc(AP,"value",function(v,a){var o=ap(ao,a,[]);return o?attr(o,ap(an,a,[]),v):v});var san=function(o,x){try{ap(av.set,x,[attr(o,ap(an,x,[]),ap(av.get,x,[]))])}catch(e){}};var sAN=EP.setAttributeNode,sANS=EP.setAttributeNodeNS;EP.setAttributeNode=function(x){san(this,x);return ap(sAN,this,[x])};if(sANS)EP.setAttributeNodeNS=function(x){san(this,x);return ap(sANS,this,[x])};if(T){var rg=gd(L.prototype,"relList");if(rg&&rg.get)dp(L.prototype,"relList",{get:function(){var l=ap(rg.get,this,[]);ap(wa,rl,[l]);return l},enumerable:true,configurable:true});var tok=function(n,ix){var f=T.prototype[n];if(typeof f==="function")T.prototype[n]=function(){var a=[],i,h=ap(wh,rl,[this]);for(i=0;i<arguments.length;i++)a[i]=h&&(ix<0||i===ix)?rel(arguments[i]):arguments[i];return ap(f,this,a)}};tok("add",-1);tok("toggle",0);tok("replace",1);var tv=gd(T.prototype,"value");if(tv&&tv.set)dp(T.prototype,"value",{get:tv.get,set:function(v){ap(tv.set,this,[ap(wh,rl,[this])?rel(v):v])},enumerable:true,configurable:true})}for(k of["appendChild","insertBefore","replaceChild"])pre(NP,k,0);for(k of["append","prepend","replaceChildren","before","after","replaceWith"]){pre(EP,k,-1);pre(F.prototype,k,-1);if(D)pre(D.prototype,k,-1)}pre(EP,"insertAdjacentElement",1);if(R){pre(R.prototype,"insertNode",0);pre(R.prototype,"surroundContents",0)}acc(EP,"innerHTML",html);acc(EP,"outerHTML",html);str(EP,"insertAdjacentHTML",1);str(EP,"setHTMLUnsafe",0);str(EP,"setHTML",0);if(SR){acc(SR.prototype,"innerHTML",html);str(SR.prototype,"setHTMLUnsafe",0);str(SR.prototype,"setHTML",0)}if(D){str(D,"parseHTMLUnsafe",0);str(D,"parseHTML",0);str(D.prototype,"write",-1);str(D.prototype,"writeln",-1);acc(D.prototype,"body",function(v){scan(v);return v})}var as=EP.attachShadow;if(as)EP.attachShadow=function(o){var r=ap(as,this,[o]);watch(r);return r};watch(document)}catch(e){}})()</script>`;

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
/**
 * The page as a file that opens anywhere (a fragment gets a document around it), with the CSP and
 * RTC_GUARD first in <head>. Only a <head> (or <html>) with nothing but a doctype before it counts:
 * a "<head>" inside an earlier comment or script must not take the CSP with it (it would be inert
 * there); otherwise they go first in the document, right after a leading doctype.
 */
export function standaloneHtml(html, title = 'Eden page') {
  const first = `<meta http-equiv="Content-Security-Policy" content="${STANDALONE_CSP}">${RTC_GUARD}`;
  let doc = inertHtml(String(html || ''));
  if (!/<html[\s>]|<!doctype/i.test(doc)) doc = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeText(title)}</title></head><body>${doc}</body></html>`;
  const plain = (before, html) => new RegExp(`^\\s*(?:<!doctype[^>]*>\\s*)?${html ? '(?:<html(?:\\s[^>]*)?>\\s*)?' : ''}$`, 'i').test(before);
  const head = /<head(?:\s[^>]*)?>/i.exec(doc);
  if (head && plain(doc.slice(0, head.index), true)) return doc.slice(0, head.index + head[0].length) + `\n${first}` + doc.slice(head.index + head[0].length);
  const root = /<html(?:\s[^>]*)?>/i.exec(doc);
  if (!head && root && plain(doc.slice(0, root.index), false)) return doc.slice(0, root.index + root[0].length) + `<head>${first}</head>` + doc.slice(root.index + root[0].length);
  const lead = /^(?:\s|<!--[\s\S]*?-->)*<!doctype[^>]*>/i.exec(doc);
  return lead ? doc.slice(0, lead[0].length) + first + doc.slice(lead[0].length) : first + doc;
}

/** "Tip calculator" → "tip-calculator.html" */
export function pageFileName(title) {
  const slug = String(title || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ').trim().replace(/[\s-]+/g, '-').slice(0, 60).replace(/-+$/, '');
  return `${slug || 'eden-page'}.html`;
}

export const byteSize = (s) => new TextEncoder().encode(String(s)).length;
