// The menu bar icon, drawn in code: a ring (the orb) with what JARVIS is doing inside it.
// Black on transparent, so macOS draws it as a template image (white in a dark menu bar,
// inverted while its menu is open). One PNG per scale, 18 points square: crisp at 1× and 2×.
//
// Pure (Node's zlib only): app/features/shell.js turns the PNGs into a nativeImage, and
// tests/web/shell.test.mjs decodes them to check the pixels.
'use strict';

const zlib = require('zlib');

const SIZE = 18; // points
const STATES = ['idle', 'listening', 'thinking', 'speaking'];

// Each glyph is a union of shapes in point coordinates, the centre at (9, 9). Edges sit on
// whole points where they're straightest (the ring's sides, the core's), so they land on
// pixel edges at both scales instead of blurring across two.
const RING = { r: 7.25, half: 0.75 }; // a 1.5 pt stroke from 1 pt in
const GLYPHS = {
  idle: [{ disc: [9, 9, 2] }], // the core, resting
  listening: [{ disc: [9, 9, 4] }], // the core lit up: it's taking in what you say
  thinking: [{ disc: [6, 9, 1] }, { disc: [9, 9, 1] }, { disc: [12, 9, 1] }],
  speaking: [{ bar: [6, 9, 4] }, { bar: [9, 9, 8] }, { bar: [12, 9, 4] }],
};
const BAR_RADIUS = 1; // bars are 2 pt wide, with round ends

function inside(x, y, shapes) {
  const d = Math.hypot(x - 9, y - 9);
  if (Math.abs(d - RING.r) <= RING.half) return true;
  for (const s of shapes) {
    if (s.disc) {
      const [cx, cy, r] = s.disc;
      if (Math.hypot(x - cx, y - cy) <= r) return true;
    } else if (s.bar) {
      const [cx, cy, height] = s.bar;
      const straight = Math.max(0, height / 2 - BAR_RADIUS);
      const dy = Math.max(0, Math.abs(y - cy) - straight);
      if (Math.hypot(x - cx, dy) <= BAR_RADIUS) return true;
    }
  }
  return false;
}

// Alpha per pixel (0–255), 4×4 samples a pixel for smooth edges.
function coverage(state, scale) {
  const shapes = GLYPHS[state] || GLYPHS.idle;
  const n = SIZE * scale;
  const alpha = new Uint8Array(n * n);
  const k = 4;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      let hits = 0;
      for (let b = 0; b < k; b++) {
        for (let a = 0; a < k; a++) {
          if (inside((i + (a + 0.5) / k) / scale, (j + (b + 0.5) / k) / scale, shapes)) hits++;
        }
      }
      alpha[j * n + i] = Math.round((hits / (k * k)) * 255);
    }
  }
  return { size: n, alpha };
}

// ── PNG: 8-bit RGBA, one IDAT, no filtering ──

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
}

function encodePng(size, alpha) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bits per channel
  header[9] = 6; // RGBA
  const rows = Buffer.alloc(size * (1 + size * 4)); // black everywhere; only alpha varies
  for (let y = 0; y < size; y++) {
    const at = y * (1 + size * 4); // each row starts with its filter byte: 0, none
    for (let x = 0; x < size; x++) rows[at + 1 + x * 4 + 3] = alpha[y * size + x];
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// The icon for a state ('transcribing' draws as thinking), as a PNG at 1× or 2×.
function iconPng(state, scale = 1) {
  const glyph = state === 'transcribing' ? 'thinking' : STATES.includes(state) ? state : 'idle';
  const { size, alpha } = coverage(glyph, scale === 2 ? 2 : 1);
  return encodePng(size, alpha);
}

module.exports = { iconPng, crc32, STATES, SIZE };
