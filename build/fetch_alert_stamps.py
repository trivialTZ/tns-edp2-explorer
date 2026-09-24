#!/usr/bin/env python3
"""Public Rubin alert cutouts (science, template, difference) for each object, via Fink LSST.

Rubin alert packets are world-public and carry 30x30-pixel cutouts (0.2"/px, 6" on a
side). For every catalogue object with alert DiaSources (cache/raw/fink_lsst/sources,
written by fetch_alerts.py) we take its highest-S/N positive detection (else, for objects
that only have negative difference detections, the strongest negative one; `neg` = 1)
and fetch that alert's three cutouts in one call:

  POST https://api.lsst.fink-portal.org/api/v1/cutouts  {diaSourceId, kind: "All", output-format: "array"}
    -> cache/raw/fink_lsst/cutouts/<diaSourceId>.json

Each object's cutouts are rendered to one WebP strip (science | template | difference,
120 px each, pixels shown nearest-neighbour) at cache/alert_stamps_webp/<name>.webp
(assemble.py copies them to data/stamps/), and the choice is recorded in
cache/norm/alert_stamps.parquet:

  name, alert_id, dia_source_id, mjd, band, snr, neg

Usage:
  python build/fetch_alert_stamps.py              # fetch missing, render all
  python build/fetch_alert_stamps.py --render-only
"""
from __future__ import annotations

import argparse
import json
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from io import BytesIO
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402
import fetch_alerts as FA  # noqa: E402

RAW = FA.RAW / "cutouts"
OUT = common.NORM / "alert_stamps.parquet"
WEBP = common.CACHE / "alert_stamps_webp"
TILE = 120
KINDS = ("b:cutoutScience", "b:cutoutTemplate", "b:cutoutDifference")


def best_sources() -> pd.DataFrame:
    """Highest-S/N positive alert detection per catalogue object (else the strongest negative one)."""
    ids = pd.read_parquet(FA.OUT_IDS)
    rows = []
    for name, aid in zip(ids["name"], ids["alert_id"].astype(str)):
        p = FA.RAW_SRC / f"{aid}.json"
        if not p.exists():
            continue
        for s in json.loads(p.read_text()):
            snr, flux = s.get("r:snr"), s.get("r:psfFlux")
            if snr is None or flux is None or not np.isfinite(flux):
                continue
            neg = int(bool(s.get("r:isNegative")) or flux < 0)
            rows.append({"name": name, "alert_id": aid, "dia_source_id": FA.id_str(s["r:diaSourceId"]),
                         "mjd": float(s["r:midpointMjdTai"]), "band": str(s.get("r:band") or ""),
                         "snr": abs(float(snr)), "neg": neg})
    df = pd.DataFrame(rows, columns=["name", "alert_id", "dia_source_id", "mjd", "band", "snr", "neg"])
    df = df.sort_values(["name", "neg", "snr"], ascending=[True, True, False])
    return df.drop_duplicates("name").reset_index(drop=True)


def fetch(sid: str) -> str:
    path = RAW / f"{sid}.json"
    if path.exists():
        return "cached"
    last = None
    for attempt in range(FA.MAX_TRIES):
        try:
            r = FA.session().post(f"{FA.API}/cutouts", json={"diaSourceId": sid, "kind": "All",
                                                            "output-format": "array"}, timeout=FA.TIMEOUT)
            if r.status_code == 200:
                d = r.json()
                if isinstance(d, dict) and all(k in d for k in KINDS):
                    FA.write_atomic(path, r.text)
                    return "fetched"
                last = f"unexpected payload {str(d)[:80]}"
            else:
                last = f"HTTP {r.status_code}"
        except Exception as e:  # noqa: BLE001
            last = type(e).__name__
        import time  # noqa: PLC0415
        time.sleep(min(2 ** attempt, 60))
    raise RuntimeError(f"cutouts {sid}: {last}")


def _scale(a: np.ndarray, diff: bool) -> np.ndarray:
    """8-bit greyscale. Science/template: zscale-like percentile stretch; difference: symmetric."""
    f = np.isfinite(a)
    if not f.any():
        return np.zeros(a.shape, np.uint8)
    v = a[f]
    if diff:
        m = np.nanpercentile(np.abs(v), 99.5) or 1.0
        lo, hi = -m, m
    else:
        lo, hi = np.nanpercentile(v, [1.0, 99.7])
        if hi <= lo:
            hi = lo + 1.0
    x = np.clip((np.where(f, a, lo) - lo) / (hi - lo), 0, 1)
    if not diff:
        x = np.arcsinh(6 * x) / np.arcsinh(6)
    return (x * 255).astype(np.uint8)


def render(sid: str) -> bytes:
    from PIL import Image  # noqa: PLC0415
    d = json.loads((RAW / f"{sid}.json").read_text())
    tiles = []
    for k in KINDS:
        a = np.array(d[k], dtype=float)
        img = Image.fromarray(_scale(a, k.endswith("Difference")), mode="L")
        img = img.transpose(Image.FLIP_TOP_BOTTOM)          # FITS convention: row 0 at the bottom (detector orientation, not rotated to north)
        tiles.append(img.resize((TILE, TILE), Image.NEAREST))
    strip = Image.new("L", (TILE * 3, TILE))
    for i, t in enumerate(tiles):
        strip.paste(t, (i * TILE, 0))
    buf = BytesIO()
    strip.save(buf, format="WEBP", quality=82, method=6)
    return buf.getvalue()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--render-only", action="store_true")
    a = ap.parse_args()
    best = best_sources()
    names = set(common.load_targets()["name"].astype(str))
    best = best[best["name"].isin(names)]
    if not a.render_only:
        RAW.mkdir(parents=True, exist_ok=True)
        todo = [s for s in best["dia_source_id"] if not (RAW / f"{s}.json").exists()]
        FA.log(f"{len(best)} objects with an alert detection ({int(best['neg'].sum())} negative only); "
               f"fetching {len(todo)} cutout sets")
        with ThreadPoolExecutor(4) as ex:
            futs = {ex.submit(fetch, s): s for s in todo}
            for k, f in enumerate(as_completed(futs), 1):
                try:
                    f.result()
                except Exception as e:  # noqa: BLE001
                    FA.log(str(e))
                if k % 100 == 0:
                    FA.log(f"  {k}/{len(todo)}")
    best = best[[(RAW / f"{s}.json").exists() for s in best["dia_source_id"]]].reset_index(drop=True)
    WEBP.mkdir(parents=True, exist_ok=True)
    total = 0
    for name, sid in zip(best["name"], best["dia_source_id"]):
        b = render(sid)
        (WEBP / f"{name}.webp").write_bytes(b)
        total += len(b)
    best.to_parquet(OUT, index=False)
    FA.log(f"{len(best)} alert stamp strips ({total / 1e6:.1f} MB) -> {WEBP}")


if __name__ == "__main__":
    main()
