#!/usr/bin/env python3
"""Fail if the public site contains proprietary Rubin DP2 (EDP2) data.

Stdlib only: runs from the pre-commit hook and CI.  Usage: check_public.py [docs]

Plaintext EDP2 data may never appear under docs/. The one exception is the
encrypted team-access layer in docs/data/edp2/ (SCHEMA.md section 3): every file
there must be exactly one of the shapes below, with base64 fields and nothing else,
and each ciphertext must be padded and look like ciphertext rather than text.

    keyinfo.js  TNSX.onKeyInfo({"v":1,"kdf":"PBKDF2-SHA256","iter":N,"salt":B64,"check":{"iv":B64,"ct":B64}});
    catalog.js  TNSX.onEnc("catalog",{"iv":B64,"ct":B64});
    NNN.js      TNSX.onEnc("lc-NNN",{"iv":B64,"ct":B64});
"""
from __future__ import annotations

import base64
import binascii
import json
import re
import sys
from pathlib import Path

MAX_BYTES = 50_000_000
DP2_ID = re.compile(r"(?<!\d)7\d{17}(?!\d)")          # DP2 catalog diaObjectIds are ~7.6e17
PRIVATE_SOURCE = re.compile(r'"edp2_(dia|fp)"')
PRIVATE_COL = re.compile(r"edp2|diaobjectid|sep_arcsec", re.I)

# ---- encrypted layer (data/edp2/)
ENC_DIR = "edp2"
MIN_ITER = 600_000
SALT_BYTES, IV_BYTES, TAG_BYTES = 16, 12, 16
PAD_BYTES = 4096                 # plaintexts are space-padded to a multiple of this
MAX_CHECK_PLAIN = 64             # the key-check plaintext is a short constant
_B64 = r"([A-Za-z0-9+/]+={0,2})"
KEYINFO_RE = re.compile(r'TNSX\.onKeyInfo\(\{"v":1,"kdf":"PBKDF2-SHA256","iter":(\d{6,8}),"salt":"' + _B64 +
                        r'","check":\{"iv":"' + _B64 + r'","ct":"' + _B64 + r'"\}\}\);\n?')
ENC_RE = re.compile(r'TNSX\.onEnc\("(catalog|lc-\d{3})",\{"iv":"' + _B64 + r'","ct":"' + _B64 + r'"\}\);\n?')
SHARD_FILE = re.compile(r"\d{3}\.js")


def _b64(s: str) -> bytes:
    try:
        return base64.b64decode(s, validate=True)
    except (binascii.Error, ValueError) as e:
        raise ValueError(f"bad base64 ({e})") from None


def _looks_random(b: bytes) -> bool:
    """AES-GCM output is uniform bytes (~38% printable); base64'd or raw text is ~100%."""
    sample = b[:65536]
    printable = sum(1 for c in sample if 32 <= c < 127 or c in (9, 10, 13))
    return printable / max(1, len(sample)) < 0.6


def parse_keyinfo(txt: str) -> dict:
    """Parse keyinfo.js; raise ValueError unless it has exactly the allowed shape."""
    m = KEYINFO_RE.fullmatch(txt)
    if not m:
        raise ValueError("not exactly TNSX.onKeyInfo({v,kdf,iter,salt,check:{iv,ct}})")
    it, salt, iv, ct = int(m.group(1)), _b64(m.group(2)), _b64(m.group(3)), _b64(m.group(4))
    if it < MIN_ITER:
        raise ValueError(f"iter {it} < {MIN_ITER}")
    if len(salt) != SALT_BYTES or len(iv) != IV_BYTES:
        raise ValueError("salt must be 16 bytes and iv 12 bytes")
    if not TAG_BYTES < len(ct) <= TAG_BYTES + MAX_CHECK_PLAIN:
        raise ValueError("check ciphertext has the wrong length")
    return {"iter": it, "salt": salt, "iv": iv, "ct": ct, "salt_b64": m.group(2)}


def parse_enc(txt: str) -> tuple[str, bytes, bytes]:
    """Parse catalog.js / NNN.js; raise ValueError unless it has exactly the allowed shape."""
    m = ENC_RE.fullmatch(txt)
    if not m:
        raise ValueError('not exactly TNSX.onEnc("catalog"|"lc-NNN",{iv,ct})')
    name, iv, ct = m.group(1), _b64(m.group(2)), _b64(m.group(3))
    if len(iv) != IV_BYTES:
        raise ValueError("iv must be 12 bytes")
    n = len(ct) - TAG_BYTES
    if n < PAD_BYTES or n % PAD_BYTES:
        raise ValueError(f"ciphertext is not padded to a multiple of {PAD_BYTES} bytes")
    if not _looks_random(ct):
        raise ValueError("ciphertext looks like text, not AES-GCM output")
    return name, iv, ct


def check_enc_dir(root: Path) -> list[str]:
    """Errors for docs/data/edp2/: only the encrypted shapes, one file per lightcurve shard."""
    d = root / "data" / ENC_DIR
    if not d.exists():
        return []
    errs = []
    if not d.is_dir():
        return [f"data/{ENC_DIR}: must be a directory"]
    shards = set()
    for f in sorted(d.iterdir()):
        rel = f"data/{ENC_DIR}/{f.name}"
        if not f.is_file():
            errs.append(f"{rel}: only files are allowed in data/{ENC_DIR}/")
            continue
        txt = f.read_text(errors="replace")
        try:
            if f.name == "keyinfo.js":
                parse_keyinfo(txt)
            elif f.name == "catalog.js" or SHARD_FILE.fullmatch(f.name):
                name = parse_enc(txt)[0]
                want = "catalog" if f.name == "catalog.js" else "lc-" + f.name[:3]
                if name != want:
                    raise ValueError(f"blob name {name!r} does not match the file name (want {want!r})")
                if f.name != "catalog.js":
                    shards.add(f.name)
            else:
                raise ValueError(f"unexpected file; data/{ENC_DIR}/ may hold only keyinfo.js, catalog.js and NNN.js")
        except ValueError as e:
            errs.append(f"{rel}: {e}")
    for need in ("keyinfo.js", "catalog.js"):
        if not (d / need).is_file():
            errs.append(f"data/{ENC_DIR}/{need}: missing")
    lc = root / "data" / "lc"
    public = {f.name for f in lc.iterdir() if SHARD_FILE.fullmatch(f.name)} if lc.is_dir() else set()
    if shards != public:
        errs.append(f"data/{ENC_DIR}/: shard files must match data/lc/ one to one "
                    f"({len(shards - public)} extra, {len(public - shards)} missing)")
    return errs


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
        if rel.as_posix() == "data/catalog.js":
            j = json.loads(txt[txt.index("(") + 1: txt.rindex(")")])
            if j["meta"].get("mode") != "public":
                errs.append(f"{rel}: meta.mode is {j['meta'].get('mode')!r}, not 'public'")
            bad = [c for c in j["cols"] if PRIVATE_COL.search(c)]
            if bad:
                errs.append(f"{rel}: private columns {bad}")
            bad = [s for s in j["meta"].get("sources", {}) if s.startswith("edp2")]
            if bad:
                errs.append(f"{rel}: private sources {bad}")
    errs += check_enc_dir(root)
    for e in errs:
        print(f"check_public: {e}", file=sys.stderr)
    if not errs:
        print(f"check_public: OK ({root})")
    return 1 if errs else 0


if __name__ == "__main__":
    sys.exit(main(Path(sys.argv[1] if len(sys.argv) > 1 else "docs")))
