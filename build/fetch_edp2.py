#!/usr/bin/env python3
"""Private EDP2 layer: Rubin DP2 catalog photometry for TNS objects matched to a DiaObject.

Sources written (see SCHEMA.md):
  edp2_dia  dp2.DiaSource rows (already pulled by the cross-match run), kind 0
  edp2_fp   dp2.ForcedSourceOnDiaObject psfDiffFlux on every overlapping visit, kind 1

PROPRIETARY (Rubin Data Policy RDO-13, DPOL-506/516). Every output of this script
goes under common.PRIVATE, which lives outside this public repo. Nothing here
writes fluxes, diaObjectIds or match separations into the repo.

Outputs:
  PRIVATE/cache/edp2_fp/b_<hash>.parquet + .json   raw forced rows, one pair per TAP batch
  PRIVATE/norm/edp2.parquet                        common.NORM_COLUMNS
  PRIVATE/norm/edp2_objects.parquet                per-object side table
  PRIVATE/cache/edp2_build_stats.json              counts and sanity checks of the last run

Usage:
  python build/fetch_edp2.py                  fetch missing forced batches, then normalize
  python build/fetch_edp2.py --limit 50       first 50 matched objects (by TNS name)
  python build/fetch_edp2.py --normalize-only no TAP calls; use whatever is cached

RSP access follows ~/.claude/skills/rubin-edp2/SKILL.md: schema dp2, sync TAP
with TOP, token from load_rsp_token() and never printed.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common as C  # noqa: E402

SKILL_DIR = Path.home() / ".claude/skills/rubin-edp2"
FP_CACHE = C.PRIVATE_CACHE / "edp2_fp"
OUT_NORM = C.PRIVATE_NORM / "edp2.parquet"
OUT_OBJECTS = C.PRIVATE_NORM / "edp2_objects.parquet"
OUT_STATS = C.PRIVATE_CACHE / "edp2_build_stats.json"

FP_TABLE = "dp2.ForcedSourceOnDiaObject"
FP_ID_COLS = ["diaObjectId", "visit"]
FP_INT_COLS = ["detector"]
FP_STR_COLS = ["band"]
FP_FLOAT_COLS = ["psfDiffFlux", "psfDiffFluxErr"]
# Fit-failure flags: a row with any of these set has no usable difference flux and is dropped.
# diff_PixelFlags_nodataCenter rows are not flagged by psfDiffFlux_flag, but their centre is
# NO_DATA on the difference image: most have psfDiffFlux == 0.0 exactly, the rest are noise.
FP_DROP_FLAGS = ["psfDiffFlux_flag", "diff_PixelFlags_nodataCenter", "invalidPsfFlag"]
# Quality flags kept on the point as short codes in `note`.
FP_NOTE_FLAGS = {
    "pixelFlags_nodata": "nodata",
    "pixelFlags_edge": "edge",
    "pixelFlags_bad": "bad",
    "pixelFlags_saturatedCenter": "satC",
    "pixelFlags_crCenter": "crC",
    "pixelFlags_interpolatedCenter": "interpC",
    "pixelFlags_suspectCenter": "suspC",
}
FP_BOOL_COLS = FP_DROP_FLAGS + list(FP_NOTE_FLAGS)
FP_COLS = FP_ID_COLS + FP_INT_COLS + FP_STR_COLS + FP_FLOAT_COLS + FP_BOOL_COLS

_DIGITS = re.compile(r"^[0-9]+$")


def _guard_private() -> None:
    """Refuse to run if PRIVATE resolves inside the public repo."""
    priv, repo = C.PRIVATE.resolve(), C.REPO.resolve()
    if priv == repo or repo in priv.parents:
        raise SystemExit(f"refusing to write proprietary data inside the public repo: {priv}")


def log(msg: str) -> None:
    print(msg, flush=True)


# ---------------------------------------------------------------- inputs

def load_matches(limit: int | None) -> pd.DataFrame:
    m = pd.read_csv(C.MATCH_CSV, dtype={"diaObjectId": "string"}, low_memory=False)
    m = m[m["sep_arcsec"].le(C.MATCH_RADIUS_AS).fillna(False)].copy()
    bad = ~m["diaObjectId"].fillna("").str.match(_DIGITS)
    if bad.any():
        raise SystemExit(f"{int(bad.sum())} matched rows have a non-integer diaObjectId string")
    tc = m["time_consistent"].map(
        lambda v: v if isinstance(v, bool) else {"true": True, "false": False}.get(str(v).strip().lower())
    )
    out = pd.DataFrame({
        "name": m["name"].astype("string"),
        "diaObjectId": m["diaObjectId"].astype("string"),
        "oid": pd.array([int(s) for s in m["diaObjectId"]], dtype="Int64"),
        "sep_arcsec": m["sep_arcsec"].astype(float),
        "nDiaSources": m["nDiaSources"].astype(float).round().astype("Int64"),
        "lead_days": m["lead_days"].astype(float),
        "time_consistent": tc.astype("boolean"),
        "disc_mjd": m["disc_mjd"].astype(float),
        "n_visits": m["n_visits"].fillna(0).astype(int),
        "tns_type": m["tns_type"].astype("string"),
    })
    # int -> string must round-trip exactly (float64 would silently corrupt ~1e17 ids)
    assert (out["oid"].astype("string") == out["diaObjectId"]).all(), "diaObjectId round-trip failed"
    if out["name"].duplicated().any() or out["oid"].duplicated().any():
        raise SystemExit("duplicate names or diaObjectIds among matched rows")
    out = out.sort_values("name").reset_index(drop=True)
    if limit:
        out = out.head(limit).reset_index(drop=True)
    return out


def load_visits() -> pd.DataFrame:
    v = pd.read_csv(C.VISITS_CSV, dtype={"visit": "Int64"})
    return v[["visit", "band", "expMidptMJD"]].rename(columns={"band": "visit_band"})


# ---------------------------------------------------------------- forced-photometry fetch

def _batch_key(ids: list[int]) -> str:
    return hashlib.sha1(",".join(str(i) for i in sorted(ids)).encode()).hexdigest()[:12]


def done_ids() -> set[int]:
    done: set[int] = set()
    for js in FP_CACHE.glob("b_*.json"):
        meta = json.loads(js.read_text())
        if js.with_suffix(".parquet").exists():
            done.update(int(s) for s in meta["ids"])
    return done


def _rows_to_frame(columns: list[str], rows: list[list[str]]) -> pd.DataFrame:
    """Column-first conversion of TAP string rows; ids never touch float64."""
    if columns and set(columns) != set(FP_COLS):
        raise RuntimeError(f"unexpected TAP columns: {columns}")
    idx = {c: i for i, c in enumerate(columns)}
    col = lambda c: [r[idx[c]] for r in rows]  # noqa: E731
    out: dict[str, object] = {}
    for c in FP_ID_COLS + FP_INT_COLS:
        out[c] = pd.array([int(x) if x != "" else None for x in col(c)], dtype="Int64")
    for c in FP_STR_COLS:
        out[c] = pd.array(col(c), dtype="string")
    for c in FP_FLOAT_COLS:
        out[c] = pd.to_numeric(pd.Series(col(c), dtype="string").replace("", None), errors="coerce").astype("float64")
    for c in FP_BOOL_COLS:
        # tap.py yields 'True'/'False' (BINARY2) or 'true'/'false' (CSV); astype(bool) would read 'False' as True
        vals = [{"true": True, "false": False}.get(x.strip().lower()) for x in col(c)]
        out[c] = pd.array(vals, dtype="boolean")
    return pd.DataFrame(out, columns=FP_COLS)


def _query_fp(ids: list[int], token: str, top: int, tap_sync) -> pd.DataFrame:
    adql = (f"SELECT TOP {top} {', '.join(FP_COLS)} FROM {FP_TABLE} "
            f"WHERE diaObjectId IN ({','.join(str(i) for i in ids)})")
    last: Exception | None = None
    for attempt in range(4):
        try:
            res = tap_sync(adql, token, timeout=120)
            return _rows_to_frame(res.columns, res.rows)
        except Exception as e:  # noqa: BLE001 (transient Qserv/HTTP errors; 401 retried once, then raised)
            last = e
            if "401" in str(e) and attempt >= 1:
                break
            time.sleep(5 * (attempt + 1))
    raise RuntimeError(f"forced batch of {len(ids)} ids failed: {str(last)[:200]}")


def fetch_batch(ids: list[int], token: str, top: int, tap_sync) -> list[tuple[list[int], int]]:
    """Fetch and cache one batch; halve it if TOP was hit. Returns [(ids, n_rows)]."""
    t0 = time.time()
    df = _query_fp(ids, token, top, tap_sync)
    if len(df) >= top:
        if len(ids) == 1:
            raise RuntimeError(f"single diaObjectId returned >= TOP {top} rows; raise --top")
        h = len(ids) // 2
        return fetch_batch(ids[:h], token, top, tap_sync) + fetch_batch(ids[h:], token, top, tap_sync)
    key = _batch_key(ids)
    pq, js = FP_CACHE / f"b_{key}.parquet", FP_CACHE / f"b_{key}.json"
    df.to_parquet(pq, index=False)
    js.write_text(json.dumps({
        "ids": [str(i) for i in sorted(ids)], "n_rows": len(df), "top": top,
        "seconds": round(time.time() - t0, 1), "fetched": datetime.now(timezone.utc).isoformat(),
    }))
    return [(ids, len(df))]


def make_batches(todo: pd.DataFrame, max_ids: int, max_expected: int) -> list[list[int]]:
    """Greedy batches of <= max_ids ids and <= max_expected expected rows (n_visits as proxy)."""
    batches, cur, load = [], [], 0
    for oid, nv in zip(todo["oid"].tolist(), todo["n_visits"].tolist()):
        exp = max(int(nv), 20)
        if cur and (len(cur) >= max_ids or load + exp > max_expected):
            batches.append(cur)
            cur, load = [], 0
        cur.append(int(oid))
        load += exp
    if cur:
        batches.append(cur)
    return batches


def fetch_forced(matches: pd.DataFrame, args) -> None:
    sys.path.insert(0, str(SKILL_DIR.resolve()))
    from rsp_token import load_rsp_token  # noqa: PLC0415
    from tap import tap_sync  # noqa: PLC0415

    FP_CACHE.mkdir(parents=True, exist_ok=True)
    done = done_ids()
    todo = matches[~matches["oid"].isin(list(done))].sort_values("n_visits")
    log(f"[fp] {len(matches) - len(todo)} of {len(matches)} objects already cached; {len(todo)} to fetch")
    if todo.empty:
        return
    token = load_rsp_token()  # never printed
    if not token:
        raise SystemExit("no RSP_TOKEN found (see ~/.claude/skills/rubin-edp2/SKILL.md)")
    batches = make_batches(todo, args.batch, args.max_expected)
    log(f"[fp] {len(batches)} batches (<= {args.batch} ids, TOP {args.top}), {args.workers} workers")
    t0, n_rows, n_done, failed = time.time(), 0, 0, []
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futs = {ex.submit(fetch_batch, b, token, args.top, tap_sync): b for b in batches}
        for i, fut in enumerate(as_completed(futs), 1):
            b = futs[fut]
            try:
                for ids, n in fut.result():
                    n_rows += n
                    n_done += len(ids)
            except Exception as e:  # noqa: BLE001
                failed.append(b)
                log(f"[fp] batch of {len(b)} failed: {str(e)[:160]}")
            if i % 5 == 0 or i == len(batches):
                log(f"[fp] {i}/{len(batches)} batches, {n_done} objects, {n_rows} rows, {time.time() - t0:.0f}s")
    if failed:
        log(f"[fp] {len(failed)} batches failed ({sum(map(len, failed))} objects); re-run to resume")


def load_forced_cache(oids: set[int]) -> pd.DataFrame:
    parts = []
    for js in sorted(FP_CACHE.glob("b_*.json")):
        pq = js.with_suffix(".parquet")
        if pq.exists():
            parts.append(pd.read_parquet(pq))
    if not parts:
        return _rows_to_frame(FP_COLS, [])
    fp = pd.concat(parts, ignore_index=True)
    for c in FP_ID_COLS + FP_INT_COLS:
        fp[c] = fp[c].astype("Int64")
    return fp[fp["diaObjectId"].isin(list(oids))].reset_index(drop=True)


# ---------------------------------------------------------------- normalize

def _in_window(mjd: pd.Series, disc: pd.Series) -> pd.Series:
    return (mjd >= disc - C.WINDOW_PRE_D) & (mjd <= disc + C.WINDOW_POST_D)


def _g(x: float) -> str:
    return f"{x:.2g}" if np.isfinite(x) else "nan"


def build_dia(matches: pd.DataFrame, stats: dict) -> tuple[pd.DataFrame, pd.DataFrame]:
    d = pd.read_parquet(C.EDP2_DIA_PARQUET)
    d["diaObjectId"] = d["diaObjectId"].astype("Int64")
    d = d[d["diaObjectId"].isin(matches["oid"].tolist())].copy()
    key = matches.set_index("oid")
    counts = d.groupby("diaObjectId").size()
    got = counts.reindex(key.index).fillna(0).astype(int)
    exp = key["nDiaSources"].astype(int)
    mism = got[got != exp]
    dup = int(d.duplicated(["diaSourceId"]).sum())
    stats["dia_integrity"] = {
        "objects": len(key), "rows": len(d), "objects_with_rows": int((got > 0).sum()),
        "count_mismatches": len(mism), "duplicate_diaSourceId": dup,
        "mismatch_examples": [
            {"name": str(key.loc[o, "name"]), "nDiaSources": int(exp[o]), "rows": int(got[o])}
            for o in mism.index[:10]
        ],
    }
    log(f"[dia] {len(d)} rows for {int((got > 0).sum())}/{len(key)} matched objects; "
        f"nDiaSources mismatches: {len(mism)}; duplicate diaSourceId: {dup}")
    d = d.merge(matches[["oid", "name", "disc_mjd"]], left_on="diaObjectId", right_on="oid", how="inner")
    n0 = len(d)
    keep = _in_window(d["midpointMjdTai"], d["disc_mjd"])
    d_all = d.copy()  # pre-window copy for the same-visit sanity check
    d = d[keep]
    stats["dia_window_cut"] = int(n0 - len(d))
    log(f"[dia] window [disc-{C.WINDOW_PRE_D:g}, disc+{C.WINDOW_POST_D:g}] d cut {n0 - len(d)} of {n0} rows")
    norm = pd.DataFrame({
        "name": d["name"].values,
        "source": "edp2_dia",
        "mjd": d["midpointMjdTai"].astype(float).values,
        "band": d["band"].astype(str).values,
        "flux": d["psfFlux"].astype(float).values,
        "flux_err": d["psfFluxErr"].astype(float).values,
        "kind": C.KIND_DET,
        "lim_mag": np.nan,
        "note": [f"snr={s:.1f};rel={_g(r)}" for s, r in zip(d["snr"], d["reliability"])],
    })
    return norm, d_all


def build_fp(matches: pd.DataFrame, visits: pd.DataFrame, stats: dict) -> tuple[pd.DataFrame, pd.DataFrame]:
    fp = load_forced_cache(set(int(o) for o in matches["oid"]))
    n_raw = len(fp)
    covered = set(int(o) for o in fp["diaObjectId"].unique()) if n_raw else set()
    cached = done_ids()
    not_cached = int((~matches["oid"].isin(list(cached))).sum())
    zero_rows = int(matches["oid"].isin(list(cached)).sum() - len(covered))
    s: dict = {"raw_rows": n_raw, "objects_with_rows": len(covered),
               "objects_not_cached": not_cached, "objects_cached_zero_rows": zero_rows}

    dup = fp.duplicated(["diaObjectId", "visit", "detector"])
    s["duplicate_rows"] = int(dup.sum())
    fp = fp[~dup]
    s["same_visit_multi_detector"] = int(fp.duplicated(["diaObjectId", "visit"]).sum())

    for c in FP_BOOL_COLS:
        s[f"flag_{c}"] = int(fp[c].fillna(False).sum())
    s["flag_null_psfDiffFlux_flag"] = int(fp["psfDiffFlux_flag"].isna().sum())
    fail = fp[FP_DROP_FLAGS].fillna(False).any(axis=1).to_numpy(dtype=bool)
    nonfinite = ~(np.isfinite(fp["psfDiffFlux"].to_numpy()) & np.isfinite(fp["psfDiffFluxErr"].to_numpy())
                  & (fp["psfDiffFluxErr"].to_numpy() > 0))
    s["dropped_fit_flag"] = int(fail.sum())
    seen = np.zeros(len(fp), dtype=bool)
    for c in FP_DROP_FLAGS:  # first flag in FP_DROP_FLAGS order that removes the row
        f = fp[c].fillna(False).to_numpy(dtype=bool)
        s[f"dropped_by_{c}"] = int((f & ~seen).sum())
        seen |= f
    s["dropped_nonfinite_only"] = int((nonfinite & ~fail).sum())
    s["frac_dropped"] = round(float((fail | nonfinite).mean()) if len(fp) else 0.0, 5)
    fp = fp[~(fail | nonfinite)].copy()

    fp = fp.merge(visits, on="visit", how="left")
    s["missing_visit_mjd"] = int(fp["expMidptMJD"].isna().sum())
    s["band_mismatch_vs_visit"] = int((fp["visit_band"].notna() & (fp["band"] != fp["visit_band"])).sum())
    fp = fp[fp["expMidptMJD"].notna()]

    fp = fp.merge(matches[["oid", "name", "disc_mjd"]], left_on="diaObjectId", right_on="oid", how="inner")
    fp_all = fp.copy()
    n0 = len(fp)
    fp = fp[_in_window(fp["expMidptMJD"], fp["disc_mjd"])]
    s["window_cut"] = int(n0 - len(fp))
    s["rows_out"] = len(fp)

    flags = fp[list(FP_NOTE_FLAGS)].fillna(False).to_numpy(dtype=bool)
    codes = np.array(list(FP_NOTE_FLAGS.values()))
    notes = [("flags=" + ",".join(codes[row])) if row.any() else "" for row in flags]
    s["rows_with_note_flags"] = int(flags.any(axis=1).sum())
    stats["fp"] = s
    log(f"[fp] raw {n_raw} rows for {len(covered)} objects (not cached {not_cached}, cached with 0 rows {zero_rows})")
    log(f"[fp] dropped {s['dropped_fit_flag']} fit-failure rows ("
        + ", ".join(f"{c} {s[f'dropped_by_{c}']}" for c in FP_DROP_FLAGS)
        + f") + {s['dropped_nonfinite_only']} non-finite "
        f"({100 * s['frac_dropped']:.2f}%); missing visit MJD {s['missing_visit_mjd']}; "
        f"window cut {s['window_cut']} of {n0}; kept {len(fp)}")
    norm = pd.DataFrame({
        "name": fp["name"].values,
        "source": "edp2_fp",
        "mjd": fp["expMidptMJD"].astype(float).values,
        "band": fp["band"].astype(str).values,
        "flux": fp["psfDiffFlux"].astype(float).values,
        "flux_err": fp["psfDiffFluxErr"].astype(float).values,
        "kind": C.KIND_FORCED,
        "lim_mag": np.nan,
        "note": notes,
    })
    return norm, fp_all


# ---------------------------------------------------------------- sanity checks

def sanity(matches: pd.DataFrame, dia_all: pd.DataFrame, fp_all: pd.DataFrame, norm: pd.DataFrame,
           stats: dict) -> None:
    n_fp = norm[norm["source"] == "edp2_fp"].groupby("name").size()
    dist = n_fp.reindex(matches["name"]).fillna(0).astype(int)
    q = dist.quantile([0, 0.1, 0.25, 0.5, 0.75, 0.9, 0.99, 1.0])
    stats["fp_rows_per_object"] = {f"q{int(k * 100)}": int(v) for k, v in q.items()} | {
        "mean": round(float(dist.mean()), 1), "zero": int((dist == 0).sum())}
    log("[check] forced points per object (after cuts): " +
        ", ".join(f"{k}={v}" for k, v in stats["fp_rows_per_object"].items()))

    # Same visit, same object: DiaSource psfFlux (fit at the DiaSource centroid) vs forced psfDiffFlux
    # (fit at the DiaObject mean position). Should agree to within errors for S/N >~ 10.
    pair = dia_all.merge(fp_all[["diaObjectId", "visit", "psfDiffFlux", "psfDiffFluxErr", "expMidptMJD"]],
                         on=["diaObjectId", "visit"], how="inner")
    dt = (pair["midpointMjdTai"] - pair["expMidptMJD"]).abs() * 86400
    bright = pair[pair["snr"] >= 20]
    ratio = bright["psfDiffFlux"] / bright["psfFlux"]
    pull = (pair["psfDiffFlux"] - pair["psfFlux"]) / np.hypot(pair["psfDiffFluxErr"], pair["psfFluxErr"])
    stats["same_visit"] = {
        "pairs": len(pair), "dia_rows": len(dia_all),
        "dia_without_fp": int(len(dia_all) - pair[["diaObjectId", "visit"]].drop_duplicates().shape[0]),
        "mjd_diff_s_max": round(float(dt.max()), 2) if len(dt) else None,
        "snr20_pairs": len(bright),
        "snr20_ratio_median": round(float(ratio.median()), 4) if len(ratio) else None,
        "snr20_ratio_p16_p84": [round(float(ratio.quantile(0.16)), 4), round(float(ratio.quantile(0.84)), 4)]
        if len(ratio) else None,
        "pull_median": round(float(pull.median()), 3) if len(pull) else None,
        "pull_mad_sigma": round(float(1.4826 * (pull - pull.median()).abs().median()), 3) if len(pull) else None,
    }
    log(f"[check] same-visit pairs {len(pair)}; S/N>=20: {len(bright)}, fp/dia flux ratio median "
        f"{stats['same_visit']['snr20_ratio_median']} (16-84%: {stats['same_visit']['snr20_ratio_p16_p84']}); "
        f"pull median {stats['same_visit']['pull_median']}, robust sigma {stats['same_visit']['pull_mad_sigma']}; "
        f"|midpointMjdTai - expMidptMJD| max {stats['same_visit']['mjd_diff_s_max']} s")

    # Three bright spectroscopic SNe: compare near-peak epochs visit by visit.
    typed = matches[matches["tns_type"].fillna("").str.startswith("SN") & matches["time_consistent"].fillna(False)]
    peak = pair[pair["diaObjectId"].isin(typed["oid"].tolist())].sort_values("snr", ascending=False)
    picks = peak.drop_duplicates("diaObjectId").head(3)
    stats["bright_sne"] = []
    for oid in picks["diaObjectId"]:
        obj = typed[typed["oid"] == oid].iloc[0]
        p = peak[peak["diaObjectId"] == oid].sort_values("snr", ascending=False).head(5)
        rows = [{"band": b, "dia_snr": round(float(s), 1), "fp_over_dia": round(float(f / d), 4),
                 "pull": round(float((f - d) / np.hypot(fe, de)), 2)}
                for b, s, f, d, fe, de in zip(p["band"], p["snr"], p["psfDiffFlux"], p["psfFlux"],
                                              p["psfDiffFluxErr"], p["psfFluxErr"])]
        stats["bright_sne"].append({"name": str(obj["name"]), "type": str(obj["tns_type"]), "epochs": rows})
        log(f"[check] {obj['name']} ({obj['tns_type']}): " +
            "; ".join(f"{r['band']} S/N {r['dia_snr']} fp/dia {r['fp_over_dia']} pull {r['pull']}" for r in rows))


# ---------------------------------------------------------------- main

def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--limit", type=int, default=None, help="only the first N matched objects (by name)")
    ap.add_argument("--normalize-only", action="store_true", help="no TAP calls; normalize from cache")
    ap.add_argument("--batch", type=int, default=60, help="max diaObjectIds per IN (...) query")
    ap.add_argument("--max-expected", type=int, default=12000,
                    help="max expected rows per batch (sum of n_visits as a proxy)")
    ap.add_argument("--top", type=int, default=40000, help="TOP per query; batches that hit it are split")
    ap.add_argument("--workers", type=int, default=4)
    args = ap.parse_args()

    _guard_private()
    matches = load_matches(args.limit)
    log(f"[edp2] {len(matches)} matched objects (sep <= {C.MATCH_RADIUS_AS:g} arcsec); outputs under {C.PRIVATE}")
    if not args.normalize_only:
        fetch_forced(matches, args)

    stats: dict = {"built": datetime.now(timezone.utc).isoformat(), "n_matched": len(matches),
                   "limit": args.limit}
    visits = load_visits()
    dia_norm, dia_all = build_dia(matches, stats)
    fp_norm, fp_all = build_fp(matches, visits, stats)
    norm = pd.concat([dia_norm, fp_norm], ignore_index=True)
    C.write_norm(norm, OUT_NORM)

    n_fp = fp_norm.groupby("name").size()
    objects = pd.DataFrame({
        "name": matches["name"].astype("string"),
        "diaObjectId": matches["diaObjectId"].astype("string"),
        "sep_arcsec": matches["sep_arcsec"].astype("float64"),
        "nDiaSources": matches["nDiaSources"].astype("int64"),
        "n_fp": n_fp.reindex(matches["name"]).fillna(0).astype("int64").values,
        "lead_days": matches["lead_days"].astype("float64"),
        "time_consistent": matches["time_consistent"].astype("boolean"),
    })
    OUT_OBJECTS.parent.mkdir(parents=True, exist_ok=True)
    objects.to_parquet(OUT_OBJECTS, index=False)

    stats["rows"] = {"edp2_dia": len(dia_norm), "edp2_fp": len(fp_norm)}
    stats["objects"] = {"edp2_dia": int(dia_norm["name"].nunique()), "edp2_fp": int(fp_norm["name"].nunique())}
    sanity(matches, dia_all, fp_all, norm, stats)
    OUT_STATS.parent.mkdir(parents=True, exist_ok=True)
    OUT_STATS.write_text(json.dumps(stats, indent=1))
    log(f"[edp2] wrote {OUT_NORM} ({OUT_NORM.stat().st_size / 1e6:.2f} MB; dia {len(dia_norm)} rows / "
        f"{stats['objects']['edp2_dia']} objects, fp {len(fp_norm)} rows / {stats['objects']['edp2_fp']} objects)")
    log(f"[edp2] wrote {OUT_OBJECTS} ({len(objects)} objects) and {OUT_STATS}")


if __name__ == "__main__":
    main()
