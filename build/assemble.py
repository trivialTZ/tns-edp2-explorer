#!/usr/bin/env python3
"""Assemble the site's JS data files from the normalized photometry.

    python build/assemble.py --mode public    # -> docs/data/ (committed, GitHub Pages)
    python build/assemble.py --mode private   # -> PRIVATE/site/ (full copy, EDP2 included)

Public mode never reads anything under PRIVATE and refuses to emit private
sources or columns. Private mode refuses to write inside this repo.
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

import common as C

PUBLIC_NORM_FILES = ["ztf.parquet", "tns.parquet", "lsst_alert.parquet"]
CODE_SUFFIXES = {".html", ".js", ".css", ".svg", ".png", ".ico", ".txt"}


def _clean(v, nd=None):
    if v is None or (isinstance(v, float) and not np.isfinite(v)):
        return None
    if isinstance(v, (np.floating, float)):
        return round(float(v), nd) if nd is not None else float(v)
    if isinstance(v, (np.integer,)):
        return int(v)
    if isinstance(v, (np.bool_,)):
        return bool(v)
    if v is pd.NA:
        return None
    return v


def build_catalog(mode: str) -> pd.DataFrame:
    m = pd.read_csv(C.MATCH_CSV, dtype={"diaObjectId": "string"}, low_memory=False)
    cat = pd.DataFrame({
        "name": m["name"].astype(str),
        "prefix": m["name_prefix"],
        "ra": m["tns_ra"],
        "dec": m["tns_dec"],
        "type": m["tns_type"],
        "z": m["tns_z"],
        "group": m["reporting_group"],
        "disc_mjd": m["disc_mjd"],
        "disc_mag": m["discoverymag"],
        "disc_filter": pd.NA,
        "internal": m["internal_names"].fillna(""),
        "n_visits": m["n_visits"].fillna(0).astype(int),
        "n_visits_active": m["n_visits_active"].fillna(0).astype(int),
    })
    # Refresh classification fields from the newer TNS dump when available.
    if C.TNS_DUMP.exists():
        d = pd.read_parquet(C.TNS_DUMP, columns=["objname", "name_prefix", "type", "redshift",
                                                 "reporting_group", "filter"])
        d = d.drop_duplicates("objname").set_index("objname")
        j = d.reindex(cat["name"])
        for col, src in [("prefix", "name_prefix"), ("type", "type"), ("z", "redshift"),
                         ("group", "reporting_group"), ("disc_filter", "filter")]:
            new = j[src].to_numpy()
            has = pd.notna(new) & (pd.Series(new).astype(str).str.strip() != "").to_numpy()
            cat.loc[has, col] = new[has]
    cat["alert_ids"] = ""
    p = C.NORM / "lsst_alert_ids.parquet"
    if p.exists():
        a = pd.read_parquet(p)
        a["alert_id"] = a["alert_id"].astype(str)
        ids = a.groupby("name")["alert_id"].agg(lambda s: ",".join(sorted(set(s))))
        cat["alert_ids"] = cat["name"].map(ids).fillna("")
    cat["n_spec"], cat["spec_types"] = 0, ""
    p = C.NORM / "tns_spectra.parquet"
    if p.exists():
        s = pd.read_parquet(p).drop_duplicates("name").set_index("name")
        cat["n_spec"] = cat["name"].map(s["n_spectra"]).fillna(0).astype(int)
        cat["spec_types"] = cat["name"].map(s["spec_types"]).fillna("").astype(str)
    if mode == "private":
        p = C.PRIVATE_NORM / "edp2_objects.parquet"
        if p.exists():
            e = pd.read_parquet(p).drop_duplicates("name").set_index("name")
            e["diaObjectId"] = e["diaObjectId"].astype("string")
        else:  # fall back to the cross-match table
            e = m[m["sep_arcsec"].le(C.MATCH_RADIUS_AS)].set_index("name")
            e = e.assign(n_fp=np.nan)
        cat["edp2_id"] = cat["name"].map(e["diaObjectId"]).astype("string")
        cat["edp2_sep"] = cat["name"].map(e["sep_arcsec"])
        cat["edp2_ndia"] = cat["name"].map(e["nDiaSources"])
        cat["edp2_lead"] = cat["name"].map(e["lead_days"])
        cat["edp2_tc"] = cat["name"].map(e["time_consistent"])
    return cat.sort_values(["disc_mjd", "name"]).reset_index(drop=True)


def load_phot(mode: str, cat: pd.DataFrame) -> pd.DataFrame:
    files = [C.NORM / f for f in PUBLIC_NORM_FILES]
    if mode == "private":
        files.append(C.PRIVATE_NORM / "edp2.parquet")
    parts = []
    for f in files:
        if f.exists():
            parts.append(pd.read_parquet(f))
            print(f"  read {f.name}: {len(parts[-1]):,} rows")
        else:
            print(f"  (missing {f})")
    if not parts:
        return C.empty_norm()
    ph = pd.concat(parts, ignore_index=True)
    if mode == "public" and ph["source"].isin(C.PRIVATE_SOURCES).any():
        sys.exit("refusing: private sources found in public inputs")
    # Re-apply the epoch window (defence in depth) and keep catalog objects only.
    disc = cat.set_index("name")["disc_mjd"]
    d = ph["name"].map(disc)
    keep = d.notna() & ph["mjd"].between(d - C.WINDOW_PRE_D, d + C.WINDOW_POST_D)
    print(f"  kept {int(keep.sum()):,} of {len(ph):,} rows after window/catalog filter")
    return ph[keep].sort_values(["name", "source", "mjd"]).reset_index(drop=True)


def encode_lc(g: pd.DataFrame) -> dict:
    def fl(a, nd):
        return [None if not np.isfinite(v) else round(float(v), nd) for v in a]
    return {"t": fl(g["mjd"].to_numpy(float), 5), "b": g["band"].astype(str).tolist(),
            "f": fl(g["flux"].to_numpy(float), 1), "e": fl(g["flux_err"].to_numpy(float), 1),
            "k": g["kind"].astype(int).tolist(), "l": fl(g["lim_mag"].to_numpy(float), 2),
            "x": g["note"].fillna("").astype(str).tolist()}


def stats_block() -> dict:
    s = json.loads(C.SUMMARY_JSON.read_text())
    m = pd.read_csv(C.MATCH_CSV, usecols=["sep_arcsec"])
    r, dc, ctl = s["real"], s["dia_coverage"], s["control"]
    return {
        "TNS objects discovered MJD 60730-61047": s["tns_in_window"],
        "within 2.1 deg of an EDP2 visit centre (this site)": r["n"],
        "with a visit in [disc-30, disc+100] d": r["active_coverage"],
        "matched to an EDP2 DiaObject within 2\"": r["matched_2as"],
        "matched within 0.5\"": int(m["sep_arcsec"].le(0.5).sum()),
        "median match separation (arcsec)": round(r["sep_arcsec_median"], 2),
        "chance-match rate, 60\" offset control": f"{ctl['matched_2as'] / ctl['n']:.1%}",
        "unmatched visited objects with no DiaObject within 30\"":
            f"{dc['unmatched_zero_dia_30as_frac']:.1%}",
        "recovery inside DIA coverage, <=2\" (sparse-field corrected)":
            f"{dc['est_recovery_2as_sparse_corrected']:.0%}",
        "recovery inside DIA coverage, <=0.5\"": f"{dc['est_recovery_0p5as_sparse_corrected']:.0%}",
    }


def notes(mode: str) -> list[str]:
    n = [
        "Fluxes are in nJy (AB zero point 31.4). TNS-reported magnitudes are converted assuming AB.",
        f"Epochs are limited to {C.WINDOW_PRE_D:.0f} d before to {C.WINDOW_POST_D:.0f} d after TNS discovery.",
        "LSSTCam pointing ticks come from the dp2.Visit table. A visit centre within 1.75 deg does not "
        "guarantee the object fell on a detector or was processed: 88% of visited-but-unmatched objects "
        "have no DiaObject within 30\".",
        "Rubin alert-stream diaObjectIds and DP2 catalog diaObjectIds are different ID spaces; "
        "alerts are associated by position (2\").",
    ]
    if mode == "public":
        n.insert(0, "Rubin DP2 (EDP2) catalog photometry is proprietary under the Rubin Data Policy "
                    "(RDO-13) and is not included. The cross-match numbers on this page are aggregate "
                    "derived statistics.")
    else:
        n.insert(0, "PROPRIETARY: contains Rubin DP2 catalog photometry. For Rubin data-rights holders "
                    "only. Do not redistribute or post publicly (Rubin Data Policy RDO-13).")
        n.append("EDP2 match: nearest dp2.DiaObject within 2\" of the TNS position. About 6% of matches "
                 "are expected to be chance coincidences, mostly at 1-2\".")
    return n


def write_js(path: Path, call: str, payload) -> int:
    txt = f"{call}{json.dumps(payload, separators=(',', ':'), allow_nan=False)});\n"
    path.write_text(txt)
    return len(txt)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--mode", choices=["public", "private"], required=True)
    ap.add_argument("--out", type=Path, help="site root (default: docs/ or PRIVATE/site)")
    a = ap.parse_args()

    out = (a.out or (C.SITE if a.mode == "public" else C.PRIVATE_SITE)).resolve()
    if a.mode == "private" and out.is_relative_to(C.REPO.resolve()):
        sys.exit(f"refusing: private build must live outside the public repo ({out})")
    if a.mode == "private":
        out.mkdir(parents=True, exist_ok=True)
        for f in C.SITE.iterdir():
            if f.is_file() and f.suffix in CODE_SUFFIXES:
                shutil.copy2(f, out / f.name)

    print(f"[{a.mode}] catalog")
    cat = build_catalog(a.mode)
    print(f"[{a.mode}] photometry")
    ph = load_phot(a.mode, cat)

    sources = [s for s in C.SOURCES if s in set(ph["source"])]
    meas = ph[ph["kind"] != C.KIND_UL]
    for s in sources:
        g = meas[meas["source"] == s].groupby("name")["mjd"]
        cat[f"n_{s}"] = cat["name"].map(g.size()).fillna(0).astype(int)
        cat[f"t0_{s}"] = cat["name"].map(g.min())
        cat[f"t1_{s}"] = cat["name"].map(g.max())
    cat["shard"] = np.arange(len(cat)) // C.SHARD_SIZE

    meta = {
        "mode": a.mode,
        "built": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "n_objects": len(cat),
        "window": {"mjd_start": 60790.117, "mjd_end": 61047.155},
        "sources": {s: {**{k: C.SOURCES[s][k] for k in ("label", "desc", "survey")},
                        "n_objects": int(ph.loc[ph["source"] == s, "name"].nunique()),
                        "n_points": int((ph["source"] == s).sum())} for s in sources},
        "stats": stats_block(),
        "notes": notes(a.mode),
    }
    cols = list(cat.columns)
    if a.mode == "public":
        leak = [c for c in cols if "edp2" in c] + [s for s in sources if not C.SOURCES[s]["public"]]
        if leak:
            sys.exit(f"refusing: private fields in public build: {leak}")
    nd = {"ra": 6, "dec": 6, "z": 5, "disc_mjd": 4, "disc_mag": 2, "edp2_sep": 3, "edp2_lead": 2}
    rows = [[_clean(v, nd.get(c) if isinstance(v, (float, np.floating)) else None)
             for c, v in zip(cols, r)] for r in cat.itertuples(index=False, name=None)]

    data = out / "data"
    if (data / "lc").exists():
        shutil.rmtree(data / "lc")
    (data / "lc").mkdir(parents=True)
    size = write_js(data / "catalog.js", "TNSX.onCatalog(", {"meta": meta, "cols": cols, "rows": rows})

    v = pd.read_csv(C.VISITS_CSV, usecols=["expMidptMJD", "band", "ra", "dec"])
    vrows = [[round(t, 5), b, round(r, 4), round(d, 4)]
             for t, b, r, d in v[["expMidptMJD", "band", "ra", "dec"]].itertuples(index=False, name=None)]
    size += write_js(data / "visits.js", "TNSX.onVisits(", {"cols": ["mjd", "band", "ra", "dec"], "rows": vrows})

    shard_of = cat.set_index("name")["shard"]
    ph["shard"] = ph["name"].map(shard_of)
    n_lc = 0
    for sh in range(int(cat["shard"].max()) + 1):
        objs = {}
        for (name, src), g in ph[ph["shard"] == sh].groupby(["name", "source"], sort=False):
            objs.setdefault(name, {})[src] = encode_lc(g)
        size += write_js(data / "lc" / f"{sh:03d}.js", f"TNSX.onShard({sh},", objs)
        n_lc += 1
    print(f"[{a.mode}] wrote {out}/data: {len(cat):,} objects, {n_lc} shards, "
          f"{len(ph):,} points, {size / 1e6:.1f} MB")
    for s in sources:
        print(f"    {s:14s} objects {meta['sources'][s]['n_objects']:5d}  points {meta['sources'][s]['n_points']:8,d}")


if __name__ == "__main__":
    main()
