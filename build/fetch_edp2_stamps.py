#!/usr/bin/env python3
"""Private EDP2 layer: Rubin DP2 deep-coadd image stamps around each object.

DP2 serves deep coadds only (no visit or difference images), so a stamp is the
static coadd at the TNS position: 40" on a side, bands g, r, i where they exist
(else the nearest available). Pixels are Rubin DP2 data (Rubin Data Policy RDO-13):
they stay under common.PRIVATE, and reach the site only inside the encrypted
team layer (assemble.py renders them).

Inputs:
  PRIVATE/norm/edp2_coadd.parquet      object -> tract.patch (build/fetch_edp2_coadd.py)
  ivoa.ObsCore (LSST.DP2 deep_coadd)   (tract, patch, band) -> obs_publisher_did
  SODA cutout service                  https://data.lsst.cloud/api/cutout/sync (~35 calls/min)

Outputs (PRIVATE only):
  PRIVATE/cache/edp2_coadd_dids.parquet        lsst_tract, lsst_patch, lsst_band, obs_publisher_did
  PRIVATE/cache/edp2_stamps/<name>_<band>.npz  float32 pixels (NaN kept) of the image plane
  PRIVATE/cache/edp2_stamps/_failures.json

Token from load_rsp_token(); never printed. Cutout URLs are not logged.

Usage:
  python build/fetch_edp2_stamps.py                   DP2-matched objects (typed first)
  python build/fetch_edp2_stamps.py --scope coadd     every object inside the coadd footprint
  python build/fetch_edp2_stamps.py --limit 20
"""
from __future__ import annotations

import argparse
import json
import sys
import threading
import time
import urllib.parse
from concurrent.futures import ThreadPoolExecutor, as_completed
from email.utils import parsedate_to_datetime
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path

import numpy as np
import pandas as pd
import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common as C  # noqa: E402

SKILL_DIR = Path.home() / ".claude/skills/rubin-edp2"
CUTOUT_URL = "https://data.lsst.cloud/api/cutout/sync"
DIDS = C.PRIVATE_CACHE / "edp2_coadd_dids.parquet"
STAMPS = C.PRIVATE_CACHE / "edp2_stamps"
FAIL = STAMPS / "_failures.json"
COADD = C.PRIVATE_NORM / "edp2_coadd.parquet"
RADIUS_AS = 20.0
BAND_PREF = ["g", "r", "i", "z", "y", "u"]    # take the first three available
PER_MIN = 32                                   # the service allows ~35 cutouts/min
WORKERS = 2

_lock = threading.Lock()
_next_slot = [0.0]


def log(msg: str) -> None:
    with _lock:
        print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


def _guard_private() -> None:
    if C.PRIVATE.resolve().is_relative_to(C.REPO.resolve()):
        sys.exit(f"refusing: PRIVATE ({C.PRIVATE}) is inside the public repo")


def _tap():
    sys.path.insert(0, str(SKILL_DIR.resolve()))
    from rsp_token import load_rsp_token  # noqa: PLC0415
    from tap import tap_sync  # noqa: PLC0415
    return load_rsp_token(), tap_sync


def fetch_dids(pairs: pd.DataFrame, token: str, tap_sync) -> pd.DataFrame:
    """obs_publisher_did for every (tract, patch) in `pairs`, all bands; cached and extended."""
    have = pd.read_parquet(DIDS) if DIDS.exists() else pd.DataFrame(
        columns=["lsst_tract", "lsst_patch", "lsst_band", "obs_publisher_did"])
    key = set(zip(have["lsst_tract"].astype(int), have["lsst_patch"].astype(int)))
    need = pairs[[(int(t), int(p)) not in key for t, p in zip(pairs["lsst_tract"], pairs["lsst_patch"])]]
    tracts = sorted(set(need["lsst_tract"].astype(int)))
    parts = [have]
    for k in range(0, len(tracts), 40):
        tt = tracts[k:k + 40]
        adql = ("SELECT TOP 100000 obs_publisher_did, lsst_tract, lsst_patch, lsst_band FROM ivoa.ObsCore "
                "WHERE obs_collection = 'LSST.DP2' AND dataproduct_subtype = 'lsst.deep_coadd' "
                f"AND lsst_tract IN ({','.join(map(str, tt))})")
        for attempt in range(4):
            try:
                df = pd.DataFrame(tap_sync(adql, token, timeout=180).as_dicts())
                break
            except Exception as e:  # noqa: BLE001 (transient Qserv/HTTP errors)
                if attempt == 3:
                    raise RuntimeError(f"ObsCore query failed: {str(e)[:160]}") from None
                time.sleep(5 * (attempt + 1))
        want = set(zip(need["lsst_tract"].astype(int), need["lsst_patch"].astype(int)))
        df = df[[(int(t), int(p)) in want for t, p in zip(df["lsst_tract"], df["lsst_patch"])]]
        parts.append(df)
        log(f"  ObsCore tracts {tt[0]}..{tt[-1]}: {len(df)} patch-band coadds")
    out = pd.concat([p for p in parts if len(p)], ignore_index=True).drop_duplicates(
        ["lsst_tract", "lsst_patch", "lsst_band"])
    out.to_parquet(DIDS, index=False)
    return out


def _wait_slot() -> None:
    with _lock:
        now = time.monotonic()
        slot = max(now, _next_slot[0])
        _next_slot[0] = slot + 60.0 / PER_MIN
    time.sleep(max(0.0, slot - time.monotonic()))


