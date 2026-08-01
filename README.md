# Draft Order Challenge

League of Ordinary Gentlemen draft-night party game. Twelve questions, four
tiers, thirty seconds each — the final scoreboard becomes the draft board.

Play: https://drshredgnar.github.io/draft-order-challenge/

One TV screen hosts, everyone else joins on a phone with a four-letter room
code. Rooms are realtime via Supabase; the question pool is sealed and drawn
at random at kickoff, so the commissioner plays as blind as everyone else.
The war room also serves this build at `/challenge` from a vendored copy.

## Repo layout

`index.html` is a **generated** single-file bundle — ~440KB with React, the
template runtime, Supabase, a QR encoder and all six webfonts inlined as
base64+gzip. Do not edit it by hand. Edit `src/` and rebuild.

```
src/template.html       the app: design-system CSS, markup, and game logic
src/vendor/             libraries and woff2 files, inlined at build time
src/assets.json         uuid -> vendor file (uuids are stable across builds)
src/shell.html          the loader that unpacks the bundle in the browser
src/ext_resources.json   \ bundler metadata, carried through untouched
src/page_order.json      /
build.py                src/ -> index.html
unpack.py               index.html -> src/   (recovery only; already done)
```

`src/template.html` is one file in four parts:

| Lines | What |
|---|---|
| ~15–60 | `@font-face` for Barlow Condensed + JetBrains Mono |
| ~68–360 | Nocturne base tokens and component classes (the artifact scaffold) |
| ~363–500 | **Draft Night Broadcast** — the league's design system, overriding the above |
| ~500–1000 | Markup for all five screens (home, pool, join, player, host) |
| ~1000+ | Game logic and the view model, in a `<script type="text/x-dc">` |

Markup uses a small template DSL, not JSX: `<sc-if value="{{ x }}">`,
`<sc-for list="{{ xs }}" as="x">`, `{{ interpolation }}`, and
`sc-camel-on-click`. Colours in the view model are CSS variable references
(`"var(--color-onair)"`), so retuning the token block retunes the whole app.

## Build

```sh
python3 build.py           # rebuild index.html from src/
python3 build.py --check   # rebuild in memory, diff against committed index.html
```

`--check` compares *semantically* — the loader shell, the four data tags, and
every asset's decompressed bytes. It deliberately does not byte-compare the
file: payloads are gzipped, and gzip streams carry the compressor's identity,
so bytes from Python will never equal bytes from the toolchain that produced
the original bundle even when every decoded byte matches.

To preview locally, `python3 -m http.server` and open `index.html`.

## Tests

```sh
node test/qr.test.js        # QR encoder conformance
```

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
`league/index.html` so `/challenge` serves the same build.

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
