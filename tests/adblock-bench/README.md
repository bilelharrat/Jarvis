# Ad-block benchmark: our browser's blocker against Brave Shields

Loads the same pages at the same time in three browsers and measures what each lets through:

- **none**: Electron with no blocker (what the page offers),
- **ours**: Electron with the browser's blocker wired as `app/main.js` wires it (`app/adblock.js`:
  `network`, `attach`, `load`, with the lists in `app/adblock-lists.json`),
- **brave**: the installed Brave, headless, a fresh profile, Shields at their default (Standard).
  The run waits for Brave to download its list and resource components before it starts.

```
app/node_modules/.bin/electron tests/adblock-bench/run.cjs                  # everything, ~25 min
app/node_modules/.bin/electron tests/adblock-bench/run.cjs --set=tests      # just the ad-test pages
app/node_modules/.bin/electron tests/adblock-bench/run.cjs --only=cnn,delish --arms=ours,brave
app/node_modules/.bin/electron tests/adblock-bench/run.cjs --app=/path/to/older/app --legacy --label=before
```

`--legacy` runs our blocker as it was before 2026-11-13 (Ghostery's `fullLists` from its mirror,
Ghostery's own network handler); `--app` takes the blocker's files from another copy (give that copy
a `node_modules` link to `app/node_modules`). Results go to `results/<time>-<label>/`: `report.md`,
`results.json` (every number, leaked hosts, ad samples) and `shots/` (one screenshot per page and arm).

## What is measured

Per page and arm, after the page loads, settles, is scrolled to the bottom and back:

- **leaked**: requests to known ad and tracker hosts that got an answer. "Known" is Disconnect's list
  (Advertising, Analytics, FingerprintingInvasive, Cryptomining), the one Firefox's tracking
  protection uses, so the judge isn't the lists either blocker runs. It's fetched at run time into a
  temp folder and never shipped (CC BY-NC-SA). The page's own site is never counted.
- **ads**: ad elements shown with something in them (a frame, picture, link or text), found by a
  fixed set of ad selectors (`AD_SELECTORS` in `run.cjs`), outermost only.
- **slots**: the same, filled or empty: an empty grey box is still ad space.
- **overlays**: fixed boxes over a third of the window with text in them (cookie walls, nags).
- **broken**: under 60% of the text the page has with no blocker, or the page failed to load. Check
  the screenshots too: a missing video or a page that is only half laid out shows there first.
- the test pages' **own scores** (adblock-tester.com's points, turtlecute's count of blocked requests).
- **YouTube**: three popular videos, signed out; the player is started muted (as a reader pressing
  play would) and watched for 25 s for an ad (`.ad-showing`, the ad overlay).

## Rules

Read-only. Pages are loaded, waited on and scrolled; nothing is clicked, typed, signed into, bought
or submitted, and no ad is ever clicked. Cookie banners are left as they are.

## Pages

`pages.json`: the ad-test pages (adblock-tester.com, adblock.turtlecute.org, canyoublockit.com's two
tests), three YouTube videos and 28 popular news and recipe sites (home pages, so the URLs last).
Retired: d3ward's test (archived by its author; it no longer runs its tests) and fanboy.co.nz/test
(serves explicit ad images inline from its own host). uBlock Origin's test pages need filters added
by hand, so they don't measure default lists.

## Limits

- Ads differ from load to load and by region (the run is from the US); compare runs side by side,
  not one page's one number. Real sites show fewer ads to a fresh, signed-out, cookie-less browser.
- Brave runs headless (`--headless=new`) with the same user agent as the Electron arms. Its
  fingerprinting and cookie protections are on as by default; they don't change these numbers much.
- A blocker that blocks an ad script early never sees the requests the script would have made: that
  is why "leaked" is counted, not a "percent blocked".
