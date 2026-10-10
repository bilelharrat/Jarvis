# Ask Eden for Excel

An Office add-in for Excel on Mac, Windows and the web. It adds an **Ask Eden** button to the Home tab that
opens a task pane, plus a cell function, `=EDEN.ASK(prompt, [range])`. All of its files live in this folder and
are served from `https://askeden.com/addins/excel/` by `src/eden/addins.js` (only names matching
`[a-z0-9-]+.(html|js|css|json|xml|png|svg)`; this README isn't served). It only works once the site is deployed:
the manifest, the pane and the API are all on askeden.com.

## How it works

- `manifest.xml`: an XML add-in manifest (TaskPaneApp, host Workbook). A **shared runtime**
  (`<Runtime lifetime="long">`, requirement SharedRuntime 1.1): the task pane and the cell function run in the
  same page (`taskpane.html`), so they share the stored token, the cache and the counters. Custom functions
  in namespace `EDEN` (metadata `functions.json`, code `functions.js`).
- `lib.js`: the pure helpers (sets `globalThis.EdenExcel`): PKCE, request bodies within the server's limits,
  reading answers (one formula, one line per row, same-shape TSV), what may be written back, the cell cache,
  light Markdown as blocks, English and French words. Tested by `site/test/excel-addin.test.js`.
- **Connect**: the pane opens `connect.html?state=…&code_challenge=…` in an Office dialog. That page loads
  Office.js first (so the dialog keeps its link to Excel) and goes on to `/eden/connect?client_id=excel&…`
  (PKCE S256 + state). The person signs in to Eden if needed and presses Connect; the dialog lands on
  `connected.html`, which hands the code back two ways: `POST /api/eden/relay {state, code}` (askeden.com keeps
  it 2 minutes) and Office's `messageParent`. While the dialog is open the pane polls
  `POST /api/eden/relay/take {state}` about every 1.5 s; whichever arrives first wins (Excel on the web can cut
  the dialog off from the pane, so the relay is its way back). The pane checks the state, redeems the code at
  `POST /api/eden/token` (same origin) with its verifier and keeps the scoped `ask` token in localStorage. A
  401 forgets only the token it was for (a newer one stays); another pane's Connect or Disconnect is followed.
  Disconnect calls `POST /api/eden/disconnect` and forgets the token and the saved cell answers.
- **The pane** (`taskpane.html/.js/.css`): shows the selection's address; Ask (the input), Analyze, Write a
  formula, Explain formula, Fill column, Clean, Make a table; answers stream in from `POST /api/eden/sheet`, with
  follow-ups. One ask at a time (a second press or Enter does nothing; ■ stops). Nothing is read or sent until a
  button is pressed, and then only what the action needs: the selected cells (values; formulas for Clean and
  Explain); for Write a formula / Explain on one cell, the active cell plus the sheet's header row and first 5
  rows. Hidden or filtered rows are included, and the pane says so before sending (press again to send).
  Limits: 5,000 cells / 60,000 characters (history included) / 1,000 rows for Fill and Clean; a cell over 2,000
  characters is refused for Fill and Clean, never cut. Fill and Clean bigger than one answer go in parts
  (Fill ≤ 200 rows, Clean ≤ the server's `cleanTokens` 8,000), at most 2 at once, with progress; nothing is
  written unless every part came back right. Clean sends line breaks and tabs inside a cell escaped (`\n`, `\t`,
  `\\`) so a cell stays one field, and turns them back. Changes to the sheet are always shown first: **Insert**
  puts a formula in the active cell (a formula that reaches outside the workbook — WEBSERVICE, IMAGE, HYPERLINK,
  DDE, external links… — is flagged and its button says "Insert anyway"), **Fill** writes one line per row into
  the column to the right (refused when the count doesn't match or the rows changed), **Replace with cleaned
  data** writes only changed cells and never formulas (refused when the shape doesn't match or the cells
  changed), **Insert table** writes at the active cell. Writing over filled cells needs a second press; a
  protected sheet is refused before anything is written. Text Excel would turn into something else (`007`,
  `1/2`, `5%`, `TRUE`, `#N/A`, `=…`) gets the Text number format (`@`) first, so it stays as written; plain
  numbers go in as numbers; Clean keeps each cell's kind.
- **`=EDEN.ASK`**: returns Eden's short answer (a plain number as a number) in one cell (a 1×1 result, because
  `requiresParameterAddresses` needs a matrix). Whole-column ranges are trimmed to their data; dates go as
  shown (the range is read through its address), errors in the range as their code
  (`allowErrorForDataTypeAny`). Answers are cached by (prompt + the range's values) in memory and localStorage
  (500 entries, 30 days); a blank or cut answer is never kept. At most 2 run at once (the server's limit per
  account), "busy" waits its Retry-After, a try ends after 90 s, and 100 answers per session (failures don't
  count; the pane's "=EDEN.ASK in cells" section allows more, which works the paused cells out again).

## Trying it (sideloading)

- **Mac**: copy `manifest.xml` (download it from `https://askeden.com/addins/excel/manifest.xml`) into
  `~/Library/Containers/com.microsoft.Excel/Data/Documents/wef/` (create `wef` if it isn't there), quit and
  reopen Excel, open a workbook, then Home › Add-ins (or Insert › My Add-ins) › Ask Eden.
- **Windows**: put `manifest.xml` in a shared network folder, add it under File › Options › Trust Center ›
  Trust Center Settings › Trusted Add-in Catalogs ("Show in Menu"), restart Excel, then Home › Add-ins ›
  Shared Folder › Ask Eden. Or use Excel on the web's upload below.
- **Excel on the web**: open a workbook, Home › Add-ins › More Add-ins › My Add-ins › **Upload My Add-in**,
  choose `manifest.xml`.

## Publishing (AppSource)

Microsoft Partner Center (partner.microsoft.com) › Marketplace offers › New offer › Office add-in. Upload
`manifest.xml`, the listing (name, descriptions, screenshots at 1366×768, the 300×300 logo), the privacy policy
and terms URLs (askeden.com/privacy, askeden.com/terms), support URL (askeden.com/help) and test notes with a
test Eden account. Microsoft's validation runs the manifest through its service (`npx office-addin-manifest
validate manifest.xml` does the same check before submitting). A new `<Version>` in the manifest is needed for
every resubmission. Organisations can also deploy it centrally from the Microsoft 365 admin center
(Settings › Integrated apps › Upload custom apps) without AppSource.
