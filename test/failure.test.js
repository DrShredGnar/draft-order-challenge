// Regression tests for the states that only exist when something goes wrong.
//
// Run: node test/failure.test.js [path-to-index.html]
//
// Every one of these guards a failure the game shipped with for months, and
// every one of them is invisible on a working network in a quiet room — which
// is exactly why they survived. The shared property is that the happy path
// stays green while the broken path silently does the wrong thing:
//
//   * a room code the mint can never produce is accepted by the join input,
//     so the player waits forever for a room that cannot exist;
//   * a dropped connection leaves the last snapshot on screen, so a frozen
//     clock is pixel-identical to a running one;
//   * the answer board is sliced to six rows, so anyone 7th or worse looks at
//     a list that does not contain them;
//   * a name is cut with slice(), which splits a surrogate pair and renders a
//     replacement box on the draft board.
//
// Same approach as draw.test.js and reveal.test.js: read the BUILT bundle,
// lift the shipped declarations, and run them. Testing src/ would let a build
// that drops these on the floor still pass.

const fs = require('fs');
const path = require('path');

const BUNDLE = process.argv[2] || path.join(__dirname, '..', 'index.html');
const html = fs.readFileSync(BUNDLE, 'utf8');

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

const tagMatch = html.match(/<script type="__bundler\/template">([\s\S]*?)<\/script>/);
assert(tagMatch, 'bundle has no __bundler/template tag');
const template = JSON.parse(tagMatch[1].trim().replace(/<\\u002F/g, '</'));

function lift(re, what) {
  const m = template.match(re);
  if (!m) throw new Error('could not find ' + what + ' in the bundled template');
  return m[0];
}

// ── the room-code alphabet ──────────────────────────────────────────────────
console.log('\nroom codes');

const alphabetSrc = lift(/const CODE_ALPHABET = "[A-Z]+";/, 'CODE_ALPHABET');
const rejectSrc = lift(/const CODE_REJECT_RE = \/\[\^[A-Z]+\]\/g;/, 'CODE_REJECT_RE');
const { CODE_ALPHABET, CODE_REJECT_RE } =
  new Function(alphabetSrc + rejectSrc + 'return { CODE_ALPHABET, CODE_REJECT_RE };')();

check('the alphabet holds out the letters that look like digits', () => {
  assert(!CODE_ALPHABET.includes('I'), 'I is in the code alphabet; it reads as 1 across a room');
  assert(!CODE_ALPHABET.includes('O'), 'O is in the code alphabet; it reads as 0 across a room');
  assert(CODE_ALPHABET.length === 24, 'expected 24 letters, got ' + CODE_ALPHABET.length);
});

// The bug this replaces: the mint used a 24-letter alphabet and the input
// filter used /[^A-Z]/, so the two disagreed about exactly two letters and
// "IOWA" was a well-formed code that could never match any room.
check('the join filter and the mint agree on every letter', () => {
  for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    const survives = ch.replace(new RegExp(CODE_REJECT_RE.source, 'g'), '') === ch;
    const mintable = CODE_ALPHABET.includes(ch);
    assert(survives === mintable,
      `"${ch}" ${survives ? 'survives the join filter' : 'is stripped by the join filter'} but ` +
      `${mintable ? 'IS' : 'is NOT'} mintable — the two must agree`);
  }
});

check('a code of nothing but held-out letters collapses to empty', () => {
  const typed = 'IOIO'.replace(new RegExp(CODE_REJECT_RE.source, 'g'), '');
  assert(typed === '', 'expected "" from "IOIO", got ' + JSON.stringify(typed));
});

// ── the give-up timer ───────────────────────────────────────────────────────
console.log('\njoining a room that is not there');

const giveUpSrc = lift(/const JOIN_GIVEUP_MS = \d+;/, 'JOIN_GIVEUP_MS');
const { JOIN_GIVEUP_MS } = new Function(giveUpSrc + 'return { JOIN_GIVEUP_MS };')();

