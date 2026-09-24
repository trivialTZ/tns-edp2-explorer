#!/usr/bin/env python3
"""Private EDP2 layer: is each catalogue object inside the Rubin DP2 deep-coadd footprint?

The site's 9,330 objects are "within 2.1 deg of a dp2.Visit centre", which is wider than
the area DP2 actually processed into deep coadds. This script downloads the coadd patch
footprints and, per object, whether a patch contains it and in which bands it has a coadd.

Inputs (TAP, sync with TOP; token from load_rsp_token(), never printed):
  dp2.CoaddPatches                      one row per patch with a coadd: tract, patch, s_region
  ivoa.ObsCore (LSST.DP2 deep_coadd)    one row per patch and band

Outputs (PROPRIETARY, under common.PRIVATE only):
  PRIVATE/cache/edp2_coadd_patches.parquet   lsst_tract, lsst_patch, s_ra, s_dec, s_region
  PRIVATE/cache/edp2_coadd_bands.parquet     lsst_tract, lsst_patch, lsst_band
  PRIVATE/norm/edp2_coadd.parquet            name, edp2_coadd, edp2_coadd_bands, edp2_coadd_patch

Usage:
  python build/fetch_edp2_coadd.py                  download (if not cached) and match
  python build/fetch_edp2_coadd.py --refetch        download again
"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.spatial import cKDTree

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common as C  # noqa: E402

SKILL_DIR = Path.home() / ".claude/skills/rubin-edp2"
PATCHES = C.PRIVATE_CACHE / "edp2_coadd_patches.parquet"
BANDS = C.PRIVATE_CACHE / "edp2_coadd_bands.parquet"
OUT = C.PRIVATE_NORM / "edp2_coadd.parquet"
TOP = 200_000
BAND_ORDER = "ugrizy"


def _guard_private() -> None:
    if C.PRIVATE.resolve().is_relative_to(C.REPO.resolve()):
        sys.exit(f"refusing: PRIVATE ({C.PRIVATE}) is inside the public repo")


def _query(adql: str, token: str, tap_sync) -> pd.DataFrame:
    last = None
    for attempt in range(4):
        try:
            df = pd.DataFrame(tap_sync(adql, token, timeout=120).as_dicts())
            if len(df) >= TOP:
                raise SystemExit(f"a query hit TOP {TOP}; use smaller chunks: {adql[:120]}")
            return df
        except SystemExit:
            raise
        except Exception as e:  # noqa: BLE001 (transient Qserv/HTTP errors)
            last = e
            time.sleep(5 * (attempt + 1))
    raise RuntimeError(f"TAP query failed: {str(last)[:200]}")


def download() -> None:
    sys.path.insert(0, str(SKILL_DIR.resolve()))
    from rsp_token import load_rsp_token  # noqa: PLC0415
    from tap import tap_sync  # noqa: PLC0415
    token = load_rsp_token()  # never printed
    parts = []
    for ra0 in range(0, 360, 30):     # the densest 30-deg slice holds ~37k patches
        parts.append(_query(f"SELECT TOP {TOP} lsst_tract, lsst_patch, s_ra, s_dec, s_region FROM dp2.CoaddPatches "
                            f"WHERE s_ra >= {ra0} AND s_ra < {ra0 + 30}", token, tap_sync))
        print(f"  patches RA {ra0:3d}-{ra0 + 30:3d}: {len(parts[-1]):,}", flush=True)
    p = pd.concat(parts, ignore_index=True)
    p.to_parquet(PATCHES, index=False)
    per_tract = p.groupby("lsst_tract").size()
    parts, chunk, n = [], [], 0
    for t, k in per_tract.items():        # ~6 bands per patch: keep each chunk well under TOP
        chunk.append(t)
        n += int(k)
        if n > 20_000 or t == per_tract.index[-1]:
            parts.append(_query(f"SELECT TOP {TOP} lsst_tract, lsst_patch, lsst_band FROM ivoa.ObsCore "
                                "WHERE obs_collection = 'LSST.DP2' AND dataproduct_subtype = 'lsst.deep_coadd' "
                                f"AND lsst_tract >= {chunk[0]} AND lsst_tract <= {chunk[-1]}", token, tap_sync))
            print(f"  bands tracts {chunk[0]}-{chunk[-1]}: {len(parts[-1]):,}", flush=True)
            chunk, n = [], 0
    b = pd.concat(parts, ignore_index=True)
    b[b["lsst_tract"].isin(per_tract.index)].to_parquet(BANDS, index=False)
    print(f"downloaded {len(p):,} patches in {p['lsst_tract'].nunique():,} tracts, {len(b):,} patch-band coadds")


def _unit(ra, dec) -> np.ndarray:
    ra, dec = np.radians(np.asarray(ra, float)), np.radians(np.asarray(dec, float))
    return np.stack([np.cos(dec) * np.cos(ra), np.cos(dec) * np.sin(ra), np.sin(dec)], -1)


def _gnomonic(ra, dec, ra0, dec0):
    ra, dec, ra0, dec0 = (np.radians(x) for x in (ra, dec, ra0, dec0))
    c = np.sin(dec0) * np.sin(dec) + np.cos(dec0) * np.cos(dec) * np.cos(ra - ra0)
    return (np.cos(dec) * np.sin(ra - ra0) / c,
            (np.cos(dec0) * np.sin(dec) - np.sin(dec0) * np.cos(dec) * np.cos(ra - ra0)) / c)


def contains(p: pd.DataFrame, ra: np.ndarray, dec: np.ndarray) -> list[list[int]]:
    """Row positions of the patches whose 4-vertex s_region contains each point."""
    verts = np.array([[float(x) for x in s.split()[2:]] for s in p["s_region"]]).reshape(-1, 4, 2)
    tree = cKDTree(_unit(p["s_ra"], p["s_dec"]))
    cand = tree.query_ball_point(_unit(ra, dec), 2 * np.sin(np.radians(0.3) / 2))   # patches are ~0.19 deg
    out = []
    for i, ks in enumerate(cand):
        hit = []
        for k in ks:
            ra0, dec0 = p["s_ra"].iat[k], p["s_dec"].iat[k]
            px, py = _gnomonic(ra[i], dec[i], ra0, dec0)
            vx, vy = _gnomonic(verts[k, :, 0], verts[k, :, 1], ra0, dec0)
            s = [(vx[(a + 1) % 4] - vx[a]) * (py - vy[a]) - (vy[(a + 1) % 4] - vy[a]) * (px - vx[a]) for a in range(4)]
            if all(x >= 0 for x in s) or all(x <= 0 for x in s):
                hit.append(k)
        out.append(hit)
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--refetch", action="store_true", help="download the footprints again")
    a = ap.parse_args()
    _guard_private()
    C.PRIVATE_CACHE.mkdir(parents=True, exist_ok=True)
    if a.refetch or not (PATCHES.exists() and BANDS.exists()):
        download()
    p = pd.read_parquet(PATCHES)
    b = pd.read_parquet(BANDS)
    bands = b.groupby(["lsst_tract", "lsst_patch"])["lsst_band"].agg(set)
    t = C.load_targets()
    hits = contains(p, t["ra"].to_numpy(float), t["dec"].to_numpy(float))
    keys = [[(int(p["lsst_tract"].iat[k]), int(p["lsst_patch"].iat[k])) for k in h] for h in hits]
    out = pd.DataFrame({
        "name": t["name"].astype(str),
        "edp2_coadd": [bool(k) for k in keys],
        "edp2_coadd_bands": ["".join(x for x in BAND_ORDER if any(x in bands.get(kk, ()) for kk in k)) or None for k in keys],
        "edp2_coadd_patch": [f"{k[0][0]}.{k[0][1]}" if k else None for k in keys],
    })
    C.PRIVATE_NORM.mkdir(parents=True, exist_ok=True)
    out.to_parquet(OUT, index=False)
    inside = out["edp2_coadd"]
    print(f"{int(inside.sum()):,} of {len(out):,} catalogue objects are inside the DP2 deep-coadd footprint "
          f"({len(p):,} patches); matched to a DiaObject: "
          f"{int((inside & t['edp2_matched'].to_numpy()).sum()):,} of {int(t['edp2_matched'].sum()):,} -> {OUT}")


if __name__ == "__main__":
    main()
