// Regression tests for src/vendor/qr.js.
//
// Run: node test/qr.test.js [path-to-qr.js]
//
// These exist because the encoder shipped for weeks producing symbols that no
// camera could read. The failure was silent: the canvas looked like a QR code,
// the page threw nothing, and the only signal was people at a draft party
// pointing phones at a TV and getting no prompt. Rendering something
// QR-shaped is not the same as rendering a QR code, so these assert the parts
// a decoder actually reads.
//
// The load-bearing check is formatInfoIsLegal. Format information is a
// BCH(15,5) codeword; a decoder reads it FIRST to learn the mask pattern and
// error-correction level. If it is not a legal codeword within 3 bit errors,
// the decoder gives up before it ever looks at the data, and no amount of
// size, contrast, or quiet zone can rescue it. The original bug put it 4 bits
// out.

const fs = require('fs');
const path = require('path');

const QR_PATH = process.argv[2] || path.join(__dirname, '..', 'src', 'vendor', 'qr.js');
global.window = {};
eval(fs.readFileSync(QR_PATH, 'utf8'));
const LOOGQR = global.window.LOOGQR;

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log('  ok   ' + name);
  } catch (e) {
    failures++;
    console.log('  FAIL ' + name + '\n         ' + e.message);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

// The 32 legal format codewords: 5 data bits (2 EC + 3 mask), BCH(15,5) with
// generator 0x537, XOR-masked with 0x5412 per ISO/IEC 18004 Annex C.
function bchFormat(d) {
  let v = d << 10;
  for (let i = 4; i >= 0; i--) if (v & (1 << (i + 10))) v ^= 0x537 << i;
  return ((d << 10) | v) ^ 0x5412;
}
const LEGAL = new Map();
for (let d = 0; d < 32; d++) LEGAL.set(bchFormat(d), d);

// Top-left format copy, MSB (bit 14) first. ISO/IEC 18004 8.9.
const FORMAT_POS = [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
                    [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]];
function readFormat(m) {
  return parseInt(FORMAT_POS.map(([r, c]) => (m[r][c] ? '1' : '0')).join(''), 2);
}
function hamming(a, b) {
  let n = 0, x = a ^ b;
  while (x) { n += x & 1; x >>>= 1; }
  return n;
}

// URLs spanning the encoder's supported versions (1-6).
const CASES = [
  ['short host', 'http://a.io/#AB'],
  ['LAN address', 'http://192.168.1.42:8000/#WXYZ'],
  ['production URL', 'https://drshredgnar.github.io/draft-order-challenge/#LQLS'],
  ['production, longest code', 'https://drshredgnar.github.io/draft-order-challenge/#ZZZZ'],
  ['deep path', 'https://example.github.io/a/rather/longer/path/to/the/game/#QRST'],
];

console.log('qr.js regression tests (' + QR_PATH + ')');

for (const [label, url] of CASES) {
  const qr = LOOGQR.generate(url);
  const m = qr.modules;
  const size = qr.size;

  check(label + ' — symbol size is a valid QR version', () => {
    assert((size - 17) % 4 === 0, 'size ' + size + ' is not 17 + 4v');
    const v = (size - 17) / 4;
    assert(v >= 1 && v <= 6, 'version ' + v + ' outside the encoder\'s 1-6 range');
  });

  check(label + ' — format info is a legal BCH codeword', () => {
    const val = readFormat(m);
    if (LEGAL.has(val)) return;
    let best = 99;
    for (const k of LEGAL.keys()) best = Math.min(best, hamming(k, val));
    throw new Error('format 0x' + val.toString(16) + ' is ' + best +
      ' bits from any legal codeword (BCH corrects at most 3 — undecodable)');
  });

  check(label + ' — format info declares error level M', () => {
    const d = LEGAL.get(readFormat(m));
    assert(d !== undefined, 'format info is not legal, cannot read EC level');
    assert((d >> 3) === 0b00, 'EC level bits are ' + (d >> 3).toString(2) + ', expected 00 (M)');
  });

  check(label + ' — both format copies agree', () => {
    const val = readFormat(m);
    const second = [];
    for (let i = 0; i < 7; i++) second.push(m[size - 1 - i][8] ? '1' : '0');
    for (let i = 8; i < 15; i++) second.push(m[8][size - 15 + i] ? '1' : '0');
    // second copy reads bits 0..6 then 8..14; rebuild and compare those bits
    const bits = val.toString(2).padStart(15, '0').split('').reverse();
    const expect = [];
    for (let i = 0; i < 7; i++) expect.push(bits[i]);
    for (let i = 8; i < 15; i++) expect.push(bits[i]);
    assert(second.join('') === expect.join(''),
      'copy 2 = ' + second.join('') + ', expected ' + expect.join(''));
  });

  check(label + ' — finder patterns intact', () => {
    for (const [br, bc] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
      for (let r = 0; r < 7; r++) for (let c = 0; c < 7; c++) {
        const ring = Math.max(Math.abs(r - 3), Math.abs(c - 3));
        const want = ring !== 2;
        assert(!!m[br + r][bc + c] === want,
          'finder at ' + br + ',' + bc + ' wrong at ' + r + ',' + c);
      }
    }
  });

  check(label + ' — timing patterns alternate', () => {
    for (let i = 8; i < size - 8; i++) {
      assert(!!m[6][i] === (i % 2 === 0), 'row-6 timing wrong at col ' + i);
      assert(!!m[i][6] === (i % 2 === 0), 'col-6 timing wrong at row ' + i);
    }
  });

  check(label + ' — the fixed dark module is set', () => {
    assert(m[size - 8][8] === true, 'module at (' + (size - 8) + ',8) must always be dark');
  });
}

console.log(failures === 0 ? '\nAll passed.' : '\n' + failures + ' failing.');
process.exit(failures === 0 ? 0 : 1);
