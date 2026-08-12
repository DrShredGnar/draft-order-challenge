# Draft Order Challenge

League of Ordinary Gentlemen draft-night party game. Twelve questions, four
tiers, thirty seconds each — the final scoreboard becomes the draft board.

Play: https://drshredgnar.github.io/draft-order-challenge/

One TV screen hosts, everyone else joins on a phone with a four-letter room
code. Rooms are realtime via Supabase; the question pool is sealed and drawn
at random at kickoff, so the commissioner plays as blind as everyone else.
The war room also serves this build at `/challenge` from a vendored copy.

## Repo layout

`index.html` is a **generated** single-file bundle — ~465KB with React, the
template runtime, Supabase, a QR encoder and all six webfonts inlined as
base64+gzip. Do not edit it by hand. Edit `src/` and rebuild.

`kickoff-plate.mp4` is the **one deliberate exception** to that: a 5s clip that
plays under the cold open. It is 2.3MB against a 465KB page that has to open
over a phone hotspot on draft night, and only the host screen ever renders it —
so it ships as a sibling file the eleven phones never request. Do not inline it;
a test in the war room fails the build if a `video/*` mime appears in the asset
manifest.

```
src/template.html       the app: design-system CSS, markup, and game logic
src/vendor/             libraries and woff2 files, inlined at build time
src/assets.json         uuid -> vendor file (uuids are stable across builds)
src/shell.html          the loader that unpacks the bundle in the browser
src/ext_resources.json   \ bundler metadata, carried through untouched
src/page_order.json      /
src/league_pool.json    GENERATED, sealed — the league's own questions
build.py                src/ -> index.html
unpack.py               index.html -> src/   (recovery only; already done)
kickoff-plate.mp4       cold-open background clip; NOT bundled (see above)
kickoff-vo.mp3          Sterling reads the cold open; sibling file, TV only
reveal-vo.mp3           Sterling reads the close over the held draft board
```

`src/template.html` is one file in four parts:

| Lines | What |
|---|---|
| ~18–73 | `@font-face` for Barlow Condensed + JetBrains Mono |
| ~77–590 | **Draft Night Broadcast** — the league's design system. The only token block. |
| ~590–1110 | Markup for all five screens (home, pool, join, player, host) |
| ~1110+ | Game logic and the view model, in a `<script type="text/x-dc">` |

The generic Nocturne scaffold that used to sit between the faces and the
design system is gone. It was ~290 lines of another product's buttons, cards,
dialogs, tables and tonal ramps, fully overridden by the block below it, and
it was still being served to twelve phones to style exactly one button. Two
things in it were load-bearing and both moved into the Draft Night block: the
`box-sizing` reset, and the pool screen's Back button, which is hand-styled
now like every other control. If you are diffing against an older bundle,
that deletion is most of the churn.

Markup uses a small template DSL, not JSX: `<sc-if value="{{ x }}">`,
`<sc-for list="{{ xs }}" as="x">`, `{{ interpolation }}`, and
`sc-camel-on-click`. Colours in the view model are CSS variable references
(`"var(--color-onair)"`), so retuning the token block retunes the whole app.

One DSL trap worth knowing: `sc-camel-*` is compiled to a **camelCase React
prop**, so `sc-camel-on-click` becomes `onClick` — correct for handlers, and
wrong for ARIA. `aria-*` and `role` must be written plain (`aria-live="polite"`),
because React renders those hyphenated and there is no camelCase form. An
`sc-camel-aria-live` silently becomes an `ariaLive` prop that reaches nothing.

## Accessibility

The rules that are easy to undo by accident:

- Every screen root is a `<main>` and carries exactly one `<h1>` — on the host
  that is the room code in the lobby and the question during play.
- The play clock is a `role="timer"`. The field bar underneath it is
  `aria-hidden` because it is a *picture* of the clock, not a second fact, and
  its yard numerals are decoration exempt from contrast rules.
