// The QR encoder behind askeden.com's sign-in code (src/eden/qr.js), checked module for module
// against the Python encoder it is a port of (src/jarvis/qr.py). Every expected value below was
// produced by running the Python module; a code is compared in full or by the sha256 of its
// rows joined by '\n'.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { TooLong, encode, qrRows, rows } from '../src/eden/qr.js';

const sha256 = (lines) => createHash('sha256').update(lines.join('\n')).digest('hex');

const LINK_ROWS = {
  'jarvis-link://K7QM-4ZTR': [
    '1111111000001101101111111', '1000001001010011101000001', '1011101011100011001011101',
    '1011101010001101101011101', '1011101010001101101011101', '1000001011010011101000001',
    '1111111010101010101111111', '0000000010001010100000000', '1011111001100101101111100',
    '1111000111010010000101010', '1000101011111011110101111', '1101010100001000000010011',
    '1000111111101010011010101', '1101000100000111100100000', '1001001100111101100001111',
    '1001010100110000110110000', '1011101000010010111111100', '0000000011001011100011100',
    '1111111000000010101010011', '1000001010101001100010010', '1011101010001011111110111',
    '1011101010100010101011011', '1011101010011100110100101', '1000001001110001100101001',
    '1111111011111001000111111',
  ],
  'jarvis-link://0000-0000': [
    '1111111011100010001111111', '1000001010011010001000001', '1011101000101100101011101',
    '1011101011111101101011101', '1011101000110111001011101', '1000001001001110101000001',
    '1111111010101010101111111', '0000000011110000000000000', '1011011101101000001001011',
    '0100110000011010000101010', '0101001111001010001110100', '0010000110100100101111110',
    '0110101110001101111010101', '0111010000011001011111011', '0101111011110100001100010',
    '1010000000010000110110000', '0010101111101111111110111', '0000000010100110100010001',
    '1111111011000000101010011', '1000001011110010100011001', '1011101001100000111111010',
    '1011101011000010101011011', '1011101011000011101111110', '1000001000111100001000100',
    '1111111010011001000111111',
  ],
};

// [name, input, side in modules, sha256 of the rows]. The last four are also the ones
// tests/test_qr.py checks against macOS's own generator (Core Image).
const HASHED = [
  ['a 62-byte sign-in URL (version 4)', 'https://askeden.com/sign-in?code=jarvis-link%3A%2F%2FK7QM-4ZTR', 33,
    'f7126ed9b72efbf80283021987924ce85c58530ddcc7feb8efc6907acb6168c9'],
  ['315 bytes (version 13: nine blocks of two sizes, version bits)', 'The quick brown fox jumps over the lazy dog. '.repeat(7), 69,
    '41f53eb75f853857aa02bfda0d94751eb1cddb92d2cc682b1a7db0f69a02fb75'],
  ['non-ASCII, as UTF-8', 'Café ✓', 21,
    '4e808e71853c87b1d7e08e2605f85561de98903293d6ea1976b99acd590a5946'],
  ['every byte value, from a Uint8Array (version 12)', Uint8Array.from({ length: 256 }, (_, i) => i), 65,
    '6a045f467423b47c55735e7b6cfa43ccef1260c6e60b631199ed24d5779aba12'],
  ['the most a code holds: 2,331 bytes (version 40)', 'x'.repeat(2331), 177,
    'b79a2ade5122c29ec45a888fb0ff276e5ad3012fce208565ea30a61e39346e25'],
  ['hello (version 1)', 'hello', 21,
    '52a7aa67e7296ede539d6be86579c7180e3b6d417445712ae8bd314c1818458a'],
  ['four-byte UTF-8 and CJK (version 7)', 'é中文🙂'.repeat(10), 45,
    'bcd3b7ec4eef54212f30f17dea620cf33f0419b22cdb087bcba376e4cb85ad9f'],
  ['250 bytes (version 11: a two-byte length)', 'a'.repeat(250), 61,
    '1da848d51e4467085049447b060c61a4ae8bef932f659ae1118c63c882fbd872'],
];

// jarvis-link://K7QM-4ZTR with each mask forced; mask 2 is the one the penalty picks.
const MASKED = [
  'bb859fa60daecfc2cad0d9ca77ef8d57f9dff10d482e783e00654cda449f492a',
  'ae2b6746ec2f32ae79a2e0b37d1448a7d2e892a257f211c16f11e4e9047d426a',
  'c107bedf497aec653c3cc59f45e336f0e2a451f86cfc1de39a6b5a9982900215',
  '097a7c3fceb42179ea30e8379d0313b6b0a7ba1b305be2ed214214318a68016f',
  '6725fec504334b98ad6bd7b590551e6a4d8705f2544ba8f43f6c557cd06ce9fb',
  '1a55280581553c85b9f25c6756ddb856370bcdc35058de2dcb556c5c0ca71c55',
  '7ede68438458814520dd9c0aedb11008df65a12da173fb2814bde63acc1d1f03',
  'a3c1f957c50cf811037a94332d1a1002a9c93a1af786648f2dda5a3831a980ba',
];

for (const [text, expected] of Object.entries(LINK_ROWS)) {
  test(`${text} matches the Python encoder module for module`, () => {
    assert.deepEqual(qrRows(text), expected);
    const modules = encode(text);
    assert.equal(modules.length, 25); // version 2
    assert.ok(modules.every((row) => row.length === 25 && row.every((m) => typeof m === 'boolean')));
    assert.deepEqual(rows(modules), expected);
  });
}

for (const [name, input, side, digest] of HASHED) {
  test(`${name} matches the Python encoder`, () => {
    const lines = rows(encode(input));
    assert.equal(lines.length, side);
    assert.ok(lines.every((line) => line.length === side && /^[01]+$/.test(line)));
    assert.equal(sha256(lines), digest);
  });
}

MASKED.forEach((digest, mask) => {
  test(`mask ${mask}, forced, matches the Python encoder`, () => {
    assert.equal(sha256(rows(encode('jarvis-link://K7QM-4ZTR', mask))), digest);
  });
});

test('without a mask, the one with the lowest penalty is picked (as Python picks it)', () => {
  assert.deepEqual(encode('jarvis-link://K7QM-4ZTR'), encode('jarvis-link://K7QM-4ZTR', 2));
});

test('the smallest version that holds the text', () => {
  // Byte-mode capacities at level M: 14 bytes fit version 1, 15 need 2, 122 fit version 7.
  assert.deepEqual([14, 15, 122].map((n) => encode('x'.repeat(n)).length), [21, 25, 45]);
});

test('more than 2,331 bytes is TooLong', () => {
  assert.throws(() => encode('x'.repeat(2332)), TooLong);
  assert.throws(() => qrRows('é'.repeat(1166)), TooLong); // 1,166 characters, 2,332 bytes
  assert.throws(() => encode('x'.repeat(5000)), (error) =>
    error instanceof TooLong && error instanceof Error && error.name === 'TooLong'
    && error.message === '5000 bytes is more than a QR code holds');
});

test('a mask outside 0-7 is refused', () => {
  for (const mask of [-1, 8, 1.5, '2']) assert.throws(() => encode('hi', mask), RangeError);
});
