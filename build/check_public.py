#!/usr/bin/env python3
"""Fail if the public site contains proprietary Rubin DP2 (EDP2) data.

Stdlib only: runs from the pre-commit hook and CI.  Usage: check_public.py [docs]
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

MAX_BYTES = 50_000_000
DP2_ID = re.compile(r"(?<!\d)7\d{17}(?!\d)")          # DP2 catalog diaObjectIds are ~7.6e17
PRIVATE_SOURCE = re.compile(r'"edp2_(dia|fp)"')
PRIVATE_COL = re.compile(r"edp2|diaobjectid|sep_arcsec", re.I)


def main(root: Path) -> int:
    errs = []
    for f in root.rglob("*"):
        if not f.is_file():
            continue
        rel = f.relative_to(root)
        if f.stat().st_size > MAX_BYTES:
            errs.append(f"{rel}: larger than {MAX_BYTES / 1e6:.0f} MB")
        if f.suffix in {".parquet", ".csv", ".fits", ".npy", ".pkl"}:
            errs.append(f"{rel}: raw data file type not allowed in the public site")
        if rel.parts[0] != "data":
            continue
        txt = f.read_text(errors="ignore")
        if PRIVATE_SOURCE.search(txt):
            errs.append(f"{rel}: contains a private EDP2 source key")
        if DP2_ID.search(txt):
            errs.append(f"{rel}: contains a DP2-catalog-like diaObjectId ({DP2_ID.search(txt).group()[:4]}...)")
        if f.name == "catalog.js":
            j = json.loads(txt[txt.index("(") + 1: txt.rindex(")")])
            if j["meta"].get("mode") != "public":
                errs.append(f"{rel}: meta.mode is {j['meta'].get('mode')!r}, not 'public'")
            bad = [c for c in j["cols"] if PRIVATE_COL.search(c)]
            if bad:
                errs.append(f"{rel}: private columns {bad}")
            bad = [s for s in j["meta"].get("sources", {}) if s.startswith("edp2")]
            if bad:
                errs.append(f"{rel}: private sources {bad}")
    for e in errs:
        print(f"check_public: {e}", file=sys.stderr)
    if not errs:
        print(f"check_public: OK ({root})")
    return 1 if errs else 0


if __name__ == "__main__":
    sys.exit(main(Path(sys.argv[1] if len(sys.argv) > 1 else "docs")))