- An answer's selected state is carried by `aria-pressed` **and** a tick in the
  letter badge, never by colour alone.
- Quiet text uses `--color-muted` / `--color-muted-strong`. Do not reintroduce
  ad-hoc `color-mix(var(--color-text) N%, transparent)` for type: everything
  under about 48% lands below 4.5:1 on these grounds, which is what the whole
  ladder used to do in 27 places.
- Tier colours have a `-ink` twin for use as text. `--tier-hard` and
  `--tier-brutal` miss 4.5:1 on `--color-surface`; the `-ink` values clear it.

## The house questions

Three of the twelve tiers' questions each game come from the league's own
history — every pick of the 2024 and 2025 drafts, both title games, and the
full weekly scoring table. One per tier, guaranteed rather than left to a
blind draw across a merged pool: a night that happened to serve zero of them
would be the old game with extra steps. `LEAGUE_QUOTA` in `src/template.html`
is that floor; if a tier's house pool ever runs short the rest is topped up
from the general pool and the tier still yields three.

They are generated in the war room, where the Sleeper history lives:

```sh
cd ../League_of_ordinary_gentlemen/shreddy_draft
python3 scripts/pull_league_weeks.py        # refresh league-wide weekly scores
python3 scripts/gen_league_questions.py     # -> ../../draft-order-challenge/src/league_pool.json
cd ../../draft-order-challenge && python3 build.py
```

Re-run both after each season ends. `gen_league_questions.py --check`
validates and reports per-tier counts without writing.

`league_pool.json` is base64 and that is a **spoiler guard, not secrecy**. The
commissioner runs the generator, reviews the diff, and pushes the commit, so a
plaintext pool would spoil itself before it ever shipped. Against a player it
buys nothing: `index.html` is public and the 120 general questions have always
sat in it in plain text. The seal on this game has always been social.

## Build

```sh
python3 build.py           # rebuild index.html from src/
python3 build.py --check   # rebuild in memory, diff against committed index.html
```

`build.py` substitutes `league_pool.json` into the template at the
`{{__LEAGUE_POOL__}}` marker, so the generated blob never lands in the
authored source. With that file absent the build still succeeds and the game
falls back to three general questions per tier — but a *malformed* seal is a
hard error, because a silently empty pool looks exactly like a working game
until the night it matters.

`--check` compares *semantically* — the loader shell, the four data tags, and
every asset's decompressed bytes. It deliberately does not byte-compare the
file: payloads are gzipped, and gzip streams carry the compressor's identity,
so bytes from Python will never equal bytes from the toolchain that produced
the original bundle even when every decoded byte matches.

To preview locally, `python3 -m http.server` and open `index.html`.

**The kickoff plate will not play under `http.server`.** It answers a Range
request with a plain 200 and no `Accept-Ranges`, and Chrome's media pipeline
will not progressively play a video without byte-range support, so the clip
sits at `readyState 0` forever and looks like a broken file. GitHub Pages does
serve 206, so this is a local-only trap. Use any Range-capable static server
when you need to check the cold open — everything else on the page previews
fine under `http.server`.

## Tests

```sh
python3 build.py --check    # FIRST — see below
node test/qr.test.js        # QR encoder conformance
node test/draw.test.js      # the kickoff draw and the house-question floor
node test/reveal.test.js    # the reveal read's cue, against a virtual clock
node test/failure.test.js   # the states that only exist when something breaks
```

**Run `--check` before the tests, or rebuild.** Three of the four suites —
`draw`, `reveal` and `failure` — read the generated `index.html` rather than
`src/`, deliberately: testing the source would let a build that drops a fix on
the floor still go green. The cost of that choice is that editing `src/`
without rebuilding leaves the tests asserting against the *old* bundle, where
they pass and mean nothing. `--check` fails loudly on exactly that, so it is
the cheap guard; `python3 build.py` is the other answer if you know the bundle
is stale.