check('the search gives up in a human amount of time', () => {
  assert(JOIN_GIVEUP_MS >= 3000, 'giving up under 3s will fire on a slow but working host');
  assert(JOIN_GIVEUP_MS <= 10000, 'over 10s is long enough that the game starts without them');
});

check('submitJoin arms the give-up timer and keeps pinging', () => {
  const src = lift(/^  submitJoin = \(\) => \{[\s\S]*?\n  \};$/m, 'submitJoin()');
  assert(/joinSearch: "looking"/.test(src), 'submitJoin does not enter the "looking" state');
  assert(/joinGiveUp\s*=\s*setTimeout/.test(src), 'submitJoin never arms the give-up timer');
  assert(/joinSearch: "missing"/.test(src), 'the give-up timer never reaches the "missing" state');
  // The ping must NOT stop when it gives up: a host booting late still has to
  // be able to pull this player in without them retyping anything. There are
  // two places that could quietly kill it, so both are checked — the interval
  // clearing itself, and the give-up timeout clearing it on the way out.
  const ping = src.match(/this\.pingTimer = setInterval\(([\s\S]*?)\n/);
  assert(ping, 'submitJoin no longer starts a ping');
  assert(!/clearInterval\(this\.pingTimer\)/.test(ping[1]),
    'the ping now clears itself inside its own callback — a late host can no longer recover the player');
  const giveUp = src.match(/this\.joinGiveUp = setTimeout\(\(\) => \{([\s\S]*?)\}, JOIN_GIVEUP_MS\)/);
  assert(giveUp, 'submitJoin no longer defines the give-up callback');
  assert(!/clearInterval\(this\.pingTimer\)/.test(giveUp[1]),
    'the give-up callback now stops the ping — the screen would say "no room" and mean it, ' +
    'so a host starting a few seconds late could never recover the player');
});

// Giving up is a message, not a teardown. onMsg is what actually stops the
// ping, and only because a snapshot arrived.
check('only an arriving snapshot stops the ping', () => {
  const src = lift(/^  onMsg\(m, role\) \{[\s\S]*?\n  \}$/m, 'onMsg()');
  assert(/m\.t === "state"/.test(src), 'onMsg no longer handles a state snapshot');
  const stateBranch = src.match(/if \(m\.t === "state"\) \{([\s\S]*?)\n      \}/);
  assert(stateBranch, 'the state branch is no longer a block');
  assert(/clearInterval\(this\.pingTimer\)/.test(stateBranch[1]),
    'a snapshot no longer stops the ping, so it pings forever after the player is in');
  assert(/joinSearch: "found"/.test(stateBranch[1]),
    'a snapshot no longer clears the "no room" state, so a late host leaves the error on screen');
});

// ── staleness ───────────────────────────────────────────────────────────────
console.log('\na link that has gone away');

const staleSrc = lift(/^  linkIsStale\(\) \{[\s\S]*?\n  \}$/m, 'linkIsStale()');
const linkIsStale = new Function('return ' + staleSrc.replace(/^  linkIsStale\(\)/, 'function linkIsStale()'))();

check('a fresh snapshot is not stale', () => {
  const host = { state: { link: 'live' }, lastSnapAt: Date.now() };
  assert(linkIsStale.call(host) === false, 'a snapshot that just landed reads as stale');
});

check('silence for more than three seconds is stale', () => {
  const host = { state: { link: 'live' }, lastSnapAt: Date.now() - 3500 };
  assert(linkIsStale.call(host) === true, '3.5s of silence does not read as stale');
});

check('an explicitly closed channel is stale even if a snapshot just landed', () => {
  const host = { state: { link: 'down' }, lastSnapAt: Date.now() };
  assert(linkIsStale.call(host) === true, 'a CLOSED channel still reads as live');
});

check('a player who has never had a snapshot is not reported as stale', () => {
  // Before the first snapshot the right message is "finding the huddle",
  // not "reconnecting" — they were never connected to begin with.
  const host = { state: { link: '' }, lastSnapAt: null };
  assert(linkIsStale.call(host) === false, 'the pre-join state is being reported as a dropped link');
});

check('the channel subscribes to the states that are not SUBSCRIBED', () => {
  const src = lift(/^  openChannel\(code, role\) \{[\s\S]*?\n  \}$/m, 'openChannel()');
  for (const s of ['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED']) {
    assert(src.includes(s), `openChannel ignores ${s}; a dropped link stays invisible`);
  }
  assert(/lastSnapAt/.test(src), 'openChannel never stamps lastSnapAt, so nothing can measure staleness');
});

// ── the board ───────────────────────────────────────────────────────────────
console.log('\nseeing where you stand');

check('a player outside the top five still sees their own row', () => {
  // Lifting the whole view model is not practical, so this reproduces the
  // shipped selection and asserts the property that matters. The guard
  // against regression is the source check below it.
  const board = Array.from({ length: 12 }, (_, i) => ({ id: 'p' + i, rank: i + 1, name: 'P' + i, score: 12 - i, timeMs: i * 1000 }));
  const myId = 'p10';                                   // 11th of 12
  const meRow = board.find((b) => b.id === myId);
  const top = board.slice(0, 5);
  const rows = top.slice();
  let gapAt = -1;
  if (meRow && !top.some((b) => b.id === myId)) { gapAt = rows.length; rows.push(meRow); }
  assert(rows.some((r) => r.id === myId), '11th place is not on their own board');
  assert(gapAt === 5, 'no gap marker between the top five and the player');
  assert(rows.length === 6, 'expected five plus me, got ' + rows.length);
});

check('a player inside the top five is not listed twice', () => {
  const board = Array.from({ length: 12 }, (_, i) => ({ id: 'p' + i, rank: i + 1 }));
  const myId = 'p2';
  const top = board.slice(0, 5);
  const rows = top.slice();
  if (!top.some((b) => b.id === myId)) rows.push(board.find((b) => b.id === myId));
  assert(rows.filter((r) => r.id === myId).length === 1, 'a top-five player appears twice');
});

check('the view model no longer truncates the board to a flat six', () => {
  assert(!/\(s\.board \|\| \[\]\)\.slice\(0, 6\)/.test(template),
    'miniBoard is back to slice(0, 6); ranks 7-12 cannot see themselves');
  assert(/const meRow = board\.find\(/.test(template),
    'the view model no longer looks up the player\'s own row');
});

// ── names ───────────────────────────────────────────────────────────────────
console.log('\nnames people actually type');

const clipSrc = lift(/^function clip\(str, n\) \{[\s\S]*?\n\}$/m, 'clip()');
const clip = new Function(clipSrc + 'return clip;')();

// Count the way a reader would, not the way any string API does. Every length
// assertion below goes through this, because code-point counts are exactly
// the thing that made the old tests pass while the behaviour was still wrong.
const seg = new Intl.Segmenter('en', { granularity: 'grapheme' });
const graphemes = (s) => [...seg.segment(s)].map((g) => g.segment);

check('an emoji on the boundary is not cut in half', () => {
  const name = 'Casey ' + '\u{1F3C8}'.repeat(20);       // 🏈 is a surrogate pair
  const out = clip(name, 18);
  assert(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out), 'output ends in a lone high surrogate');
  assert(!/(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(out), 'output contains a lone low surrogate');
  assert(graphemes(out).length === 18, 'expected 18 graphemes, got ' + graphemes(out).length);
});

check('a plain name is returned untouched', () => {
  assert(clip('Zach West', 18) === 'Zach West', 'a short name was modified');
});

check('the length limit counts what a person would count', () => {
  assert(graphemes(clip('\u{1F3C8}'.repeat(30), 5)).length === 5, 'five footballs should clip to five footballs');
});

// The two cases code-point clipping gets wrong. Neither renders as a broken
// box the way a split surrogate does — they render as a DIFFERENT name, which
// is its own kind of wrong on a television in front of the league.
check('a combining mark stays attached to its letter', () => {
  const accented = 'é'.repeat(6);                 // José, six times over
  assert(clip(accented, 5) === 'é'.repeat(5),
    'clip split an accented character, leaving a bare letter or a floating accent');
});

check('a zero-width-joiner emoji is not split into its parts', () => {
  const family = '\u{1F468}‍\u{1F469}‍\u{1F467}';   // one grapheme, five code points
  const out = clip(family + family + family, 2);
  assert(graphemes(out).length === 2, 'expected 2 graphemes, got ' + graphemes(out).length);
  assert(out === family + family, 'clip broke a joined emoji into separate people');
  assert(!out.endsWith('‍'), 'output ends on a dangling zero-width joiner');
});

// A grapheme count alone bounds nothing: one base letter can carry unlimited
// combining marks and still be a single grapheme.
check('a pathological name cannot grow without bound', () => {
  const zalgo = 'a' + '́'.repeat(5000);
  const out = clip(zalgo, 18);
  assert(out.length <= 18 * 8, 'a single-grapheme name of 5000 marks passed through at ' + out.length + ' code units');
});

// ── the clock face ──────────────────────────────────────────────────────────
console.log('\nthe play clock');

const mmssSrc = lift(/^function mmss\(s\) \{.*\}$/m, 'mmss()');
const mmss = new Function(mmssSrc + 'return mmss;')();

check('under a minute drops the leading "0:"', () => {
  assert(mmss(30) === '30', 'expected "30", got ' + JSON.stringify(mmss(30)));
  assert(mmss(9) === '9', 'expected "9", got ' + JSON.stringify(mmss(9)));
  assert(mmss(0) === '0', 'expected "0", got ' + JSON.stringify(mmss(0)));
});

check('a minute or more still reads as a clock', () => {
  assert(mmss(60) === '1:00', 'expected "1:00", got ' + JSON.stringify(mmss(60)));
  assert(mmss(75) === '1:15', 'expected "1:15", got ' + JSON.stringify(mmss(75)));
});

// ── the roster cap ──────────────────────────────────────────────────────────
console.log('\ntwelve seats');

const maxSrc = lift(/const MAX_PLAYERS = \d+;/, 'MAX_PLAYERS');
const { MAX_PLAYERS } = new Function(maxSrc + 'return { MAX_PLAYERS };')();

check('real joins respect the same cap the demo roster does', () => {
  const src = lift(/^  hostJoin\(id, name\) \{[\s\S]*?\n  \}$/m, 'hostJoin()');
  assert(/players\.length >= MAX_PLAYERS/.test(src),
    'hostJoin has no cap; a thirteenth phone joins silently and breaks the draft grid');
  assert(/t: "full"/.test(src), 'the thirteenth player is turned away without being told');
});

check('the lobby hint cannot count below zero', () => {
  const src = lift(/v\.lobbyHint = [\s\S]*?;\n/, 'lobbyHint');
  assert(!/12 - st\.players\.length/.test(src), 'lobbyHint still hardcodes 12 rather than MAX_PLAYERS');
  assert(/Roster's full/.test(src), 'a full roster still renders a "N more can still join" line');
  assert(MAX_PLAYERS === 12, 'MAX_PLAYERS moved; check the draft grid still lays out');
});

// ── the fabricated field ────────────────────────────────────────────────────
console.log('\nnothing on screen is invented');

check('the down-and-distance readout is gone', () => {
  assert(!/1st & 10/.test(template),
    'downLabel is back — a status field derived from qIndex % 4, on a screen whose ' +
    'own pitch is "decided on the field, not by a random number generator"');
});

console.log('');
if (failures) { console.log(failures + ' failing\n'); process.exit(1); }
console.log('all good\n');
