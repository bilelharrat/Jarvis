# Classic askeden.com front page (saved 2026-10-13)

The front page as it was before the Eden Code look (cream paper, navy, coral, Fraunces) replaced it.
Dark Stark-Glass look with the breathing orb, the seven films stacked as cards, plans and downloads.

- `public-home/`: `index.html`, `home.css`, `features.js` (what lived in `site/public/home/`)
- `public-lang/fr-home.js`: its French (what lived in `site/public/lang/fr-home.js`)

To bring it back: copy `public-home/*` over `site/public/home/` and `public-lang/fr-home.js` over `site/public/lang/fr-home.js`,
and put the page's CSP back to `style-src 'self'` with no font hosts (src/eden/pages.js HOME_CSP; test/pages.test.js expects it).
It lives outside `public/`, so it is not served. The films (`public/jarvis/walk-N.*`) are unchanged.