def _retry_after(h: str | None) -> float:
    if not h:
        return 30.0
    try:
        return float(h)
    except ValueError:
        try:
            when = parsedate_to_datetime(h)
            when = when if when.tzinfo else when.replace(tzinfo=timezone.utc)
            return max(0.0, (when - datetime.now(timezone.utc)).total_seconds())
        except Exception:  # noqa: BLE001
            return 30.0


def image_plane(fits_bytes: bytes) -> np.ndarray | None:
    from astropy.io import fits  # noqa: PLC0415
    with fits.open(BytesIO(fits_bytes)) as hdul:
        for h in hdul:
            d = getattr(h, "data", None)
            if d is not None and getattr(d, "ndim", 0) == 2 and d.size:
                return np.asarray(d, dtype=np.float32)
    return None


def fetch_one(job: tuple, token: str) -> tuple[str, str, str | None]:
    name, band, did, ra, dec = job
    dst = STAMPS / f"{name}_{band}.npz"
    pos = f"CIRCLE {ra:.7f} {dec:.7f} {RADIUS_AS / 3600.0:.7f}"
    url = f"{CUTOUT_URL}?ID={urllib.parse.quote(did, safe='')}&POS={urllib.parse.quote(pos)}"
    err = None
    for attempt in range(6):
        _wait_slot()
        try:
            r = requests.get(url, headers={"Authorization": f"Bearer {token}"}, timeout=300)
        except requests.RequestException as e:
            err = type(e).__name__
            time.sleep(10 * (attempt + 1))
            continue
        if r.status_code == 429:
            wait = _retry_after(r.headers.get("Retry-After")) + 5 * attempt
            with _lock:
                _next_slot[0] = max(_next_slot[0], time.monotonic() + wait)
            err = "HTTP 429"
            continue
        if r.status_code != 200:
            err = f"HTTP {r.status_code}"
            if r.status_code in (500, 502, 503, 504):
                time.sleep(15 * (attempt + 1))
                continue
            break
        img = image_plane(r.content)
        if img is None:
            return name, band, "no 2D image plane"
        np.savez_compressed(dst, img=img)
        return name, band, None
    return name, band, err or "failed"


def jobs_for(scope: str, limit: int | None, token: str, tap_sync) -> list[tuple]:
    cov = pd.read_parquet(COADD)
    t = C.load_targets()[["name", "ra", "dec", "edp2_matched"]]
    df = t.merge(cov, on="name")
    df = df[df["edp2_coadd"].fillna(False).astype(bool)]
    if scope == "matched":
        df = df[df["edp2_matched"].astype(bool)]
    import assemble as A  # noqa: PLC0415 (heavy; only needed for the TNS types)
    cat = A.build_catalog("public")
    typed = set(cat.loc[cat["type"].notna(), "name"].astype(str))
    df = df.assign(_typed=~df["name"].isin(typed), _m=~df["edp2_matched"].astype(bool))
    df = df.sort_values(["_m", "_typed", "name"])
    if limit:
        df = df.head(limit)
    tp = df["edp2_coadd_patch"].str.split(".", expand=True).astype(int)
    df = df.assign(lsst_tract=tp[0].to_numpy(), lsst_patch=tp[1].to_numpy())
    dids = fetch_dids(df[["lsst_tract", "lsst_patch"]].drop_duplicates(), token, tap_sync)
    by = {(int(a), int(b), str(c)): d for a, b, c, d in dids[["lsst_tract", "lsst_patch", "lsst_band", "obs_publisher_did"]].itertuples(index=False)}
    jobs = []
    for r in df.itertuples():
        bands = [b for b in BAND_PREF if (r.lsst_tract, r.lsst_patch, b) in by][:3]
        for b in bands:
            if not (STAMPS / f"{r.name}_{b}.npz").exists():
                jobs.append((r.name, b, by[(r.lsst_tract, r.lsst_patch, b)], float(r.ra), float(r.dec)))
    log(f"{len(df):,} objects ({scope}); {len(jobs):,} cutouts to fetch")
    return jobs


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--scope", choices=["matched", "coadd"], default="matched")
    ap.add_argument("--limit", type=int, default=None)
    a = ap.parse_args()
    _guard_private()
    STAMPS.mkdir(parents=True, exist_ok=True)
    token, tap_sync = _tap()          # never printed
    jobs = jobs_for(a.scope, a.limit, token, tap_sync)
    fails = json.loads(FAIL.read_text()) if FAIL.exists() else {}
    n_ok = 0
    with ThreadPoolExecutor(WORKERS) as ex:
        futs = [ex.submit(fetch_one, j, token) for j in jobs]
        for k, f in enumerate(as_completed(futs), 1):
            name, band, err = f.result()
            if err:
                fails[f"{name}_{band}"] = err
                log(f"{name} {band}: {err}")
            else:
                fails.pop(f"{name}_{band}", None)
                n_ok += 1
            if k % 50 == 0 or k == len(futs):
                log(f"  {k}/{len(futs)} done ({n_ok} ok)")
                FAIL.write_text(json.dumps(fails, indent=1))
    FAIL.write_text(json.dumps(fails, indent=1))
    log(f"{n_ok} of {len(jobs)} cutouts saved -> {STAMPS}")


if __name__ == "__main__":
    main()
