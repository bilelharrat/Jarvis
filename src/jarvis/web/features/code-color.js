// Eden Code theme color in Settings (features/code_color.py): independent Accent color and
// Background color pickers, each with preselected swatches + interactive RGB color wheel,
// brightness slider, and Hex/RGB inputs. Tints the accent color and frosted Liquid Glass
// wallpaper independently across light and dark mode. Pure helpers exported for node --test.
(function (root) {
  'use strict';

  const DEFAULT_COLOR = '#007aff';
  const DEFAULT_BG_COLOR = '#dce6f5';
  const STORE_KEY = 'eden.code.color';
  const BG_STORE_KEY = 'eden.code.bg_color';

  const PRESETS = [
    { id: 'blue', label: 'Eden Blue', hex: '#007aff' },
    { id: 'indigo', label: 'Indigo', hex: '#5e5ce6' },
    { id: 'purple', label: 'Purple', hex: '#af52de' },
    { id: 'rose', label: 'Rose', hex: '#ff2d55' },
    { id: 'red', label: 'Red', hex: '#ff3b30' },
    { id: 'orange', label: 'Orange', hex: '#ff9500' },
    { id: 'emerald', label: 'Emerald', hex: '#34c759' },
    { id: 'teal', label: 'Teal', hex: '#30b0c7' },
    { id: 'black', label: 'Black', hex: '#000000' },
  ];

  const BG_PRESETS = [
    { id: 'sky', label: 'Sky Glass', hex: '#dce6f5' },
    { id: 'midnight', label: 'Midnight', hex: '#1e3a8a' },
    { id: 'indigo', label: 'Cosmic Indigo', hex: '#4338ca' },
    { id: 'plum', label: 'Amethyst', hex: '#7e22ce' },
    { id: 'rose', label: 'Sunset Rose', hex: '#be123c' },
    { id: 'amber', label: 'Warm Amber', hex: '#d97706' },
    { id: 'forest', label: 'Forest Pine', hex: '#047857' },
    { id: 'slate', label: 'Slate Grey', hex: '#64748b' },
    { id: 'black', label: 'Black', hex: '#000000' },
  ];

  function clamp(n, min, max) {
    const v = Number(n);
    if (!Number.isFinite(v)) return min;
    return Math.min(max, Math.max(min, v));
  }

  function normalizeHex(input) {
    if (typeof input !== 'string') return '';
    const raw = input.trim().replace(/^#/, '').toLowerCase();
    if (/^[0-9a-f]{3}$/.test(raw)) {
      return `#${raw[0]}${raw[0]}${raw[1]}${raw[1]}${raw[2]}${raw[2]}`;
    }
    if (/^[0-9a-f]{6}$/.test(raw)) {
      return `#${raw}`;
    }
    return '';
  }

  function hexToRgb(hex) {
    const clean = normalizeHex(hex) || DEFAULT_COLOR;
    const n = parseInt(clean.slice(1), 16);
    return {
      r: (n >> 16) & 255,
      g: (n >> 8) & 255,
      b: n & 255,
    };
  }

  function rgbToHex(r, g, b) {
    const toHex = (c) => Math.round(clamp(c, 0, 255)).toString(16).padStart(2, '0');
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  }

  function rgbToHsv(r, g, b) {
    const rn = clamp(r, 0, 255) / 255;
    const gn = clamp(g, 0, 255) / 255;
    const bn = clamp(b, 0, 255) / 255;
    const max = Math.max(rn, gn, bn);
    const min = Math.min(rn, gn, bn);
    const d = max - min;
    let h = 0;
    if (d > 0) {
      if (max === rn) h = ((gn - bn) / d) % 6;
      else if (max === gn) h = (bn - rn) / d + 2;
      else h = (rn - gn) / d + 4;
      h = Math.round(h * 60);
      if (h < 0) h += 360;
    }
    const s = max === 0 ? 0 : d / max;
    return { h, s, v: max };
  }

  function hsvToRgb(h, s, v) {
    const hn = (((Number(h) || 0) % 360) + 360) % 360;
    const sn = clamp(s, 0, 1);
    const vn = clamp(v, 0, 1);
    const c = vn * sn;
    const x = c * (1 - Math.abs(((hn / 60) % 2) - 1));
    const m = vn - c;
    let r1 = 0, g1 = 0, b1 = 0;
    if (hn < 60) { r1 = c; g1 = x; }
    else if (hn < 120) { r1 = x; g1 = c; }
    else if (hn < 180) { g1 = c; b1 = x; }
    else if (hn < 240) { g1 = x; b1 = c; }
    else if (hn < 300) { r1 = x; b1 = c; }
    else { r1 = c; b1 = x; }
    return {
      r: Math.round((r1 + m) * 255),
      g: Math.round((g1 + m) * 255),
      b: Math.round((b1 + m) * 255),
    };
  }

  function wheelPointToHsv(dx, dy, radius, v = 1) {
    const r = Math.max(1, Number(radius) || 1);
    const dist = Math.hypot(dx, dy);
    const s = clamp(dist / r, 0, 1);
    let angle = Math.atan2(dy, dx) * (180 / Math.PI);
    if (angle < 0) angle += 360;
    return { h: angle, s, v: clamp(v, 0, 1) };
  }

  function hsvToWheelPoint(h, s, radius) {
    const r = Math.max(1, Number(radius) || 1);
    const rad = (((Number(h) || 0) % 360) * Math.PI) / 180;
    const dist = clamp(s, 0, 1) * r;
    return {
      x: Math.cos(rad) * dist,
      y: Math.sin(rad) * dist,
    };
  }

  function isPitchBlack(hex) {
    const clean = normalizeHex(hex);
    if (!clean) return false;
    const { r, g, b } = hexToRgb(clean);
    const { v } = rgbToHsv(r, g, b);
    return v <= 0.12;
  }

  function bgPaletteFor(hex, dark = false) {
    const clean = normalizeHex(hex) || DEFAULT_BG_COLOR;
    const { r, g, b } = hexToRgb(clean);
    const { h, s, v } = rgbToHsv(r, g, b);
    const pitchBlack = v <= 0.12;
    const neutral = s < 0.05;

    if (!dark) {
      if (pitchBlack) {
        return {
          bg: '#f2f2f5',
          canvasRgb: '242 242 245',
          wash1: 'rgba(0, 0, 0, 0.08)',
          wash2: 'rgba(0, 0, 0, 0.06)',
          wash3: 'rgba(0, 0, 0, 0.08)',
          wash4: 'rgba(0, 0, 0, 0.05)',
          wall: 'linear-gradient(rgba(245, 245, 248, 0.9), rgba(235, 235, 240, 0.95)), #ececf1',
          pitchBlack: true,
        };
      }
      const vScale = clamp(0.74 + v * 0.26, 0.74, 1);
      const spot1 = hsvToRgb(h, neutral ? s : clamp(s * 0.50, 0.12, 0.62), vScale);
      const spot2 = hsvToRgb((h - 14 + 360) % 360, neutral ? s : clamp(s * 0.58, 0.15, 0.70), vScale);
      const spot3 = hsvToRgb((h + 28) % 360, neutral ? s : clamp(s * 0.46, 0.12, 0.58), clamp(vScale * 0.96, 0.70, 0.98));
      const base = hsvToRgb(h, neutral ? s : clamp(s * 0.20, 0.04, 0.28), clamp(vScale * 0.96, 0.72, 0.97));
      const bg = hsvToRgb(h, neutral ? s : clamp(s * 0.12, 0.02, 0.18), clamp(vScale * 0.98, 0.75, 0.99));
      const wash3Rgb = hsvToRgb(h, neutral ? s : clamp(s * 0.72, 0.18, 0.88), vScale);
      return {
        bg: rgbToHex(bg.r, bg.g, bg.b),
        canvasRgb: `${bg.r} ${bg.g} ${bg.b}`,
        wash1: `rgba(${spot1.r}, ${spot1.g}, ${spot1.b}, 0.38)`,
        wash2: `rgba(${spot2.r}, ${spot2.g}, ${spot2.b}, 0.30)`,
        wash3: `rgba(${wash3Rgb.r}, ${wash3Rgb.g}, ${wash3Rgb.b}, 0.28)`,
        wash4: `rgba(${spot3.r}, ${spot3.g}, ${spot3.b}, 0.24)`,
        wall: `linear-gradient(rgba(255, 255, 255, 0.32), rgba(255, 255, 255, 0.32)), ` +
          `radial-gradient(circle at 12% 18%, ${rgbToHex(spot1.r, spot1.g, spot1.b)} 0, rgba(${spot1.r}, ${spot1.g}, ${spot1.b}, 0) 42%), ` +
          `radial-gradient(circle at 75% 22%, ${rgbToHex(spot1.r, spot1.g, spot1.b)} 0, rgba(${spot1.r}, ${spot1.g}, ${spot1.b}, 0) 48%), ` +
          `radial-gradient(circle at 88% 12%, ${rgbToHex(spot2.r, spot2.g, spot2.b)} 0, rgba(${spot2.r}, ${spot2.g}, ${spot2.b}, 0) 40%), ` +
          `radial-gradient(circle at 72% 92%, ${rgbToHex(spot3.r, spot3.g, spot3.b)} 0, rgba(${spot3.r}, ${spot3.g}, ${spot3.b}, 0) 45%), ` +
          `${rgbToHex(base.r, base.g, base.b)}`,
        pitchBlack: false,
      };
    }

    if (pitchBlack) {
      return {
        bg: '#000000',
        canvasRgb: '0 0 0',
        wash1: 'rgba(0, 0, 0, 0)',
        wash2: 'rgba(0, 0, 0, 0)',
        wash3: 'rgba(0, 0, 0, 0)',
        wash4: 'rgba(0, 0, 0, 0)',
        wall: '#000000',
        pitchBlack: true,
      };
    }

    const dVScale = clamp(0.45 + v * 0.55, 0.45, 1);
    const dSpot1 = hsvToRgb(h, neutral ? s : clamp(s * 0.78, 0.2, 0.85), clamp(0.82 * dVScale, 0.28, 0.85));
    const dSpot2 = hsvToRgb((h - 14 + 360) % 360, neutral ? s : clamp(s * 0.85, 0.25, 0.9), clamp(0.88 * dVScale, 0.32, 0.9));
    const dSpot3 = hsvToRgb((h + 28) % 360, neutral ? s : clamp(s * 0.75, 0.2, 0.85), clamp(0.65 * dVScale, 0.24, 0.75));
    const dBase = hsvToRgb(h, neutral ? s : clamp(s * 0.55, 0.15, 0.65), clamp(0.18 * dVScale, 0.07, 0.22));
    const dBg = hsvToRgb(h, neutral ? s : clamp(s * 0.55, 0.12, 0.6), clamp(0.10 * dVScale, 0.04, 0.14));
    const dWash3 = hsvToRgb(h, neutral ? s : clamp(s * 0.92, 0, 1), clamp(Math.max(v, 0.62) * dVScale, 0.35, 1));
    const veil = hsvToRgb(h, neutral ? s : clamp(s * 0.38, 0.10, 0.45), clamp(0.22 * dVScale, 0.10, 0.26));
    return {
      bg: rgbToHex(dBg.r, dBg.g, dBg.b),
      canvasRgb: `${dBg.r} ${dBg.g} ${dBg.b}`,
      wash1: `rgba(${dSpot1.r}, ${dSpot1.g}, ${dSpot1.b}, 0.34)`,
      wash2: `rgba(${dSpot2.r}, ${dSpot2.g}, ${dSpot2.b}, 0.28)`,
      wash3: `rgba(${dWash3.r}, ${dWash3.g}, ${dWash3.b}, 0.32)`,
      wash4: `rgba(${dSpot3.r}, ${dSpot3.g}, ${dSpot3.b}, 0.22)`,
      wall: `linear-gradient(rgba(${veil.r}, ${veil.g}, ${veil.b}, 0.42), rgba(${veil.r}, ${veil.g}, ${veil.b}, 0.42)), ` +
        `radial-gradient(circle at 20% 20%, ${rgbToHex(dSpot1.r, dSpot1.g, dSpot1.b)} 0, rgba(${dSpot1.r}, ${dSpot1.g}, ${dSpot1.b}, 0) 45%), ` +
        `radial-gradient(circle at 68% 22%, ${rgbToHex(dSpot1.r, dSpot1.g, dSpot1.b)} 0, rgba(${dSpot1.r}, ${dSpot1.g}, ${dSpot1.b}, 0) 50%), ` +
        `radial-gradient(circle at 85% 25%, ${rgbToHex(dSpot2.r, dSpot2.g, dSpot2.b)} 0, rgba(${dSpot2.r}, ${dSpot2.g}, ${dSpot2.b}, 0) 40%), ` +
        `radial-gradient(circle at 55% 95%, ${rgbToHex(dSpot3.r, dSpot3.g, dSpot3.b)} 0, rgba(${dSpot3.r}, ${dSpot3.g}, ${dSpot3.b}, 0) 45%), ` +
        `${rgbToHex(dBase.r, dBase.g, dBase.b)}`,
      pitchBlack: false,
    };
  }

  function paletteFor(hex, dark = false) {
    const clean = normalizeHex(hex) || DEFAULT_COLOR;
    const { r, g, b } = hexToRgb(clean);
    const { h, s, v } = rgbToHsv(r, g, b);
    const pitchBlack = v <= 0.12;
    const hover = hsvToRgb(h, clamp(s * 1.05, 0, 1), clamp(v * (dark ? 1.08 : 0.88), 0.15, 1));
    const glow = hsvToRgb(h, clamp(s * 0.85, 0, 1), clamp(Math.max(v, 0.75), 0.3, 1));
    const bgPal = bgPaletteFor(clean, dark);

    if (!dark) {
      if (pitchBlack) {
        return Object.assign({}, bgPal, {
          accent: '#000000',
          rgb: '0 0 0',
          hoverRgb: '28 28 32',
          glowRgb: '60 60 68',
          softRgb: '234 234 238',
          inkRgb: '18 18 22',
          inkHex: '#121216',
          soft: 'rgba(0, 0, 0, 0.10)',
          focus: 'rgba(0, 0, 0, 0.35)',
          lgFocus: 'rgba(0, 0, 0, 0.20)',
          lgFill: 'linear-gradient(160deg, rgba(0, 0, 0, 0.14), rgba(0, 0, 0, 0.05) 55%, rgba(255, 255, 255, 0.45))',
        });
      }
      const softRgb = hsvToRgb(h, clamp(s * 0.16, 0.05, 0.24), 0.98);
      const inkRgb = hsvToRgb(h, clamp(Math.max(s, 0.55), 0.35, 1), clamp(Math.min(v, 0.72), 0.28, 0.72));
      return Object.assign({}, bgPal, {
        accent: clean,
        rgb: `${r} ${g} ${b}`,
        hoverRgb: `${hover.r} ${hover.g} ${hover.b}`,
        glowRgb: `${glow.r} ${glow.g} ${glow.b}`,
        softRgb: `${softRgb.r} ${softRgb.g} ${softRgb.b}`,
        inkRgb: `${inkRgb.r} ${inkRgb.g} ${inkRgb.b}`,
        inkHex: rgbToHex(inkRgb.r, inkRgb.g, inkRgb.b),
        soft: `rgba(${r}, ${g}, ${b}, 0.14)`,
        focus: `rgba(${r}, ${g}, ${b}, 0.45)`,
        lgFocus: `rgba(${r}, ${g}, ${b}, 0.24)`,
        lgFill: `linear-gradient(160deg, rgba(${r}, ${g}, ${b}, 0.18), rgba(${r}, ${g}, ${b}, 0.07) 55%, rgba(255, 255, 255, 0.35))`,
      });
    }

    if (pitchBlack) {
      return Object.assign({}, bgPal, {
        accent: '#26262b',
        rgb: '38 38 43',
        hoverRgb: '58 58 66',
        glowRgb: '120 120 132',
        softRgb: '28 28 34',
        inkRgb: '220 220 228',
        inkHex: '#dcdce4',
        soft: 'rgba(255, 255, 255, 0.10)',
        focus: 'rgba(255, 255, 255, 0.32)',
        lgFocus: 'rgba(255, 255, 255, 0.22)',
        lgFill: 'linear-gradient(160deg, rgba(255, 255, 255, 0.08), rgba(255, 255, 255, 0.03) 55%, rgba(0, 0, 0, 0.85))',
      });
    }

    const dSpot1 = hsvToRgb(h, clamp(s * 0.78, 0.2, 0.85), clamp(v * 0.82, 0.35, 0.85));
    const dAccent = hsvToRgb(h, clamp(s * 0.92, 0, 1), clamp(Math.max(v, 0.62), 0.4, 1));
    const dSoftRgb = hsvToRgb(h, clamp(s * 0.65, 0.15, 0.75), 0.24);
    const dInkRgb = hsvToRgb(h, clamp(s * 0.55, 0.15, 0.68), clamp(Math.max(v, 0.92), 0.82, 1));
    return Object.assign({}, bgPal, {
      accent: rgbToHex(dAccent.r, dAccent.g, dAccent.b),
      rgb: `${dAccent.r} ${dAccent.g} ${dAccent.b}`,
      hoverRgb: `${hover.r} ${hover.g} ${hover.b}`,
      glowRgb: `${glow.r} ${glow.g} ${glow.b}`,
      softRgb: `${dSoftRgb.r} ${dSoftRgb.g} ${dSoftRgb.b}`,
      inkRgb: `${dInkRgb.r} ${dInkRgb.g} ${dInkRgb.b}`,
      inkHex: rgbToHex(dInkRgb.r, dInkRgb.g, dInkRgb.b),
      soft: `rgba(${dAccent.r}, ${dAccent.g}, ${dAccent.b}, 0.18)`,
      focus: `rgba(${dAccent.r}, ${dAccent.g}, ${dAccent.b}, 0.5)`,
      lgFocus: `rgba(${dAccent.r}, ${dAccent.g}, ${dAccent.b}, 0.35)`,
      lgFill: `linear-gradient(160deg, rgba(${dAccent.r}, ${dAccent.g}, ${dAccent.b}, 0.30), rgba(${dSpot1.r}, ${dSpot1.g}, ${dSpot1.b}, 0.12) 55%, rgba(255, 255, 255, 0.04))`,
    });
  }

  function contrastColorFor(hex) {
    const { r, g, b } = hexToRgb(hex);
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return lum > 0.55 ? '#0f172a' : '#ffffff';
  }

  function modeRulesFor(p, contrast) {
    const commaRgb = p.rgb.replace(/\s+/g, ', ');
    const canvasLine = p.canvasRgb ? `\n  --c-canvas: ${p.canvasRgb};` : '';
    return `
  --ecg-accent: ${p.accent};
  --eden-accent: ${p.accent};
  --ecs-accent: ${p.accent};
  --pal-accent: ${p.accent};
  --action: ${p.accent};
  --action-ink: ${contrast};
  --accent: ${p.accent};
  --accent-strong: ${p.accent};
  --accent-contrast: ${contrast};
  --eden-accent-soft: ${p.soft};
  --accent-soft: ${p.soft};
  --accent-track: ${p.soft};
  --eden-focus-ring: ${p.focus};
  --ecg-lg-focus: ${p.lgFocus};
  --ecg-lg-fill: ${p.lgFill};
  --eden-bg: ${p.bg};${canvasLine}
  --eden-wash1: ${p.wash1};
  --eden-wash2: ${p.wash2};
  --eden-wash3: ${p.wash3};
  --eden-wash4: ${p.wash4};
  --ecg-wall: ${p.wall};
  --c-accent: ${p.rgb};
  --c-accent-hover: ${p.hoverRgb};
  --c-accent-soft: ${p.softRgb};
  --c-accent-ink: ${p.inkRgb};
  --c-glow: ${p.glowRgb};
  --ob-arc: ${p.accent};
  --ob-arc-rgb: ${commaRgb};
  --ob-focus-ring: ${p.focus};`;
  }

  function styleTextFor(accentHex, bgHex) {
    const cleanAccent = normalizeHex(accentHex);
    const cleanBg = normalizeHex(bgHex);
    if (!cleanAccent && !cleanBg) return '';
    const hasExplicitBgArg = arguments.length >= 2;
    const effectiveAccent = cleanAccent || DEFAULT_COLOR;
    const effectiveBg = cleanBg || (hasExplicitBgArg ? DEFAULT_BG_COLOR : effectiveAccent);

    const lightAccent = paletteFor(effectiveAccent, false);
    const darkAccent = paletteFor(effectiveAccent, true);
    const lightBg = bgPaletteFor(effectiveBg, false);
    const darkBg = bgPaletteFor(effectiveBg, true);
    const light = Object.assign({}, lightAccent, lightBg);
    const dark = Object.assign({}, darkAccent, darkBg);

    const lightContrast = contrastColorFor(light.accent);
    const darkContrast = contrastColorFor(dark.accent);
    const lightVars = modeRulesFor(light, lightContrast);
    const darkVars = modeRulesFor(dark, darkContrast);
    const darkBlackOverrides = dark.pitchBlack ? `
  :root, body, body:not([data-skin]), body.eden-code:not([data-skin]) {
    --ecg-wall: #000000 !important;
    --ecg-side: rgba(0, 0, 0, 0.96) !important;
    --ecg-side-rim: rgba(255, 255, 255, 0.14) !important;
    --ecg-side-sh: inset 0 1px 0 rgba(255, 255, 255, 0.12), 0 8px 24px rgba(0, 0, 0, 0.85) !important;
    --ecg-panel: rgba(0, 0, 0, 0.96) !important;
    --ecg-panel-rim: rgba(255, 255, 255, 0.14) !important;
    --ecg-card: #000000 !important;
    --ecg-term: #000000 !important;
    --ecg-term-rim: rgba(255, 255, 255, 0.16) !important;
    --eden-bg: #000000 !important;
    --eden-content: rgba(255, 255, 255, 0.05) !important;
    --eden-pane: #000000 !important;
    --eden-elevated: #0a0a0c !important;
    --eden-code: #000000 !important;
    --eden-glass: rgba(0, 0, 0, 0.94) !important;
    --eden-glass2: rgba(8, 8, 10, 0.96) !important;
    background: #000000 !important;
    background-color: #000000 !important;
    background-image: none !important;
  }
  body.eden-code .jc-settings.ecs-sheet {
    --ecs-frame: #000000 !important;
    --ecs-frame-rim: rgba(255, 255, 255, 0.16) !important;
    --ecs-side: #050507 !important;
    --ecs-side-rim: rgba(255, 255, 255, 0.14) !important;
    --ecs-panel: #000000 !important;
    --ecs-panel-rim: rgba(255, 255, 255, 0.14) !important;
    --ecs-list: rgba(255, 255, 255, 0.05) !important;
    --ecs-list-rim: rgba(255, 255, 255, 0.10) !important;
    background: rgba(0, 0, 0, 0.72) !important;
  }
  .cb {
    --ecg-card: #000000 !important;
    --ecg-wall: #000000 !important;
  }
  .cb-panel {
    background: rgba(0, 0, 0, 0.96) !important;
  }` : '';
    return `
:root, body, body:not([data-skin]), body.eden-code:not([data-skin]),
html body[data-skin="obsidian"], html body[data-skin="glass"] {${lightVars}
}
.deck.jc, .browser-dock, body:not([data-skin]) .deck.jc, body.eden-code:not([data-skin]) .deck.jc,
html body[data-skin="obsidian"] .deck.jc, html body[data-skin="obsidian"] .browser-dock,
html body[data-skin="glass"] .deck.jc, html body[data-skin="glass"] .browser-dock,
#settings.with-nav, .cs-board, .cs-board[data-theme="light"] {${lightVars}
}
.cs-board:not([data-theme="light"]) {${darkVars}
}
body.eden-code .jc-settings.ecs-sheet, #palette {
  --ecs-accent: ${light.accent};
  --pal-accent: ${light.accent};
}
.sn-item[aria-selected="true"] {
  background: ${light.accent} !important;
  color: ${lightContrast} !important;
}
body.eden-code:not([data-skin]) .deck.jc .jc-user,
body:not([data-skin]) .jc-user,
.deck.jc .jc-user,
.jc-user {
  background: ${light.accent} !important;
  color: ${lightContrast} !important;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2), inset 0 0 0 1px rgba(0, 0, 0, 0.08) !important;
}
body.eden-code:not([data-skin]) .deck.jc .jc-user .jc-user-text,
.deck.jc .jc-user .jc-user-text,
.jc-user .jc-user-text {
  color: ${lightContrast} !important;
}
body.eden-code:not([data-skin]) .deck.jc .jc-user a,
.deck.jc .jc-user a,
.jc-user a {
  color: ${lightContrast} !important;
  text-decoration: underline !important;
}
body.eden-code:not([data-skin]) .deck.jc .jc-btn.filled,
.deck.jc .jc-btn.filled,
.jc-btn.filled {
  background: ${light.accent} !important;
  color: ${lightContrast} !important;
}
html body[data-skin="obsidian"]:not([data-tone="light"]),
html body[data-skin="obsidian"]:not([data-tone="light"]) .deck.jc,
html body[data-skin="obsidian"]:not([data-tone="light"]) .browser-dock,
html body[data-skin="obsidian"]:not([data-tone="light"]) .deck.jc .jc-dock,
html body[data-skin="glass"]:not([data-tone="light"]),
html body[data-skin="glass"]:not([data-tone="light"]) .deck.jc,
html body[data-skin="glass"]:not([data-tone="light"]) .browser-dock {${darkVars}
}
@media (prefers-color-scheme: dark) {
  :root, body, body:not([data-skin]), body.eden-code:not([data-skin]),
  html body[data-skin="obsidian"]:not([data-tone="light"]),
  html body[data-skin="glass"]:not([data-tone="light"]) {${darkVars}
  }
  .deck.jc, .browser-dock, body:not([data-skin]) .deck.jc, body.eden-code:not([data-skin]) .deck.jc,
  html body[data-skin="obsidian"]:not([data-tone="light"]) .deck.jc,
  html body[data-skin="obsidian"]:not([data-tone="light"]) .browser-dock,
  html body[data-skin="obsidian"]:not([data-tone="light"]) .deck.jc .jc-dock,
  html body[data-skin="glass"]:not([data-tone="light"]) .deck.jc,
  html body[data-skin="glass"]:not([data-tone="light"]) .browser-dock,
  #settings.with-nav, .cs-board:not([data-theme="light"]) {${darkVars}
  }
  .cs-board[data-theme="light"] {${lightVars}
  }
  body.eden-code .jc-settings.ecs-sheet, #palette {
    --ecs-accent: ${dark.accent};
    --pal-accent: ${dark.accent};
  }
  .sn-item[aria-selected="true"] {
    background: ${dark.accent} !important;
    color: ${darkContrast} !important;
  }
  body.eden-code:not([data-skin]) .deck.jc .jc-user,
  body:not([data-skin]) .jc-user,
  .deck.jc .jc-user,
  .jc-user {
    background: ${dark.accent} !important;
    color: ${darkContrast} !important;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.5), inset 0 0 0 1px rgba(255, 255, 255, 0.15) !important;
  }
  body.eden-code:not([data-skin]) .deck.jc .jc-user .jc-user-text,
  .deck.jc .jc-user .jc-user-text,
  .jc-user .jc-user-text {
    color: ${darkContrast} !important;
  }
  body.eden-code:not([data-skin]) .deck.jc .jc-user a,
  .deck.jc .jc-user a,
  .jc-user a {
    color: ${darkContrast} !important;
    text-decoration: underline !important;
  }
  body.eden-code:not([data-skin]) .deck.jc .jc-btn.filled,
  .deck.jc .jc-btn.filled,
  .jc-btn.filled {
    background: ${dark.accent} !important;
    color: ${darkContrast} !important;
  }${darkBlackOverrides}
}
html body[data-tone="light"],
html body[data-skin][data-tone="light"],
html body[data-skin][data-tone="light"] .deck.jc,
html body[data-skin][data-tone="light"] .browser-dock,
html body[data-tone="light"] .cs-board[data-theme="light"] {${lightVars}
}`.trim();
  }

  const api = {
    PRESETS,
    BG_PRESETS,
    DEFAULT_COLOR,
    DEFAULT_BG_COLOR,
    normalizeHex,
    hexToRgb,
    rgbToHex,
    rgbToHsv,
    hsvToRgb,
    wheelPointToHsv,
    hsvToWheelPoint,
    isPitchBlack,
    paletteFor,
    bgPaletteFor,
    styleTextFor,
  };
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
    return;
  }
  root.edenCodeColor = api;

  const F = root.edenCodeFeatures || root.jarvisFeatures;
  const doc = root.document;
  if (!F || !doc || !doc.body) return;
  const { el } = F;
  const t = (s) => (typeof F.t === 'function' ? F.t(s) : s);

  let currentHex = '';
  let currentHsv = rgbToHsv(0, 122, 255);
  let currentBgHex = '';
  const defaultBgRgb = hexToRgb(DEFAULT_BG_COLOR);
  let currentBgHsv = rgbToHsv(defaultBgRgb.r, defaultBgRgb.g, defaultBgRgb.b);
  let lastSavedAt = 0;
  let lastBgSavedAt = 0;
  const pickers = [];

  try {
    const bodySaved = normalizeHex((doc.body && doc.body.dataset && doc.body.dataset.codeColor) || '');
    const localSaved = normalizeHex(root.localStorage.getItem(STORE_KEY) || '');
    const saved = bodySaved || localSaved;
    if (saved) {
      currentHex = saved;
      const rgb = hexToRgb(saved);
      currentHsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
      if (bodySaved && bodySaved !== localSaved) {
        root.localStorage.setItem(STORE_KEY, bodySaved);
      }
    }

    const bodyBgSaved = normalizeHex((doc.body && doc.body.dataset && doc.body.dataset.codeBgColor) || '');
    const localBgSaved = normalizeHex(root.localStorage.getItem(BG_STORE_KEY) || '');
    const savedBg = bodyBgSaved || localBgSaved;
    if (savedBg) {
      currentBgHex = savedBg;
      const rgb = hexToRgb(savedBg);
      currentBgHsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
      if (bodyBgSaved && bodyBgSaved !== localBgSaved) {
        root.localStorage.setItem(BG_STORE_KEY, bodyBgSaved);
      }
    }
  } catch (_) { /* ignore storage errors */ }

  function ensureStyleTag() {
    if (!doc.head) return null;
    let tag = doc.getElementById('eden-code-color-vars');
    if (!tag) {
      tag = doc.createElement('style');
      tag.id = 'eden-code-color-vars';
      doc.head.append(tag);
    }
    return tag;
  }

  function refreshStyleTag() {
    const tag = ensureStyleTag();
    const css = styleTextFor(currentHex, currentBgHex);
    if (tag && tag.textContent !== css) tag.textContent = css;
  }

  function applyColor(hex, { persist = false, broadcast = false, keepHueSat = false } = {}) {
    const clean = normalizeHex(hex);
    currentHex = clean;
    const active = clean || DEFAULT_COLOR;
    const rgb = hexToRgb(active);
    const hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
    currentHsv = keepHueSat
      ? { h: currentHsv.h, s: currentHsv.s, v: hsv.v }
      : { h: hsv.s > 0.001 ? hsv.h : currentHsv.h, s: hsv.s, v: hsv.v };

    refreshStyleTag();

    if (clean) doc.body.dataset.codeColor = clean;
    else delete doc.body.dataset.codeColor;

    if (persist) {
      try {
        if (clean) root.localStorage.setItem(STORE_KEY, clean);
        else root.localStorage.removeItem(STORE_KEY);
      } catch (_) { /* ignore */ }
    }
    if (broadcast && typeof F.send === 'function') {
      lastSavedAt = Date.now();
      F.send({ type: 'feature_prefs', changes: { code_color: clean } });
    }
    for (const p of pickers) p.sync();
  }

  function applyBgColor(hex, { persist = false, broadcast = false, keepHueSat = false } = {}) {
    const clean = normalizeHex(hex);
    currentBgHex = clean;
    const active = clean || DEFAULT_BG_COLOR;
    const rgb = hexToRgb(active);
    const hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
    currentBgHsv = keepHueSat
      ? { h: currentBgHsv.h, s: currentBgHsv.s, v: hsv.v }
      : { h: hsv.s > 0.001 ? hsv.h : currentBgHsv.h, s: hsv.s, v: hsv.v };

    refreshStyleTag();

    if (clean) doc.body.dataset.codeBgColor = clean;
    else delete doc.body.dataset.codeBgColor;

    if (persist) {
      try {
        if (clean) root.localStorage.setItem(BG_STORE_KEY, clean);
        else root.localStorage.removeItem(BG_STORE_KEY);
      } catch (_) { /* ignore */ }
    }
    if (broadcast && typeof F.send === 'function') {
      lastBgSavedAt = Date.now();
      F.send({ type: 'feature_prefs', changes: { code_bg_color: clean } });
    }
    for (const p of pickers) p.sync();
  }

  function paintWheelCanvas(canvas, brightness = 1) {
    if (!canvas || typeof canvas.getContext !== 'function') return;
    const size = 132;
    const dpr = Math.min(2, Math.max(1, Number(root.devicePixelRatio) || 1));
    const px = Math.round(size * dpr);
    if (canvas.width !== px || canvas.height !== px) {
      canvas.width = px;
      canvas.height = px;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx || typeof ctx.createImageData !== 'function') return;
    const img = ctx.createImageData(px, px);
    const data = img.data;
    const half = px / 2;
    const val = clamp(brightness, 0.2, 1);
    for (let y = 0; y < px; y += 1) {
      const dy = y + 0.5 - half;
      for (let x = 0; x < px; x += 1) {
        const dx = x + 0.5 - half;
        const dist = Math.hypot(dx, dy);
        if (dist > half + 0.8) continue;
        const sat = Math.min(1, dist / half);
        let angle = Math.atan2(dy, dx) * (180 / Math.PI);
        if (angle < 0) angle += 360;
        const rgb = hsvToRgb(angle, sat, val);
        const edgeAlpha = dist > half - 1 ? clamp(half + 0.8 - dist, 0, 1) : 1;
        const idx = (y * px + x) * 4;
        data[idx] = rgb.r;
        data[idx + 1] = rgb.g;
        data[idx + 2] = rgb.b;
        data[idx + 3] = Math.round(edgeAlpha * 255);
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  function createColorSection(opts) {
    const sec = el('div', 'ecp-section');
    sec.dataset.kind = opts.kind;

    const top = el('div', 'ecp-top');
    const head = el('div', 'ecp-head');
    const title = el('span', 'ecp-title', t(opts.title));
    const sub = el('span', 'ecp-sub', t(opts.subtitle));
    head.append(title, sub);

    const resetBtn = el('button', 'ecp-reset', t('Reset'));
    resetBtn.type = 'button';
    resetBtn.addEventListener('click', () => {
      opts.apply('', { persist: true, broadcast: true });
    });

    const actions = el('div', 'ecp-top-actions');
    actions.append(resetBtn);
    top.append(head, actions);

    const presetsWrap = el('div', 'ecp-presets');
    presetsWrap.setAttribute('role', 'radiogroup');
    presetsWrap.setAttribute('aria-label', t(opts.presetsAria));
    const swatchBtns = new Map();
    for (const preset of opts.presets) {
      const b = el('button', 'ecp-swatch');
      b.type = 'button';
      b.dataset.color = preset.hex;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-label', t(preset.label));
      b.title = t(preset.label);
      b.style.setProperty('--sw-color', preset.hex);
      b.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-6.5"/></svg>';
      b.addEventListener('click', () => {
        const isDefault = preset.hex === opts.defaultColor;
        opts.apply(isDefault ? '' : preset.hex, { persist: true, broadcast: true });
      });
      presetsWrap.append(b);
      swatchBtns.set(preset.hex, b);
    }

    const wheelRow = el('div', 'ecp-wheel-row');
    const wheelWrap = el('div', 'ecp-wheel-wrap');
    wheelWrap.tabIndex = 0;
    wheelWrap.setAttribute('role', 'slider');
    wheelWrap.setAttribute('aria-label', t(opts.wheelAria));
    const canvas = el('canvas', 'ecp-wheel-canvas');
    const thumb = el('span', 'ecp-wheel-thumb');
    wheelWrap.append(canvas, thumb);

    const controls = el('div', 'ecp-controls');
    const previewRow = el('div', 'ecp-preview-row');
    const previewDot = el('span', 'ecp-preview-dot');
    const hexInput = el('input', 'ecp-hex');
    hexInput.type = 'text';
    hexInput.maxLength = 7;
    hexInput.spellcheck = false;
    hexInput.autocomplete = 'off';
    hexInput.setAttribute('aria-label', t('Hex color'));
    hexInput.setAttribute('data-no-i18n', '');
    previewRow.append(previewDot, hexInput);

    const brightRow = el('div', 'ecp-bright-row');
    const brightHead = el('div', 'ecp-bright-head');
    const brightLabel = el('span', '', t('Brightness'));
    const brightVal = el('span', '', '100%');
    brightVal.setAttribute('data-no-i18n', '');
    brightHead.append(brightLabel, brightVal);
    const brightSlider = el('input', 'ecp-bright');
    brightSlider.type = 'range';
    brightSlider.min = '0';
    brightSlider.max = '100';
    brightSlider.step = '1';
    brightSlider.value = '100';
    brightSlider.setAttribute('aria-label', t('Brightness'));
    brightRow.append(brightHead, brightSlider);

    const rgbRow = el('div', 'ecp-rgb-row');
    const makeChannel = (label, aria) => {
      const wrap = el('label', 'ecp-rgb-field');
      const tag = el('span', '', label);
      tag.setAttribute('data-no-i18n', '');
      const inp = el('input');
      inp.type = 'number';
      inp.min = '0';
      inp.max = '255';
      inp.setAttribute('aria-label', t(aria));
      inp.setAttribute('data-no-i18n', '');
      wrap.append(tag, inp);
      return { wrap, inp };
    };
    const rCh = makeChannel('R', 'Red channel');
    const gCh = makeChannel('G', 'Green channel');
    const bCh = makeChannel('B', 'Blue channel');
    rgbRow.append(rCh.wrap, gCh.wrap, bCh.wrap);

    controls.append(previewRow, brightRow, rgbRow);
    wheelRow.append(wheelWrap, controls);
    sec.append(top, presetsWrap, wheelRow);

    let lastPaintedV = -1;
    function updateFromWheelEvent(e, commit) {
      const rect = wheelWrap.getBoundingClientRect();
      const radius = (rect.width || 132) / 2;
      const cx = rect.left + radius;
      const cy = rect.top + radius;
      const curHsv = opts.getHsv();
      const vUse = curHsv.v > 0.05 ? curHsv.v : 1;
      const hsv = wheelPointToHsv(e.clientX - cx, e.clientY - cy, radius, vUse);
      opts.setHsv(hsv);
      const rgb = hsvToRgb(hsv.h, hsv.s, hsv.v);
      const hex = rgbToHex(rgb.r, rgb.g, rgb.b);
      opts.apply(hex, { persist: commit, broadcast: commit });
    }

    let dragging = false;
    wheelWrap.addEventListener('pointerdown', (e) => {
      dragging = true;
      if (typeof wheelWrap.setPointerCapture === 'function') {
        try { wheelWrap.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      }
      updateFromWheelEvent(e, true);
    });
    wheelWrap.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      updateFromWheelEvent(e, false);
    });
    const stopDrag = (e) => {
      if (!dragging) return;
      dragging = false;
      updateFromWheelEvent(e, true);
    };
    wheelWrap.addEventListener('pointerup', stopDrag);
    wheelWrap.addEventListener('pointercancel', stopDrag);

    wheelWrap.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 15 : 5;
      const curHsv = Object.assign({}, opts.getHsv());
      let handled = true;
      if (e.key === 'ArrowRight') curHsv.h = (curHsv.h + step) % 360;
      else if (e.key === 'ArrowLeft') curHsv.h = (curHsv.h - step + 360) % 360;
      else if (e.key === 'ArrowUp') curHsv.s = clamp(curHsv.s + 0.05, 0, 1);
      else if (e.key === 'ArrowDown') curHsv.s = clamp(curHsv.s - 0.05, 0, 1);
      else handled = false;
      if (!handled) return;
      e.preventDefault();
      opts.setHsv(curHsv);
      const rgb = hsvToRgb(curHsv.h, curHsv.s, curHsv.v || 1);
      opts.apply(rgbToHex(rgb.r, rgb.g, rgb.b), { persist: true, broadcast: true });
    });

    brightSlider.addEventListener('input', () => {
      const v = clamp(Number(brightSlider.value) / 100, 0, 1);
      const curHsv = opts.getHsv();
      curHsv.v = v;
      const rgb = hsvToRgb(curHsv.h, curHsv.s, v);
      opts.apply(rgbToHex(rgb.r, rgb.g, rgb.b), { persist: false, broadcast: false, keepHueSat: true });
    });
    brightSlider.addEventListener('change', () => {
      const v = clamp(Number(brightSlider.value) / 100, 0, 1);
      const curHsv = opts.getHsv();
      curHsv.v = v;
      const rgb = hsvToRgb(curHsv.h, curHsv.s, v);
      opts.apply(rgbToHex(rgb.r, rgb.g, rgb.b), { persist: true, broadcast: true, keepHueSat: true });
    });

    hexInput.addEventListener('change', () => {
      const clean = normalizeHex(hexInput.value);
      if (clean) opts.apply(clean === opts.defaultColor ? '' : clean, { persist: true, broadcast: true });
      else sync();
    });

    const onRgbInput = () => {
      const r = clamp(rCh.inp.value, 0, 255);
      const g = clamp(gCh.inp.value, 0, 255);
      const b = clamp(bCh.inp.value, 0, 255);
      const hex = rgbToHex(r, g, b);
      opts.apply(hex === opts.defaultColor ? '' : hex, { persist: true, broadcast: true });
    };
    rCh.inp.addEventListener('change', onRgbInput);
    gCh.inp.addEventListener('change', onRgbInput);
    bCh.inp.addEventListener('change', onRgbInput);

    function sync() {
      const rawHex = opts.getHex();
      const active = rawHex || opts.defaultColor;
      const rgb = hexToRgb(active);
      const hsv = opts.getHsv();
      const pureRgb = hsvToRgb(hsv.h, Math.max(0.2, hsv.s), 1);
      const pureHex = rgbToHex(pureRgb.r, pureRgb.g, pureRgb.b);

      sec.style.setProperty('--ecp-current', active);
      sec.style.setProperty('--ecp-pure', pureHex);

      for (const [hex, btn] of swatchBtns.entries()) {
        btn.setAttribute('aria-checked', String(hex === active));
      }

      const radius = 66;
      const pt = hsvToWheelPoint(hsv.h, hsv.s, radius - 8);
      thumb.style.left = `${radius + pt.x}px`;
      thumb.style.top = `${radius + pt.y}px`;
      thumb.style.background = active;

      if (doc.activeElement !== hexInput) hexInput.value = active.toUpperCase();
      const pct = Math.round(clamp(hsv.v, 0, 1) * 100);
      brightSlider.value = String(pct);
      brightVal.textContent = `${pct}%`;

      if (doc.activeElement !== rCh.inp) rCh.inp.value = String(rgb.r);
      if (doc.activeElement !== gCh.inp) gCh.inp.value = String(rgb.g);
      if (doc.activeElement !== bCh.inp) bCh.inp.value = String(rgb.b);

      wheelWrap.setAttribute('aria-valuetext', active.toUpperCase());
      resetBtn.disabled = !rawHex || rawHex === opts.defaultColor;

      const roundedV = Math.round(clamp(hsv.v, 0.25, 1) * 50) / 50;
      if (lastPaintedV !== roundedV) {
        lastPaintedV = roundedV;
        paintWheelCanvas(canvas, roundedV);
      }
    }

    return { sec, sync };
  }

  function createPickerWidget(idPrefix) {
    const card = el('div', 'ecp-card');
    card.id = `${idPrefix}-card`;

    const accentSec = createColorSection({
      kind: 'accent',
      title: 'Accent color',
      subtitle: 'Choose a preset color or spin the RGB wheel.',
      presetsAria: 'Preset colors',
      wheelAria: 'RGB color wheel',
      presets: PRESETS,
      defaultColor: DEFAULT_COLOR,
      getHex: () => currentHex,
      getHsv: () => currentHsv,
      setHsv: (hsv) => { currentHsv = hsv; },
      apply: applyColor,
    });

    const divider = el('hr', 'ecp-divider');

    const bgSec = createColorSection({
      kind: 'bg',
      title: 'Background color',
      subtitle: 'Choose a background preset or spin the RGB wheel while keeping your accent color.',
      presetsAria: 'Preset background colors',
      wheelAria: 'Background RGB color wheel',
      presets: BG_PRESETS,
      defaultColor: DEFAULT_BG_COLOR,
      getHex: () => currentBgHex,
      getHsv: () => currentBgHsv,
      setHsv: (hsv) => { currentBgHsv = hsv; },
      apply: applyBgColor,
    });

    card.append(accentSec.sec, divider, bgSec.sec);

    function sync() {
      accentSec.sync();
      bgSec.sync();
    }

    const inst = { card, sync };
    pickers.push(inst);
    sync();
    return card;
  }

  function mountPickers() {
    if (F.splitPane || typeof doc.getElementById !== 'function') return;

    // 1. #jcs-general (for code-settings.js / #jc-settings)
    const jcsGeneral = doc.getElementById('jcs-general');
    if (jcsGeneral) {
      let group = doc.getElementById('ecs-color-group');
      let label = doc.getElementById('ecs-color-label');
      if (!group) {
        group = el('div', 'jcs-group');
        group.id = 'ecs-color-group';
        group.dataset.ecsSection = 'general';
        group.append(createPickerWidget('ecs-color'));
      }
      if (!label) {
        label = el('p', 'jcs-label', t('Color'));
        label.id = 'ecs-color-label';
        label.dataset.ecsSection = 'general';
      }
      if (group.parentElement !== jcsGeneral) {
        jcsGeneral.insertBefore(group, jcsGeneral.firstChild);
      }
      if (label.parentElement !== jcsGeneral || label.nextElementSibling !== group) {
        jcsGeneral.insertBefore(label, group);
      }
    }

    // 2. #settings › General › Look (when #look-group exists in index.html)
    const lookGroup = doc.getElementById('look-group');
    const lookSection = lookGroup && lookGroup.closest && lookGroup.closest('section.group');
    if (lookSection && !doc.getElementById('sn-look-color')) {
      const wrap = el('div', 'sn-look-color');
      wrap.id = 'sn-look-color';
      wrap.append(createPickerWidget('sn-general-color'));
      const toneRow = doc.getElementById('tone-row');
      const after = (toneRow && toneRow.parentElement === lookSection) ? toneRow.nextSibling : lookGroup.nextSibling;
      lookSection.insertBefore(wrap, after);
    }

    // 3. #settings › Eden Code pane (so opening Eden Code settings on the 'code' pane shows it right at the top)
    const settingsSheet = doc.getElementById('settings');
    if (settingsSheet && !doc.getElementById('jcs-sec-color')) {
      const sec = el('section', 'group jcs-adopted');
      sec.id = 'jcs-sec-color';
      sec.dataset.settingsPane = 'code';
      sec.dataset.keywords = 'color colour theme accent background wallpaper rgb wheel tint look appearance';
      sec.append(el('h3', '', t('Color')), createPickerWidget('sn-code-color'));
      const jumps = doc.getElementById('sn-code-jumps');
      if (jumps && jumps.parentElement === settingsSheet) {
        settingsSheet.insertBefore(sec, jumps.nextSibling);
      } else {
        settingsSheet.prepend(sec);
      }
    }
  }

  applyColor(currentHex, { persist: false, broadcast: false });
  applyBgColor(currentBgHex, { persist: false, broadcast: false });
  mountPickers();

  if (!F.splitPane && typeof MutationObserver === 'function') {
    const jcSettings = doc.getElementById('jc-settings');
    if (jcSettings) {
      new MutationObserver(() => {
        if (!jcSettings.hidden) {
          mountPickers();
          for (const p of pickers) p.sync();
        }
      }).observe(jcSettings, { attributes: true, attributeFilter: ['hidden'] });
    }
    const jcsGeneral = doc.getElementById('jcs-general');
    if (jcsGeneral) {
      new MutationObserver(() => {
        if (!doc.getElementById('ecs-color-group')) mountPickers();
      }).observe(jcsGeneral, { childList: true });
    }
  }

  if (typeof root.addEventListener === 'function') {
    if (!F.splitPane) {
      root.addEventListener('eden-code-features-ready', mountPickers);
      root.addEventListener('jarvis-features-ready', mountPickers);
    }
    root.addEventListener('storage', (e) => {
      if (e && e.key === STORE_KEY) {
        applyColor(e.newValue || '', { persist: false, broadcast: false });
      } else if (e && e.key === BG_STORE_KEY) {
        applyBgColor(e.newValue || '', { persist: false, broadcast: false });
      }
    });
  }

  function onPrefs(p, { fromHello = false } = {}) {
    if (!p || !p.features) return;
    const syncChanges = {};
    if (typeof p.features.code_color === 'string') {
      const incoming = normalizeHex(p.features.code_color);
      if (incoming) {
        if (incoming !== currentHex) applyColor(incoming, { persist: true, broadcast: false });
      } else if (p.features.code_color === '') {
        if (fromHello && currentHex && !F.splitPane) {
          syncChanges.code_color = currentHex;
        } else if (Date.now() - lastSavedAt > 1500 && !fromHello) {
          applyColor('', { persist: true, broadcast: false });
        }
      }
    } else if (fromHello && currentHex && !F.splitPane) {
      syncChanges.code_color = currentHex;
    }

    if (typeof p.features.code_bg_color === 'string') {
      const incomingBg = normalizeHex(p.features.code_bg_color);
      if (incomingBg) {
        if (incomingBg !== currentBgHex) applyBgColor(incomingBg, { persist: true, broadcast: false });
      } else if (p.features.code_bg_color === '') {
        if (fromHello && currentBgHex && !F.splitPane) {
          syncChanges.code_bg_color = currentBgHex;
        } else if (Date.now() - lastBgSavedAt > 1500 && !fromHello) {
          applyBgColor('', { persist: true, broadcast: false });
        }
      }
    } else if (fromHello && currentBgHex && !F.splitPane) {
      syncChanges.code_bg_color = currentBgHex;
    }

    if (Object.keys(syncChanges).length > 0 && typeof F.send === 'function') {
      F.send({ type: 'feature_prefs', changes: syncChanges });
    }
  }
  F.on('hello', (ev) => onPrefs(ev && ev.prefs, { fromHello: true }), { replay: true });
  F.on('prefs', (ev) => onPrefs(ev, { fromHello: false }), { replay: true });

  root.edenCodeColor = Object.assign(api, {
    get: () => currentHex || DEFAULT_COLOR,
    set: (hex) => applyColor(hex, { persist: true, broadcast: true }),
    reset: () => applyColor('', { persist: true, broadcast: true }),
    getBg: () => currentBgHex || DEFAULT_BG_COLOR,
    setBg: (hex) => applyBgColor(hex, { persist: true, broadcast: true }),
    resetBg: () => applyBgColor('', { persist: true, broadcast: true }),
    mountPickers,
  });
})(typeof window === 'object' ? window : globalThis);
