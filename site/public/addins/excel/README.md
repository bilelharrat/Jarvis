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
  the dialog off from the pane, so the relay is its way back). Excel on the web reports the window closed (12006)
  as soon as it reaches a sign-in page that cuts it off (COOP), so there 12006 doesn't end the attempt: the pane says
  "Finish signing in in the window that opened; this pane will connect by itself" with a Cancel, and keeps polling
  (backing off to every 5 s) for 5 minutes; Connect meanwhile reopens the window for the same attempt (same state
  and verifier). On Windows, Mac and iPad the window is Office's own, so 12006 means it was closed: a few more looks,
  then "The sign-in window closed". An attempt that ran out of time is still looked at every 10 s for 10 minutes
  (and by the next Connect), so a late sign-in connects by itself. One look at a time; each gives up after 8 s, the
  code's exchange after 15 s, and a 429 waits its Retry-After. The landing page says "Connected" only when
  `messageParent` handed the code over; relayed only, it says to go back to Excel (and press Connect if it doesn't
  show Connected). The pane checks the state, redeems the code at
  `POST /api/eden/token` (same origin) with its verifier and keeps the scoped `ask` token in localStorage. A
  401 forgets only the token it was for (a newer one stays); another pane's Connect or Disconnect is followed.
  Disconnect calls `POST /api/eden/disconnect` and forgets the token and the saved cell answers.
- **The pane** (`taskpane.html/.js/.css`): shows the selection's address; Ask (the input), Analyze, Write a
  formula, Explain formula, Fill column, Clean, Make a table; answers stream in from `POST /api/eden/sheet` (with `x-eden-trailer: 1`: the stream
  ends with U+0000 and how it ended, so a cut-off, a refusal and a dropped connection get their own words; the pane
  splits at U+0000 even if a proxy drops the response header, and a stream without one broke off), with
  follow-ups. One ask at a time (a second press or Enter does nothing; ■ stops). Nothing is read or sent until a
  button is pressed, and then only what the action needs: the selected cells (values; formulas for Clean and
  Explain); for Write a formula / Explain on one cell, the active cell plus the sheet's header row and first 5
  rows. Hidden or filtered rows (and hidden columns, also among Fill's neighbour columns) are included, and the
  pane says so before sending (press again to send).
  Each Excel round trip (`context.sync()`) is a trip to Excel's server on the web, so most actions read in two
  (the selection with the data's extent, then the cells with their number formats and hidden-row count; a whole
  column is clipped to the data without a trip of its own, and Fill into a column right of the data reads the
  columns beside it in that same second trip) and writes in two (the checks, then the write); a closed pane
  stops following the selection (`Office.addin.onVisibilityModeChanged`).
  Limits: 5,000 cells / 60,000 characters (history included) / 1,000 rows for Fill and Clean; a cell over 2,000
  characters is refused for Fill and Clean, never cut. Fill and Clean bigger than one answer go in parts
  (Fill ≤ 200 rows, Clean ≤ the server's `cleanTokens` 8,000), at most 2 at once, with progress; nothing is
  written unless every part came back right. Fill parts also stay within the server's answer budget
  (`fillTokens`, 8,000: long answers like translations go in smaller parts) and 5,000 cells. Fill into an empty
  column reads and sends only the filled columns right next to it (at most 10, up to the first empty column).
  Numbers go as their values (never their shown rounding: `1.2E+08`, `1.2M`); dates and times as shown (by
  their number format); percentages, money, fractions and numbers with a unit keep their unit: as shown when the
  shown text is exactly the value (`5%`, `1 234,50 €`), else the exact value with its unit (`12.345%`,
  `$1234.5678`). Fill and Make a table give a number written into a date-formatted cell, or a percentage, its own
  format. Clean never writes a date or number cell (a value Eden would change is left as it is and
  counted), nor a cell whose line breaks Eden dropped. The "rows changed" checks compare values and formulas,
  not shown text. Clean sends line breaks and tabs inside a cell escaped (`\n`, `\t`,
  `\\`) so a cell stays one field, and turns them back. Changes to the sheet are always shown first: **Insert**
  puts a formula in the active cell (a formula that reaches outside the workbook — WEBSERVICE, IMAGE, HYPERLINK,
  IMPORTCSV, IMPORTTEXT, DDE, external links… — is flagged and its button says "Insert anyway"), **Fill** writes one line per row into
  the column to the right (refused when the count doesn't match or the rows changed), **Replace with cleaned
  data** writes only changed cells and never formulas (refused when the shape doesn't match or the cells
  changed), **Insert table** writes at the active cell. Writing over filled cells needs a second press; a
  protected sheet is refused before anything is written. Text Excel would turn into something else (`007`,
  `1/2`, `12:30`, `TRUE`, `#N/A`, `=…`) gets the Text number format (`@`) first, so it stays as written (only
  such text: "Building 5" stays General); numbers go in as numbers, `1.50`, `1,234` (English) and `50%` with a
  format that shows them as written; Clean keeps each cell's kind. Insert sets a Text-formatted cell back to
  General before writing a formula.
- **`=EDEN.ASK`**: returns Eden's short answer (a plain number as a number) in one cell (a 1×1 result, because
  `requiresParameterAddresses` needs a matrix). Whole-column ranges are trimmed to their data; dates go as
  shown (the range is read through its address), errors in the range as their code
  (`allowErrorForDataTypeAny`). Answers are cached by (prompt + the range's values) in memory and localStorage
  (500 entries, 30 days); only a 200 marked `x-eden-answer: complete` goes in a cell; a blank, cut or unmarked
  answer is never kept, and a question over 2,000 characters is refused. At most 2 run at once (the server's limit per
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
