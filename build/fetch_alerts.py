#!/usr/bin/env python3
"""Public Rubin alert-stream photometry for the TNS targets, via the Fink LSST broker.

Rubin alerts are world-public, so everything here is public data (sources
`lsst_alert`, `lsst_alert_fp`). Alert-stream diaObjectIds live in a different
ID space from the DP2/EDP2 catalogs: never join them to EDP2 by ID.

Steps (each response cached verbatim, so reruns skip finished work):
  1. cone search every target (TNS ra/dec, 2")  POST /api/v1/conesearch
       -> cache/raw/fink_lsst/cone/<name>.json
  2. per alert diaObjectId: DiaSources          POST /api/v1/sources
       -> cache/raw/fink_lsst/sources/<diaObjectId>.json
     and alert-packet forced photometry         POST /api/v1/fp
       -> cache/raw/fink_lsst/fp/<diaObjectId>.json
  3. normalize -> cache/norm/lsst_alert.parquet, cache/norm/lsst_alert_ids.parquet

IDs (~1.7e17) exceed float64 / JS Number precision. Fink returns them as bare
JSON integers; Python's json keeps them as exact ints and we turn them into
decimal strings immediately (`id_str` refuses floats). No pandas I/O touches them
before that.

Usage:
  python build/fetch_alerts.py                    # everything
  python build/fetch_alerts.py --limit 40
  python build/fetch_alerts.py --names 2025nxh,2026fbw
  python build/fetch_alerts.py --normalize-only
"""
from __future__ import annotations

import argparse
import json
import random
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402

API = "https://api.lsst.fink-portal.org/api/v1"
RADIUS_AS = common.MATCH_RADIUS_AS
MAX_WORKERS = 4
TIMEOUT = (15, 120)          # connect, read (s)
MAX_TRIES = 7
UA = "tns-edp2-explorer/1.0 (static lightcurve site; contact via GitHub)"

RAW = common.CACHE / "raw" / "fink_lsst"
RAW_CONE = RAW / "cone"
RAW_SRC = RAW / "sources"
RAW_FP = RAW / "fp"
OUT_PHOT = common.NORM / "lsst_alert.parquet"
OUT_IDS = common.NORM / "lsst_alert_ids.parquet"

# DiaSource columns requested from /sources (unknown names are ignored by Fink).
SRC_COLUMNS = ",".join([
    "r:diaObjectId", "r:diaSourceId", "r:visit", "r:detector", "r:midpointMjdTai", "r:band",
    "r:ra", "r:dec", "r:psfFlux", "r:psfFluxErr", "r:psfFlux_flag", "r:scienceFlux",
    "r:scienceFluxErr", "r:snr", "r:reliability", "r:isNegative", "r:isDipole",
    "r:extendedness", "r:pixelFlags", "r:pixelFlags_saturated", "r:pixelFlags_cr",
    "r:pixelFlags_bad", "r:pixelFlags_edge", "r:glint_trail", "r:ssObjectId",
    "r:timeProcessedMjdTai", "r:observation_reason",
    "f:clf_snnSnVsOthers_score", "f:clf_cats_class", "f:clf_cats_score",
    "f:clf_earlySNIa_score", "f:xm_tns_fullname", "f:xm_tns_type", "f:fink_science_version",
])
LSST_BANDS = set("ugrizy")

_tls = threading.local()
_log_lock = threading.Lock()


def log(msg: str) -> None:
    with _log_lock:
        print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


def id_str(v) -> str:
    """Exact decimal string for a 64-bit ID; refuse anything that went through float."""
    if isinstance(v, bool) or v is None:
        raise ValueError(f"bad id {v!r}")
    if isinstance(v, int):
        return str(v)
    if isinstance(v, str) and v.isdigit():
        return v
    raise ValueError(f"id {v!r} is not an exact integer (float corruption?)")


def session() -> requests.Session:
    s = getattr(_tls, "s", None)
    if s is None:
        s = requests.Session()
        s.headers.update({"User-Agent": UA, "Content-Type": "application/json"})
        _tls.s = s
    return s


def post(endpoint: str, payload: dict) -> str:
    """POST with exponential backoff on 429/5xx/network errors. Returns the body text,
    which must parse as a JSON list (Fink returns [] when nothing matches)."""
    url = f"{API}/{endpoint}"
    last = None
    for attempt in range(MAX_TRIES):
        try:
            r = session().post(url, json=payload, timeout=TIMEOUT)
            if r.status_code == 200:
                data = json.loads(r.text)
                if isinstance(data, list):
                    return r.text
                last = f"unexpected payload: {r.text[:200]}"
            elif r.status_code in (408, 425, 429) or r.status_code >= 500:
                last = f"HTTP {r.status_code}"
                ra = r.headers.get("Retry-After")
                if ra and ra.isdigit():
                    time.sleep(min(int(ra), 300))
                    continue
            else:  # other 4xx: our request is wrong, retrying will not help
                raise RuntimeError(f"HTTP {r.status_code}: {r.text[:200]}")
        except (requests.RequestException, json.JSONDecodeError) as e:
            last = f"{type(e).__name__}: {e}"
        time.sleep(min(2 ** attempt, 120) + random.uniform(0, 1.5))
    raise RuntimeError(f"{endpoint} failed after {MAX_TRIES} tries: {last}")


