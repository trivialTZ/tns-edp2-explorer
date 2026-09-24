#!/usr/bin/env python3
"""Download and normalize the public TNS spectra of the catalogue objects.

The spectra list comes from the cached TNS get/object replies (fetch_tns_phot.py,
spectra=1). Each public spectrum's ASCII file is downloaded once with the bot marker
(TNS asks bots to POST the api_key to /system/files/...) into

  cache/raw/tns_spectra/<file name>

and every file is parsed into cache/norm/tns_spec.parquet, one row per spectrum:

  name, mjd, tel, inst, grp, url, w0, dw, f (list), n_native, flux_unit

Wavelengths are converted to Angstrom and put on a uniform grid (w0 + k*dw, at most
MAX_POINTS bins, never finer than the native sampling); flux is divided by its median so
the site shows shapes, not calibrated fluxes. The original file stays linked.

Credentials come from common.read_env(); nothing here prints them.

Usage:
  python build/fetch_tns_spectra.py                  # download missing files, then normalize
  python build/fetch_tns_spectra.py --normalize-only
"""
from __future__ import annotations

import argparse
import json
import math
import re
import sys
import time
from pathlib import Path
from urllib.parse import unquote, urlparse

import numpy as np
import pandas as pd
import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402
import fetch_tns_phot as T  # noqa: E402

RAW = common.CACHE / "raw" / "tns_spectra"
FAIL = RAW / "_failures.json"
OUT = common.NORM / "tns_spec.parquet"
MAX_POINTS = 1200
NUM = re.compile(r"^[-+]?(\d+\.?\d*|\.\d+)([eEdD][-+]?\d+)?$")


def spectra_list(names: set[str]) -> list[dict]:
    out = []
    for f in sorted(T.RAW_DIR.glob("*.json")):
        name = f.stem
        if name not in names:
            continue
        data = json.loads(f.read_text())
        spec = data.get("spectra") or []
        if isinstance(spec, dict):
            spec = list(spec.values())
        for s in spec:
            if not isinstance(s, dict) or str(s.get("public")) != "1" or not s.get("asciifile"):
                continue
            jd = T._num(s.get("jd"))
            tel, inst = T._name(s.get("telescope")), T._name(s.get("instrument"))
            grp = T._name(s.get("source_group")) or str(s.get("source_group_name") or "").strip()
            out.append({"name": name, "mjd": jd - T.JD_MJD if math.isfinite(jd) else math.nan,
                        "tel": "" if tel.lower() == "object" else tel, "inst": inst,
                        "grp": "" if grp.lower() in ("none", "other", "null") else grp,
                        "url": s["asciifile"]})
    return out


def local_path(url: str) -> Path:
    p = urlparse(url)
    if p.netloc != "www.wis-tns.org" or not p.path.startswith("/system/files/"):
        raise ValueError(f"unexpected spectrum URL host/path: {p.netloc}{p.path[:40]}")
    return RAW / re.sub(r"[^A-Za-z0-9._+-]", "_", unquote(Path(p.path).name))


def download(items: list[dict]) -> None:
    RAW.mkdir(parents=True, exist_ok=True)
    todo = [s for s in items if not local_path(s["url"]).exists()]
    fails = json.loads(FAIL.read_text()) if FAIL.exists() else {}
    if not todo:
        T.log(f"all {len(items)} spectrum files cached")
        return
    tns = T.TNS(common.read_env())
    T.log(f"downloading {len(todo)} of {len(items)} spectrum files")
    for k, s in enumerate(todo, 1):
        dst = local_path(s["url"])
        for attempt in range(4):
            tns._obey()
            try:
                r = tns.session.post(s["url"], data={"api_key": tns.api_key}, timeout=tns.timeout_s)
            except requests.RequestException as e:
                T.log(f"{dst.name}: {type(e).__name__}; retrying")
                time.sleep(10 * (attempt + 1))
                continue
            tns.n_requests += 1
            tns._note_headers(r)
            if r.status_code == 429:
                wait = tns._reset_seconds(r) + 1.0
                tns.wait_until = time.monotonic() + wait
                T.log(f"HTTP 429; waiting {wait:.0f}s")
                continue
            if r.status_code == 200 and r.content and not r.content.lstrip()[:15].lower().startswith((b"<!doctype", b"<html")):
                dst.write_bytes(r.content)
                fails.pop(s["url"], None)
            else:
                fails[s["url"]] = f"HTTP {r.status_code}"
                T.log(f"{dst.name}: HTTP {r.status_code}")
            break
        if k % 25 == 0 or k == len(todo):
            T.log(f"  {k}/{len(todo)} (remaining quota {tns.last_remaining})")
    FAIL.write_text(json.dumps(fails, indent=1))


