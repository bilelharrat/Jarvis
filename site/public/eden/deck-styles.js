// Eden Slides styles: whole visual systems on top of the slide anatomy (deck-render.js) — backgrounds, title
// treatment, bullets, cards or no cards, tables, charts, image framing and type. Each style is a theme with a
// `style` flag (deck-model.js THEMES takes STYLE_THEMES), so existing decks are untouched: a slide of a styled theme
// gets the class `st-<style>` and this file's CSS for that style only; the PowerPoint file gets its matching
// background shapes and cards (stylePptx, from deck-pptx.js). Pure: no DOM.
//
// Fonts: each theme names a CSS stack that degrades to system faces; templates also set `theme.fonts` to the free
// families (deck-fonts.js, the Eden families among them) so the frame embeds them and PowerPoint names them.

const stack = (...faces) => faces.map((f) => (/[\s\d]/.test(f) && !/^(serif|sans-serif|monospace|cursive)$/.test(f) ? `"${f}"` : f)).join(', ');

/** id → theme (the shape of deck-model.js THEMES entries, plus `style`, `palette` and `fonts`: the free families to embed). */
export const STYLE_THEMES = {
  swiss: {
    name: 'Swiss Grid', style: 'swiss', dark: false,
    colors: { bg: '#ffffff', bg2: '#ffffff', surface: '#ffffff', text: '#111111', muted: '#575757', accent: '#e30613', accent2: '#111111' },
    heading: { css: stack('Space Grotesk', 'Helvetica Neue', 'Arial', 'sans-serif'), pptx: 'Arial' }, body: { css: stack('Inter', 'Helvetica Neue', 'Arial', 'sans-serif'), pptx: 'Arial' },
    fonts: { heading: 'Space Grotesk', body: 'Inter' },
    palette: ['#e30613', '#111111', '#8c8c8c', '#f2a900', '#0055a4', '#c8c8c8'],
  },
  magazine: {
    name: 'Editorial Magazine', style: 'magazine', dark: false,
    colors: { bg: '#f4efe4', bg2: '#f4efe4', surface: '#fbf8f1', text: '#161412', muted: '#5b5249', accent: '#a4161a', accent2: '#1d3557' },
    heading: { css: stack('Fraunces', 'Playfair Display', 'Georgia', 'serif'), pptx: 'Georgia' }, body: { css: stack('Source Serif 4', 'Georgia', 'serif'), pptx: 'Georgia' },
    fonts: { heading: 'Fraunces', body: 'Source Serif 4' },
    palette: ['#a4161a', '#1d3557', '#c9a227', '#6b705c', '#457b9d', '#b7a99a'],
  },
  block: {
    name: 'Colour Block', style: 'block', dark: false,
    colors: { bg: '#ffd60a', bg2: '#ffd60a', surface: '#ffffff', text: '#111111', muted: '#383838', accent: '#ff4d00', accent2: '#2d3cff' },
    heading: { css: stack('Eden Geometric', 'Jost', 'Futura', 'Avenir Next', 'sans-serif'), pptx: 'Arial Black' }, body: { css: stack('Jost', 'Avenir Next', 'Arial', 'sans-serif'), pptx: 'Arial' },
    fonts: { heading: 'Eden Geometric', body: 'Jost' },
    palette: ['#ff4d00', '#2d3cff', '#111111', '#00a676', '#ff5fa2', '#7a5cff'],
  },
  minimal: {
    name: 'Minimal Mono', style: 'minimal', dark: false,
    colors: { bg: '#ffffff', bg2: '#ffffff', surface: '#f4f4f4', text: '#0a0a0a', muted: '#666666', accent: '#0a0a0a', accent2: '#8a8a8a' },
    heading: { css: stack('Eden Sans', 'Inter', 'Helvetica Neue', 'sans-serif'), pptx: 'Arial' }, body: { css: stack('Inter', 'Helvetica Neue', 'sans-serif'), pptx: 'Arial' },
    fonts: { heading: 'Eden Sans', body: 'Inter' },
    palette: ['#0a0a0a', '#5a5a5a', '#9a9a9a', '#cfcfcf', '#2e2e2e', '#7a7a7a'],
  },
  cinema: {
    name: 'Cinematic Dark', style: 'cinema', dark: true,
    colors: { bg: '#0b0b0c', bg2: '#151517', surface: '#18181b', text: '#f4f1ea', muted: '#aaa39b', accent: '#e8c27a', accent2: '#d9622b' },
    heading: { css: stack('Eden Display', 'Fraunces', 'Georgia', 'serif'), pptx: 'Georgia' }, body: { css: stack('Manrope', 'Avenir Next', 'Helvetica Neue', 'sans-serif'), pptx: 'Arial' },
    fonts: { heading: 'Eden Display', body: 'Manrope' },
    palette: ['#e8c27a', '#f4f1ea', '#d9622b', '#7c9a92', '#aaa39b', '#57534e'],
  },
  playful: {
    name: 'Playful Rounded', style: 'playful', dark: false,
    colors: { bg: '#fff4e6', bg2: '#ffe9d1', surface: '#ffffff', text: '#2b2118', muted: '#6b5644', accent: '#f0545a', accent2: '#1f9e91' },
    heading: { css: stack('Eden Geometric', 'SF Pro Rounded', 'Avenir Next', 'Trebuchet MS', 'sans-serif'), pptx: 'Trebuchet MS' }, body: { css: stack('Manrope', 'SF Pro Rounded', 'Avenir Next', 'sans-serif'), pptx: 'Trebuchet MS' },
    fonts: { heading: 'Eden Geometric', body: 'Manrope' },
    palette: ['#f0545a', '#1f9e91', '#ffc23c', '#7c5cff', '#ff9f1c', '#2ec4b6'],
  },
  corporate: {
    name: 'Corporate Clean', style: 'corporate', dark: false,
    colors: { bg: '#ffffff', bg2: '#f3f6fa', surface: '#ffffff', text: '#0b2545', muted: '#4f5e77', accent: '#0b2545', accent2: '#13a89e' },
    heading: { css: stack('Public Sans', 'Segoe UI', 'Helvetica Neue', 'Arial', 'sans-serif'), pptx: 'Arial' }, body: { css: stack('Public Sans', 'Segoe UI', 'Arial', 'sans-serif'), pptx: 'Arial' },
    fonts: { heading: 'Public Sans', body: 'Public Sans' },
    palette: ['#0b2545', '#13a89e', '#8da9c4', '#f2a65a', '#134074', '#5c7c99'],
  },
  academic: {
    name: 'Academic', style: 'academic', dark: false,
    colors: { bg: '#fcfbf7', bg2: '#fcfbf7', surface: '#ffffff', text: '#1b1b1b', muted: '#555048', accent: '#1f4e3d', accent2: '#7a2e1f' },
    heading: { css: stack('EB Garamond', 'Garamond', 'Georgia', 'serif'), pptx: 'Georgia' }, body: { css: stack('Source Serif 4', 'Georgia', 'serif'), pptx: 'Georgia' },
    fonts: { heading: 'EB Garamond', body: 'Source Serif 4' },
    palette: ['#1f4e3d', '#7a2e1f', '#c49a3a', '#3d5a80', '#8a8a8a', '#5b8c5a'],
  },
  gradient: {
    name: 'Startup Gradient', style: 'gradient', dark: true,
    colors: { bg: '#3a14b8', bg2: '#ff2d87', surface: '#2a1185', text: '#ffffff', muted: '#e9e2ff', accent: '#ffd166', accent2: '#7cf2ff' },
    heading: { css: stack('Eden Grotesk', 'Space Grotesk', 'Helvetica Neue', 'sans-serif'), pptx: 'Arial' }, body: { css: stack('Manrope', 'Helvetica Neue', 'sans-serif'), pptx: 'Arial' },
    fonts: { heading: 'Eden Grotesk', body: 'Manrope' },
    palette: ['#ffd166', '#7cf2ff', '#ffffff', '#ff8fab', '#b8f2a1', '#c3b5ff'],
  },
  notebook: {
    name: 'Hand-drawn Notebook', style: 'notebook', dark: false,
    colors: { bg: '#fffdf4', bg2: '#fffdf4', surface: '#fff3a3', text: '#1f2a44', muted: '#4a5472', accent: '#e63946', accent2: '#2a9d8f' },
    heading: { css: stack('Marker Felt', 'Chalkboard SE', 'Segoe Print', 'Comic Sans MS', 'cursive'), pptx: 'Segoe Print' }, body: { css: stack('Jost', 'Avenir Next', 'Trebuchet MS', 'sans-serif'), pptx: 'Trebuchet MS' },
    fonts: { body: 'Jost' },
    palette: ['#e63946', '#2a9d8f', '#f4a261', '#457b9d', '#8d6cab', '#264653'],
  },
};
export const STYLE_IDS = Object.keys(STYLE_THEMES);

