// QR codes for askeden.com's web sign-in: the page shows a jarvis-link://XXXX-XXXX code as a QR
// that the J.A.R.V.I.S. iPhone app scans.
//
// A port of src/jarvis/qr.py: same algorithm, same output, module for module. QR Code Model 2
// (ISO/IEC 18004), byte mode (UTF-8), error correction level M, the smallest version (1-40) the
// text fits in, and the mask of the eight with the lowest penalty. No dependencies and no Node
// built-ins, so it runs in Node and in a Cloudflare Worker.

// Level M, per version (index 0 unused): error correction codewords in each block, and how many
// blocks the codewords are split into (ISO/IEC 18004 table 9).
const ECC_PER_BLOCK = [
  -1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26,
  26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
];
const BLOCKS = [
  -1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16,
  17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49,
];
const LEVEL_M_BITS = 0; // the format information's two bits for level M
const PENALTY_RUN = 3, PENALTY_BOX = 3, PENALTY_FINDER = 40, PENALTY_BALANCE = 10;

/** More than a version 40 code holds at level M (2,331 bytes). */
export class TooLong extends Error {
  constructor(message) {
    super(message);
    this.name = 'TooLong';
  }
}

// ── the Galois field and Reed-Solomon ──

const EXP = new Array(512).fill(0);
const LOG = new Array(256).fill(0);
for (let i = 0, value = 1; i < 255; i++) {
  EXP[i] = value;
  LOG[value] = i;
  value <<= 1;
  if (value & 0x100) value ^= 0x11d; // x^8 + x^4 + x^3 + x^2 + 1
}
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];

const multiply = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

// (x - a^0)(x - a^1)...(x - a^(degree-1)), highest power first, without its leading 1.
function rsGenerator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    poly.forEach((coef, j) => {
      next[j] ^= coef;
      next[j + 1] ^= multiply(coef, EXP[i]);
    });
    poly = next;
  }
  return poly.slice(1);
}

// The error correction codewords for these data codewords.
function rsRemainder(data, degree) {
  const generator = rsGenerator(degree);
  const remainder = new Array(degree).fill(0);
  for (const byte of data) {
    const factor = byte ^ remainder.shift();
    remainder.push(0);
    generator.forEach((coef, i) => (remainder[i] ^= multiply(coef, factor)));
  }
  return remainder;
}

// ── sizes ──

