// Regression tests for the reveal read and the cue it hands off on.
//
// Run: node test/reveal.test.js [path-to-index.html]
//
// The thing being protected is a timing relationship you cannot see in a diff.
// The board holds while Sterling reads, and pick twelve is supposed to land ON
// his closing line — not after it, and not 2.6s after it. Two edits break that
// silently:
//
//   * cueing the ticker with a bare setInterval, which pays out on its first
//     tick rather than immediately, putting pick twelve one whole step late;
//   * re-cutting the read without re-measuring REVEAL_VO_CUE_MS, which leaves
//     a hole of dead air where the handoff was.
//
// Both leave every existing test green and both are inaudible until twelve
// people are watching. So these tests do not check that the code *looks* right
// — they run the shipped reveal against a virtual clock and assert when things
// actually happen. See the war room's test_challenge_reveal_read.py for the
// other half: that the cue still lands inside the audio file that ships.

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

// ── recover the shipped reveal logic ────────────────────────────────────────
// Same approach as draw.test.js: read the *built* bundle, lift the exact
// declarations, evaluate them. Class-property arrows are rewritten to plain
// functions so they can be .call()'d against a stand-in host — an arrow would
// close over the wrong `this` once it is out of the class body.

const tagMatch = html.match(/<script type="__bundler\/template">([\s\S]*?)<\/script>/);
assert(tagMatch, 'bundle has no __bundler/template tag');
const template = JSON.parse(tagMatch[1].trim().replace(/<\\u002F/g, '</'));

function lift(re, what) {
  const m = template.match(re);
  if (!m) throw new Error('could not find ' + what + ' in the bundled template');
  return m[0];
}

const src = [
  lift(/const REVEAL_STEP_MS = \d+;/, 'REVEAL_STEP_MS'),
  lift(/const REVEAL_VO_CUE_MS = \d+;/, 'REVEAL_VO_CUE_MS'),
  lift(/^  nextQuestion = \(\) => \{[\s\S]*?\n  \};$/m, 'nextQuestion()')
    .replace(/^  nextQuestion = \(\) => \{/, 'function nextQuestion() {')
    .replace(/\n  \};$/, '\n}'),
  lift(/^  runReveal\(\) \{[\s\S]*?\n  \}$/m, 'runReveal()')
    .replace(/^  runReveal\(\)/, 'function runReveal()'),
  lift(/^  skipRevealHold = \(\) => \{[\s\S]*?\n  \};$/m, 'skipRevealHold()')
    .replace(/^  skipRevealHold = \(\) => \{/, 'function skipRevealHold() {')
    .replace(/\n  \};$/, '\n}'),
  'module.exports = { nextQuestion, runReveal, skipRevealHold, REVEAL_STEP_MS, REVEAL_VO_CUE_MS };',
].join('\n\n');

// ── a virtual clock ─────────────────────────────────────────────────────────
// Nothing waits in real time; the point is to read the schedule the code sets
// up, exactly as it set it up.

function makeClock() {
  let now = 0, seq = 0;
  const timers = new Map();      // id -> {at, every, fn}
  const api = {
    setTimeout(fn, ms) { const id = ++seq; timers.set(id, { at: now + ms, every: 0, fn }); return id; },
    setInterval(fn, ms) { const id = ++seq; timers.set(id, { at: now + ms, every: ms, fn }); return id; },
    clearTimeout(id) { timers.delete(id); },
    clearInterval(id) { timers.delete(id); },
    now: () => now,
    pending: () => timers.size,
    // Run every timer due up to `until`, in fire order.
    advanceTo(until) {
      for (;;) {
        let nextId = null, nextAt = Infinity;
        for (const [id, t] of timers) if (t.at < nextAt) { nextAt = t.at; nextId = id; }
        if (nextId === null || nextAt > until) break;
        now = nextAt;
        const t = timers.get(nextId);
        if (t.every) t.at = now + t.every; else timers.delete(nextId);
        t.fn();
      }
      now = until;
    },
  };
  return api;
}