def write_atomic(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text)
    tmp.replace(path)


def load_json(path: Path):
    return json.loads(path.read_text())


# --------------------------------------------------------------------------- fetch

def fetch_cone(row) -> tuple[str, int]:
    path = RAW_CONE / f"{row.name}.json"
    if path.exists():
        return "cached", len(load_json(path))
    body = post("conesearch", {"ra": float(row.ra), "dec": float(row.dec),
                               "radius": RADIUS_AS, "output-format": "json"})
    write_atomic(path, body)
    return "fetched", len(json.loads(body))


def fetch_object(oid: str) -> str:
    did = []
    for endpoint, d, extra in (("sources", RAW_SRC, {"columns": SRC_COLUMNS}),
                               ("fp", RAW_FP, {})):
        path = d / f"{oid}.json"
        if path.exists():
            continue
        body = post(endpoint, {"diaObjectId": oid, "output-format": "json", **extra})
        rows = json.loads(body)
        bad = [x for x in rows if id_str(x.get("r:diaObjectId")) != oid]
        if bad:
            raise RuntimeError(f"{endpoint} {oid}: {len(bad)} rows with another diaObjectId")
        write_atomic(path, body)
        did.append(f"{endpoint}={len(rows)}")
    return ",".join(did) or "cached"


def run_pool(fn, items, workers: int, label: str, key=lambda x: x):
    done = errors = 0
    t0 = time.time()
    n = len(items)
    failed = []
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futs = {ex.submit(fn, it): it for it in items}
        for fut in as_completed(futs):
            it = futs[fut]
            try:
                fut.result()
            except Exception as e:  # noqa: BLE001
                errors += 1
                failed.append(key(it))
                log(f"{label} ERROR {key(it)}: {e}")
            done += 1
            if done % 200 == 0 or done == n:
                el = time.time() - t0
                eta = el / done * (n - done)
                log(f"{label}: {done}/{n} done, {errors} errors, {el/60:.1f} min elapsed, "
                    f"ETA {eta/60:.1f} min")
    return failed


def cone_ids(name: str) -> list[tuple[str, float]]:
    """(alert diaObjectId, sep arcsec) from a cached cone search, closest first, unique."""
    path = RAW_CONE / f"{name}.json"
    if not path.exists():
        return []
    best: dict[str, float] = {}
    for x in load_json(path):
        if x.get("r:diaObjectId") is None:  # e.g. a solar-system source with no diaObject
            continue
        oid = id_str(x["r:diaObjectId"])
        sep = x.get("v:separation_degree")
        sep = float(sep) * 3600.0 if sep is not None else np.nan
        if oid not in best or (sep < best[oid]):
            best[oid] = sep
    return sorted(best.items(), key=lambda kv: (np.nan_to_num(kv[1], nan=99.0), kv[0]))


# --------------------------------------------------------------------------- normalize

def _f(v) -> float:
    return float(v) if v is not None else np.nan


