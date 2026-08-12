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

// The phone board is not truncated at all. It shipped as slice(0, 6); the
// first fix for that was top-five-plus-your-own-row, which still hid the back
// half of a twelve-person league from everyone. The region already scrolls,
// so the answer was never fewer rows — it was a way to find yourself in them.
check('the phone board is never truncated', () => {
  assert(!/\.slice\(0, 6\)/.test(template),
    'miniBoard is back to slice(0, 6); most of the room is missing');
  assert(!/const top = board\.slice\(0, 5\)/.test(template),
    'miniBoard is back to top-five-plus-me; the back half of the league is missing');
  const src = lift(/v\.miniBoard = board\.map\(\([\s\S]*?\}\)\);/, 'miniBoard');
  assert(/board\.map\(/.test(src), 'miniBoard no longer maps the whole board');
});

check('every player on the board gets a row, and exactly one is marked as you', () => {
  // Reproduces the shipped selection so the property is asserted directly.
  const board = Array.from({ length: 12 }, (_, i) => ({ id: 'p' + i, rank: i + 1, name: 'P' + i, score: 12 - i, timeMs: i * 1000 }));
  for (const myId of ['p0', 'p4', 'p10', 'p11']) {
    const rows = board.map((b) => ({ rank: b.rank, me: b.id === myId ? '1' : '' }));
    assert(rows.length === 12, myId + ': expected all 12 rows, got ' + rows.length);
    assert(rows.filter((r) => r.me === '1').length === 1, myId + ': own row is not marked exactly once');
    assert(rows[rows.length - 1].rank === 12, myId + ': last place is missing from the board');
  }
});

check('the scroll-into-view fires once per question, not on every render', () => {
  const src = lift(/^  componentDidUpdate\(\) \{[\s\S]*?\n  \}$/m, 'componentDidUpdate()');
  assert(/data-me="1"/.test(src), 'nothing scrolls the player\'s own row into view');
  assert(/scrolledFor/.test(src),
    'the scroll is not keyed, so it re-fires on every render and fights anyone scrolling the list');
  assert(/block: "nearest"/.test(src),
    'block:"nearest" is what leaves the list alone when the row is already visible');
});

// ── watching the reveal without the room ────────────────────────────────────
console.log('\nthe reveal, on a phone');

// The phone used to show your own pick number and the words "Watch the big
// screen." Anyone playing remotely got a dash for half a minute and never saw
// the board at all. Nothing new crosses the wire for the fix — the snapshot
// has always carried the ranked board, the revealed count and the draft size.
const pFinalBody = lift(/if \(v\.pFinal\) \{[\s\S]*?\n      \}/, 'the pFinal branch')
  .replace(/^if \(v\.pFinal\) \{/, '').replace(/\n      \}$/, '');
const NAMES = ['Sully', 'Nate', 'Big Rich', 'Petey', 'Wes', 'Cam', 'Theo', 'Gunner', 'Dave', 'Hollis', 'Marcus', 'Zach'];
const BOARD = NAMES.map((n, i) => ({ id: 'p' + i, name: n, score: 24 - i * 2, timeMs: (i + 1) * 1400, rank: i + 1 }));
const pts = (n) => n + (n === 1 ? ' pt' : ' pts');
const ordinal = (n) => { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };
function pFinal(revealed, myId) {
  const v = {}, st = { myId, voOn: false };
  new Function('v', 'st', 's', 'pts', 'ordinal', 'SNAKE_DRAFT', 'self_',
    pFinalBody.replace(/this\./g, 'self_.'))(v, st, { board: BOARD, draftTotal: 12, revealed }, pts, ordinal, true, { playCall() {} });
  return v;
}

check('the phone renders the whole board at every stage of the reveal', () => {
  for (const revealed of [0, 1, 6, 11, 12]) {
    const v = pFinal(revealed, 'p10');
    assert(v.pDraftRows && v.pDraftRows.length === 12,
      'revealed=' + revealed + ': expected 12 rows, got ' + (v.pDraftRows || []).length);
  }
});

check('picks appear worst to first, one at a time', () => {
  const named = (v) => v.pDraftRows.filter((d) => d.name !== '—' && d.name !== 'ON THE CLOCK').map((d) => Number(d.pickNum));
  assert(named(pFinal(0, 'p0')).length === 0, 'a pick is already showing before the reveal starts');
  assert(named(pFinal(1, 'p0')).join() === '12', 'the first pick out is not pick 12');
  assert(named(pFinal(6, 'p0')).join() === '7,8,9,10,11,12', 'six revealed should be picks 7-12');
  assert(named(pFinal(12, 'p0')).length === 12, 'the finished board is not fully revealed');
});