def parse(path: Path) -> tuple[np.ndarray, np.ndarray]:
    """First two numeric columns of every data row (whitespace- or comma-separated)."""
    w, f = [], []
    for line in path.read_text(errors="replace").splitlines():
        line = line.strip()
        if not line or line[0] in "#!;%/" or line[0].isalpha():
            continue
        tok = [t for t in re.split(r"[\s,;]+", line) if t]
        if len(tok) < 2 or not (NUM.match(tok[0]) and NUM.match(tok[1])):
            continue
        w.append(float(tok[0].replace("D", "e").replace("d", "e")))
        f.append(float(tok[1].replace("D", "e").replace("d", "e")))
    return np.asarray(w, float), np.asarray(f, float)


def to_angstrom(w: np.ndarray) -> np.ndarray | None:
    med = float(np.median(w))
    if 1500 <= med <= 60000:     # Angstrom, optical to JWST NIRSpec
        return w
    if 150 <= med < 1500:
        return w * 10.0          # nm
    if 0.15 <= med < 3:
        return w * 1e4           # micron
    return None


def rebin(w: np.ndarray, f: np.ndarray) -> tuple[float, float, list]:
    step = max(float(np.median(np.diff(w))), (w[-1] - w[0]) / MAX_POINTS)
    step = float(f"{step:.3g}")
    w0 = math.floor(w[0] / step) * step
    k = np.floor((w - w0) / step).astype(int)
    n = int(k.max()) + 1
    s, c = np.bincount(k, f, n), np.bincount(k, None, n)
    with np.errstate(invalid="ignore", divide="ignore"):
        v = s / c
    return round(w0 + step / 2, 3), step, [None if not math.isfinite(x) else float(f"{x:.4g}") for x in v]


def normalize(items: list[dict]) -> pd.DataFrame:
    rows, bad = [], []
    for s in items:
        p = local_path(s["url"])
        if not p.exists():
            continue
        w, f = parse(p)
        ok = np.isfinite(w) & np.isfinite(f)
        w, f = w[ok], f[ok]
        if len(w) < 20:
            bad.append((p.name, "fewer than 20 numeric rows"))
            continue
        if to_angstrom(w) is None and to_angstrom(f) is not None and np.all(np.diff(f) > 0):
            w, f = f, w          # some files list flux first, then wavelength
        o = np.argsort(w, kind="stable")
        w, f = w[o], f[o]
        wa = to_angstrom(w)
        if wa is None:
            bad.append((p.name, f"wavelength median {np.median(w):.4g} not A/nm/micron"))
            continue
        mid = f[(wa > np.quantile(wa, 0.25)) & (wa < np.quantile(wa, 0.75))]
        scale = float(np.median(mid)) if len(mid) else float(np.median(f))
        if not (math.isfinite(scale) and scale > 0):
            scale = float(np.median(np.abs(f))) or 1.0
        w0, dw, fb = rebin(wa, f / scale)
        rows.append({**s, "w0": w0, "dw": dw, "f": fb, "n_native": int(len(w))})
    for name, why in bad:
        T.log(f"skipped {name}: {why}")
    df = pd.DataFrame(rows, columns=["name", "mjd", "tel", "inst", "grp", "url", "w0", "dw", "f", "n_native"])
    return df.sort_values(["name", "mjd"]).reset_index(drop=True)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--normalize-only", action="store_true")
    a = ap.parse_args()
    names = set(common.load_targets()["name"].astype(str))
    items = spectra_list(names)
    if not a.normalize_only:
        download(items)
    df = normalize(items)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    df.to_parquet(OUT, index=False)
    T.log(f"{len(df)} of {len(items)} public spectra normalized for {df['name'].nunique()} objects -> {OUT}")


if __name__ == "__main__":
    main()
