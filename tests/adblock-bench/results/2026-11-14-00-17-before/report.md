# Ad-block benchmark, 2026-11-14T00:29 (before)

Arms: none, ours, brave (Brave: Chrome/154.0.8037.93).

Each cell: leaked / ads / slots / overlays. Leaked = requests to known ad and tracker hosts (Disconnect) that got an answer; ads = filled ad elements shown after load and a scroll; slots = ad slots shown, filled or empty; overlays = fixed boxes over a third of the window (cookie walls, nags). Broken (!) = under 60% of the text the page has with no blocker, or it failed to load.

| page | none | ours | brave | page's own score / YouTube |
|---|---|---|---|---|
| adblock-tester | 47 / 1 / 1 / 0 | 0 / 0 / 0 / 0 | 3 / 0 / 0 / 0 | none 41; ours 100; brave 96 |
| turtlecute | 49 / 0 / 0 / 0 | 3 / 0 / 0 / 0 | 12 / 0 / 0 / 0 | none 7; ours 90; brave 81 |
| canyoublockit-testing | 23 / 4 / 4 / 1 | 0 / 0 / 0 / 0 | 2 / 0 / 0 / 0 |  |
| canyoublockit-extreme | 16 / 0 / 0 / 0 | 6 / 0 / 0 / 2 | 0 / 0 / 0 / 0 |  |
| youtube-1 | 16 / 0 / 0 / 0 | 0 / 0 / 0 / 0 | 5 / 0 / 0 / 0 | none: AD (25s); ours: no ad, played 25s; brave: no ad, played 27s |
| youtube-2 | 4 / 0 / 0 / 0 | 0 / 0 / 0 / 0 | 3 / 0 / 0 / 0 | none: no ad, played 28s; ours: no ad, played 25s; brave: no ad, played 28s |
| youtube-3 | 4 / 1 / 1 / 0 | 0 / 0 / 0 / 0 ! | 3 / 0 / 0 / 0 | none: no ad, played 28s; ours: no ad, played 24s; brave: no ad, played 27s |
| cnn | 13 / 0 / 41 / 3 | 6 / 0 / 5 / 0 | 10 / 0 / 5 / 0 |  |
| foxnews | 829 / 17 / 17 / 0 | 5 / 12 / 15 / 0 | 11 / 0 / 0 / 0 |  |
| nytimes | 340 / 4 / 4 / 0 | 0 / 0 / 0 / 0 | 2 / 0 / 0 / 0 |  |
| guardian | 528 / 6 / 12 / 0 | 0 / 0 / 0 / 1 | 2 / 0 / 0 / 0 |  |
| washingtonpost | 109 / 0 / 0 / 1 | 0 / 0 / 0 / 1 | 3 / 0 / 0 / 1 |  |
| usatoday | 1629 / 16 / 28 / 0 | 6 / 0 / 0 / 0 | 10 / 0 / 0 / 0 |  |
| nbcnews | 381 / 6 / 6 / 0 | 0 / 0 / 0 / 0 | 1 / 0 / 0 / 0 |  |
| cbsnews | 388 / 1 / 1 / 0 | 2 / 1 / 1 / 0 | 4 / 0 / 0 / 0 |  |
| apnews | 1993 / 5 / 5 / 0 | 1 / 0 / 0 / 0 | 1 / 0 / 0 / 0 |  |
| forbes | 41 / 0 / 0 / 0 | 0 / 0 / 0 / 0 | 1 / 0 / 0 / 0 |  |
| businessinsider | 613 / 10 / 10 / 0 | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |  |
| huffpost | 1074 / 19 / 31 / 1 | 6 / 0 / 0 / 1 | 3 / 0 / 0 / 1 |  |
| dailymail | 599 / 8 / 8 / 0 | 0 / 0 / 0 / 0 | 1 / 0 / 0 / 0 |  |
| independent | 916 / 4 / 4 / 1 | 1 / 0 / 0 / 1 | 3 / 0 / 0 / 1 |  |
| nypost | 500 / 4 / 5 / 0 | 0 / 0 / 0 / 1 | 4 / 0 / 0 / 0 |  |
| people | 638 / 10 / 16 / 0 | 0 / 10 / 16 / 0 | 3 / 0 / 0 / 0 |  |
| theverge | 1309 / 17 / 23 / 1 | 2 / 0 / 0 / 0 | 6 / 0 / 0 / 0 |  |
| latimes | 4 / 11 / 12 / 0 | 0 / 0 / 0 / 0 | 6 / 0 / 0 / 0 |  |
| allrecipes | 488 / 8 / 8 / 0 | 0 / 8 / 8 / 0 | 2 / 0 / 0 / 0 |  |
| foodnetwork | 374 / 4 / 4 / 0 | 5 / 0 / 0 / 0 | 5 / 0 / 0 / 0 |  |
| simplyrecipes | 618 / 10 / 13 / 0 | 0 / 10 / 13 / 0 | 2 / 0 / 0 / 0 |  |
| seriouseats | 353 / 5 / 11 / 0 | 0 / 5 / 11 / 0 | 2 / 0 / 0 / 0 |  |
| delish | 283 / 5 / 5 / 0 | 0 / 0 / 0 / 0 | 1 / 0 / 0 / 0 |  |
| tasteofhome | 1 / 0 / 7 / 1 | 0 / 0 / 7 / 0 | 0 / 0 / 7 / 0 |  |
| food-com | 357 / 4 / 4 / 0 | 0 / 0 / 3 / 0 | 0 / 0 / 3 / 0 |  |
| budgetbytes | 123 / 0 / 0 / 0 | 0 / 0 / 0 / 0 | 2 / 0 / 0 / 0 |  |
| sallysbaking | 21 / 0 / 0 / 1 | 0 / 0 / 0 / 0 | 1 / 0 / 0 / 0 |  |
| pioneerwoman | 359 / 7 / 7 / 0 | 0 / 0 / 0 / 0 | 1 / 0 / 0 / 0 |  |

## Totals

| set | arm | pages | leaked | ads | slots | overlays | broken | YouTube ads |
|---|---|---|---|---|---|---|---|---|
| tests | none | 4 | 135 | 5 | 5 | 1 | 0 |  |
| tests | ours | 4 | 9 | 0 | 0 | 2 | 0 |  |
| tests | brave | 4 | 17 | 0 | 0 | 0 | 0 |  |
| youtube | none | 3 | 24 | 1 | 1 | 0 | 0 | 1 |
| youtube | ours | 3 | 0 | 0 | 0 | 0 | 1 | 0 |
| youtube | brave | 3 | 11 | 0 | 0 | 0 | 0 | 0 |
| real | none | 28 | 14881 | 181 | 282 | 9 | 0 |  |
| real | ours | 28 | 34 | 46 | 79 | 5 | 0 |  |
| real | brave | 28 | 87 | 0 | 15 | 3 | 0 |  |
