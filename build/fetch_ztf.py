#!/usr/bin/env python3
"""ZTF layer via ALeRCE: alert detections, non-detections and forced photometry.

For every target whose TNS internal names contain ZTF object ids, fetch per oid

  GET https://api.alerce.online/ztf/v1/objects/{oid}/lightcurve
      -> {"detections": [...], "non_detections": [...]}
  GET https://api.alerce.online/v2/lightcurve/forced-photometry/{oid}
      -> [...]  (the fp_hists carried in ZTF alert packets, as ingested by ALeRCE;
                 same route the official `alerce` client uses)

cache the raw responses one JSON per oid under cache/raw/ztf/, and normalize to
cache/norm/ztf.parquet (SCHEMA.md contract, sources `ztf` and `ztf_fp`).

Units
-----
Detections (source ztf, kind 0): flux, err = common.mag_to_njy(magpsf, sigmapsf);
flux is negated when isdiffpos says the difference was negative.

Non-detections (source ztf, kind 2): flux NaN, lim_mag = diffmaglim.

Forced photometry (source ztf_fp, kind 1): ALeRCE does not return
forcediffimflux itself. It returns mag = magzpsci - 2.5 log10|forcediffimflux|,
e_mag = 1.0857 * forcediffimfluxunc / |forcediffimflux|, isdiffpos = sign of the
flux, and magzpsci in extra_fields. We invert that:
    DN     = isdiffpos * 10**((magzpsci - mag)/2.5)          (= forcediffimflux)
    DN_err = |DN| * e_mag * ln(10)/2.5                         (= forcediffimfluxunc)
    nJy    = DN * 10**((31.4 - magzpsci)/2.5)   (same factor for the error)
which is algebraically flux = isdiffpos * 10**((31.4 - mag)/2.5). Rows are
dropped when procstatus is not in KEEP_PROCSTATUS (below), when mag/e_mag/magzpsci are missing or
non-finite, when e_mag <= 0, or when |DN| or DN_err hits the -99999 sentinel.

procstatus codes (IRSA ZTF forced-photometry doc, section 9): 0 = success;
57 = no reference-catalog source within 5 arcsec (harmless for difference flux
of a hostless or faint-host transient) -> kept. 56 = may be impacted by bad or
NaN'd pixels, 58-61 = missing PSF catalog / suspect uncertainties / bad PSF
dims / cutout off the edge, 62-255 = errors -> dropped.

Everything is cut to [disc_mjd - WINDOW_PRE_D, disc_mjd + WINDOW_POST_D].
An object listing several ZTF oids gets all of them; points are deduplicated on
(source, kind, band, mjd) keeping the first oid in TNS order (and, within an
oid, the alert copy of a detection over its prv_candidates copy). `note` is the oid.

Usage
-----
  python build/fetch_ztf.py                  # fetch everything missing, then normalize
  python build/fetch_ztf.py --limit 30       # first 30 ZTF targets in load_targets() order
  python build/fetch_ztf.py --names 2025abc,2025xyz   (TNS names or ZTF oids)
  python build/fetch_ztf.py --normalize-only # rebuild the parquet from the raw cache
  python build/fetch_ztf.py --workers 6

Normalization always covers every ZTF target that has a raw cache file, so a
partial fetch never shrinks the parquet. Failures are written to
cache/raw/ztf/_failures.json and retried on the next run. Objects ALeRCE does
not know (HTTP 404 on /lightcurve) are cached with status "not_found"; delete
their file to retry.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import random
import re
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd
import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402

LC_URL = "https://api.alerce.online/ztf/v1/objects/{oid}/lightcurve"
FP_URL = "https://api.alerce.online/v2/lightcurve/forced-photometry/{oid}"
RAW_DIR = common.CACHE / "raw" / "ztf"
FAIL_FILE = RAW_DIR / "_failures.json"
OUT = common.NORM / "ztf.parquet"

ZTF_RE = re.compile(r"ZTF\d{2}[a-z]{7}")
FID_BAND = {1: "ztf-g", 2: "ztf-r", 3: "ztf-i"}
SENTINEL = -99999.0
KEEP_PROCSTATUS = {"0", "57"}
TIMEOUT = (15, 180)
MAX_TRIES = 6            # for 5xx / network errors
MAX_429 = 12             # HTTP 429 retries (shared cooldown 30 s doubling to 300 s, ~40 min worst case)
DEFAULT_RPS = 3.0        # global request rate; ALeRCE's ELB answers 429 for minutes above ~5 req/s
USER_AGENT = "tns-edp2-explorer/fetch_ztf (+https://github.com; research use)"

_tls = threading.local()


class Throttle:
    """Process-wide request pacing plus a shared cooldown after HTTP 429."""

    def __init__(self, rps: float) -> None:
        self.interval = 1.0 / rps if rps > 0 else 0.0
        self.lock = threading.Lock()
        self.next_slot = 0.0
        self.cool_until = 0.0

    def wait(self) -> None:
        with self.lock:
            now = time.monotonic()
            slot = max(now, self.next_slot, self.cool_until)
            self.next_slot = slot + self.interval
        time.sleep(max(0.0, slot - time.monotonic()))

    def cooldown(self, seconds: float) -> None:
        with self.lock:
            self.cool_until = max(self.cool_until, time.monotonic() + seconds)


THROTTLE = Throttle(DEFAULT_RPS)


def log(msg: str) -> None:
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


# --------------------------------------------------------------------------- targets

def ztf_targets() -> pd.DataFrame:
    """Targets with ZTF oids, in load_targets() order. Drops edp2_matched."""
    t = common.load_targets()
    t["oids"] = t["internal_names"].astype(str).map(lambda s: list(dict.fromkeys(ZTF_RE.findall(s))))
    t = t[t["oids"].str.len() > 0]
    return t[["name", "disc_mjd", "oids"]].reset_index(drop=True)


def select(t: pd.DataFrame, names: str | None, limit: int | None) -> pd.DataFrame:
    if names:
        want = {n.strip().removeprefix("SN ").removeprefix("AT ").strip()
                for n in names.split(",") if n.strip()}
        t = t[t["name"].isin(want) | t["oids"].map(lambda os_: bool(want & set(os_)))]
    if limit:
        t = t.head(limit)
    return t


# --------------------------------------------------------------------------- fetch

def _session() -> requests.Session:
    s = getattr(_tls, "s", None)
    if s is None:
        s = requests.Session()
        s.headers["User-Agent"] = USER_AGENT
        s.headers["Accept"] = "application/json"
        _tls.s = s
    return s


class NotFound(Exception):
    pass


def get_json(url: str):
    """GET with pacing, retries and backoff. 404 -> NotFound (not retried).

    429 puts every worker into a shared cooldown (Retry-After if given, else
    30 s doubling to 300 s) and does not count against MAX_TRIES.
    """
    last = None
    tries = n429 = 0
    while tries < MAX_TRIES and n429 <= MAX_429:
        THROTTLE.wait()
        try:
            r = _session().get(url, timeout=TIMEOUT)
            if r.status_code == 200:
                return r.json()
            if r.status_code == 404:
                raise NotFound(url)
            last = f"HTTP {r.status_code}"
            if r.status_code == 429:
                ra = r.headers.get("Retry-After", "")
                THROTTLE.cooldown(int(ra) if ra.isdigit() else min(30 * 2 ** n429, 300))
                n429 += 1
                continue
            if r.status_code not in (408, 425, 500, 502, 503, 504, 520, 522, 524):
                break
        except NotFound:
            raise
        except (requests.RequestException, ValueError) as exc:
            last = f"{type(exc).__name__}: {str(exc)[:200]}"
        time.sleep(min(2 ** tries, 60) + random.uniform(0, 1))
        tries += 1
    raise RuntimeError(last or "unknown error")


def raw_path(oid: str) -> Path:
    return RAW_DIR / f"{oid}.json"


def fetch_one(oid: str) -> tuple[str, str, str | None]:
    """Fetch both endpoints for one oid and cache atomically. Returns (oid, status, err)."""
    rec = {"oid": oid, "fetched_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
           "endpoints": {"lightcurve": LC_URL.format(oid=oid), "forced_photometry": FP_URL.format(oid=oid)}}
    try:
        try:
            lc = get_json(LC_URL.format(oid=oid))
            rec["status"] = "ok"
        except NotFound:
            lc = None
            rec["status"] = "not_found"
        fp = get_json(FP_URL.format(oid=oid)) if lc is not None else []
        if lc is not None and not (isinstance(lc, dict) and "detections" in lc):
            raise RuntimeError(f"unexpected lightcurve payload type {type(lc).__name__}")
        if not isinstance(fp, list):
            raise RuntimeError(f"unexpected forced_photometry payload type {type(fp).__name__}")
    except NotFound:
        fp, rec["fp_status"] = [], "not_found"
    except Exception as exc:  # noqa: BLE001
        return oid, "failed", f"{type(exc).__name__}: {exc}"[:300]
    rec["lightcurve"] = lc
    rec["forced_photometry"] = fp
    tmp = raw_path(oid).with_suffix(".json.tmp")
    tmp.write_text(json.dumps(rec, separators=(",", ":")))
    os.replace(tmp, raw_path(oid))
    return oid, rec["status"], None


def fetch_all(oids: list[str], workers: int) -> None:
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    todo = [o for o in oids if not raw_path(o).exists()]
    log(f"fetch: {len(oids)} oids, {len(oids) - len(todo)} cached, {len(todo)} to fetch, workers={workers}")
    if not todo:
        return
    old_fail = json.loads(FAIL_FILE.read_text()) if FAIL_FILE.exists() else {}
    fails: dict[str, dict] = {}
    counts = {"ok": 0, "not_found": 0, "failed": 0}
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futs = {ex.submit(fetch_one, o): o for o in todo}
        for i, fut in enumerate(as_completed(futs), 1):
            oid, status, err = fut.result()
            counts[status] += 1
            if err:
                prev = old_fail.get(oid, {})
                fails[oid] = {"error": err, "runs_failed": prev.get("runs_failed", 0) + 1,
                              "last_utc": datetime.now(timezone.utc).isoformat(timespec="seconds")}
                log(f"  FAIL {oid}: {err}")
            if i % 50 == 0 or i == len(todo):
                dt = time.time() - t0
                eta = (len(todo) - i) * dt / i
                log(f"  {i}/{len(todo)} {counts} {i / dt:.2f} oid/s, ETA {eta / 60:.1f} min")
    # keep failures of oids not attempted this run; drop ones that now succeeded
    merged = {k: v for k, v in old_fail.items() if k not in futs}
    merged.update(fails)
    FAIL_FILE.write_text(json.dumps(merged, indent=1, sort_keys=True))
    log(f"fetch done in {(time.time() - t0) / 60:.1f} min: {counts}; failures file has {len(merged)}")


# --------------------------------------------------------------------------- normalize

def _neg(isdiffpos) -> bool:
    if isinstance(isdiffpos, str):
        return isdiffpos.strip().lower() in ("f", "0", "-1", "false", "n")
    try:
        return float(isdiffpos) <= 0
    except (TypeError, ValueError):
        return False


def _num(x) -> float:
    try:
        v = float(x)
    except (TypeError, ValueError):
        return math.nan
    return v if math.isfinite(v) else math.nan


def rows_for_oid(name: str, oid: str, rec: dict, stats: dict) -> list[tuple]:
    rows = []
    lc = rec.get("lightcurve") or {}
    # The same exposure can appear twice (the alert itself and a later packet's
    # prv_candidates, rounded differently); list alert copies first so dedup keeps them.
    for d in sorted(lc.get("detections") or [], key=lambda d: not d.get("has_stamp")):
        band = FID_BAND.get(d.get("fid"))
        mjd, mag, err = _num(d.get("mjd")), _num(d.get("magpsf")), _num(d.get("sigmapsf"))
        if band is None or math.isnan(mjd) or math.isnan(mag):
            stats["det_dropped"] += 1
            continue
        f, fe = common.mag_to_njy(mag, err)
        f, fe = float(f), float(fe)
        if _neg(d.get("isdiffpos")):
            f = -f
            stats["det_negative"] += 1
        rows.append((name, "ztf", mjd, band, f, fe, common.KIND_DET, math.nan, oid))
    for d in lc.get("non_detections") or []:
        band = FID_BAND.get(d.get("fid"))
        mjd, lim = _num(d.get("mjd")), _num(d.get("diffmaglim"))
        if band is None or math.isnan(mjd) or math.isnan(lim):
            stats["ul_dropped"] += 1
            continue
        rows.append((name, "ztf", mjd, band, math.nan, math.nan, common.KIND_UL, lim, oid))
    for d in rec.get("forced_photometry") or []:
        ef = d.get("extra_fields") or {}
        band = FID_BAND.get(d.get("fid"))
        mjd = _num(d.get("mjd"))
        mag = _num(d.get("mag", ef.get("mag")))
        emag = _num(d.get("e_mag", ef.get("e_mag")))
        zp = _num(ef.get("magzpsci", d.get("magzpsci")))
        ps = str(ef.get("procstatus", d.get("procstatus", ""))).strip()
        codes = set(re.split(r"[,;\s]+", ps)) - {""}
        if not codes or not codes <= KEEP_PROCSTATUS:
            stats[f"fp_drop_procstatus_{ps or 'missing'}"] += 1
            continue
        if band is None or any(math.isnan(v) for v in (mjd, mag, emag, zp)) or emag <= 0:
            stats["fp_drop_missing"] += 1
            continue
        dn = 10 ** ((zp - mag) / 2.5)
        dn_err = dn * emag * math.log(10) / 2.5
        if abs(dn - abs(SENTINEL)) < 1 or abs(dn_err - abs(SENTINEL)) < 1:
            stats["fp_drop_sentinel"] += 1
            continue
        if _neg(d.get("isdiffpos")):
            dn = -dn
        scale = 10 ** ((common.ZP_NJY - zp) / 2.5)
        rows.append((name, "ztf_fp", mjd, band, dn * scale, dn_err * scale, common.KIND_FORCED, math.nan, oid))
    return rows


def normalize(t: pd.DataFrame) -> pd.DataFrame:
    from collections import Counter
    stats: Counter = Counter()
    rows: list[tuple] = []
    for name, disc, oids in t[["name", "disc_mjd", "oids"]].itertuples(index=False):
        lo, hi = disc - common.WINDOW_PRE_D, disc + common.WINDOW_POST_D
        obj_rows = []
        for oid in oids:
            p = raw_path(oid)
            if not p.exists():
                stats["oid_uncached"] += 1
                continue
            rec = json.loads(p.read_text())
            stats[f"oid_{rec.get('status', '?')}"] += 1
            obj_rows += rows_for_oid(name, oid, rec, stats)
        n0 = len(obj_rows)
        obj_rows = [r for r in obj_rows if lo <= r[2] <= hi]
        stats["out_of_window"] += n0 - len(obj_rows)
        rows += obj_rows
    df = pd.DataFrame(rows, columns=list(common.NORM_COLUMNS))
    n0 = len(df)
    df["_k"] = df["mjd"].round(6)
    df = df.drop_duplicates(["name", "source", "kind", "band", "_k"], keep="first").drop(columns="_k")
    stats["duplicates"] = n0 - len(df)
    if df.empty:
        df = common.empty_norm()
    common.write_norm(df, OUT)
    log("normalize stats: " + json.dumps(dict(sorted(stats.items()))))
    summ = df.groupby(["source", "kind"]).agg(points=("mjd", "size"), objects=("name", "nunique"))
    log(f"wrote {OUT} ({OUT.stat().st_size / 1e6:.2f} MB), {len(df)} rows, "
        f"{df['name'].nunique()} objects\n{summ.to_string()}")
    return df


# --------------------------------------------------------------------------- main

def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--limit", type=int, default=None, help="first N ZTF targets (load_targets order)")
    ap.add_argument("--names", default=None, help="comma-separated TNS names or ZTF oids")
    ap.add_argument("--normalize-only", action="store_true", help="rebuild parquet from raw cache, no network")
    ap.add_argument("--workers", type=int, default=6, help="concurrent oids (each does 2 sequential requests)")
    ap.add_argument("--rps", type=float, default=DEFAULT_RPS, help="global max requests per second (0 = unpaced)")
    args = ap.parse_args(argv)

    t_all = ztf_targets()
    log(f"{len(t_all)} targets with ZTF ids ({t_all['oids'].str.len().sum()} oids)")
    if not args.normalize_only:
        THROTTLE.interval = 1.0 / args.rps if args.rps > 0 else 0.0
        t = select(t_all, args.names, args.limit)
        oids = list(dict.fromkeys(o for os_ in t["oids"] for o in os_))
        fetch_all(oids, max(1, min(args.workers, 8)))
    normalize(t_all)
    return 0


if __name__ == "__main__":
    sys.exit(main())