// ── the slide CSS, one block per style (only the deck's style is sent to the frame) ──

const NO_FX = (p) => `${p} .orb,${p} .bg-grid,${p} .bento-orb,${p} .eb-dot,${p} .col-bar,${p} .hero-glow{display:none}`;
// a template's picture placeholder: a framed hint, not a loading shimmer (deck.js never searches for template words)
const PLACEHOLDER = '.tpl .loading-img .img-shimmer{display:none}.tpl .noimg.loading-img{border-style:dashed;font-size:17px;gap:6px}.tpl .noimg.loading-img::before{content:"";width:46px;height:34px;border:3px solid currentColor;border-radius:8px;opacity:.55;background:radial-gradient(circle at 50% 55%,currentColor 0 7px,transparent 8px)}';

const CSS = {
  swiss: (p) => `${NO_FX(p)}
${p} .bgfx{background:#fff}
${p} .bgfx::before{content:"";position:absolute;left:68px;right:68px;top:30px;height:2px;background:#111}
${p} .bgfx::after{content:"";position:absolute;left:68px;top:14px;width:14px;height:14px;background:var(--accent)}
${p} .inner{inset:52px 68px 46px}
${p} .eyebrow{background:none;border:0;box-shadow:none;padding:0;border-radius:0;color:var(--accent);font-size:13px;letter-spacing:.06em;font-weight:700}
${p} .s-title{font-weight:700;letter-spacing:-.045em;line-height:.98}
${p}.l-title .s-title,${p}.l-section .s-title{font-size:96px!important;letter-spacing:-.055em}
${p} .kicker{width:100%;height:2px;border-radius:0;background:#111;margin-bottom:24px}
${p} .subtitle{color:#111;font-size:24px;max-width:780px}
${p} .card{background:none;border:0;border-radius:0;box-shadow:none;padding:16px 0 0;border-top:2px solid #111}
${p} .bullets-card{border-left:0;justify-content:center}
${p} .bento-card,${p} .stat{border-top:2px solid #111!important;padding:14px 0 0}
${p} .bento-badge,${p} .col-num{background:none;border:0;padding:0;border-radius:0;color:var(--accent);font-size:13px;letter-spacing:.04em}
${p} .bento-grid,${p} .cols,${p} .stats{gap:32px}
${p} .bl{counter-reset:sw}${p} .bl>li{counter-increment:sw;padding-left:2.1em}
${p} .bl>li::before{content:counter(sw,decimal-leading-zero);background:none;box-shadow:none;width:auto;height:auto;border-radius:0;top:.08em;left:0;font-size:.62em;font-weight:700;color:var(--accent);font-family:var(--hf)}
${p} .bl ul>li::before{border-radius:0;background:#111;width:.3em;height:.3em}
${p} .sv{background:none;-webkit-background-clip:border-box;background-clip:border-box;color:#111;font-size:84px;font-weight:700;letter-spacing:-.06em}
${p} .stat-delta{background:none;border:0;padding:0;color:var(--accent);font-size:15px}
${p} .takeaway{background:none;border:0;border-left:8px solid var(--accent);border-radius:0;box-shadow:none;padding:4px 16px;font-size:18px}
${p} .tk-pill{background:none;color:var(--accent);padding:0}
${p} .tbl th{background:none;color:#111;border-bottom:2px solid #111;border-radius:0!important;padding-left:0}
${p} .tbl td{padding-left:0;border-bottom:1px solid #d0d0d0}${p} .tbl tr:nth-child(even) td{background:none}
${p} .chartbox,${p} .diagbox,${p} .tablebox{padding:16px 0 0}
${p} .sec-n{background:var(--accent);border-radius:0;box-shadow:none;font-size:28px;padding:8px 18px}${p} .sec-line{background:#111;height:2px;width:120px}
${p} .quote{border-left:0;border-top:2px solid #111;padding:32px 0 0}${p} .quote-mark{color:var(--accent);opacity:1;font-size:140px}
${p} .quote blockquote{font-weight:700;letter-spacing:-.03em}${p} .q-dash{background:var(--accent);border-radius:0}${p} .quote figcaption{color:#111}
${p} .side-pic,${p} .pic,${p} .title-hero,${p} .sec-pic,${p} .quote-pic,${p} .pic img{border-radius:0!important;box-shadow:none;border:0}
${p} .pic-badge{border-radius:0;background:#111}
${p} .foot{bottom:14px}${p} .fn{background:none;border:0;padding:0;color:#111}${p} .fd-dot{border-radius:0;background:var(--accent)}`,

  magazine: (p) => `${NO_FX(p)}
${p} .bgfx{background:var(--bg)}
${p} .bgfx::before{content:"";position:absolute;left:68px;right:68px;top:24px;height:5px;border-top:2px solid var(--text);border-bottom:1px solid var(--text)}
${p} .inner{inset:50px 68px 46px}
${p} .eyebrow{background:none;border:0;box-shadow:none;padding:0;border-radius:0;color:var(--accent);font-family:var(--bf);font-style:italic;text-transform:none;letter-spacing:.01em;font-size:17px;font-weight:600}
${p} .s-title{font-weight:600;letter-spacing:-.02em;line-height:1.04}
${p}.l-title .s-title{font-size:88px!important;font-style:italic;font-weight:500}
${p} .kicker{width:56px;height:3px;border-radius:0;background:var(--accent)}
${p} .subtitle{font-family:var(--bf);font-style:italic;font-size:24px}
${p} .card{background:none;border:0;border-radius:0;box-shadow:none;padding:12px 0 0}
${p} .bullets-card{border-left:0}
${p} .bullets-card .bl{columns:2;column-gap:56px;column-rule:1px solid color-mix(in srgb,var(--text) 25%,transparent);display:block}
${p} .bullets-card .bl>li{break-inside:avoid;margin-bottom:.55em}
${p} .bl>li::before{content:"■";background:none;box-shadow:none;width:auto;height:auto;border-radius:0;font-size:.5em;top:.55em;color:var(--accent)}
${p} .bento-card,${p} .stat,${p} .col{border-top:1px solid var(--text)!important;padding-top:14px}
${p} .bento-card+.bento-card,${p} .stat+.stat{border-left:1px solid color-mix(in srgb,var(--text) 25%,transparent);padding-left:24px}
${p} .bento-badge,${p} .col-num{background:none;border:0;padding:0;color:var(--accent);font-style:italic;font-family:var(--bf);text-transform:none;letter-spacing:0;font-size:15px;font-weight:600}
${p} .bento-card h3,${p} .col h3{font-weight:600;font-size:1.15em}
${p} .sv{background:none;-webkit-background-clip:border-box;background-clip:border-box;color:var(--accent);font-style:italic;font-weight:500;font-size:76px}
${p} .stat-delta{background:none;border:0;color:var(--accent2);font-style:italic;padding:0}
${p} .takeaway{background:none;border:0;border-top:1px solid var(--text);border-bottom:1px solid var(--text);border-radius:0;box-shadow:none;font-family:var(--hf);font-style:italic;font-size:20px;font-weight:500}
${p} .tk-pill{background:none;color:var(--accent);padding:0;font-family:var(--bf)}
${p} .tbl th{background:none;color:var(--text);border-top:2px solid var(--text);border-bottom:1px solid var(--text);border-radius:0!important;font-family:var(--hf);font-style:italic;font-weight:600}${p} .tbl tr:nth-child(even) td{background:none}
${p} .quote{border-left:0;padding:24px 40px;text-align:center}${p} .quote-mark{font-size:180px;color:var(--accent);opacity:.9;text-align:center}
${p} .quote blockquote{font-style:italic;font-weight:500;line-height:1.2}${p} .quote figcaption{justify-content:center;color:var(--text);font-family:var(--bf);font-style:italic}${p} .q-dash{background:var(--text);height:1px}
${p}.l-title .title-hero,${p} .sec-pic{position:absolute;top:-50px;bottom:-46px;right:-68px;width:46%;height:auto!important;border-radius:0!important;box-shadow:none;border:0}
${p}.l-title .title-split.with-hero .center,${p} .section-split.with-pic .section-wrap{max-width:54%;flex:none}
${p} .side-pic,${p} .pic,${p} .quote-pic,${p} .pic img{border-radius:0!important;box-shadow:none;border:0}
${p} .pic-badge{border-radius:0;background:none;color:var(--text);position:static;padding:6px 0 0;font-style:italic;backdrop-filter:none;border:0}
${p} .sec-n{background:none;color:var(--accent);box-shadow:none;font-style:italic;font-size:40px;padding:0;font-weight:500}${p} .sec-line{background:var(--text);height:1px}
${p} .fn{background:none;border:0;font-style:italic;color:var(--text)}${p} .fd{font-style:italic}`,

  block: (p) => `${NO_FX(p)}
${p} .bgfx{background:var(--bg)}
${p}.l-title .bgfx,${p}.l-section .bgfx{background:linear-gradient(90deg,var(--bg) 0 62%,var(--accent2) 62%)}
${p}.l-title .bgfx::after,${p}.l-section .bgfx::after{content:"";position:absolute;left:40%;bottom:0;width:22%;height:34%;background:var(--accent)}
${p}.l-title .center,${p}.l-section .section-wrap{max-width:56%}
${p} .eyebrow{background:#111;color:#fff;border:0;box-shadow:none;border-radius:0;padding:6px 12px;font-size:13px}
${p} .s-title{font-weight:900;letter-spacing:-.04em;line-height:.98;text-transform:uppercase}
${p} .kicker{width:120px;height:14px;border-radius:0;background:#111}
${p} .subtitle{color:#111;font-weight:600}
${p} .card{border-radius:0;box-shadow:8px 8px 0 #111;border:3px solid #111;background:#fff}
${p} .bento-card.bc-0{background:var(--accent);color:#111}${p} .bento-card.bc-1{background:var(--accent2);color:#fff}${p} .bento-card.bc-2{background:#fff}${p} .bento-card.bc-3{background:#111;color:#fff}
${p} .bento-card{border-top-width:3px!important;border-top-color:#111!important}
${p} .bento-card.bc-1 h3,${p} .bento-card.bc-3 h3{color:#fff}${p} .bento-card.bc-1 .bl ul,${p} .bento-card.bc-3 .bl ul{color:#eee}
${p} .bento-badge,${p} .col-num{background:#111;color:#fff!important;border:0;border-radius:0}
${p} .bc-3 .bento-badge{background:#fff;color:#111!important}
${p} .bullets-card{border-left:3px solid #111}
${p} .bl>li::before{border-radius:0;background:#111;box-shadow:none;width:.5em;height:.5em}
${p} .stat.st-0{background:var(--accent)}${p} .stat.st-1{background:var(--accent2);color:#fff}${p} .stat.st-1 .sl,${p} .stat.st-1 .stat-idx{color:#fff}${p} .stat.st-1 .sv{color:#fff}
${p} .stat{border-top-color:#111!important}
${p} .sv{background:none;-webkit-background-clip:border-box;background-clip:border-box;color:#111;font-weight:900}
${p} .stat-delta{background:#111;color:#fff;border:0;border-radius:0}
${p} .takeaway{background:#111;color:#fff;border:0;border-radius:0;box-shadow:none}${p} .tk-pill{background:var(--accent);color:#111;border-radius:0}
${p} .tbl th{background:#111;color:#fff;border-radius:0!important}${p} .tbl tr:nth-child(even) td{background:color-mix(in srgb,var(--accent) 18%,#fff)}
${p} .quote{background:var(--accent2);color:#fff;border-left:0}${p} .quote-mark{color:var(--bg);opacity:1}${p} .quote figcaption{color:var(--bg)}${p} .q-dash{background:var(--bg)}
${p} .sec-n{background:#111;border-radius:0;box-shadow:none}${p} .sec-line{background:#111;height:6px}
${p} .side-pic,${p} .pic,${p} .title-hero,${p} .sec-pic,${p} .quote-pic,${p} .pic img{border-radius:0!important;border:3px solid #111;box-shadow:8px 8px 0 #111}
${p}.l-title .title-hero,${p} .sec-pic{position:absolute;right:-68px;top:-44px;bottom:-46px;width:38%;height:auto!important;border:0!important;box-shadow:none!important;flex:none}
${p}.l-title .title-hero .noimg,${p} .sec-pic .noimg{border:0;border-radius:0;color:#fff;background:var(--accent2)}
${p} .fn{background:#111;color:#fff;border:0;border-radius:0}${p} .fd-dot{border-radius:0;background:#111}`,

  minimal: (p) => `${NO_FX(p)}
${p} .bgfx{background:#fff}
${p} .inner{inset:72px 120px 64px}
${p} .eyebrow{background:none;border:0;box-shadow:none;padding:0;border-radius:0;color:var(--muted);font-weight:500;letter-spacing:.24em;font-size:11px}
${p} .s-title{font-weight:300;letter-spacing:-.03em;line-height:1.08}
${p}.l-title .s-title,${p}.l-section .s-title{font-weight:250;font-size:76px!important}
${p} .kicker{width:40px;height:1px;border-radius:0;background:#0a0a0a}
${p} .subtitle{font-weight:300;color:var(--muted)}
${p} .card{background:none;border:0;border-radius:0;box-shadow:none;padding:0}
${p} .bullets-card{border-left:0}
${p} .bl{gap:.75em;font-weight:300}
${p} .bl>li{padding-left:1.6em}${p} .bl>li::before{content:"—";background:none;box-shadow:none;width:auto;height:auto;border-radius:0;top:0;left:0;color:var(--muted)}
${p} .bl ul>li::before{content:"·";background:none;width:auto;height:auto;top:0}
${p} .bento-card,${p} .stat{border-top:1px solid #0a0a0a!important;padding-top:18px}
${p} .bento-badge,${p} .col-num{background:none;border:0;padding:0;color:var(--muted);font-weight:500;letter-spacing:.2em}
${p} .bento-card h3,${p} .col h3{font-weight:400}
${p} .sv{background:none;-webkit-background-clip:border-box;background-clip:border-box;color:#0a0a0a;font-weight:200;font-size:72px}
${p} .stat-delta{background:none;border:1px solid #0a0a0a;color:#0a0a0a;font-weight:400}
${p} .takeaway{background:none;border:0;border-top:1px solid #0a0a0a;border-radius:0;box-shadow:none;font-weight:400;padding:12px 0}${p} .tk-pill{background:#0a0a0a;color:#fff;border-radius:0}
${p} .tbl th{background:none;color:var(--muted);font-weight:500;border-bottom:1px solid #0a0a0a;border-radius:0!important;letter-spacing:.1em;text-transform:uppercase;font-size:.7em}${p} .tbl td{font-weight:300}${p} .tbl tr:nth-child(even) td{background:none}
${p} .quote{border-left:0;padding:0}${p} .quote-mark{display:none}${p} .quote blockquote{font-weight:250}${p} .quote figcaption{color:var(--muted);font-weight:400}${p} .q-dash{background:#0a0a0a;height:1px}
${p} .sec-n{background:none;color:#0a0a0a;box-shadow:none;font-weight:250;font-size:52px;padding:0}${p} .sec-line{background:#0a0a0a;height:1px}
${p} .side-pic,${p} .pic,${p} .title-hero,${p} .sec-pic,${p} .quote-pic,${p} .pic img{border-radius:0!important;box-shadow:none;border:0;filter:grayscale(1)}
${p} .pic-badge{display:none}
${p} .foot{left:120px;right:120px}${p} .fn{background:none;border:0;font-weight:400}${p} .fd-dot{display:none}`,

  cinema: (p) => `${NO_FX(p)}
${p} .bgfx{background:radial-gradient(120% 90% at 50% 0%,#1b1b1e,#0b0b0c 70%)}
${p} .eyebrow{background:none;border:0;box-shadow:none;padding:0;border-radius:0;color:var(--accent);letter-spacing:.42em;font-size:12px;font-weight:600}
${p} .s-title{font-weight:500;letter-spacing:-.01em;line-height:1.04}
${p}.l-title .s-title,${p}.l-section .s-title{font-size:92px!important;font-weight:400;text-shadow:0 4px 30px rgba(0,0,0,.6)}
${p} .kicker{width:64px;height:1px;border-radius:0;background:var(--accent)}
${p}.l-title .title-hero,${p} .sec-pic{position:absolute;inset:-44px -68px -46px;width:auto!important;height:auto!important;border-radius:0!important;box-shadow:none;border:0;z-index:0;flex:none}
${p}.l-title .title-hero::after,${p} .sec-pic::after{content:"";position:absolute;inset:0;background:linear-gradient(90deg,rgba(5,5,6,.92) 0%,rgba(5,5,6,.6) 45%,rgba(5,5,6,.15) 100%),linear-gradient(0deg,rgba(5,5,6,.7),transparent 40%)}
${p}.l-title .center,${p} .section-wrap{position:relative;z-index:1}
${p}.l-title .title-hero .noimg,${p} .sec-pic .noimg{border:0;border-radius:0;align-items:flex-end;justify-content:flex-end;padding:0 56px 52px 0;font-size:14px;color:rgba(244,241,234,.55);background:linear-gradient(135deg,#141416,#26221c)}
${p}.l-title .title-split.with-hero .center,${p} .section-split.with-pic .section-wrap{max-width:720px;flex:none}
${p} .card{background:rgba(255,255,255,.035);border:1px solid rgba(232,194,122,.28);border-radius:4px;box-shadow:none;backdrop-filter:none}
${p} .bullets-card{border-left:1px solid var(--accent)}
${p} .bl>li::before{background:var(--accent);box-shadow:none;width:.9em;height:1px;border-radius:0;top:.68em}
${p} .bl>li{padding-left:1.6em}
${p} .bento-card,${p} .stat{border-top:1px solid var(--accent)!important}
${p} .bento-badge,${p} .col-num{background:none;border:0;padding:0;color:var(--accent);letter-spacing:.3em}
${p} .sv{background:none;-webkit-background-clip:border-box;background-clip:border-box;color:var(--accent);font-family:var(--hf);font-weight:400;font-size:70px}
${p} .stat-delta{background:none;border:1px solid rgba(232,194,122,.5);color:var(--accent)}
${p} .takeaway{background:none;border:0;border-top:1px solid rgba(232,194,122,.5);border-radius:0;box-shadow:none;color:var(--text)}${p} .tk-pill{background:none;color:var(--accent);letter-spacing:.3em;padding:0}
${p} .tbl th{background:none;color:var(--accent);border-bottom:1px solid var(--accent);border-radius:0!important;letter-spacing:.2em;text-transform:uppercase;font-size:.72em}${p} .tbl tr:nth-child(even) td{background:rgba(255,255,255,.03)}${p} .tbl td{border-color:rgba(255,255,255,.1)}
${p} .quote{background:none;border:0;padding:0}${p} .quote-mark{color:var(--accent);opacity:.8}${p} .quote blockquote{font-weight:400}${p} .q-dash{background:var(--accent)}
${p} .sec-n{background:none;box-shadow:none;color:var(--accent);padding:0;letter-spacing:.3em;font-weight:500}${p} .sec-line{background:var(--accent);height:1px}
${p} .side-pic,${p} .pic,${p} .quote-pic{border-radius:2px!important;box-shadow:0 30px 60px rgba(0,0,0,.6);border:0}
${p} .fn{background:none;border:0;color:var(--accent);letter-spacing:.2em}${p} .fd-dot{background:var(--accent)}`,

  playful: (p) => `${NO_FX(p)}
${p} .bgfx{background:var(--bg)}
${p} .bgfx::before{content:"";position:absolute;width:300px;height:300px;right:-90px;top:-110px;border-radius:50%;background:var(--accent2);opacity:.9}
${p} .bgfx::after{content:"";position:absolute;width:180px;height:180px;left:-60px;bottom:-70px;border-radius:42% 58% 63% 37% / 41% 44% 56% 59%;background:#ffc23c}
${p}.l-title .bgfx::after,${p}.l-section .bgfx::after{width:360px;height:360px;left:auto;right:120px;bottom:-200px;background:var(--accent)}
${p} .eyebrow{background:#ffc23c;color:#2b2118;border:2px solid #2b2118;border-radius:999px;box-shadow:3px 3px 0 #2b2118;font-size:13px}
${p} .s-title{font-weight:800;letter-spacing:-.02em}
${p} .kicker{width:90px;height:14px;border-radius:99px;background:repeating-linear-gradient(90deg,var(--accent) 0 14px,transparent 14px 22px)}
${p} .card{background:#fff;border:3px solid #2b2118;border-radius:28px;box-shadow:6px 6px 0 #2b2118}
${p} .bullets-card{border-left-width:3px}
${p} .bento-card.bc-0{background:#ffe1e1}${p} .bento-card.bc-1{background:#d9f4f0}${p} .bento-card.bc-2{background:#fff1c9}${p} .bento-card.bc-3{background:#e9e3ff}
${p} .bento-card{border-top-width:3px!important;border-top-color:#2b2118!important}
${p} .bento-badge,${p} .col-num{background:#fff;border:2px solid #2b2118;color:#2b2118!important}
${p} .bl>li::before{width:.62em;height:.62em;top:.36em;background:var(--accent);box-shadow:none;border:2px solid #2b2118}
${p} .bl>li:nth-child(3n+2)::before{background:var(--accent2);border-radius:3px;transform:rotate(45deg)}${p} .bl>li:nth-child(3n)::before{background:#ffc23c;border-radius:2px}
${p} .stat.st-0{background:#ffe1e1}${p} .stat.st-1{background:#d9f4f0}${p} .stat.st-2{background:#fff1c9}${p} .stat.st-3{background:#e9e3ff}
${p} .stat{border-top-color:#2b2118!important}
${p} .sv{background:none;-webkit-background-clip:border-box;background-clip:border-box;color:#2b2118;font-weight:900}
${p} .stat-delta{background:#fff;border:2px solid #2b2118;color:#2b2118}
${p} .takeaway{background:#ffc23c;border:3px solid #2b2118;border-radius:999px;box-shadow:4px 4px 0 #2b2118}${p} .tk-pill{background:#2b2118;color:#fff}
${p} .tbl th{background:var(--accent2);color:#fff}${p} .tbl th:first-child{border-radius:18px 0 0 0}${p} .tbl th:last-child{border-radius:0 18px 0 0}${p} .tbl tr:nth-child(even) td{background:#fff6ea}
${p} .quote{border-left:0}${p} .quote-mark{color:var(--accent);opacity:1}
${p} .sec-n{background:var(--accent);border:3px solid #2b2118;box-shadow:4px 4px 0 #2b2118}${p} .sec-line{background:repeating-linear-gradient(90deg,#2b2118 0 10px,transparent 10px 16px);height:4px}
${p} .side-pic,${p} .pic,${p} .title-hero,${p} .sec-pic,${p} .quote-pic{border-radius:44px 44px 44px 8px!important;border:3px solid #2b2118;box-shadow:8px 8px 0 #2b2118}${p} .pic img{border-radius:0}
${p} .fn{background:#fff;border:2px solid #2b2118;color:#2b2118}${p} .fd-dot{background:var(--accent)}`,

  corporate: (p) => `${NO_FX(p)}
${p} .bgfx{background:#fff}
${p} .bgfx::before{content:"";position:absolute;left:0;right:0;top:0;height:12px;background:var(--accent)}
${p} .bgfx::after{content:"";position:absolute;left:68px;right:68px;bottom:40px;height:1px;background:#c9d3e0}
${p}.l-title .bgfx,${p}.l-section .bgfx{background:linear-gradient(90deg,#fff 0 64%,var(--accent) 64%)}
${p}.l-title .bgfx::before,${p}.l-section .bgfx::before{top:auto;bottom:0;height:16px;background:var(--accent2)}
${p}.l-title .bgfx::after,${p}.l-section .bgfx::after{left:64%;right:0;top:0;bottom:auto;height:12px;background:var(--accent2)}
${p}.l-title .center,${p}.l-section .section-wrap{max-width:60%}
${p}.l-title .title-hero{position:absolute;right:-68px;top:-46px;bottom:-52px;width:36%;height:auto;border:0;border-radius:0!important}
${p} .inner{inset:46px 68px 52px}
${p} .eyebrow{background:none;border:0;box-shadow:none;padding:0;border-radius:0;color:var(--accent2);font-size:13px;letter-spacing:.12em}
${p} .s-title{font-weight:700;letter-spacing:-.015em}
${p} .kicker{width:72px;height:6px;border-radius:0;background:var(--accent2)}
${p} .card{background:#fff;border:1px solid #d5dde8;border-radius:4px;box-shadow:0 1px 2px rgba(11,37,69,.06)}
${p} .bullets-card{border-left:4px solid var(--accent2)}
${p} .bento-card,${p} .stat{border-top:4px solid var(--accent)!important}
${p} .bento-card.bc-1,${p} .bento-card.bc-3,${p} .stat.st-1,${p} .stat.st-3{border-top-color:var(--accent2)!important}
${p} .bento-badge,${p} .col-num{background:#eef3f8;border:0;border-radius:3px;color:var(--accent)!important}
${p} .bl>li::before{border-radius:1px;background:var(--accent2);box-shadow:none;width:.42em;height:.42em}
${p} .sv{background:none;-webkit-background-clip:border-box;background-clip:border-box;color:var(--accent);font-weight:700}
${p} .stat-delta{background:#e5f6f4;color:#0d6e67;border:0;border-radius:3px}
${p} .takeaway{background:#eef3f8;border:0;border-left:4px solid var(--accent);border-radius:0;box-shadow:none}${p} .tk-pill{background:var(--accent);border-radius:2px}
${p} .tbl th{background:var(--accent);border-radius:0!important}${p} .tbl tr:nth-child(even) td{background:#f3f6fa}${p} .tbl td{border-bottom:1px solid #dfe5ee}
${p} .quote{border-left:4px solid var(--accent2);background:#f3f6fa}${p} .quote-mark{color:var(--accent);opacity:.25}
${p} .sec-n{background:var(--accent2);border-radius:2px;box-shadow:none}${p} .sec-line{background:#fff}
${p} .side-pic,${p} .pic,${p} .title-hero,${p} .sec-pic,${p} .quote-pic,${p} .pic img{border-radius:4px!important;box-shadow:none;border:1px solid #d5dde8}
${p} .fn{background:none;border:0;color:var(--muted)}${p} .fd-dot{border-radius:0;background:var(--accent2)}`,

  academic: (p) => `${NO_FX(p)}
${p} .bgfx{background:var(--bg)}
${p} .bgfx::after{content:"";position:absolute;left:68px;right:68px;bottom:42px;height:1px;background:#bdb6a8}
${p} .slide-inner,${p} .inner{counter-reset:fig}
${p} .eyebrow{background:none;border:0;box-shadow:none;padding:0;border-radius:0;color:var(--accent);font-family:var(--hf);font-variant:small-caps;text-transform:lowercase;letter-spacing:.08em;font-size:18px;font-weight:600}
${p} .s-title{font-weight:600;letter-spacing:0;line-height:1.12}
${p}.l-title .s-title{text-align:left}
${p} .kicker{width:100%;height:1px;border-radius:0;background:var(--text);margin-bottom:8px}
${p} .subtitle{font-style:italic}
${p} .card{background:none;border:0;border-radius:0;box-shadow:none;padding:6px 0}
${p} .bullets-card{border-left:0}
${p} .bl{counter-reset:ac}${p} .bl>li{counter-increment:ac;padding-left:2em}
${p} .bl>li::before{content:counter(ac,lower-roman) ".";background:none;box-shadow:none;width:auto;height:auto;border-radius:0;top:0;left:0;color:var(--accent);font-style:italic}
${p} .bento-card,${p} .stat,${p} .col{border-top:1px solid var(--text)!important;padding-top:10px}
${p} .bento-badge,${p} .col-num{background:none;border:0;padding:0;color:var(--accent);font-variant:small-caps;text-transform:lowercase;letter-spacing:.06em;font-size:15px}
${p} .sv{background:none;-webkit-background-clip:border-box;background-clip:border-box;color:var(--text);font-weight:500}
${p} .stat-delta{background:none;border:0;color:var(--accent2);font-style:italic}
${p} .chartbox,${p} .diagbox{counter-increment:fig;flex-direction:column;border-top:1px solid var(--text);border-bottom:1px solid var(--text);padding:10px 0}
${p} .chartbox::after,${p} .diagbox::after{content:"Figure " counter(fig);align-self:flex-start;font-style:italic;font-size:15px;color:var(--muted);margin-top:4px}
${p} .takeaway{background:none;border:1px solid var(--text);border-radius:0;box-shadow:none;font-style:italic;font-weight:500}${p} .tk-pill{background:none;color:var(--accent);padding:0;font-style:normal}
${p} .tbl{border-top:2px solid var(--text);border-bottom:2px solid var(--text)}${p} .tbl th{background:none;color:var(--text);border-bottom:1px solid var(--text);border-radius:0!important;font-weight:600}${p} .tbl td{border-bottom:0}${p} .tbl tr:nth-child(even) td{background:none}
${p} .quote{border-left:2px solid var(--accent);font-style:italic}${p} .quote-mark{display:none}${p} .quote blockquote{font-weight:500}${p} .q-dash{background:var(--text);height:1px}
${p} .sec-n{background:none;color:var(--accent);box-shadow:none;padding:0;font-size:40px}${p} .sec-n::before{content:"§ "}${p} .sec-line{background:var(--text);height:1px}
${p} .side-pic,${p} .pic,${p} .title-hero,${p} .sec-pic,${p} .quote-pic,${p} .pic img{border-radius:0!important;box-shadow:none;border:1px solid var(--text)}
${p} .pic-badge{border-radius:0;background:#fff;color:var(--text);font-style:italic;border:1px solid var(--text);backdrop-filter:none}
${p} .fn{background:none;border:0;font-style:italic}${p} .fd-dot{display:none}`,

  gradient: (p) => `${NO_FX(p)}
${p} .bgfx{background:linear-gradient(125deg,#2a0fa6 0%,#5b1fd6 38%,#c026d3 72%,#ff2d87 100%)}
${p}:not(.l-title):not(.l-section):not(.l-quote) .bgfx{background:linear-gradient(160deg,#1b0b5e 0%,#2d0f8f 55%,#4a1199 100%)}
${p}:not(.l-title):not(.l-section):not(.l-quote) .bgfx::after{content:"";position:absolute;left:0;right:0;top:0;height:8px;background:linear-gradient(90deg,#5b1fd6,#c026d3,#ff2d87)}
${p} .eyebrow{background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.3);box-shadow:none;color:#fff}
${p} .s-title{font-weight:800;letter-spacing:-.04em}
${p}.l-title .s-title,${p}.l-section .s-title{font-size:90px!important;letter-spacing:-.05em}
${p} .kicker{background:#fff;height:6px}
${p} .subtitle{color:rgba(255,255,255,.86)}
${p} .card{background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.22);border-radius:20px;box-shadow:none}
${p} .bullets-card{border-left:4px solid var(--accent)}
${p} .bento-card,${p} .stat{border-top:3px solid var(--accent)!important}${p} .bento-card.bc-1,${p} .bento-card.bc-3,${p} .stat.st-1,${p} .stat.st-3{border-top-color:var(--accent2)!important}
${p} .bento-badge,${p} .col-num{background:rgba(255,255,255,.16);border:0;color:#fff!important}
${p} .bl>li::before{background:linear-gradient(135deg,var(--accent),#ff8fab);box-shadow:none}
${p} .sv{background:linear-gradient(120deg,#fff,var(--accent));-webkit-background-clip:text;background-clip:text;color:transparent}
${p} .stat-delta{background:rgba(255,209,102,.16);border:0;color:var(--accent)}
${p} .takeaway{background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.25)}${p} .tk-pill{background:var(--accent);color:#1b0b5e}
${p} .tbl th{background:rgba(255,255,255,.18)}${p} .tbl tr:nth-child(even) td{background:rgba(255,255,255,.05)}${p} .tbl td{border-color:rgba(255,255,255,.14)}
${p} .quote{border:0;background:none}${p} .quote-mark{color:#fff;opacity:.5}${p} .quote blockquote{font-weight:750}${p} .quote figcaption{color:var(--accent)}
${p} .sec-n{background:#fff;color:#2a0fa6;box-shadow:none}${p} .sec-line{background:#fff}
${p} .side-pic,${p} .pic,${p} .title-hero,${p} .sec-pic,${p} .quote-pic,${p} .pic img{border-radius:28px!important;border:0;box-shadow:0 30px 60px rgba(20,0,60,.45)}
${p} .noimg{border-color:rgba(255,255,255,.4);color:rgba(255,255,255,.8)}
${p} .fn{background:rgba(255,255,255,.14);border:0;color:#fff}${p} .fd-dot{background:var(--accent)}`,

  notebook: (p) => `${NO_FX(p)}
${p} .bgfx{background:repeating-linear-gradient(180deg,transparent 0 35px,#c9dcf0 35px 36px),var(--bg)}
${p} .bgfx::before{content:"";position:absolute;top:0;bottom:0;left:52px;width:2px;background:#f2a1a7}
${p} .bgfx::after{content:"";position:absolute;top:0;bottom:0;left:16px;width:16px;background:radial-gradient(circle at 8px 60px,#e6e1d3 7px,transparent 8px) 0 0/16px 120px repeat-y}
${p} .inner{inset:40px 68px 46px 84px}
${p} .eyebrow{background:none;border:0;box-shadow:none;padding:0;border-radius:0;color:var(--accent);font-family:var(--hf);text-transform:none;letter-spacing:0;font-size:22px;transform:rotate(-2deg);transform-origin:left}
${p} .s-title{font-weight:700;letter-spacing:0;line-height:1.1;background:linear-gradient(180deg,transparent 58%,rgba(255,224,102,.85) 58% 92%,transparent 92%);display:inline;-webkit-box-decoration-break:clone;box-decoration-break:clone;padding:0 6px}
${p} .s-head{display:block}
${p} .kicker{width:150px;height:10px;border-radius:0;background:none;border-bottom:4px solid var(--accent);transform:rotate(-1.5deg)}
${p} .card{background:var(--surface);border:0;border-radius:2px;box-shadow:2px 6px 14px rgba(60,50,20,.18)}
${p} .bento-card:nth-child(odd){transform:rotate(-1.2deg)}${p} .bento-card:nth-child(even){transform:rotate(1deg)}
${p} .bento-card.bc-1{background:#d9f2ee}${p} .bento-card.bc-2{background:#ffd9d6}${p} .bento-card.bc-3{background:#e3e3ff}
${p} .bento-card,${p} .stat{border-top:0!important}
${p} .bullets-card{border-left:0;background:none;box-shadow:none}
${p} .bento-badge,${p} .col-num{background:none;border:0;color:var(--accent)!important;font-family:var(--hf);text-transform:none;letter-spacing:0;font-size:16px}
${p} .bl>li{padding-left:1.5em}${p} .bl>li::before{content:"✓";background:none;box-shadow:none;width:auto;height:auto;border-radius:0;top:-.05em;left:0;color:var(--accent2);font-weight:900;font-family:var(--hf)}
${p} .sv{background:none;-webkit-background-clip:border-box;background-clip:border-box;color:var(--accent);font-family:var(--hf)}
${p} .stat-delta{background:none;border:2px solid var(--accent2);color:var(--accent2);border-radius:40% 60% 55% 45%}
${p} .takeaway{background:none;border:2px dashed var(--accent);border-radius:12px;box-shadow:none;font-family:var(--hf)}${p} .tk-pill{background:var(--accent);border-radius:4px}
${p} .tbl th{background:none;color:var(--text);border-bottom:3px solid var(--accent);border-radius:0!important;font-family:var(--hf)}${p} .tbl tr:nth-child(even) td{background:none}
${p} .quote{border-left:0;background:var(--surface);transform:rotate(-1deg)}${p} .quote-mark{color:var(--accent);opacity:.8}${p} .quote blockquote{font-family:var(--hf)}
${p} .sec-n{background:none;color:var(--accent);box-shadow:none;font-family:var(--hf);border:3px solid var(--accent);border-radius:50%}${p} .sec-line{background:none;border-bottom:4px solid var(--accent);transform:rotate(-2deg)}
${p} .side-pic,${p} .pic,${p} .title-hero,${p} .sec-pic,${p} .quote-pic{border-radius:2px!important;border:10px solid #fff;border-bottom-width:34px;box-shadow:3px 8px 18px rgba(60,50,20,.25);transform:rotate(2deg)}${p} .pic img{border-radius:0}
${p} .fn{background:none;border:0;font-family:var(--hf);color:var(--accent)}${p} .fd-dot{display:none}`,
};

