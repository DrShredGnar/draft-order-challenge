// Regression tests for the kickoff draw — specifically the guarantee that
// every tier serves one question from the league's own history.
//
// Run: node test/draw.test.js [path-to-index.html]
//
// This reads the *built* index.html rather than src/template.html on purpose.
// The league pool does not exist in the source at all — src/template.html
// carries a marker and build.py substitutes the sealed payload in — so a test
// against the source would be testing a file where the feature is absent by
// construction and would pass just as happily with the injection broken.
//
// The failure this guards against is quiet and unrecoverable in the moment:
// twelve people are around a TV, the draw happens once, and a game that
// silently served twelve general-knowledge questions would look exactly like
// a game that worked. Nobody would know until it was over.

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

// ── recover the shipped game logic ──────────────────────────────────────────
// The template is a JSON string inside a bundler tag; the logic sits in a
// <script type="text/x-dc"> inside that. Rather than parse the app, lift the
// exact declarations the draw depends on and evaluate them.

const tagMatch = html.match(/<script type="__bundler\/template">([\s\S]*?)<\/script>/);
assert(tagMatch, 'bundle has no __bundler/template tag');
const template = JSON.parse(tagMatch[1].trim().replace(/<\\u002F/g, '</'));

function lift(re, what) {
  const m = template.match(re);
  if (!m) throw new Error('could not find ' + what + ' in the bundled template');
  return m[0];
}

