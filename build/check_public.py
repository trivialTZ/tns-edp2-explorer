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

Bulk downloads: data/download/ may hold only catalog.csv, the gzipped CSVs listed in
DOWNLOAD_FILES and MANIFEST.json; the gzipped files are decompressed and scanned like any
other data file. No other .csv anywhere.

Image stamps: data/stamps/ may hold only <name>.webp Rubin alert cutouts of objects whose
catalogue row has a `stamp`. DP2 deep-coadd stamps (data/dp2stamps/) exist only in the
private site, never under docs/.

Host galaxies (diagnostic): the public catalogue's "hosts" table may hold only objects
this site shows as TNS-typed SN Ia, with host_* columns and no list-membership or DP2
field; data/hosts/ may hold only <name>.webp figures of those rows. Host rows of the
DP2-derived good-EDP2 list exist only inside the encrypted layer.
"""
from __future__ import annotations

import base64
import binascii
import gzip
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

# ---- host galaxies (data/catalog.js "hosts" table, data/hosts/<name>.webp)
HOST_COL = re.compile(r"host_[a-z0-9_]+")
HOST_BAD_COL = re.compile(r"list|good|edp2|diaobject|sep_arcsec", re.I)
HOST_BAD_VALUE = re.compile(r"edp2|dp2|diaobject", re.I)
HOST_IMG = re.compile(r"\d{4}[0-9A-Za-z]+\.webp")    # TNS names: 2025abc, 2026A, 20250227A
MAX_HOST_IMG = 150_000

# ---- bulk downloads and image stamps
DOWNLOAD_FILES = {"catalog.csv", "photometry.csv.gz", "classifiers.csv.gz", "MANIFEST.json"}
STAMP_IMG = HOST_IMG
MAX_STAMP_IMG = 40_000


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


def check_hosts(root: Path, cat: dict | None) -> list[str]:
    """Public host rows only for objects typed SN Ia here; images only for those rows."""
    errs, hosts = [], (cat or {}).get("hosts")
    shown = set()
    if hosts is not None:
        cols, rows = hosts.get("cols", []), hosts.get("rows", [])
        if not cols or cols[0] != "name" or not all(HOST_COL.fullmatch(c) for c in cols[1:]):
            errs.append(f"data/catalog.js: host table columns must be name + host_*: {cols}")
        bad = [c for c in cols if HOST_BAD_COL.search(c)]
        if bad:
            errs.append(f"data/catalog.js: forbidden host columns {bad}")
        cc = cat["cols"]
        typ = {r[cc.index("name")]: r[cc.index("type")] for r in cat["rows"]} if "type" in cc else {}
        not_ia = [r[0] for r in rows if not str(typ.get(r[0]) or "").startswith("SN Ia")]
        if not_ia:
            errs.append(f"data/catalog.js: {len(not_ia)} public host rows are not TNS-typed SN Ia here "
                        f"(only SN Ia-list hosts may be public), e.g. {not_ia[:3]}")
        leaky = [r[0] for r in rows if any(isinstance(x, str) and HOST_BAD_VALUE.search(x) for x in r[1:])]
        if leaky:
            errs.append(f"data/catalog.js: host values mention DP2/EDP2 for {leaky[:3]}")
        if "host_img" in cols:
            k = cols.index("host_img")
            shown = {r[0] for r in rows if r[k] == "file"}
            if any(r[k] not in (None, "file") for r in rows):
                errs.append('data/catalog.js: public host_img may only be "file" or null')
    d = root / "data" / "hosts"
    if d.exists():
        files = set()
        for f in sorted(d.iterdir()):
            rel = f"data/hosts/{f.name}"
            if not f.is_file() or not HOST_IMG.fullmatch(f.name):
                errs.append(f"{rel}: data/hosts/ may hold only <TNS name>.webp files")
                continue
            b = f.read_bytes()
            if b[:4] != b"RIFF" or b[8:12] != b"WEBP":
                errs.append(f"{rel}: not a WebP image")
            if len(b) > MAX_HOST_IMG:
                errs.append(f"{rel}: larger than {MAX_HOST_IMG // 1000} KB")
            files.add(f.name[:-5])
        if files - shown:
            errs.append(f"data/hosts/: {len(files - shown)} figures without a public host row, "
                        f"e.g. {sorted(files - shown)[:3]}")
        if shown - files:
            errs.append(f"data/hosts/: {len(shown - files)} public host rows point at a missing figure")
    elif shown:
        errs.append("data/catalog.js: host_img says file but data/hosts/ is missing")
    return errs


def check_stamps(root: Path, cat: dict | None) -> list[str]:
    """data/stamps/: alert-cutout strips of catalogue objects with a `stamp`; no DP2 stamps at all."""
    errs = []
    if (root / "data" / "dp2stamps").exists():
        errs.append("data/dp2stamps/: DP2 deep-coadd stamps belong to the private site only")
    d = root / "data" / "stamps"
    if not d.exists():
        return errs
    want = set()
    if cat and "stamp" in cat.get("cols", []):
        js, jn = cat["cols"].index("stamp"), cat["cols"].index("name")
        want = {str(r[jn]) for r in cat["rows"] if r[js]}
    have = set()
    for f in d.iterdir():
        rel = f"data/stamps/{f.name}"
        if not f.is_file() or not STAMP_IMG.fullmatch(f.name):
            errs.append(f"{rel}: data/stamps/ may hold only <TNS name>.webp files")
            continue
        if f.stat().st_size > MAX_STAMP_IMG:
            errs.append(f"{rel}: larger than {MAX_STAMP_IMG} bytes")
        if f.read_bytes()[:4] != b"RIFF":
            errs.append(f"{rel}: not a WebP file")
        have.add(f.stem)
    if have != want:
        errs.append(f"data/stamps/: {len(have - want)} images without a catalogue `stamp`, {len(want - have)} missing")
    return errs


def main(root: Path) -> int:
    errs, cat = [], None
    for f in root.rglob("*"):
        if not f.is_file():
            continue
        rel = f.relative_to(root)
        if f.stat().st_size > MAX_BYTES:
            errs.append(f"{rel}: larger than {MAX_BYTES / 1e6:.0f} MB")
        dl = rel.parts[:2] == ("data", "download")
        if dl and (len(rel.parts) != 3 or rel.name not in DOWNLOAD_FILES):
            errs.append(f"{rel}: data/download/ may hold only {sorted(DOWNLOAD_FILES)}")
        if f.suffix in {".parquet", ".csv", ".fits", ".npy", ".npz", ".pkl"} and not (dl and rel.name == "catalog.csv"):
            errs.append(f"{rel}: raw data file type not allowed in the public site")
        if rel.parts[0] != "data":
            continue
        if f.suffix == ".gz":
            try:
                txt = gzip.decompress(f.read_bytes()).decode("utf-8", errors="ignore")
            except (OSError, EOFError) as e:
                errs.append(f"{rel}: unreadable gzip ({e})")
                continue
        else:
            txt = f.read_text(errors="ignore")
        if dl and f.name.endswith((".csv", ".csv.gz")):
            bad = [c for c in txt.split("\n", 1)[0].split(",") if PRIVATE_COL.search(c)]
            if bad:
                errs.append(f"{rel}: private columns {bad}")
        if PRIVATE_SOURCE.search(txt):
            errs.append(f"{rel}: contains a private EDP2 source key")
        if DP2_ID.search(txt):
            errs.append(f"{rel}: contains a DP2-catalog-like diaObjectId ({DP2_ID.search(txt).group()[:4]}...)")
        if rel.as_posix() == "data/catalog.js":
            j = cat = json.loads(txt[txt.index("(") + 1: txt.rindex(")")])
            if j["meta"].get("mode") != "public":
                errs.append(f"{rel}: meta.mode is {j['meta'].get('mode')!r}, not 'public'")
            bad = [c for c in j["cols"] if PRIVATE_COL.search(c)]
            if bad:
                errs.append(f"{rel}: private columns {bad}")
            bad = [s for s in j["meta"].get("sources", {}) if s.startswith("edp2")]
            if bad:
                errs.append(f"{rel}: private sources {bad}")
    errs += check_enc_dir(root)
    errs += check_hosts(root, cat)
    errs += check_stamps(root, cat)
    for e in errs:
        print(f"check_public: {e}", file=sys.stderr)
    if not errs:
        print(f"check_public: OK ({root})")
    return 1 if errs else 0


if __name__ == "__main__":
    sys.exit(main(Path(sys.argv[1] if len(sys.argv) > 1 else "docs")))