/** The extra CSS for a theme's style ('' for the classic themes), plus the template picture placeholder. */
export function styleCss(t) {
  const f = t && t.style && CSS[t.style];
  // the styles' big numbers, kept inside a row of three or four (a value like "$625,000" is up to 16 characters)
  const fit = f ? `\n.st-${t.style} .stats.n3 .sv{font-size:58px}.st-${t.style} .stats.n4 .sv{font-size:46px;letter-spacing:-.03em}.st-${t.style} .sv{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}` : '';
  return `\n${PLACEHOLDER}\n${f ? f(`.st-${t.style}`) : ''}${fit}`;
}

// ── PowerPoint: the same systems as shapes behind each slide, and each style's card ──

const PANEL = { corporate: '0B2545' };
/**
 * For deck-pptx.js: { bg(slide, s) → background color hex or null, decor(ctx), card(ctx) → true when it drew the card }.
 * ctx: { slide, pres, s (the slide), x, y, w, h (px), IN, C }.
 */
export function stylePptx(t) {
  const id = t && t.style;
  if (!id || !CSS[id]) return null;
  const line = (ctx, x, y, w, h, color, width = 1) => ctx.slide.addShape(ctx.pres.ShapeType.line, { x: ctx.IN(x), y: ctx.IN(y), w: ctx.IN(w), h: ctx.IN(h), line: { color, width } });
  const rect = (ctx, x, y, w, h, color, extra = {}) => ctx.slide.addShape(ctx.pres.ShapeType.rect, { x: ctx.IN(x), y: ctx.IN(y), w: ctx.IN(w), h: ctx.IN(h), fill: { color }, line: { color, transparency: 100 }, ...extra });
  const big = (s) => s.layout === 'title' || s.layout === 'section';
  return {
    bg(s) {
      if (id === 'gradient') return big(s) ? '7A1FD0' : '24107A';
      return null;
    },
    decor(ctx) {
      const { s, C } = ctx;
      switch (id) {
        case 'swiss': line(ctx, 68, 30, 1144, 0, '111111', 1.5); rect(ctx, 68, 12, 14, 14, C(t.colors.accent)); break;
        case 'magazine': line(ctx, 68, 24, 1144, 0, C(t.colors.text), 1.5); line(ctx, 68, 29, 1144, 0, C(t.colors.text), 0.75); break;
        case 'block':
          if (big(s)) { rect(ctx, 794, 0, 486, 720, C(t.colors.accent2)); rect(ctx, 512, 476, 282, 244, C(t.colors.accent)); }
          else rect(ctx, 0, 0, 1280, 14, '111111');
          break;
        case 'cinema': line(ctx, 68, 690, 1144, 0, C(t.colors.accent), 0.5); break;
        case 'playful':
          ctx.slide.addShape(ctx.pres.ShapeType.ellipse, { x: ctx.IN(1070), y: ctx.IN(-110), w: ctx.IN(300), h: ctx.IN(300), fill: { color: C(t.colors.accent2) }, line: { color: C(t.colors.accent2) } });
          ctx.slide.addShape(ctx.pres.ShapeType.ellipse, { x: ctx.IN(-60), y: ctx.IN(610), w: ctx.IN(180), h: ctx.IN(180), fill: { color: 'FFC23C' }, line: { color: 'FFC23C' } });
          break;
        case 'corporate':
          if (big(s)) { rect(ctx, 819, 0, 461, 720, PANEL.corporate); rect(ctx, 0, 704, 1280, 16, C(t.colors.accent2)); rect(ctx, 819, 0, 461, 12, C(t.colors.accent2)); }
          else { rect(ctx, 0, 0, 1280, 12, C(t.colors.accent)); line(ctx, 68, 680, 1144, 0, 'C9D3E0', 0.75); }
          break;
        case 'academic': line(ctx, 68, 678, 1144, 0, 'BDB6A8', 0.75); break;
        case 'gradient':
          if (big(s)) rect(ctx, 760, 0, 520, 720, 'E0298F', { fill: { color: 'E0298F', transparency: 35 } });
          else rect(ctx, 0, 0, 1280, 8, 'C026D3');
          break;
        case 'notebook':
          for (let y = 36; y < 720; y += 36) line(ctx, 0, y, 1280, 0, 'C9DCF0', 0.5);
          line(ctx, 52, 0, 0, 720, 'F2A1A7', 1.5);
          break;
        default: break;
      }
    },
    card(ctx) {
      const { x, y, w, h, C } = ctx;
      switch (id) {
        case 'swiss': case 'minimal': case 'academic': line(ctx, x, y, w, 0, C(t.colors.text), id === 'swiss' ? 2 : 0.75); return true;
        case 'magazine': line(ctx, x, y, w, 0, C(t.colors.text), 0.75); return true;
        case 'block': rect(ctx, x + 8, y + 8, w, h, '111111'); ctx.slide.addShape(ctx.pres.ShapeType.rect, { x: ctx.IN(x), y: ctx.IN(y), w: ctx.IN(w), h: ctx.IN(h), fill: { color: 'FFFFFF' }, line: { color: '111111', width: 2.25 } }); return true;
        case 'playful': ctx.slide.addShape(ctx.pres.ShapeType.roundRect, { x: ctx.IN(x + 6), y: ctx.IN(y + 6), w: ctx.IN(w), h: ctx.IN(h), fill: { color: '2B2118' }, line: { color: '2B2118' }, rectRadius: 0.3 }); ctx.slide.addShape(ctx.pres.ShapeType.roundRect, { x: ctx.IN(x), y: ctx.IN(y), w: ctx.IN(w), h: ctx.IN(h), fill: { color: 'FFFFFF' }, line: { color: '2B2118', width: 2.25 }, rectRadius: 0.3 }); return true;
        case 'corporate': ctx.slide.addShape(ctx.pres.ShapeType.rect, { x: ctx.IN(x), y: ctx.IN(y), w: ctx.IN(w), h: ctx.IN(h), fill: { color: 'FFFFFF' }, line: { color: 'D5DDE8', width: 0.75 } }); rect(ctx, x, y, w, 4, C(t.colors.accent)); return true;
        case 'cinema': ctx.slide.addShape(ctx.pres.ShapeType.rect, { x: ctx.IN(x), y: ctx.IN(y), w: ctx.IN(w), h: ctx.IN(h), fill: { color: 'FFFFFF', transparency: 96 }, line: { color: C(t.colors.accent), width: 0.75, transparency: 55 } }); return true;
        case 'gradient': ctx.slide.addShape(ctx.pres.ShapeType.roundRect, { x: ctx.IN(x), y: ctx.IN(y), w: ctx.IN(w), h: ctx.IN(h), fill: { color: 'FFFFFF', transparency: 88 }, line: { color: 'FFFFFF', transparency: 70, width: 0.75 }, rectRadius: 0.2 }); return true;
        case 'notebook': ctx.slide.addShape(ctx.pres.ShapeType.rect, { x: ctx.IN(x), y: ctx.IN(y), w: ctx.IN(w), h: ctx.IN(h), fill: { color: C(t.colors.surface) }, line: { color: C(t.colors.surface), transparency: 100 }, shadow: { type: 'outer', blur: 6, offset: 3, angle: 60, color: '3C3214', opacity: 0.25 } }); return true;
        default: return false;
      }
    },
  };
}