const src = [
  lift(/const QUESTIONS_PER_TIER = \d+;/, 'QUESTIONS_PER_TIER'),
  lift(/const LEAGUE_QUOTA = \d+;/, 'LEAGUE_QUOTA'),
  lift(/const TIERS = \[[\s\S]*?\n\];/, 'TIERS'),
  lift(/const POOL = \{[\s\S]*?\n\};/, 'POOL'),
  lift(/const LEAGUE_POOL_SEALED = "[^"]*";/, 'LEAGUE_POOL_SEALED'),
  lift(/let _leaguePool = null;\nfunction leaguePool\(\) \{[\s\S]*?\n\}/, 'leaguePool()'),
  lift(/function shuffle\(a\) \{.*\n/, 'shuffle()'),
  lift(/^  drawQuestions\(\) \{[\s\S]*?\n  \}$/m, 'drawQuestions()')
    .replace(/^  drawQuestions\(\)/, 'function drawQuestions()'),
  'module.exports = { drawQuestions, leaguePool, POOL, TIERS, LEAGUE_QUOTA, QUESTIONS_PER_TIER };',
].join('\n\n');

const mod = { exports: {} };
new Function('module', 'atob', 'TextDecoder', src)(
  mod,
  (b64) => Buffer.from(b64, 'base64').toString('binary'),
  TextDecoder);
const { drawQuestions, leaguePool, POOL, TIERS, LEAGUE_QUOTA, QUESTIONS_PER_TIER } = mod.exports;

const house = leaguePool();
const houseText = new Set();
for (const t of Object.keys(house)) for (const r of house[t]) houseText.add(r[0]);

// ── the pool itself ─────────────────────────────────────────────────────────

check('every tier has league questions to draw from', () => {
  for (const t of TIERS) {
    assert((house[t.key] || []).length >= LEAGUE_QUOTA,
      `tier ${t.key} has ${(house[t.key] || []).length} league questions, needs ${LEAGUE_QUOTA}`);
  }
});

check('the seal decoded to real questions, not an empty fallback', () => {
  const total = TIERS.reduce((n, t) => n + (house[t.key] || []).length, 0);
  // leaguePool() swallows a decode failure and returns empty arrays so a
  // broken seal cannot crash the party. That makes "empty" indistinguishable
  // from "never generated" at runtime, which is fine there and not fine here.
  assert(total > 0, 'league pool is empty — the seal failed to decode, or was never injected');
});

check('league questions are well formed', () => {
  for (const t of TIERS) {
    for (const [text, correct, wrong] of house[t.key] || []) {
      assert(typeof text === 'string' && text.length > 0, `${t.key}: empty question text`);
      assert(typeof correct === 'string' && correct.length > 0, `${t.key}: empty answer`);
      assert(Array.isArray(wrong) && wrong.length === 3, `${t.key}: "${text}" needs 3 distractors`);
      assert(!wrong.includes(correct), `${t.key}: "${text}" has the answer as a distractor`);
      assert(new Set(wrong).size === 3, `${t.key}: "${text}" has duplicate distractors`);
    }
  }
});

// ── the draw ────────────────────────────────────────────────────────────────
// Repeated because the draw is random: a single run can pass by luck.

const RUNS = 500;

check(`every draw yields ${TIERS.length * QUESTIONS_PER_TIER} questions, ${QUESTIONS_PER_TIER} per tier`, () => {
  for (let i = 0; i < RUNS; i++) {
    const qs = drawQuestions();
    assert(qs.length === TIERS.length * QUESTIONS_PER_TIER,
      `run ${i}: drew ${qs.length}`);
    for (const t of TIERS) {
      const n = qs.filter((q) => q.tier === t.key).length;
      assert(n === QUESTIONS_PER_TIER, `run ${i}: tier ${t.key} drew ${n}`);
    }
  }
});

check(`every tier serves at least ${LEAGUE_QUOTA} league question, every time`, () => {
  for (let i = 0; i < RUNS; i++) {
    const qs = drawQuestions();
    for (const t of TIERS) {
      const n = qs.filter((q) => q.tier === t.key && houseText.has(q.text)).length;
      assert(n >= LEAGUE_QUOTA, `run ${i}: tier ${t.key} served ${n} league questions`);
    }
  }
});

check('the tiers still run easy → brutal, so the points ramp holds', () => {
  const want = TIERS.map((t) => t.key);
  for (let i = 0; i < RUNS; i++) {
    const seen = [];
    for (const q of drawQuestions()) if (seen[seen.length - 1] !== q.tier) seen.push(q.tier);
    assert(JSON.stringify(seen) === JSON.stringify(want),
      `run ${i}: tier order was ${seen.join(',')}`);
  }
});

check('the correct index points at the correct answer', () => {
  const byText = new Map();
  for (const t of TIERS) {
    for (const row of (house[t.key] || []).concat(POOL[t.key])) byText.set(row[0], row[1]);
  }
  for (let i = 0; i < RUNS; i++) {
    for (const q of drawQuestions()) {
      assert(q.options.length === 4, `run ${i}: "${q.text}" had ${q.options.length} options`);
      assert(new Set(q.options).size === 4, `run ${i}: "${q.text}" had a duplicate option`);
      assert(q.options[q.correct] === byText.get(q.text),
        `run ${i}: "${q.text}" marks "${q.options[q.correct]}" correct, expected "${byText.get(q.text)}"`);
    }
  }
});

check('no question repeats inside a single game', () => {
  for (let i = 0; i < RUNS; i++) {
    const qs = drawQuestions();
    const texts = new Set(qs.map((q) => q.text));
    assert(texts.size === qs.length, `run ${i}: a question was drawn twice`);
  }
});

check('the house question is not always in the same slot', () => {
  // It is shuffled in among the tier's other two. If it were appended rather
  // than mixed, the room would learn after one round that the third question
  // of every tier is the league one — and, worse, that the first two never
  // are, which is a hint on every single question.
  const positions = new Set();
  for (let i = 0; i < RUNS; i++) {
    drawQuestions().forEach((q, idx) => {
      if (houseText.has(q.text)) positions.add(idx % QUESTIONS_PER_TIER);
    });
  }
  assert(positions.size === QUESTIONS_PER_TIER,
    `league questions only ever landed in slot(s) ${[...positions].sort().join(',')}`);
});

console.log(failures ? `\n${failures} failed.` : '\nAll passed.');
process.exit(failures ? 1 : 0);
