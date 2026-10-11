// Mail, Compose, Calendar and Mail's settings in one import for mail-lazy.js (AC2-7, docs/bug-sweep/r2-ask-eden-chat.md).
// A browser keeps a failed module import for the page's life (Chrome, WebKit): when Mail was first opened offline, its
// four modules stayed broken until a reload. Only this entry is imported by address, so a failed load poisons only it,
// and mail-lazy.js asks for it again under a new address (?retry=N); the four below were never fetched and load then.
import * as mail from './mail.js';
import * as compose from './compose.js';
import * as calendar from './calendar.js';
import * as mailkit from './mailkit.js';

export { mail, compose, calendar, mailkit };
