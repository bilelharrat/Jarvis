# Ad-block benchmark, 2026-11-14T00:48 (after)

Arms: none, ours, brave (Brave: Chrome/154.0.8037.93).

Each cell: leaked / ads / slots / overlays. Leaked = requests to known ad and tracker hosts (Disconnect) that got an answer; ads = filled ad elements shown after load and a scroll; slots = ad slots shown, filled or empty; overlays = fixed boxes over a third of the window (cookie walls, nags). Broken (!) = under 60% of the text the page has with no blocker, or it failed to load.

| page | none | ours | brave | page's own score / YouTube |
|---|---|---|---|---|
| adblock-tester | 40 / 1 / 1 / 0 | 0 / 0 / 0 / 0 | 3 / 0 / 0 / 0 | none 41; ours 100; brave 96 |
| turtlecute | 49 / 0 / 0 / 0 | 4 / 0 / 0 / 0 | 12 / 0 / 0 / 0 | none 7; ours 90; brave 81 |
| canyoublockit-testing | 22 / 4 / 4 / 1 | 0 / 0 / 0 / 0 | 2 / 0 / 0 / 0 |  |
| canyoublockit-extreme | 16 / 0 / 0 / 0 | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |  |
| youtube-1 | 16 / 0 / 0 / 0 | 0 / 0 / 0 / 0 ! | 6 / 0 / 0 / 0 | none: AD (25s); ours: no ad, played 28s; brave: no ad, played 27s |
| youtube-2 | 4 / 1 / 1 / 0 | 0 / 0 / 0 / 0 | 3 / 0 / 0 / 0 | none: no ad, played 28s; ours: no ad, played 28s; brave: no ad, played 27s |
| youtube-3 | 4 / 1 / 1 / 0 | 0 / 0 / 0 / 0 | 4 / 0 / 0 / 0 | none: no ad, played 30s; ours: no ad, played 26s; brave: no ad, played 24s |
| cnn | 12 / 0 / 41 / 3 | 6 / 0 / 5 / 0 | 10 / 0 / 5 / 0 |  |
| foxnews | 879 / 17 / 17 / 0 | 4 / 0 / 0 / 0 | 11 / 0 / 0 / 0 |  |
| nytimes | 225 / 4 / 4 / 0 | 1 / 0 / 0 / 0 | 2 / 0 / 0 / 0 |  |
| guardian | 510 / 6 / 12 / 0 | 0 / 0 / 0 / 1 | 2 / 0 / 0 / 0 |  |
| washingtonpost | 86 / 0 / 0 / 1 | 0 / 0 / 0 / 1 | 3 / 0 / 0 / 1 |  |
| usatoday | 1616 / 16 / 28 / 0 | 6 / 0 / 0 / 0 | 10 / 0 / 0 / 0 |  |
| nbcnews | 421 / 6 / 6 / 0 | 0 / 0 / 0 / 0 | 1 / 0 / 0 / 0 |  |
| cbsnews | 606 / 1 / 1 / 0 | 1 / 0 / 0 / 0 | 4 / 0 / 0 / 0 |  |
| apnews | 1772 / 5 / 5 / 1 | 0 / 0 / 0 / 0 | 1 / 0 / 0 / 0 |  |
| forbes | 41 / 0 / 0 / 0 | 0 / 0 / 0 / 0 | 1 / 0 / 0 / 0 |  |
| businessinsider | 481 / 6 / 7 / 0 | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |  |
| huffpost | 1415 / 16 / 30 / 1 | 0 / 0 / 0 / 1 | 3 / 0 / 0 / 1 |  |
| dailymail | 15 / 0 / 0 / 0 | 0 / 0 / 0 / 0 | 1 / 0 / 0 / 0 |  |
| independent | 1368 / 4 / 4 / 1 | 1 / 0 / 0 / 1 | 3 / 0 / 0 / 1 |  |
| nypost | 487 / 5 / 5 / 0 | 0 / 0 / 0 / 0 | 4 / 0 / 0 / 0 |  |
| people | 733 / 10 / 16 / 0 | 0 / 0 / 0 / 0 | 3 / 0 / 0 / 0 |  |
| theverge | 1086 / 16 / 22 / 1 | 2 / 0 / 0 / 0 | 6 / 0 / 0 / 0 |  |
| latimes | 4 / 11 / 12 / 0 | 0 / 0 / 0 / 0 | 6 / 0 / 0 / 0 |  |
| allrecipes | 565 / 8 / 8 / 0 | 0 / 0 / 0 / 0 | 2 / 0 / 0 / 0 |  |
| foodnetwork | 400 / 4 / 4 / 0 | 5 / 0 / 0 / 0 | 5 / 0 / 0 / 0 |  |
| simplyrecipes | 678 / 9 / 12 / 0 | 0 / 0 / 0 / 0 | 2 / 0 / 0 / 0 |  |
| seriouseats | 396 / 5 / 11 / 0 | 0 / 0 / 0 / 0 | 2 / 0 / 0 / 0 |  |
| delish | 325 / 6 / 6 / 0 | 0 / 0 / 0 / 0 | 1 / 0 / 0 / 0 |  |
| tasteofhome | 1 / 0 / 7 / 1 | 0 / 0 / 7 / 0 | 0 / 0 / 7 / 0 |  |
| food-com | 315 / 4 / 4 / 0 | 0 / 0 / 3 / 0 | 0 / 0 / 3 / 0 |  |
| budgetbytes | 96 / 0 / 0 / 0 | 0 / 0 / 0 / 0 | 2 / 0 / 0 / 0 |  |
| sallysbaking | 20 / 0 / 0 / 1 | 0 / 0 / 0 / 0 | 1 / 0 / 0 / 0 |  |
| pioneerwoman | 307 / 7 / 7 / 0 | 0 / 0 / 0 / 0 | 1 / 0 / 0 / 0 |  |

## Totals

| set | arm | pages | leaked | ads | slots | overlays | broken | YouTube ads |
|---|---|---|---|---|---|---|---|---|
| tests | none | 4 | 127 | 5 | 5 | 1 | 0 |  |
| tests | ours | 4 | 4 | 0 | 0 | 0 | 0 |  |
| tests | brave | 4 | 17 | 0 | 0 | 0 | 0 |  |
| youtube | none | 3 | 24 | 2 | 2 | 0 | 0 | 1 |
| youtube | ours | 3 | 0 | 0 | 0 | 0 | 1 | 0 |
| youtube | brave | 3 | 13 | 0 | 0 | 0 | 0 | 0 |
| real | none | 28 | 14860 | 166 | 269 | 10 | 0 |  |
| real | ours | 28 | 26 | 0 | 15 | 4 | 0 |  |
| real | brave | 28 | 87 | 0 | 15 | 3 | 0 |  |