function makeHost(clock, playerCount) {
  const log = [];
  const host = {
    log,
    state: {
      phase: 'results',
      qIndex: 11,
      questions: new Array(12).fill(null),
      revealCount: 0,
      players: Array.from({ length: playerCount }, (_, i) => ({ id: 'p' + i, name: 'P' + i })),
    },
    setState(patch, cb) {
      Object.assign(this.state, patch);
      if (typeof patch.revealCount === 'number') log.push({ t: clock.now(), pick: patch.revealCount });
      if (cb) cb();
    },
    broadcast() {},
    beginQuestion() { throw new Error('nextQuestion advanced instead of revealing'); },
    playRevealVo() { log.push({ t: clock.now(), vo: 'play' }); },
    stopRevealVo() { log.push({ t: clock.now(), vo: 'stop' }); },
  };
  return host;
}

function loadInto(clock) {
  const mod = { exports: {} };
  new Function('module', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', src)(
    mod, clock.setTimeout, clock.setInterval, clock.clearTimeout, clock.clearInterval);
  return mod.exports;
}

const probe = loadInto(makeClock());
const { REVEAL_STEP_MS, REVEAL_VO_CUE_MS } = probe;

function runToBoardFull(playerCount) {
  const clock = makeClock();
  const api = loadInto(clock);
  const host = makeHost(clock, playerCount);
  Object.assign(host, { runReveal: api.runReveal, skipRevealHold: api.skipRevealHold });
  api.nextQuestion.call(host);
  clock.advanceTo(REVEAL_VO_CUE_MS + REVEAL_STEP_MS * (playerCount + 4));
  return { host, clock, api };
}

// Entering the reveal phase sets revealCount to 0 in the same setState that
// sets the phase. That is the board being armed, not a pick landing, so it is
// logged (a stray reset mid-ticker would still show up) but not counted here.
const picks = (host) => host.log.filter((e) => e.pick > 0);

// ── the tests ───────────────────────────────────────────────────────────────

console.log('\nreveal read\n');

check('the read starts the moment the board goes up', () => {
  const { host } = runToBoardFull(12);
  const vo = host.log.filter((e) => e.vo === 'play');
  assert(vo.length === 1, 'expected exactly one play, got ' + vo.length);
  assert(vo[0].t === 0, 'the read should start at the phase change, started at ' + vo[0].t + 'ms');
});

check('nothing on the board moves while the read runs', () => {
  const { host } = runToBoardFull(12);
  const early = picks(host).filter((e) => e.t < REVEAL_VO_CUE_MS);
  assert(early.length === 0,
    'a pick landed at ' + (early[0] || {}).t + 'ms, during the read');
});

check('pick twelve lands ON the cue, not one step after it', () => {
  // The regression this exists for: `setInterval(step, 2600)` with no leading
  // call puts the first pick at cue+2600, which reads as the read finishing
  // and then a pause. Off by one interval, and only ever audible.
  const { host } = runToBoardFull(12);
  const first = picks(host)[0];
  assert(first, 'no picks were revealed at all');
  assert(first.pick === 1, 'first reveal should be pick 1 of the ticker, was ' + first.pick);
  assert(first.t === REVEAL_VO_CUE_MS,
    'first pick landed at ' + first.t + 'ms, expected the cue at ' + REVEAL_VO_CUE_MS + 'ms');
});

check('the rest of the board comes out one step apart', () => {
  const { host } = runToBoardFull(12);
  const p = picks(host);
  assert(p.length === 12, 'expected 12 reveals, got ' + p.length);
  for (let i = 1; i < p.length; i++) {
    const gap = p[i].t - p[i - 1].t;
    assert(gap === REVEAL_STEP_MS,
      'gap ' + i + ' was ' + gap + 'ms, expected ' + REVEAL_STEP_MS + 'ms');
  }
  assert(p[p.length - 1].pick === 12, 'the board should end full, ended at ' + p[p.length - 1].pick);
});

check('the ticker stops itself when the board is full', () => {
  // A live interval past the last pick would keep pushing revealCount up and
  // re-broadcasting to eleven phones for as long as the TV stays on this screen.
  const { host, clock } = runToBoardFull(12);
  assert(clock.pending() === 0, clock.pending() + ' timer(s) still running after the board filled');
  assert(host.state.revealCount === 12,
    'revealCount ran past the roster to ' + host.state.revealCount);
});