check('the next pick is on the clock, and only that one', () => {
  const onClock = (v) => v.pDraftRows.filter((d) => d.name === 'ON THE CLOCK').map((d) => Number(d.pickNum));
  assert(onClock(pFinal(0, 'p0')).join() === '12', 'pick 12 is not on the clock at the start');
  assert(onClock(pFinal(6, 'p0')).join() === '6', 'pick 6 is not on the clock after six reveals');
  assert(onClock(pFinal(12, 'p0')).length === 0, 'something is still on the clock after the last pick');
});

check('your own row is marked at every stage, revealed or not', () => {
  for (const revealed of [0, 6, 12]) {
    const ringed = pFinal(revealed, 'p10').pDraftRows.filter((d) => d.ring !== 'none').map((d) => d.pickNum);
    assert(ringed.join() === '11', 'revealed=' + revealed + ': own row not ringed exactly once, got ' + JSON.stringify(ringed));
  }
});

check('exactly one row is flagged as the pick that just landed', () => {
  const latest = (v) => v.pDraftRows.filter((d) => d.latest === '1').map((d) => Number(d.pickNum));
  assert(latest(pFinal(0, 'p0')).length === 0, 'a row is flagged as latest before anything has been revealed');
  assert(latest(pFinal(1, 'p0')).join() === '12', 'the newest pick is not flagged for the scroll');
  assert(latest(pFinal(7, 'p0')).join() === '6', 'the newest pick is not flagged for the scroll');
});

check('nobody is told to watch a screen they cannot see', () => {
  for (const revealed of [0, 6, 12]) {
    for (const id of ['p0', 'p10', 'p11', 'nobody']) {
      const note = pFinal(revealed, id).myFinalNote || '';
      assert(!/big screen/i.test(note),
        'the phone still says "watch the big screen" (revealed=' + revealed + ', ' + id + '): ' + note);
    }
  }
});

check('the reveal read is opt-in and costs nothing until it is tapped', () => {
  assert(pFinal(0, 'p0').playCallLabel === 'Play the call', 'the call is not offered on the phone');
  const src = lift(/^  playCall = \(\) => \{[\s\S]*?\n  \};$/m, 'playCall()');
  assert(/new Audio\("reveal-vo\.mp3"\)/.test(src), 'playCall does not load the reveal read');
  assert(/if \(!this\.playerVo\)/.test(src),
    'the audio object is created eagerly; a phone that never taps would fetch the file anyway');
  // The host arms its read at kickoff. The phone must not, or every phone in
  // the room pulls the file down whether or not anyone wants it.
  const armed = template.match(/armRevealVo\(\)\s*\{[\s\S]*?\n  \}/);
  assert(armed && !/playerVo/.test(armed[0]), 'the phone read is being armed alongside the host read');
});

// ── the running ball ────────────────────────────────────────────────────────
console.log('\nthe ball crossing the bar');

// Two ways this stops moving, both silent, both shipped:
//
//   1. Positioning the runner with `transform` on the SAME element that runs
//      lofgBob. A running animation owns the property it animates, so the
//      inline translate is discarded and the ball sits at the left edge
//      bobbing in place. Verified in a browser: the computed matrix came back
//      as pure rotation with translation components 0, 0.
//   2. Expressing the travel in `vw`. The bar is not the viewport — the phone
//      column is capped at 560px and padded, the host column is padded — so
//      the ball overshoots the end and disappears into `overflow:hidden`.
check('nothing that runs lofgBob is also positioned by transform', () => {
  const bob = /animation:\s*lofgBob/;
  for (const m of template.matchAll(/<(svg|div|span)\b[^>]*style="([^"]*)"[^>]*>/g)) {
    const style = m[2];
    if (!bob.test(style)) continue;
    const positioning = /transform:[^;"]*(?:translateX|translate)\(/.test(style);
    assert(!positioning,
      'an element runs lofgBob AND sets a positioning transform, so the animation ' +
      'will discard the travel and the ball will sit still:\n           ' + style.slice(0, 150));
  }
});

check('the travel is a percentage of the bar, never a viewport unit', () => {
  const movers = [...template.matchAll(/transform:translateX\(\{\{ (\w+) \}\}\)/g)].map((m) => m[1]);
  assert(movers.length >= 2, 'expected the playhead and the runner to share a mover binding');
  for (const name of new Set(movers)) {
    const decl = template.match(new RegExp('v\\.' + name + ' = ([^;]+);'));
    assert(decl, 'no view-model value for {{ ' + name + ' }}');
    assert(!/vw|vh|vmin|vmax/.test(decl[1]),
      '{{ ' + name + ' }} is expressed in viewport units: ' + decl[1].trim() +
      ' — the bar is narrower than the viewport, so the ball runs off the end');
    assert(/"%"/.test(decl[1]),
      '{{ ' + name + ' }} is not a percentage, so it no longer tracks the bar width');
  }
});