// Modules left for data and error correction once the function patterns are drawn.
function rawModules(version) {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const aligns = Math.floor(version / 7) + 2;
    result -= (25 * aligns - 10) * aligns - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

const dataCodewords = (version) =>
  Math.floor(rawModules(version) / 8) - ECC_PER_BLOCK[version] * BLOCKS[version];

const countBits = (version) => (version <= 9 ? 8 : 16);

// The smallest version that holds this many bytes at level M.
function pickVersion(length) {
  for (let version = 1; version <= 40; version++) {
    if (4 + countBits(version) + 8 * length <= dataCodewords(version) * 8) return version;
  }
  throw new TooLong(`${length} bytes is more than a QR code holds`);
}

function alignmentPositions(version) {
  if (version === 1) return [];
  const size = version * 4 + 17;
  const count = Math.floor(version / 7) + 2;
  const step = Math.floor((version * 8 + count * 3 + 5) / (count * 4 - 4)) * 2;
  const rest = Array.from({ length: count - 1 }, (_, i) => size - 7 - i * step);
  return [6, ...rest.sort((a, b) => a - b)];
}

// ── the codewords ──

// Byte mode: the mode, the length, the bytes, then the terminator and padding.
function dataBits(data, version) {
  const bits = [];
  const put = (value, count) => {
    for (let i = count - 1; i >= 0; i--) bits.push((value >> i) & 1);
  };
  put(0b0100, 4);
  put(data.length, countBits(version));
  for (const byte of data) put(byte, 8);
  const capacity = dataCodewords(version) * 8;
  put(0, Math.min(4, capacity - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) put(pad, 8);
  return bits;
}

// The data split into blocks, each with its error correction, interleaved.
function codewords(data, version) {
  const bits = dataBits(data, version);
  const raw = [];
  for (let i = 0; i < bits.length; i += 8) {
    raw.push(bits.slice(i, i + 8).reduce((byte, bit) => (byte << 1) | bit, 0));
  }
  const blocksN = BLOCKS[version];
  const ecc = ECC_PER_BLOCK[version];
  const total = Math.floor(rawModules(version) / 8);
  const short = blocksN - (total % blocksN); // blocks one data codeword shorter than the rest
  const shortLen = Math.floor(total / blocksN) - ecc;
  const blocks = [];
  for (let i = 0, at = 0; i < blocksN; i++) {
    const size = shortLen + (i < short ? 0 : 1);
    blocks.push(raw.slice(at, at + size));
    at += size;
  }
  const eccs = blocks.map((block) => rsRemainder(block, ecc));
  const out = [];
  for (let i = 0; i <= shortLen; i++) {
    for (const block of blocks) if (i < block.length) out.push(block[i]);
  }
  for (let i = 0; i < ecc; i++) for (const e of eccs) out.push(e[i]);
  return out;
}

// ── the matrix ──

// The 15 format bits: level and mask with their BCH(15,5) check, XOR-masked.
function formatBits(mask, levelBits = LEVEL_M_BITS) {
  const data = (levelBits << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

// The 18 version bits (versions 7 and up): the version with its BCH(18,6) check.
function versionBits(version) {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >> 11) * 0x1f25);
  return (version << 12) | rem;
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x, y) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

class Grid {
  constructor(version) {
    this.version = version;
    this.size = version * 4 + 17;
    const blank = () => Array.from({ length: this.size }, () => new Array(this.size).fill(false));
    this.dark = blank();
    this.reserved = blank(); // the function patterns' modules, which data and masks skip
  }

  put(x, y, dark) {
    this.dark[y][x] = dark;
    this.reserved[y][x] = true;
  }

  drawFunctionPatterns() {
    const size = this.size;
    for (let i = 0; i < size; i++) { // the timing patterns
      this.put(6, i, i % 2 === 0);
      this.put(i, 6, i % 2 === 0);
    }
    for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) { // finders, with separators
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const x = cx + dx, y = cy + dy;
          if (x >= 0 && x < size && y >= 0 && y < size) {
            const ring = Math.max(Math.abs(dx), Math.abs(dy));
            this.put(x, y, ring !== 2 && ring !== 4);
          }
        }
      }
    }
    const positions = alignmentPositions(this.version);
    const last = positions.length - 1;
    positions.forEach((cy, i) => positions.forEach((cx, j) => {
      if ((i === 0 && (j === 0 || j === last)) || (i === last && j === 0)) return; // the finders
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) this.put(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }));
    this.drawFormat(0); // reserves the format areas; drawn again with the real mask
    if (this.version >= 7) {
      const bits = versionBits(this.version);
      for (let i = 0; i < 18; i++) {
        const dark = ((bits >> i) & 1) === 1;
        const a = size - 11 + (i % 3), b = Math.floor(i / 3);
        this.put(a, b, dark);
        this.put(b, a, dark);
      }
    }
  }

  drawFormat(mask) {
    const bits = formatBits(mask);
    const size = this.size;
    const bit = (i) => ((bits >> i) & 1) === 1;
    for (let i = 0; i < 6; i++) this.put(8, i, bit(i));
    this.put(8, 7, bit(6));
    this.put(8, 8, bit(7));
    this.put(7, 8, bit(8));
    for (let i = 9; i < 15; i++) this.put(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) this.put(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) this.put(8, size - 15 + i, bit(i));
    this.put(8, size - 8, true); // the dark module
  }

  // The codewords, two columns at a time, zigzagging up and down from the right.
  place(words) {
    const size = this.size;
    const total = words.length * 8;
    let i = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5; // the vertical timing pattern's column is skipped
      const upward = ((right + 1) & 2) === 0;
      for (let vert = 0; vert < size; vert++) {
        const y = upward ? size - 1 - vert : vert;
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          if (!this.reserved[y][x] && i < total) {
            this.dark[y][x] = ((words[i >> 3] >> (7 - (i & 7))) & 1) === 1;
            i++;
          }
        }
      }
    }
  }

  applyMask(mask) {
    const test = MASKS[mask];
    for (let y = 0; y < this.size; y++) {
      const row = this.dark[y], reserved = this.reserved[y];
      for (let x = 0; x < this.size; x++) if (!reserved[x] && test(x, y)) row[x] = !row[x];
    }
  }
}

