# J.A.R.V.I.S. Daredevil: Jarvis with a screen reader (Windows)

J.A.R.V.I.S. Daredevil is J.A.R.V.I.S. for people who are blind or have low vision: the same Jarvis, set up to work with your screen reader and from the keyboard alone. There is nothing extra to install. It switches itself on when a screen reader is running (or from Settings, then Accessibility), and the window then calls itself J.A.R.V.I.S. Daredevil.

This is the short way in. It works with NVDA, JAWS and Narrator. Everything can be done with the keyboard.

## Install and start

1. Run the installer (`J-A-R-V-I-S-Setup-…-x64.exe`). Windows may say "Windows protected your PC": choose *More info*, then *Run anyway*. (The installers aren't signed yet.)
2. J.A.R.V.I.S. opens in its own window. If your screen reader is running, **screen-reader mode turns itself on**: Jarvis stops talking out loud, and your screen reader reads each reply once, in your own voice and speed.
3. The first time you start it, Jarvis downloads its speech model (about 150 MB, a minute or two) and says so, and says again when it can hear you. After that it works without a download.
4. A short setup walks you through. Press **Tab** to move, **Enter** to choose. The Claude step asks for an API key from console.anthropic.com (API keys). Paste it with **Ctrl+V**; it is stored in Windows' password store and never shown again.

## Talking to Jarvis

- **Ctrl+Alt+J** starts listening, from any app (J is the key your index finger finds by touch). Say what you want, then stop talking. J.A.R.V.I.S. starts with Windows and waits out of the way, so the key works from the moment you sign in. If another program already uses Ctrl+Alt+J, Jarvis uses the next free key beside it (K, then H, then L) and says which in Settings; you can pick your own under *Shortcuts* in General.
- Or type in the request box: press **Tab** from the top, or choose the *Skip to the request box* link.
- Hands-free ("Jarvis, …" at any time) is on by default. If your speakers can be heard by the microphone, use headphones, or turn it off in Settings.

## Keys in screen-reader mode

| Keys | What it does |
|---|---|
| Alt+Shift+T | Talk to Jarvis |
| Alt+Shift+Y | Say **yes** to the question waiting (a send, a purchase, a delete) |
| Alt+Shift+N | Say **no** to it |
| Alt+Shift+R | Read the last reply again |
| Alt+Shift+S | Stop speaking and stop what Jarvis is doing |
| Alt+Shift+U | What is Jarvis doing right now |
| Alt+Shift+H | This list of keys |
| Esc | Close what is open, and stop |

Short sounds say what Jarvis is doing: a rising pair when it starts listening, a soft tick while it thinks, a falling pair when it has answered, three notes when it needs your OK, and a low pair for a problem. They can be turned off, or made quieter, in Settings › Accessibility.

## Email

**If your email is in Outlook** (the classic Outlook program on this PC, which a university or office usually gives you): open Outlook, then say **"open my email settings"** (or open Settings, then *Email accounts*) and choose *Use Outlook*. There is nothing to type and no password. Jarvis reads Outlook's mail while Outlook is open (it never starts Outlook), and what you send goes out **from Outlook**, with your own signature and font, so it looks like the rest of your email and is kept in your Sent Items.

**For Gmail, iCloud, Yahoo, Fastmail and other accounts:**

1. Say **"open my email settings"** (or open Settings, then *Email accounts*).
2. Type your address. Jarvis fills in the servers and tells you what to do about the password: most providers need an **app password** (not your usual one). The text under the address field says how.
3. Type the app password, then choose **Check it**. Jarvis signs in and says so in words. Choose **Add account** to keep it.

After that you can say:

- "Read my email" / "Anything new from Ann?" / "Read the one about the invoice"
- "Reply: noon works" / "Email Bea, subject lunch, say I'll be ten minutes late"
- "Archive that" / "Flag that" / "Mark them read"
- "Read the attachment" / "Read the PDF Ann sent" (text, Word and PDF files; a long one is read in parts, say "keep going"; a scanned PDF is read from pictures of its pages, four at a time)

You can **dictate** an email: say the words as you want them written and Jarvis keeps them as you said them, in your paragraphs. Nothing is **sent** without your yes. Jarvis reads you who it goes to, the subject and the whole text first. Say yes, or press Alt+Shift+Y. A long email is read in parts: say "keep going".

**New email.** Jarvis tells you when an email that matters arrives (from someone you have named a VIP, one that says it is urgent, or one that is flagged), and keeps the rest for "what did I miss?". Say "tell me about all my email" to hear every one, "don't interrupt me for an hour" for quiet, or "only urgent" to go back. It watches Outlook while Outlook is open, and your other accounts every minute.

## Punctuation

- **Saying it when you dictate:** say "comma", "period", "question mark", "colon", "new line" or "new paragraph" and Jarvis types the mark. Say **"I'll say the punctuation"** to switch to this (or choose *I say it* under *Dictated punctuation* in Settings, then Accessibility); say **"punctuate for me"** to let Jarvis add the marks itself again.
- **Hearing it:** say **"read the punctuation"** and Jarvis says the main marks aloud ("Dear Ann comma thanks period"), **"read every punctuation mark"** for all of them, or **"stop reading punctuation"**. Your screen reader reads them too. This works for everything Jarvis says, not just email.
- **Asking about it:** "How is that sentence punctuated?" / "Is there a comma after however?" / "Read that email to me with the punctuation."

## Calendar and reminders

- "What's on my calendar today?" / "What's on Thursday?" / "When am I free for an hour this week?"
- "Add a faculty meeting Friday at 2" / "Move my 3 o'clock to 4" / "Cancel the dentist". Jarvis reads you the event first and waits for your yes.
- "Remind me to call the dean at 3" / "What are my reminders?" / "I called the dean". A reminder with a time is **said aloud at that time**, once.

Jarvis keeps a calendar of its own. To read the one you already use, open Settings, then *Calendars*, and paste its **subscribe link**: in **Brightspace** choose Calendar, then Subscribe, then copy the link; in **Outlook on the web** choose Settings, Calendar, Shared calendars, Publish a calendar; in **Google Calendar** copy the *Secret address in iCal format*. Those calendars are read only (Jarvis can't change your Brightspace), and the link is kept in Windows' password store and never shown again. If your university won't let you publish a link, and you use the **Outlook program** on this PC, turn on *Read my Outlook calendar* in the same place: Jarvis then reads Outlook's calendar while Outlook is open (it never starts Outlook, and never changes anything in it).

## Your files

- "Find my budget spreadsheet" / "Move it into the Grants folder" / "Rename it 2026 budget" / "Delete the old draft". Deleted files go to the **Recycle Bin**, never for good, and "undo that" puts them back. Jarvis names what it will move or delete and waits for your yes unless your own words named the files.
- It works in your home folder, OneDrive and Dropbox (if the Dropbox app is installed, your Dropbox is just a folder to Jarvis), and the second brain reads them too ("what did I write about …").
- **Pictures and scans:** "What's in this photo?" / "Read the text on this screenshot" / "Read the scanned PDF in my Downloads". Jarvis looks at the file (PNG, JPEG, GIF, WebP) and tells you what is in it and reads any words on it; a scanned PDF is read from pictures of its pages, four at a time.
- Texts to a phone are not set up yet.

## Reading and using other apps

Jarvis can read the window in front the way a screen reader does ("what's on my screen?", "what's focused?", "which windows are open?") and press things by name ("press Save", "open the File menu"). It asks before anything that sends, buys, or deletes.

## If something doesn't work

Tell Jarvis, or press **Alt+Shift+U** to hear what it's doing. The log is `%LOCALAPPDATA%\Jarvis\Logs\jarvis.log` (paste that into File Explorer's address bar).
