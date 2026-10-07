// What "Read aloud" says: a reply's markdown turned into plain sentences, the way J.A.R.V.I.S.
// cleans a reply for speech (src/jarvis/speech.py clean_for_speech), then cut into pieces the
// voice takes one at a time. Pure (no DOM), so the tests load it as it is served.

export const MAX_CHUNK = 600; // the voice's limit per request (askeden.com /api/voice)
const FIRST_CHUNK = 220; // a short first piece: the voice starts sooner

const CODE_SAID = 'I’ve put the code on screen.';

/** A reply's markdown as something that sounds natural aloud. */
export function speechText(md) {
  let t = String(md || '').replace(/\r\n?/g, '\n');
  // fenced code (an unclosed fence, cut off mid-stream, runs to the end): never read out
  t = t.replace(/^[ \t]*(`{3,}|~{3,})[^\n]*(?:\n[\s\S]*?)?(?:\n[ \t]*\1[ \t]*(?=\n|$)|(?![\s\S]))/gm, `\n${CODE_SAID}\n`);
  t = t.replace(new RegExp(`(?:${CODE_SAID}\\s*){2,}`, 'g'), `${CODE_SAID}\n`);
  t = t.replace(/<!--[\s\S]*?-->/g, ' ');
  t = t.replace(/<\/?[a-z][^<>]*>/gi, ' ');
  t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1'); // images: their alt text
  t = t.replace(/\[([^\[\]]+)\]\((?:[^()]|\([^()]*\))+\)/g, '$1'); // links: their words
  t = t.replace(/https?:\/\/\S+/g, 'the link on screen');
  t = t.replace(/(?<!\s)\s*\[(?:n?\d+(?:,\s*n?\d+)*)\]/g, ''); // citations [1], [2, 3]
  t = t.replace(/^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(\|[ \t]*:?-{3,}:?[ \t]*)*\|?[ \t]*$/gm, ''); // table rules
  t = t.replace(/^[ \t]*\|(.*)\|[ \t]*$/gm, (_, row) => row.split('|').map((c) => c.trim()).filter(Boolean).join(', ') + '.');
  t = t.replace(/^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm, ''); // horizontal rules
  t = t.replace(/^[ \t]*>+[ \t]?/gm, ''); // quotes
  t = t.replace(/^[ \t]*#{1,6}[ \t]*/gm, ''); // headings
  t = t.replace(/^[ \t]*(?:[-*+•]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/gm, ''); // list markers, task boxes
  t = t.replace(/`([^`\n]+)`/g, '$1'); // inline code: its words
  t = t.replace(/(\*\*|\*|~~)(?=\S)([^\n]*?\S)\1/g, '$2'); // emphasis
  t = t.replace(/(^|[^\w])(__|_)(?=\S)([^\n]*?\S)\2(?!\w)/g, '$1$3'); // _emphasis_, never snake_case
  t = t.replace(/[*`~]+/g, '');
  t = t.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, '\'');
  // each line ends a sentence (as speech.py does), then tidy the joins
  t = t.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => (/[.!?:;,…]["”’)]?$/.test(l) ? l : `${l}.`)).join(' ');
  t = t.replace(/([.!?])\.(\s|$)/g, '$1$2').replace(/:\./g, ':');
  return t.replace(/\s{2,}/g, ' ').trim();
}

/** A reply's markdown as pieces of speech of at most `max` characters, at sentence ends where it can. */
export function speechChunks(md, opts) {
  return chunkText(speechText(md), opts);
}

/** Plain text cut into pieces of at most `max` characters (the first one shorter). */
export function chunkText(text, { max = MAX_CHUNK, first = FIRST_CHUNK } = {}) {
  if (!text) return [];
  const sentences = text.match(/[^.!?…]+(?:[.!?…]+["”’)]*|$)\s*/g) || [text];
  const out = [];
  let cur = '';
  const limit = () => (out.length ? max : Math.min(first, max));
  const push = () => { if (cur.trim()) out.push(cur.trim()); cur = ''; };
  for (let s of sentences) {
    while (s.length > limit()) {
      // a sentence too long for one piece: cut at a comma or a space
      push();
      const lim = limit();
      const cut = Math.max(s.lastIndexOf(', ', lim), s.lastIndexOf('; ', lim), s.lastIndexOf(' ', lim));
      const at = cut > lim / 3 ? cut + 1 : lim;
      out.push(s.slice(0, at).trim());
      s = s.slice(at);
    }
    if ((cur + s).length > limit()) push();
    cur += s;
  }
  push();
  return out.filter(Boolean);
}

/**
 * While a reply streams in: how far into `md` (from `from`) can be read aloud already. Up to
 * the last finished sentence or line, never into a code block still open (its closing fence
 * hasn't arrived), so each piece is whole. `final`: the reply is complete, all of it.
 */
export function safeCut(md, from = 0, final = false) {
  const text = String(md || '');
  if (final) return text.length;
  let limit = text.length;
  let open = null;
  for (const m of text.matchAll(/^[ \t]*(`{3,}|~{3,})/gm)) {
    if (!open) open = { at: m.index, fence: m[1] };
    else if (m[1][0] === open.fence[0] && m[1].length >= open.fence.length) open = null;
  }
  if (open) limit = open.at;
  if (limit <= from) return from;
  const part = text.slice(from, limit);
  let cut = part.lastIndexOf('\n') + 1;
  for (const m of part.matchAll(/[.!?…]+["”’)\]]*\s/g)) cut = Math.max(cut, m.index + m[0].length);
  return from + cut;
}

// Dictation by recording (no speech recognition in this browser, e.g. Firefox): the recording's
// type, the first this browser's MediaRecorder makes of the ones the server reads (Opus in WebM
// or Ogg, else AAC in MP4: Safari), or '' for the browser's own default.
export const RECORDING_TYPES = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm', 'audio/mp4'];
export const MAX_RECORDING_S = 120; // the server's limit too (POST /api/chat/transcribe)
export function recordingType(supported) {
  return RECORDING_TYPES.find((t) => { try { return !!supported(t); } catch { return false; } }) || '';
}
