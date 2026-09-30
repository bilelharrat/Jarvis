// What the built-in browser makes of an address typed in its bar, or one JARVIS asks it to
// open: a web page, a page on this Mac or the local network, a file the user typed, or
// words for a Google search.
//
// - http(s)://… as it is; a host (with a port and a path, or not) gets https, except this
//   Mac and the local network (localhost, *.localhost, *.local, IP addresses), which get
//   http: "localhost:3000", "127.0.0.1:8010", "[::1]:5173", "192.168.1.5".
// - A name with no dot is a search ("weather"), unless it has a port ("devbox:8080").
// - file: only when the user typed it themselves (typed: true), never an address JARVIS or a
//   page asks for; about:blank either way. javascript:, data: and any other scheme are never
//   opened: they're searched for, like words.
//
// brain.py's browser_address reads addresses the same way, for the turn gate: keep the two in
// step (tests/fixtures/url_input.json holds the cases both are tested against).
'use strict';

const SEARCH = 'https://www.google.com/search?q=';
const HOST = /^(\[[0-9A-Fa-f:.]+\]|[\w-]+(?:\.[\w-]+)*)(?::(\d{1,5}))?([/?#]\S*)?$/;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

function isLocalHost(host) {
  const name = String(host || '').toLowerCase().replace(/\.$/, '');
  return name === 'localhost' || name.endsWith('.localhost') || name.endsWith('.local')
    || IPV4.test(name) || /^\[[0-9a-f:.]+\]$/.test(name);
}

function toUrl(input, { typed = false } = {}) {
  const text = String(input == null ? '' : input).trim();
  if (/^https?:\/\//i.test(text)) return text;
  if (/^about:blank$/i.test(text)) return 'about:blank';
  if (typed && /^file:\/\//i.test(text)) return text;
  if (typed && /^\/(?!\/)/.test(text)) return `file://${encodeURI(text)}`; // a path typed in the bar
  const m = HOST.exec(text);
  if (m) {
    const [, host, port] = m;
    const top = host.split('.').pop();
    if (!port || Number(port) <= 65535) {
      if (isLocalHost(host) || (port && !host.includes('.'))) return `http://${text}`;
      if (host.includes('.') && /[a-z]/i.test(top)) return `https://${text}`;
    }
  }
  return SEARCH + encodeURIComponent(text);
}

module.exports = { toUrl, isLocalHost, SEARCH };
