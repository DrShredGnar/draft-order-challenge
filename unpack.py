#!/usr/bin/env python3
"""Unpack index.html (a self-contained artifact bundle) into src/.

Run this once to recover an editable source tree from a bundle, or after
pulling a bundle that was rebuilt somewhere else. Day to day you edit src/
and run build.py; you should not need this again.

The bundle is: a loader shell (plain HTML + JS), then four data script tags —
manifest (uuid -> base64(gzip(bytes))), ext_resources, page_order, template.
"""
import base64
import gzip
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).parent
SRC = ROOT / "src"

TAGS = ("manifest", "ext_resources", "page_order", "template")

# uuid -> filename. The bundle names payloads by uuid only; these are the
# identities recovered by inspecting each payload's contents. Keeping the
# uuids stable across rebuilds keeps index.html diffs readable.
ASSET_NAMES = {
    "d2d97104-fefd-4fe3-b506-701516a3327e": "supabase.umd.js",
    "8dd7a116-12ca-4e2c-a1ad-4555d932be01": "nocturne-shim.js",
    "df85a145-0bd5-4e8c-980e-7d50b3ae3e53": "qr.js",
    "4882ea57-300d-4157-9920-b486a1b0d129": "dc-runtime.js",
    "19f6b3ef-a1da-4e09-8a47-2ff094b851a9": "react.production.min.js",
    "24cc9766-be6d-4c2c-a08b-699976467d55": "react-dom.production.min.js",
    "a1000000-0000-4000-8000-000000000001": "barlow-condensed-600.woff2",
    "a1000000-0000-4000-8000-000000000002": "barlow-condensed-700.woff2",
    "a1000000-0000-4000-8000-000000000003": "barlow-condensed-800.woff2",
    "a1000000-0000-4000-8000-000000000004": "barlow-condensed-600-italic.woff2",
    "a1000000-0000-4000-8000-000000000005": "barlow-condensed-700-italic.woff2",
    "a1000000-0000-4000-8000-000000000006": "jetbrains-mono-var.woff2",
}


def find_tag(html, name):
    m = re.search(r'<script type="__bundler/%s">(.*?)</script>' % name, html, re.S)
    if not m:
        sys.exit("missing __bundler/%s tag" % name)
    return m


def main():
    html = (ROOT / "index.html").read_text()
    spans = {name: find_tag(html, name).span() for name in TAGS}

    SRC.mkdir(exist_ok=True)
    (SRC / "vendor").mkdir(exist_ok=True)

    manifest = json.loads(find_tag(html, "manifest").group(1))
    assets = []
    for uuid, entry in manifest.items():
        name = ASSET_NAMES.get(uuid)
        if not name:
            sys.exit("unknown asset uuid %s — add it to ASSET_NAMES" % uuid)
        raw = base64.b64decode(entry["data"])
        if entry.get("compressed"):
            raw = gzip.decompress(raw)
        (SRC / "vendor" / name).write_bytes(raw)
        assets.append({"uuid": uuid, "file": name, "mime": entry["mime"],
                       "compressed": bool(entry.get("compressed"))})

    (SRC / "assets.json").write_text(json.dumps(assets, indent=2) + "\n")
    (SRC / "template.html").write_text(json.loads(find_tag(html, "template").group(1)))
    (SRC / "ext_resources.json").write_text(
        find_tag(html, "ext_resources").group(1).strip() + "\n")
    (SRC / "page_order.json").write_text(
        find_tag(html, "page_order").group(1).strip() + "\n")

    # The shell is everything outside the four data tags. build.py splices
    # freshly encoded tags back into these exact slots.
    first = spans["manifest"][0]
    last = spans["template"][1]
    shell = html[:first] + "{{__BUNDLER_TAGS__}}" + html[last:]
    (SRC / "shell.html").write_text(shell)

    print("unpacked %d assets + template (%d lines) into src/"
          % (len(assets), (SRC / "template.html").read_text().count("\n") + 1))


if __name__ == "__main__":
    main()
