#!/usr/bin/env python3
"""Bundle src/ back into the single self-contained index.html.

    python3 build.py           rebuild index.html
    python3 build.py --check   rebuild in memory and diff against the committed
                               index.html, semantically (see below). Exit 1 on
                               any difference.

Why --check is semantic rather than a byte compare: the payloads are gzipped,
and gzip streams carry the compressor's identity and settings, so bytes
produced by Python will not equal bytes produced by the toolchain that made
the original bundle even when every decoded byte is identical. --check
therefore unpacks both sides and compares what the browser actually sees:
the shell, the four data tags, and each asset's decompressed content.
"""
import base64
import gzip
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).parent
SRC = ROOT / "src"
OUT = ROOT / "index.html"

TAG_SEP = "\n\n  "
PLACEHOLDER = "{{__BUNDLER_TAGS__}}"
LEAGUE_MARKER = "{{__LEAGUE_POOL__}}"


def gz(data: bytes) -> bytes:
    # mtime=0 so a rebuild with no source change produces identical bytes.
    return gzip.compress(data, compresslevel=9, mtime=0)


def js_json(obj) -> str:
    """JSON for embedding inside a <script> body.

    Every "</" is escaped so a closing tag can never appear literally inside
    the string — otherwise the app's own inline <script> would terminate the
    data tag early and the page would break in a way no test would catch.
    """
    return json.dumps(obj, ensure_ascii=False).replace("</", "<\\u002F")


def league_pool() -> str:
    """The sealed base64 pool of league-history questions, for the template.

    Generated outside this repo by shreddy_draft/scripts/gen_league_questions.py,
    which is where the draft and scoring history lives. Absent that file the
    build still succeeds with an empty seal: the game degrades to three general
    questions per tier, which is how it shipped before the house questions
    existed. A build that silently produced a *broken* seal would be worse than
    one that produced none, so the shape is checked rather than assumed.
    """
    path = SRC / "league_pool.json"
    if not path.exists():
        print("note: src/league_pool.json missing — building with no league "
              "questions (run gen_league_questions.py to add them)")
        return ""
    data = json.loads(path.read_text())
    sealed = data.get("sealed", "")
    if not isinstance(sealed, str) or not sealed:
        sys.exit("src/league_pool.json has no 'sealed' payload")
    try:
        decoded = json.loads(base64.b64decode(sealed).decode("utf-8"))
    except Exception as e:
        sys.exit("src/league_pool.json seal does not decode: %s" % e)
    missing = [t for t in ("easy", "medium", "hard", "brutal") if not decoded.get(t)]
    if missing:
        sys.exit("league pool has no questions for tier(s): %s" % ", ".join(missing))
    if '"' in sealed or "\\" in sealed:
        # It is interpolated into a JS double-quoted string literal. Base64's
        # alphabet contains neither, so this can only mean the payload is not
        # what it claims to be.
        sys.exit("league pool seal is not clean base64")
    return sealed


def rendered_template() -> str:
    """src/template.html with the league pool substituted in.

    The pool is injected at build time rather than written into template.html
    so that the authored file stays authored: a generated 32KB base64 line
    committed into the middle of the app source would make every regeneration
    look like a source change in review.
    """
    text = (SRC / "template.html").read_text()
    if LEAGUE_MARKER not in text:
        sys.exit("src/template.html has lost its %s marker" % LEAGUE_MARKER)
    return text.replace(LEAGUE_MARKER, league_pool())


def build() -> str:
    shell = (SRC / "shell.html").read_text()
    if PLACEHOLDER not in shell:
        sys.exit("src/shell.html has lost its %s marker" % PLACEHOLDER)

    manifest = {}
    for a in json.loads((SRC / "assets.json").read_text()):
        raw = (SRC / "vendor" / a["file"]).read_bytes()
        payload = gz(raw) if a["compressed"] else raw
        manifest[a["uuid"]] = {
            "mime": a["mime"],
            "compressed": a["compressed"],
            "data": base64.b64encode(payload).decode(),
        }

    tags = [
        ('manifest', js_json(manifest)),
        ('ext_resources', (SRC / "ext_resources.json").read_text().strip()),
        ('page_order', (SRC / "page_order.json").read_text().strip()),
        ('template', js_json(rendered_template())),
    ]
    # Each body sits on its own line, indented to match the surrounding shell.
    tags = [(name, "\n" + body + "\n  ") for name, body in tags]
    rendered = TAG_SEP.join(
        '<script type="__bundler/%s">%s</script>' % (name, body) for name, body in tags)
    return shell.replace(PLACEHOLDER, rendered)


def decode(html: str) -> dict:
    """What the browser ends up with, independent of compression details."""
    out = {}
    for name in ("manifest", "ext_resources", "page_order", "template"):
        m = re.search(r'<script type="__bundler/%s">(.*?)</script>' % name, html, re.S)
        if not m:
            sys.exit("built output is missing the %s tag" % name)
        out[name] = m.group(1).strip()
        if name == "manifest":
            assets = {}
            for uuid, e in json.loads(m.group(1)).items():
                raw = base64.b64decode(e["data"])
                if e.get("compressed"):
                    raw = gzip.decompress(raw)
                assets[uuid] = (e["mime"], raw)
            out["_assets"] = assets
        else:
            out[name] = m.group(1).strip()
    span = re.search(r'<script type="__bundler/manifest">', html).start()
    end = html.rindex("</script>") + len("</script>")
    out["_shell"] = html[:span] + html[end:]
    return out


def check() -> int:
    new = decode(build())
    old = decode(OUT.read_text())
    bad = []

    if new["_shell"] != old["_shell"]:
        bad.append("loader shell differs")
    for name in ("ext_resources", "page_order"):
        if new[name] != old[name]:
            bad.append("%s differs" % name)
    if json.loads(new["template"]) != json.loads(old["template"]):
        bad.append("template differs")

    if set(new["_assets"]) != set(old["_assets"]):
        bad.append("asset set differs: +%s -%s" % (
            sorted(set(new["_assets"]) - set(old["_assets"])),
            sorted(set(old["_assets"]) - set(new["_assets"]))))
    else:
        for uuid, (mime, raw) in new["_assets"].items():
            omime, oraw = old["_assets"][uuid]
            if mime != omime:
                bad.append("%s mime %s != %s" % (uuid, mime, omime))
            if raw != oraw:
                bad.append("%s content differs (%d vs %d bytes)"
                           % (uuid, len(raw), len(oraw)))

    if bad:
        print("MISMATCH:")
        for b in bad:
            print("  -", b)
        return 1
    print("OK — rebuilt bundle is semantically identical to the committed "
          "index.html (%d assets, template %d chars)"
          % (len(new["_assets"]), len(json.loads(new["template"]))))
    return 0


if __name__ == "__main__":
    if "--check" in sys.argv:
        sys.exit(check())
    html = build()
    OUT.write_text(html)
    print("wrote index.html (%.1f KB)" % (len(html.encode()) / 1024))
