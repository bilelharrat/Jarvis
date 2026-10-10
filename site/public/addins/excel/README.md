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
- **Connect**: the pane opens `/eden/connect?client_id=excel&…` (PKCE S256 + state) in an Office dialog. The
  person signs in to Eden if needed and presses Connect; the dialog lands on `connected.html`, which hands its
  address to the pane with `messageParent`. The pane checks the state, redeems the code at
  `POST /api/eden/token` (same origin) and keeps the scoped `ask` token in localStorage. Disconnect calls
  `POST /api/eden/disconnect` and forgets it.
- **The pane** (`taskpane.html/.js/.css`): shows the selection's address; Ask (the input), Analyze, Write a
  formula, Explain formula, Fill column, Clean, Make a table; answers stream in from `POST /api/eden/sheet`, with
  follow-ups. Nothing is read or sent until a button is pressed, and then only what the action needs (values;
  formulas for Explain and Clean), within 5,000 cells / 60,000 characters / 1,000 rows for Fill and Clean.
  Changes to the sheet are always shown first: **Insert** puts a formula in the active cell, **Fill** writes
  one line per row into the column to the right (refused when the line count doesn't match), **Replace with
  cleaned data** writes only changed cells and never cells holding formulas (refused when the shape doesn't
  match or the cells changed meanwhile), **Insert table** writes at the active cell. Writing over filled cells
  needs a second press. Text Eden writes never becomes a formula (`=`, `+`, `-`, `@` get a leading apostrophe).
- **`=EDEN.ASK`**: returns Eden's short answer as text. Answers are cached by (prompt + the range's values) in
  memory and localStorage (500 entries, 30 days), so recalculating doesn't ask again. At most 4 run at once and
  100 per session (the pane's "=EDEN.ASK in cells" section allows more and forgets saved answers). Not connected,
  out of included AI or too many cells: a `#N/A` with the reason on hover.

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