check('a one-player room leaves no interval behind', () => {
  const { host, clock } = runToBoardFull(1);
  assert(host.state.revealCount === 1, 'expected the single pick, got ' + host.state.revealCount);
  assert(clock.pending() === 0, 'an interval survived a one-pick board');
});

check('clicking the board cuts the read and starts the order', () => {
  const clock = makeClock();
  const api = loadInto(clock);
  const host = makeHost(clock, 12);
  Object.assign(host, { runReveal: api.runReveal, skipRevealHold: api.skipRevealHold });
  api.nextQuestion.call(host);
  host.state.phase = 'reveal';
  clock.advanceTo(3000);
  api.skipRevealHold.call(host);
  assert(host.log.some((e) => e.vo === 'stop'), 'the read kept playing over the order');
  const first = picks(host)[0];
  assert(first && first.t === 3000,
    'the order should start on the click, started at ' + (first || {}).t + 'ms');
  clock.advanceTo(3000 + REVEAL_STEP_MS * 20);
  assert(picks(host).length === 12, 'the skipped board did not fill: ' + picks(host).length);
  assert(clock.pending() === 0, 'a timer survived the skipped board');
});

check('clicking after the order is moving does nothing', () => {
  // The same element carries Copy draft order and Download card at the end.
  // If the board's own handler were live there it would restart the ticker
  // under them.
  const clock = makeClock();
  const api = loadInto(clock);
  const host = makeHost(clock, 12);
  Object.assign(host, { runReveal: api.runReveal, skipRevealHold: api.skipRevealHold });
  api.nextQuestion.call(host);
  host.state.phase = 'reveal';
  clock.advanceTo(REVEAL_VO_CUE_MS + REVEAL_STEP_MS * 3);
  const before = picks(host).length;
  api.skipRevealHold.call(host);
  assert(picks(host).length === before, 'the click advanced the board on its own');
  assert(!host.log.some((e) => e.vo === 'stop'), 'the click stopped a read that was already done');
});

check('the backdrop is up for the read and still off the phones', () => {
  // The cut scene. Rather than assert the shape of the expression, lift it and
  // evaluate it across every screen and phase that matters — the failure worth
  // catching is "and now the eleven phones each pull 2.3MB", which a regex over
  // the source cannot tell you.
  const expr = lift(/showAmbient: [\s\S]*?,\n      goHome:/, 'showAmbient')
    .replace(/^showAmbient: /, '').replace(/,\n      goHome:$/, '');
  const ambient = new Function('st', 'sc', 'return (' + expr + ');');
  const st = (over) => Object.assign(
    { reduceMotion: false, phase: 'lobby', tvSized: true }, over);

  assert(ambient(st({ phase: 'reveal' }), 'host') === true,
    'the board holds still for the whole read with no backdrop behind it');
  assert(ambient(st({ phase: 'lobby' }), 'host') === true,
    'the lobby lost its backdrop');
  // Still off every phone surface, and still off the TV mid-question.
  for (const screen of ['player', 'join', 'pool']) {
    assert(ambient(st({ phase: 'reveal' }), screen) !== true,
      'the ' + screen + ' screen would fetch 2.3MB for a backdrop it never shows');
  }
  for (const phase of ['question', 'results', 'intro']) {
    assert(ambient(st({ phase }), 'host') !== true,
      'the backdrop is up during ' + phase + ', competing with the game');
  }
  assert(ambient(st({ phase: 'reveal', reduceMotion: true }), 'host') !== true,
    'reduced motion must still drop the clip — CSS hiding does not stop a fetch');
});

check('the cue is a measured number, not a round guess', () => {
  // Not a style rule: a cue on a 500ms boundary is the tell that somebody
  // eyeballed it instead of measuring where the closing line starts. The
  // matching duration check lives in the war room, where the file is read.
  assert(REVEAL_VO_CUE_MS % 500 !== 0,
    'REVEAL_VO_CUE_MS is ' + REVEAL_VO_CUE_MS + 'ms — re-measure it against reveal-vo.mp3');
  assert(REVEAL_VO_CUE_MS > REVEAL_STEP_MS,
    'the cue is shorter than one step; the read cannot be covering anything');
});

console.log(failures ? '\n' + failures + ' FAILED.\n' : '\nAll passed.\n');
process.exit(failures ? 1 : 0);
