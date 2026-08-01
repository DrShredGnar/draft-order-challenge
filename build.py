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
        ('template', js_json((SRC / "template.html").read_text())),
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
