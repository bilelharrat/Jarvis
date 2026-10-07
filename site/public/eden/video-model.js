// Videos in a message (askeden.com: Gemini reads them; site src/eden/video.js): which files are
// videos, the caps, and the estimate shown before a long one goes (~300 input tokens a second ×
// the model's input price; ~100 a second past 45 minutes, sent at low resolution). Pure: the
// composer (composer.js) and the tests use it.
export const VIDEO_TYPES = ['video/mp4', 'video/quicktime', 'video/webm'];
export const VIDEO = { maxBytes: 100 * 1024 * 1024, freeSeconds: 20 * 60, plusSeconds: 60 * 60, confirmSeconds: 3 * 60, tokensPerSecond: 300, lowTokensPerSecond: 100, lowAfterSeconds: 45 * 60 };
const VIDEO_FILE = /\.(mp4|m4v|mov|webm)$/i;

/** Whether a file ({ type, name }) is a video Eden takes. */
export const isVideo = (f) => VIDEO_TYPES.includes(String(f.type || '').toLowerCase()) || (!f.type && VIDEO_FILE.test(String(f.name || '')));

/** A video against the caps here (the plan's own is checked by askeden.com): null, or why not. */
export function videoProblem({ type, name, size, seconds }) {
  if (!isVideo({ type, name })) return 'Send the video as MP4, MOV or WebM.';
  if (!(size > 0)) return 'The video is empty.';
  if (size > VIDEO.maxBytes) return 'Videos go up to 100 MB.';
  if (seconds > VIDEO.plusSeconds + 1) return 'Videos go up to 60 minutes on Plus (20 on Free).';
  return null;
}

export const videoTokens = (seconds) => Math.ceil(Math.max(0, Number(seconds) || 0) * (seconds > VIDEO.lowAfterSeconds ? VIDEO.lowTokensPerSecond : VIDEO.tokensPerSecond));
export const videoUSD = (seconds, inputPer1M) => Math.round(videoTokens(seconds) * (inputPer1M / 1e6) * 1e6) / 1e6;
/** Whether these videos need a yes first (any over three minutes). */
export const needsConfirm = (videos) => videos.some((v) => (v.seconds || 0) > VIDEO.confirmSeconds);

export const clock = (s) => { s = Math.round(s || 0); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = String(s % 60).padStart(2, '0'); return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`; };

/** The question before a long video goes: its length, tokens and cost on the model askeden.com named. */
export function confirmText(videos) {
  const seconds = videos.reduce((n, v) => n + (v.seconds || 0), 0);
  const tokens = videos.reduce((n, v) => n + (v.estimate && v.estimate.tokens ? v.estimate.tokens : videoTokens(v.seconds)), 0);
  const usd = videos.reduce((n, v) => n + (v.estimate && v.estimate.usd >= 0 ? v.estimate.usd : 0), 0);
  const model = (videos.find((v) => v.estimate && v.estimate.name) || { estimate: { name: 'Gemini' } }).estimate.name;
  const cost = usd >= 0.01 ? `$${usd.toFixed(2)}` : usd > 0 ? 'under $0.01' : 'a few cents';
  return `This video is ${clock(seconds)} long. ${model} reads about ${tokens.toLocaleString('en-US')} tokens of it (~300 a second), about ${cost} at its input price, plus the reply. Send it?`;
}
