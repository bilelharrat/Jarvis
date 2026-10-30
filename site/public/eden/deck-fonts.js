// Free fonts for Eden Slides' brand kits (web only): open-licence faces shipped in web/chat/fonts/ (SIL OFL 1.1,
// from github.com/google/fonts; Latin subsets as .woff2, licence beside each family), safe to embed anywhere: the
// slide frame, the PDF, shared decks, and named in the PowerPoint file. None declares a Reserved Font Name (OFL §3
// forbids one on a modified copy, and these are subsets), so IBM Plex, Source Sans and Libre Baskerville are left out. Also the closest free stand-in for a
// commercial or uploaded face, which shared copies and exports use instead of the uploaded file. Pure: no DOM.

/**
 * family → { kind: sans|serif|mono, dir (under web/chat/fonts/), styles: { regular, bold, italic?, boldItalic? } }.
 * Keyed by family name, so a family is added by data only.
 */
export const FREE_FONTS = {
  Inter: { kind: 'sans', dir: 'inter', styles: { regular: 'Inter-Regular.woff2', bold: 'Inter-Bold.woff2', italic: 'Inter-Italic.woff2' } },
  'Open Sans': { kind: 'sans', dir: 'opensans', styles: { regular: 'OpenSans-Regular.woff2', bold: 'OpenSans-Bold.woff2', italic: 'OpenSans-Italic.woff2' } },
  'Public Sans': { kind: 'sans', dir: 'publicsans', styles: { regular: 'PublicSans-Regular.woff2', bold: 'PublicSans-Bold.woff2', italic: 'PublicSans-Italic.woff2' } },
  Jost: { kind: 'sans', dir: 'jost', styles: { regular: 'Jost-Regular.woff2', bold: 'Jost-Bold.woff2' } },
  Manrope: { kind: 'sans', dir: 'manrope', styles: { regular: 'Manrope-Regular.woff2', bold: 'Manrope-Bold.woff2' } },
  'Instrument Sans': { kind: 'sans', dir: 'instrumentsans', styles: { regular: 'InstrumentSans-Regular.woff2', bold: 'InstrumentSans-Bold.woff2' } },
  'Space Grotesk': { kind: 'sans', dir: 'spacegrotesk', styles: { regular: 'SpaceGrotesk-Regular.woff2', bold: 'SpaceGrotesk-Bold.woff2' } },
  Arimo: { kind: 'sans', dir: 'arimo', styles: { regular: 'Arimo-Regular.woff2', bold: 'Arimo-Bold.woff2', italic: 'Arimo-Italic.woff2' } }, // Arial/Helvetica metrics
  Fraunces: { kind: 'serif', dir: 'fraunces', styles: { regular: 'Fraunces-Regular.woff2', bold: 'Fraunces-Bold.woff2' } },
  'EB Garamond': { kind: 'serif', dir: 'ebgaramond', styles: { regular: 'EBGaramond-Regular.woff2', bold: 'EBGaramond-Bold.woff2', italic: 'EBGaramond-Italic.woff2' } },
  Baskervville: { kind: 'serif', dir: 'baskervville', styles: { regular: 'Baskervville-Regular.woff2', bold: 'Baskervville-Bold.woff2', italic: 'Baskervville-Italic.woff2' } },
  'Source Serif 4': { kind: 'serif', dir: 'sourceserif4', styles: { regular: 'SourceSerif4-Regular.woff2', bold: 'SourceSerif4-Bold.woff2', italic: 'SourceSerif4-Italic.woff2' } },
  Tinos: { kind: 'serif', dir: 'tinos', styles: { regular: 'Tinos-Regular.woff2', bold: 'Tinos-Bold.woff2', italic: 'Tinos-Italic.woff2' } }, // Times New Roman metrics
  'JetBrains Mono': { kind: 'mono', dir: 'jetbrainsmono', styles: { regular: 'JetBrainsMono-Regular.woff2', bold: 'JetBrainsMono-Bold.woff2' } },
  Cousine: { kind: 'mono', dir: 'cousine', styles: { regular: 'Cousine-Regular.woff2', bold: 'Cousine-Bold.woff2' } }, // Courier New metrics
  // Eden's own OFL family goes here when web/chat/fonts/eden/ is ready, e.g.
  // Eden's own families (fonts/eden/FONTLOG.txt: modified OFL fonts, renamed; .ttf copies there for desktop use)
  'Eden Grotesk': { kind: 'sans', dir: 'eden', styles: { regular: 'EdenGrotesk-Regular.woff2', bold: 'EdenGrotesk-Bold.woff2', italic: 'EdenGrotesk-Italic.woff2', boldItalic: 'EdenGrotesk-BoldItalic.woff2' } },
  'Eden Geometric': { kind: 'sans', dir: 'eden', styles: { regular: 'EdenGeometric-Regular.woff2', bold: 'EdenGeometric-Bold.woff2', italic: 'EdenGeometric-Italic.woff2', boldItalic: 'EdenGeometric-BoldItalic.woff2' } },
  'Eden Sans': { kind: 'sans', dir: 'eden', styles: { regular: 'EdenSans-Regular.woff2', bold: 'EdenSans-Bold.woff2', italic: 'EdenSans-Italic.woff2', boldItalic: 'EdenSans-BoldItalic.woff2' } },
  'Eden Serif': { kind: 'serif', dir: 'eden', styles: { regular: 'EdenSerif-Regular.woff2', bold: 'EdenSerif-Bold.woff2', italic: 'EdenSerif-Italic.woff2', boldItalic: 'EdenSerif-BoldItalic.woff2' } },
  'Eden Display': { kind: 'serif', dir: 'eden', styles: { regular: 'EdenDisplay-Regular.woff2', bold: 'EdenDisplay-Bold.woff2', italic: 'EdenDisplay-Italic.woff2', boldItalic: 'EdenDisplay-BoldItalic.woff2' } },
  'Eden Mono': { kind: 'mono', dir: 'eden', styles: { regular: 'EdenMono-Regular.woff2', bold: 'EdenMono-Bold.woff2', italic: 'EdenMono-Italic.woff2', boldItalic: 'EdenMono-BoldItalic.woff2' } },
};
export const FREE_FAMILIES = Object.keys(FREE_FONTS);
export const isFreeFont = (f) => typeof f === 'string' && Object.prototype.hasOwnProperty.call(FREE_FONTS, f);
export const STYLE_FACE = { regular: { weight: 400, style: 'normal' }, bold: { weight: 700, style: 'normal' }, italic: { weight: 400, style: 'italic' }, boldItalic: { weight: 700, style: 'italic' } };
/** The faces of a free family: [{ family, weight, style, path (relative to web/chat/) }]. */
export function freeFaces(family) {
  const f = isFreeFont(family) ? FREE_FONTS[family] : null;
  if (!f) return [];
  return Object.entries(f.styles).filter(([s, file]) => STYLE_FACE[s] && /^[\w.-]+\.woff2$/.test(file))
    .map(([s, file]) => ({ family, ...STYLE_FACE[s], path: `fonts/${f.dir}/${file}` }));
}

