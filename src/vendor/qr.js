/* Minimal QR encoder — byte mode, EC level M, versions 1-6 (up to ~106 chars).
   window.LOOGQR.generate(text) -> { size, modules: boolean[][] }  (true = dark) */
(function () {
  var EXP = new Array(256), LOG = new Array(256);
  for (var i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
  EXP[255] = EXP[0];
  function mul(a, b) { return a === 0 || b === 0 ? 0 : EXP[(LOG[a] + LOG[b]) % 255]; }

  function rsPoly(n) {
    var p = [1];
    for (var i = 0; i < n; i++) {
      var q = new Array(p.length + 1).fill(0);
      for (var j = 0; j < p.length; j++) { q[j] ^= mul(p[j], 1); q[j + 1] ^= mul(p[j], EXP[i]); }
      p = q;
    }
    return p;
  }
  function ecc(data, n) {
    var g = rsPoly(n), res = new Array(n).fill(0);
    for (var i = 0; i < data.length; i++) {
      var f = data[i] ^ res[0];
      res.shift(); res.push(0);
      if (f !== 0) for (var j = 0; j < n; j++) res[j] ^= mul(g[j + 1], f);
    }
    return res;
  }

  // [version]: [totalCodewords, ecPerBlock, blocks]  (level M, uniform blocks)
  var SPEC = { 1: [26, 10, 1], 2: [44, 16, 1], 3: [70, 26, 1], 4: [100, 18, 2], 5: [134, 24, 2], 6: [172, 16, 4] };
  var ALIGN = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34] };

  function bchFormat(v) {
    var d = v << 10;
    while (Math.floor(Math.log(d) / Math.log(2)) >= 10) d ^= 0x537 << (Math.floor(Math.log(d) / Math.log(2)) - 10);
    return ((v << 10) | d) ^ 0x5412;
  }

  function build(version, bits) {
    var size = 17 + 4 * version;
    var m = [], fn = [];
    for (var r = 0; r < size; r++) { m.push(new Array(size).fill(null)); fn.push(new Array(size).fill(false)); }

    function finder(cr, cc) {
      for (var dr = -1; dr <= 7; dr++) for (var dc = -1; dc <= 7; dc++) {
        var r = cr + dr, c = cc + dc;
        if (r < 0 || c < 0 || r >= size || c >= size) continue;
        var mx = Math.max(Math.abs(dr - 3), Math.abs(dc - 3));
        m[r][c] = mx !== 2 && mx !== 4 ? true : false;
        if (mx > 3) m[r][c] = false;
        fn[r][c] = true;
      }
    }
    finder(0, 0); finder(0, size - 7); finder(size - 7, 0);

    for (var i = 8; i < size - 8; i++) { var v = i % 2 === 0; m[6][i] = v; m[i][6] = v; fn[6][i] = true; fn[i][6] = true; }

    var al = ALIGN[version];
    for (var a = 0; a < al.length; a++) for (var b = 0; b < al.length; b++) {
      var ar = al[a], ac = al[b];
      if ((ar === 6 && ac === 6) || (ar === 6 && ac === size - 7) || (ar === size - 7 && ac === 6)) continue;
      for (var dr2 = -2; dr2 <= 2; dr2++) for (var dc2 = -2; dc2 <= 2; dc2++) {
        var mx2 = Math.max(Math.abs(dr2), Math.abs(dc2));
        m[ar + dr2][ac + dc2] = mx2 !== 1;
        fn[ar + dr2][ac + dc2] = true;
      }
    }

    // reserve format areas
    for (var k = 0; k <= 8; k++) {
      if (k !== 6) { fn[8][k] = true; fn[k][8] = true; }
    }
    for (var k2 = 0; k2 < 8; k2++) { fn[8][size - 1 - k2] = true; fn[size - 1 - k2][8] = true; }
    m[size - 8][8] = true; fn[size - 8][8] = true;

    // place data, zigzag from bottom-right
    var bit = 0, up = true;
    for (var col = size - 1; col > 0; col -= 2) {
      if (col === 6) col--;
      for (var n = 0; n < size; n++) {
        var row = up ? size - 1 - n : n;
        for (var s = 0; s < 2; s++) {
          var cc2 = col - s;
          if (fn[row][cc2]) continue;
          m[row][cc2] = bit < bits.length ? bits[bit] === 1 : false;
          bit++;
        }
      }
      up = !up;
    }
    return { size: size, m: m, fn: fn };
  }

  function applyMask(g, mask) {
    var size = g.size;
    for (var r = 0; r < size; r++) for (var c = 0; c < size; c++) {
      if (g.fn[r][c]) continue;
      var flip;
      switch (mask) {
        case 0: flip = (r + c) % 2 === 0; break;
        case 1: flip = r % 2 === 0; break;
        case 2: flip = c % 3 === 0; break;
        case 3: flip = (r + c) % 3 === 0; break;
        case 4: flip = (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0; break;
        case 5: flip = ((r * c) % 2) + ((r * c) % 3) === 0; break;
        case 6: flip = (((r * c) % 2) + ((r * c) % 3)) % 2 === 0; break;
        default: flip = (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
      }
      if (flip) g.m[r][c] = !g.m[r][c];
    }
  }

  function placeFormat(g, mask) {
    var bitsF = bchFormat((0x00 << 3) | mask); // level M = 0b00
    var size = g.size;
    function bit(i) { return ((bitsF >> i) & 1) === 1; }
    // ISO/IEC 18004 8.9. The previous version walked both copies with a single
    // running index, which put the top-left run in the wrong bit order, wrote
    // bit 8 over bit 7 at (8,8), shifted every module below it by one, and ran
    // one past the end of the sequence so (0,8) was written `undefined`. The
    // resulting 15 bits sat 4 errors away from any legal codeword -- BCH(15,5)
    // corrects at most 3 -- so every conforming decoder rejected the symbol
    // before it ever looked at the data. Placement is spelled out explicitly
    // now rather than derived from a shared counter.
    var i;
    // Top-left copy: bits 0-5 down column 8, bit 6 at (7,8), bit 7 at (8,8),
    // bit 8 at (8,7), then bits 9-14 leftward along row 8.
    for (i = 0; i <= 5; i++) g.m[i][8] = bit(i);
    g.m[7][8] = bit(6);
    g.m[8][8] = bit(7);
    g.m[8][7] = bit(8);
    for (i = 9; i < 15; i++) g.m[8][14 - i] = bit(i);
    // Second copy: bits 0-7 up column 8 from the bottom edge, bits 8-14
    // leftward along row 8 from the right edge.
    for (i = 0; i < 8; i++) g.m[size - 1 - i][8] = bit(i);
    for (i = 8; i < 15; i++) g.m[8][size - 15 + i] = bit(i);
    // The module above the bottom-left finder is always dark; it shares a cell
    // with the tail of the run above, so it is written last.
    g.m[size - 8][8] = true;
  }

  function penalty(g) {
    var size = g.size, m = g.m, p = 0, r, c, run, dark = 0;
    for (r = 0; r < size; r++) {
      run = 1;
      for (c = 1; c < size; c++) {
        if (m[r][c] === m[r][c - 1]) { run++; if (run === 5) p += 3; else if (run > 5) p++; }
        else run = 1;
      }
    }
    for (c = 0; c < size; c++) {
      run = 1;
      for (r = 1; r < size; r++) {
        if (m[r][c] === m[r - 1][c]) { run++; if (run === 5) p += 3; else if (run > 5) p++; }
        else run = 1;
      }
    }
    for (r = 0; r < size - 1; r++) for (c = 0; c < size - 1; c++) {
      var v = m[r][c];
      if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) p += 3;
    }
    for (r = 0; r < size; r++) for (c = 0; c < size; c++) if (m[r][c]) dark++;
    var pct = (dark * 100) / (size * size);
    p += Math.floor(Math.abs(pct - 50) / 5) * 10;
    return p;
  }

  function generate(text) {
    var bytes = [];
    for (var i = 0; i < text.length; i++) {
      var cp = text.charCodeAt(i);
      if (cp < 0x80) bytes.push(cp);
      else if (cp < 0x800) { bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 63)); }
      else { bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63)); }
    }
    var version = 0, spec;
    for (var v = 1; v <= 6; v++) {
      spec = SPEC[v];
      var dataCw = spec[0] - spec[1] * spec[2];
      if (bytes.length + 2 <= dataCw) { version = v; break; }
    }
    if (!version) throw new Error("QR: text too long");
    spec = SPEC[version];
    var totalData = spec[0] - spec[1] * spec[2];

    var bitsArr = [];
    function push(val, len) { for (var i2 = len - 1; i2 >= 0; i2--) bitsArr.push((val >> i2) & 1); }
    push(4, 4); push(bytes.length, 8);
    for (var b = 0; b < bytes.length; b++) push(bytes[b], 8);
    var rem = totalData * 8 - bitsArr.length;
    push(0, Math.min(4, rem));
    while (bitsArr.length % 8 !== 0) bitsArr.push(0);
    var cw = [];
    for (var i3 = 0; i3 < bitsArr.length; i3 += 8) {
      var byteV = 0;
      for (var j3 = 0; j3 < 8; j3++) byteV = (byteV << 1) | bitsArr[i3 + j3];
      cw.push(byteV);
    }
    var pads = [0xec, 0x11], pi = 0;
    while (cw.length < totalData) { cw.push(pads[pi % 2]); pi++; }

    var blocks = spec[2], perBlock = totalData / blocks, ecLen = spec[1];
    var dataBlocks = [], ecBlocks = [];
    for (var bl = 0; bl < blocks; bl++) {
      var chunk = cw.slice(bl * perBlock, (bl + 1) * perBlock);
      dataBlocks.push(chunk);
      ecBlocks.push(ecc(chunk, ecLen));
    }
    var inter = [];
    for (var k3 = 0; k3 < perBlock; k3++) for (var bl2 = 0; bl2 < blocks; bl2++) inter.push(dataBlocks[bl2][k3]);
    for (var k4 = 0; k4 < ecLen; k4++) for (var bl3 = 0; bl3 < blocks; bl3++) inter.push(ecBlocks[bl3][k4]);

    var finalBits = [];
    for (var q = 0; q < inter.length; q++) for (var t = 7; t >= 0; t--) finalBits.push((inter[q] >> t) & 1);

    var best = null;
    for (var mask = 0; mask < 8; mask++) {
      var g = build(version, finalBits);
      applyMask(g, mask);
      placeFormat(g, mask);
      var sc = penalty(g);
      if (!best || sc < best.score) best = { score: sc, g: g };
    }
    return { size: best.g.size, modules: best.g.m };
  }

  window.LOOGQR = { generate: generate };
})();