// The lengths of a line's latest seven runs, newest first. A light run at either end of the line
// runs on into the quiet zone, counted as the line's length more.
class Runs {
  constructor(size) {
    this.size = size;
    this.history = [0, 0, 0, 0, 0, 0, 0];
  }

  add(length) {
    if (this.history[0] === 0) length += this.size; // the first run: light, from the quiet zone
    this.history = [length, ...this.history.slice(0, 6)];
  }

  // 0, 1 or 2 finder-like patterns ending at the light run just added.
  finderLike() {
    const h = this.history;
    const n = h[1];
    const core = n > 0 && h[2] === n && h[4] === n && h[5] === n && h[3] === n * 3;
    return (core && h[0] >= n * 4 && h[6] >= n ? 1 : 0) + (core && h[6] >= n * 4 && h[0] >= n ? 1 : 0);
  }

  // The end of the line: its last run goes on into the quiet zone.
  end(color, run) {
    if (color) { // a dark run ends at the edge
      this.add(run);
      run = 0;
    }
    this.add(run + this.size);
    return this.finderLike();
  }
}

// The standard's four penalty rules: runs of five or more alike, 2x2 boxes alike, finder-like
// patterns (dark 1:1:3:1:1 with four light modules beside it), and how far dark and light are
// from half and half.
function penalty(modules) {
  const size = modules.length;
  let score = 0;
  const columns = modules.map((_, x) => modules.map((row) => row[x]));
  for (const line of [...modules, ...columns]) {
    const runs = new Runs(size);
    let color = false, run = 0; // the line starts after the light quiet zone
    for (const dark of line) {
      if (dark === color) {
        run++;
        if (run === 5) score += PENALTY_RUN;
        else if (run > 5) score += 1;
        continue;
      }
      runs.add(run);
      if (!color) score += runs.finderLike() * PENALTY_FINDER; // a light run just ended
      color = dark;
      run = 1;
    }
    score += runs.end(color, run) * PENALTY_FINDER;
  }
  for (let y = 0; y < size - 1; y++) {
    const above = modules[y], below = modules[y + 1];
    for (let x = 0; x < size - 1; x++) {
      const c = above[x];
      if (above[x + 1] === c && below[x] === c && below[x + 1] === c) score += PENALTY_BOX;
    }
  }
  const dark = modules.reduce((sum, row) => sum + row.filter(Boolean).length, 0);
  const total = size * size;
  score += (Math.floor((Math.abs(dark * 20 - total * 10) + total - 1) / total) - 1) * PENALTY_BALANCE;
  return score;
}

/**
 * The QR code for this text (UTF-8 bytes; a Uint8Array is taken as is) at level M: rows of
 * modules, true is dark, without the quiet zone around it. mask: one of the eight (0-7), else
 * the best by penalty.
 */
export function encode(text, mask) {
  const data = typeof text === 'string' ? new TextEncoder().encode(text) : Uint8Array.from(text);
  if (mask != null && !(Number.isInteger(mask) && mask >= 0 && mask < 8)) {
    throw new RangeError(`mask must be 0-7, not ${mask}`);
  }
  const version = pickVersion(data.length);
  const words = codewords(data, version);
  let best = null;
  for (const candidate of mask == null ? [0, 1, 2, 3, 4, 5, 6, 7] : [mask]) {
    const grid = new Grid(version);
    grid.drawFunctionPatterns();
    grid.place(words);
    grid.applyMask(candidate);
    grid.drawFormat(candidate);
    const score = mask == null ? penalty(grid.dark) : 0;
    if (best === null || score < best.score) best = { score, modules: grid.dark };
  }
  return best.modules;
}

/** The modules as strings of 0 and 1, row by row, for the page to draw. */
export const rows = (modules) => modules.map((row) => row.map((dark) => (dark ? '1' : '0')).join(''));

/** rows(encode(text)): the sign-in page's QR, ready to draw. */
export const qrRows = (text) => rows(encode(text));
