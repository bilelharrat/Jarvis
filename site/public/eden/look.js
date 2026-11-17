// The opt-in Eden Code look (code-look.css). OFF by default for everyone. A classic script in <head>, right after
// app-lock.js, so the look is set before the first paint. ?look=code turns it on and remembers it (localStorage
// "eden:look"); ?look=default turns it off and forgets it. No settings UI yet.
(function () {
  var root = document.documentElement, q = null, on = false;
  try { q = new URLSearchParams(location.search).get('look'); } catch (e) { /* ignore */ }
  if (q === 'code') {
    on = true;
    try { localStorage.setItem('eden:look', 'code'); } catch (e) { /* ignore */ }
  } else if (q === 'default') {
    try { localStorage.removeItem('eden:look'); } catch (e) { /* ignore */ }
  } else {
    try { on = localStorage.getItem('eden:look') === 'code'; } catch (e) { /* ignore */ }
  }
  if (on) root.dataset.look = 'code'; else delete root.dataset.look;
})();