def normalize(targets: pd.DataFrame) -> None:
    ids_rows, phot = [], []
    n_cone = n_missing_obj = 0
    for t in targets.itertuples(index=False):
        if not (RAW_CONE / f"{t.name}.json").exists():
            continue
        n_cone += 1
        lo, hi = t.disc_mjd - common.WINDOW_PRE_D, t.disc_mjd + common.WINDOW_POST_D
        for oid, sep in cone_ids(t.name):
            ids_rows.append({"name": t.name, "alert_id": oid, "sep_arcsec": sep, "broker": "fink"})
            src_p, fp_p = RAW_SRC / f"{oid}.json", RAW_FP / f"{oid}.json"
            if not src_p.exists() or not fp_p.exists():
                n_missing_obj += 1
            if src_p.exists():
                seen = set()
                for x in load_json(src_p):
                    sid = id_str(x["r:diaSourceId"])
                    mjd, flux = _f(x.get("r:midpointMjdTai")), _f(x.get("r:psfFlux"))
                    if sid in seen or not np.isfinite(mjd) or not np.isfinite(flux):
                        continue
                    seen.add(sid)
                    if not (lo <= mjd <= hi):
                        continue
                    note = oid
                    rel = x.get("r:reliability")
                    if rel is not None:
                        note += f" rel={float(rel):.2f}"
                    if x.get("r:isNegative"):
                        note += " neg"
                    phot.append((t.name, "lsst_alert", mjd, x.get("r:band"), flux,
                                 _f(x.get("r:psfFluxErr")), common.KIND_DET, note))
            if fp_p.exists():
                seen = set()
                for x in load_json(fp_p):
                    fid = id_str(x["r:diaForcedSourceId"])
                    mjd, flux = _f(x.get("r:midpointMjdTai")), _f(x.get("r:psfFlux"))
                    if fid in seen or x.get("r:timeWithdrawnMjdTai") is not None:
                        continue
                    if not np.isfinite(mjd) or not np.isfinite(flux):
                        continue
                    seen.add(fid)
                    if not (lo <= mjd <= hi):
                        continue
                    phot.append((t.name, "lsst_alert_fp", mjd, x.get("r:band"), flux,
                                 _f(x.get("r:psfFluxErr")), common.KIND_FORCED, oid))

    df = pd.DataFrame(phot, columns=["name", "source", "mjd", "band", "flux", "flux_err",
                                     "kind", "note"])
    df["lim_mag"] = np.nan
    if len(df):
        badband = ~df["band"].isin(LSST_BANDS)
        if badband.any():
            log(f"WARNING dropping {int(badband.sum())} points with non-ugrizy band "
                f"{sorted(df.loc[badband, 'band'].astype(str).unique())}")
            df = df[~badband]
    else:
        df = common.empty_norm()
    common.write_norm(df, OUT_PHOT)

    ids = pd.DataFrame(ids_rows, columns=["name", "alert_id", "sep_arcsec", "broker"])
    ids = ids.astype({"name": "string", "alert_id": "string", "sep_arcsec": "float64",
                      "broker": "string"})
    assert ids["alert_id"].str.fullmatch(r"\d+").all()
    OUT_IDS.parent.mkdir(parents=True, exist_ok=True)
    ids.sort_values(["name", "sep_arcsec"]).to_parquet(OUT_IDS, index=False)

    n_obj = ids["name"].nunique()
    log(f"normalized: {n_cone}/{len(targets)} targets cone-searched, {n_obj} with >=1 alert "
        f"object ({len(ids)} pairs, {ids['alert_id'].nunique()} unique alert ids)"
        + (f", {n_missing_obj} alert objects still missing sources/fp" if n_missing_obj else ""))
    for src in ("lsst_alert", "lsst_alert_fp"):
        s = df[df["source"] == src]
        if len(s):
            log(f"  {src}: {len(s)} points, {s['name'].nunique()} objects, "
                f"MJD {s['mjd'].min():.3f}-{s['mjd'].max():.3f}")
        else:
            log(f"  {src}: 0 points")
    log(f"wrote {OUT_PHOT.relative_to(common.REPO)} and {OUT_IDS.relative_to(common.REPO)}")


# --------------------------------------------------------------------------- main

def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--limit", type=int, help="only the first N targets (load_targets order)")
    ap.add_argument("--names", help="comma-separated TNS names (no prefix)")
    ap.add_argument("--normalize-only", action="store_true", help="skip fetching")
    ap.add_argument("--workers", type=int, default=MAX_WORKERS,
                    help=f"concurrent requests (max {MAX_WORKERS})")
    args = ap.parse_args()

    workers = max(1, min(args.workers, MAX_WORKERS))
    if args.workers > MAX_WORKERS:
        log(f"--workers capped at {MAX_WORKERS}")

    # edp2_matched is used only for ordering by load_targets(); drop it right away.
    targets = common.load_targets().drop(columns=["edp2_matched"])
    if args.names:
        want = [n.strip().removeprefix("SN ").removeprefix("AT ").replace(" ", "")
                for n in args.names.split(",") if n.strip()]
        unknown = sorted(set(want) - set(targets["name"]))
        if unknown:
            log(f"not in targets: {unknown}")
        targets = targets[targets["name"].isin(want)]
    if args.limit:
        targets = targets.head(args.limit)
    targets = targets.reset_index(drop=True)
    log(f"{len(targets)} targets, {workers} workers, "
        f"{datetime.now(timezone.utc).isoformat(timespec='seconds')}")

    if not args.normalize_only:
        todo = [t for t in targets.itertuples(index=False)
                if not (RAW_CONE / f"{t.name}.json").exists()]
        log(f"cone search: {len(targets) - len(todo)} cached, {len(todo)} to fetch")
        failed = run_pool(fetch_cone, todo, workers, "cone", key=lambda t: t.name)
        if failed:
            log(f"cone search: {len(failed)} failed (rerun to retry): {failed[:20]}")

        oids = sorted({oid for n in targets["name"] for oid, _ in cone_ids(n)})
        todo_o = [o for o in oids
                  if not (RAW_SRC / f"{o}.json").exists() or not (RAW_FP / f"{o}.json").exists()]
        log(f"alert objects: {len(oids)} unique, {len(todo_o)} to fetch (sources + fp)")
        failed_o = run_pool(fetch_object, todo_o, workers, "sources/fp")
        if failed_o:
            log(f"sources/fp: {len(failed_o)} failed (rerun to retry): {failed_o[:20]}")

    normalize(targets)


if __name__ == "__main__":
    main()