check('each mover is a full-width child, so a percentage means the whole bar', () => {
  // translateX(47%) moves an element by 47% of ITS OWN width. That only equals
  // 47% of the bar if the mover is exactly as wide as the bar.
  for (const m of template.matchAll(/style="([^"]*transform:translateX\(\{\{ \w+ \}\}\)[^"]*)"/g)) {
    assert(/width:100%/.test(m[1]),
      'a percentage mover is not width:100% of the bar, so its travel is scaled wrong:\n           ' + m[1].slice(0, 140));
  }
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

check('the lobby cannot count below zero', () => {
  // The count lives in rosterNote; lobbyHint owns only the remote. They used
  // to both report it, in two different wordings, side by side.
  const note = lift(/v\.rosterNote = [\s\S]*?;\n/, 'rosterNote');
  const hint = lift(/v\.lobbyHint = [\s\S]*?;\n/, 'lobbyHint');
  assert(!/12 - st\.players\.length/.test(note), 'rosterNote hardcodes 12 rather than MAX_PLAYERS');
  assert(/Everybody is in/.test(note), 'a full roster has no "everybody is in" state');
  // The subtraction must sit behind the short-roster branch, or a thirteenth
  // player would render "-1 still to check in."
  assert(/!tvShort \? "Everybody is in\."/.test(note),
    'the remaining-players subtraction is not guarded by the short-roster check');
  assert(!/still to check in|more can still join/.test(hint),
    'lobbyHint is reporting the roster count again; rosterNote already does');
  assert(MAX_PLAYERS === 12, 'MAX_PLAYERS moved; check the draft grid still lays out');
});

check('the two lobby lines do not say the same thing', () => {
  const note = lift(/v\.rosterNote = [\s\S]*?;\n/, 'rosterNote');
  const hint = lift(/v\.lobbyHint = [\s\S]*?;\n/, 'lobbyHint');
  assert(/remote/i.test(hint), 'lobbyHint no longer explains the remote, which is its only job');
  assert(!/remote/i.test(note), 'rosterNote has taken on the remote as well as the count');
});

// ── the commissioner ────────────────────────────────────────────────────────
console.log('\nwho gets the remote');

const commishSrc = [
  lift(/const COMMISSIONER_ALIASES = \[[^\]]*\];/, 'COMMISSIONER_ALIASES'),
  lift(/^function normalName\(name\) \{[\s\S]*?\n\}$/m, 'normalName()'),
  lift(/^function isCommissionerName\(name\) \{[\s\S]*?\n\}$/m, 'isCommissionerName()'),
  lift(/const DEMO_NAMES = \[[^\]]*\];/, 'DEMO_NAMES'),
].join('\n');
const commish = new Function(commishSrc + 'return { isCommissionerName, normalName, DEMO_NAMES };')();

check('the commissioner is recognised by the name he actually types', () => {
  for (const n of ['Rich', 'rich', '  RICH  ', 'Richard', 'Rich V', 'Richard Vigil']) {
    assert(commish.isCommissionerName(n), JSON.stringify(n) + ' does not pick up the remote');
  }
});

// This is the whole reason the match is not a substring test. "Big Rich" is
// in the demo roster, so `name.includes("Rich")` would hand the remote to a
// bot and lock the real commissioner out of his own draft.
check('a name that merely contains "Rich" does not take the remote', () => {
  for (const n of ['Big Rich', 'Richie', 'Rich Uncle', 'Ricardo', 'Rick', 'Enrich', '', null]) {
    assert(!commish.isCommissionerName(n), JSON.stringify(n) + ' wrongly picks up the remote');
  }
});

check('no demo player can take the remote', () => {
  const bad = commish.DEMO_NAMES.filter(commish.isCommissionerName);
  assert(bad.length === 0, 'demo names that would steal the remote: ' + JSON.stringify(bad));
});

// Run the shipped hostJoin against stubs, rather than asserting on its text.
// Source checks would pass on a version that computed the right thing and
// never stored it.
const hostJoinSrc = lift(/^  hostJoin\(id, name\) \{[\s\S]*?\n  \}$/m, 'hostJoin()')
  .replace(/^  hostJoin\(id, name\)/, 'function hostJoin(id, name)');
const hostJoin = new Function(commishSrc + 'const MAX_PLAYERS = 12;\n' + hostJoinSrc + 'return hostJoin;')();