/** A face's class from its name: mono, serif or sans. */
export function fontKind(name) {
  const n = String(name || '').toLowerCase();
  if (isFreeFont(name)) return FREE_FONTS[name].kind;
  if (/\bmono(?!type)|\bcode\b|courier|consol|menlo|monaco|typewriter/.test(n)) return 'mono';
  if (/sans|grotesk|gothic/.test(n)) return 'sans';
  if (/serif|garamond|times|baskerville|bodoni|didot|caslon|minion|georgia|cambria|charter|roman|slab|playfair|tiempos|publico|book|antiqua|mrs eaves|sabon|canela|recoleta|cooper|palatino|perpetua/.test(n)) return 'serif';
  return 'sans';
}

// Common commercial families → the closest free one here (first match wins; tested in deck-brand.test.ts).
const CLOSEST = [
  [/courier|liberation mono|nimbus mono/, 'Cousine'],
  [/\bmono(?!type)|typewriter|\bcode\b|consol|menlo|monaco/, 'JetBrains Mono'],
  [/helvetica now|neue haas|aktiv|graphik|suisse|akzidenz|univers|sf pro|san francisco|system ui|-apple-system/, 'Inter'],
  [/helvetica|arial|nimbus sans|liberation sans/, 'Arimo'],
  [/times|liberation serif|nimbus roman/, 'Tinos'],
  [/futura|century gothic|avant garde|twentieth century|kabel|dm sans|poppins|sofia/, 'Jost'],
  [/gotham|montserrat|proxima|brandon|circular|gilroy|avenir|museo sans|sofia pro|metropolis|nunito/, 'Manrope'],
  [/garamond|sabon|caslon|bembo|jenson/, 'EB Garamond'],
  [/baskerville|mrs eaves/, 'Baskervville'],
  [/bodoni|didot|playfair|canela|recoleta|cooper|windsor|ogg|portrait/, 'Fraunces'],
  [/minion|georgia|cambria|charter|merriweather|tiempos|publico|lyon|freight text|utopia|palatino|book antiqua/, 'Source Serif 4'],
  [/frutiger|myriad|segoe|calibri|source sans|lato|gill sans|corbel|candara|tahoma|verdana|trebuchet|fira sans|noto sans/, 'Open Sans'],
  [/din|eurostile|roboto|ibm plex|bahnschrift|barlow|interstate|franklin/, 'Public Sans'],
  [/space|druk|grotesque|grotesk|eina|apercu|maison/, 'Space Grotesk'],
];
const BY_KIND = { sans: 'Inter', serif: 'Source Serif 4', mono: 'JetBrains Mono' };
/** The closest free family to `name` (a free family is its own). */
export function closestFree(name) {
  if (isFreeFont(name)) return name;
  const n = String(name || '').toLowerCase();
  for (const [re, fam] of CLOSEST) if (re.test(n) && isFreeFont(fam)) return fam;
  return BY_KIND[fontKind(name)];
}

/** PowerPoint's pitchFamily for a class (its hint when a named face is missing): roman 18, swiss 34, modern 49. */
export const PITCH = { serif: 18, sans: 34, mono: 49 };