`failure.test.js` covers the paths nobody exercises in a quiet room on good
wifi: the room-code alphabet agreeing with the join filter (they disagreed on
I and O, so `IOWA` was a well-formed code that matched nothing), the give-up
timer that stops a mistyped code stranding a player forever, staleness
detection so a dropped link cannot render as a running clock, the phone board
showing your own row when you are 7th of 12, grapheme-safe name truncation,
and the twelve-seat cap on real joins. Every one of those shipped broken and
stayed green under the other three suites.

The QR encoder is hand-rolled (`src/vendor/qr.js`) and shipped broken for
weeks: it wrote format information 4 bits away from any legal BCH(15,5)
codeword, and BCH corrects at most 3, so every decoder rejected the symbol
before reading the data. It fails silently — the canvas renders something
QR-shaped and nothing throws, so the only symptom is phones not scanning.

The tests assert what a decoder actually reads: format info is a legal
codeword, both copies agree, EC level is M, finders and timing are intact,
the fixed dark module is set. Run them after touching `qr.js`.

Do not diagnose QR problems by diffing the module matrix against a reference
encoder — a legal but different mask choice flips ~50% of the data region and
is indistinguishable from corruption. Decode the format bits and check them
against the 32 legal codewords, or decode the rendered canvas with Chrome's
`BarcodeDetector` alongside a known-good control image.

After changing `index.html`, copy it to the war room repo at
`league/index.html` so `/challenge` serves the same build. Copy any sibling
asset that changed across too — `kickoff-plate.mp4`, `kickoff-vo.mp3`,
`reveal-vo.mp3` — **and give each one a route in the war room's `server.py`**.
`/challenge` has no trailing slash, so the page's relative `src` resolves to the
site root and an un-routed sibling 404s there while working perfectly on Pages.
That is not hypothetical: `kickoff-vo.mp3` shipped without a route and the LAN
fallback ran a silent cold open for a day. A war-room test now derives the list
of referenced siblings from the bundle and fails if any of them is unrouted.

## The reveal read

The board goes up when the last question is scored and holds while Sterling
reads the close (`reveal-vo.mp3`). The ticker is *cued* rather than started
after him: `REVEAL_VO_CUE_MS` is measured off the file — 12.34s, where the
closing "Worst to first" begins — so pick twelve lands under those two words
and the reveal never has a silent hole in it. Clicking the board during the
hold cuts the read and starts the order, the same escape hatch the cold open
has.

Re-cutting the read means **re-measuring that number**, not nudging it. Two
tests hold the halves apart: `test/reveal.test.js` drives the shipped reveal
against a virtual clock (pick twelve on the cue, one step between the rest,
no timer left running), and the war room's `test_challenge_reveal_read.py`
reads the duration out of the mp3 and fails if the cue no longer lands inside
it. Both failure modes are invisible in a diff and inaudible until draft
night.

## Design

The look is **Draft Night Broadcast**, defined in `DESIGN.md` in the war room
repo — that file is the source of truth, not this one. Short version:

- Barlow Condensed 800 caps for anything a graphics operator would shout;
  italic condensed caps, tracked, for eyebrows; JetBrains Mono for everything
  read under the clock.
- Navy `#0a0c14` ground, 2–3px radii (broadcast graphics have corners).
- **Red `#d41818` means live** — the play clock, the ON AIR dot, the kickoff
  button, the pick currently being revealed. Nothing else is red.
- **Green `#2fa862` is the field** — points, correct answers, players present.
- **Yellow `#ffcf6b` is the flag** — a blown call is a penalty, and a penalty
  flag is yellow. This is what keeps red meaning only "live".
- Tier colours come from the position palette (RB green → WR yellow → TE
  orange → QB red), so Easy/Medium/Hard/Brutal are four different hues rather
  than four shades of one.

Retune the token block at the top of the Draft Night Broadcast section in
`src/template.html`; it propagates everywhere, including the downloadable
share card, which draws on a canvas using the same tokens and faces.