function room(players, commishId) {
  const self = {
    state: { players: players.slice(), commishId: commishId || '' },
    setState(patch) { Object.assign(self.state, typeof patch === 'function' ? patch(self.state) : patch); },
    broadcast() {},
    send() {}
  };
  return self;
}
const P = (name, id) => ({ id: id || ('id_' + name), name, score: 0, timeMs: 0, demo: false });

check('typing "Rich" picks up the remote with nobody tapping anything', () => {
  const r = room([P('Dave'), P('Sully')]);
  hostJoin.call(r, 'id_rich', 'Rich');
  assert(r.state.commishId === 'id_rich',
    'Rich joined and the remote did not move to him; commishId is ' + JSON.stringify(r.state.commishId));
});

check('"Big Rich" checking in leaves the remote alone', () => {
  const r = room([P('Dave')]);
  hostJoin.call(r, 'id_big', 'Big Rich');
  assert(r.state.commishId === '', 'Big Rich took the remote; commishId is ' + JSON.stringify(r.state.commishId));
});

check('the pickup never overrides a hand-off already made', () => {
  const r = room([P('Dave', 'id_dave')], 'id_dave');     // room already gave Dave the remote
  hostJoin.call(r, 'id_rich', 'Rich');
  assert(r.state.commishId === 'id_dave',
    'Rich checking in late silently took the remote off Dave');
});

check('a second "Rich" does not inherit the remote from the first', () => {
  const r = room([]);
  hostJoin.call(r, 'id_rich1', 'Rich');
  hostJoin.call(r, 'id_rich2', 'Rich');
  assert(r.state.commishId === 'id_rich1', 'the remote moved to the second Rich');
  assert(r.state.players[1].name === 'Rich (2)', 'the second Rich was not disambiguated');
});

check('tapping a name still works in both directions', () => {
  const src = lift(/^  setCommish\(id\) \{[\s\S]*?\n  \}$/m, 'setCommish()');
  assert(/this\.state\.commishId === id \? "" : id/.test(src),
    'setCommish no longer toggles, so the remote cannot be handed back');
});

// ── the invite ──────────────────────────────────────────────────────────────
console.log('\ngetting the link out of the room');

check('the invite carries a code somebody can retype, not just a link', () => {
  const src = lift(/^  inviteText\(code\) \{[\s\S]*?\n  \}$/m, 'inviteText()');
  const inviteText = new Function('joinUrlFor', 'return function (code) {' +
    src.replace(/^  inviteText\(code\) \{/, '').replace(/\n  \}$/, '')
       .replace(/this\.joinUrlFor/g, 'joinUrlFor') + '}')((c) => 'https://example.test/#' + c);
  const out = inviteText('ABCD');
  assert(out.includes('ABCD'), 'the room code is not in the invite text');
  assert(out.includes('https://example.test/#ABCD'), 'the join link is not in the invite text');
});

check('sharing falls back to the clipboard where there is no share sheet', () => {
  const src = lift(/^  shareInvite = \(\) => \{[\s\S]*?\n  \};$/m, 'shareInvite()');
  assert(/navigator\.share/.test(src), 'shareInvite never tries the native share sheet');
  assert(/navigator\.clipboard/.test(src),
    'no clipboard fallback — the button would do nothing on a desktop browser');
  // A dismissed share sheet rejects. That is a person changing their mind,
  // not a failure worth reporting.
  assert(/\.catch\(/.test(src), 'a dismissed share sheet would surface as an unhandled rejection');
});

// ── starting the game ───────────────────────────────────────────────────────
console.log('\nnot starting without everybody');

check('a short roster has to be confirmed, a full one does not', () => {
  const src = lift(/^  startGame = \(\) => \{[\s\S]*?\n  \};$/m, 'startGame()');
  assert(/players\.length < MAX_PLAYERS/.test(src), 'the TV starts a short roster with no confirm');
  assert(/startArmed/.test(src), 'the TV kick off has no armed state');
  // The confirm must not apply at a full roster, or the commissioner presses
  // twice every single night for no reason.
  assert(/!this\.state\.startArmed/.test(src),
    'the second press is not what actually starts the game');
});

check('the arm state cannot survive into the next room', () => {
  const goHome = lift(/^  goHome = \(\) => \{[\s\S]*?\n  \};$/m, 'goHome()');
  assert(/startArmed: false/.test(goHome), 'startArmed survives a return home');
  const goHost = lift(/^  goHost = \(\) => \{[\s\S]*?\n  \};$/m, 'goHost()');
  assert(/startArmed: false/.test(goHost), 'startArmed survives into a freshly minted room');
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
