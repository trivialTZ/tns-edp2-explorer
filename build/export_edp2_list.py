#!/usr/bin/env python3
"""Private CSV lists of TNS objects with Rubin DP2 (EDP2) data.

    python build/export_edp2_list.py              # both lists, in PRIVATE/
    python build/export_edp2_list.py --outdir DIR

  tns_with_edp2_diaobjectid.csv  a DP2 diaObjectId within 2" and EDP2 photometry
  tns_in_edp2_coadd.csv          inside the DP2 deep-coadd footprint (build/fetch_edp2_coadd.py),
                                 matched or not

PROPRIETARY: DP2 diaObjectIds, EDP2 counts and the coadd footprint are Rubin DP2 data (Rubin
Data Policy RDO-13). The files are written outside this public repo only; share them with Rubin
data-rights holders only.
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

import pandas as pd

import assemble as A
import common as C

MATCHED_CSV = "tns_with_edp2_diaobjectid.csv"
COADD_CSV = "tns_in_edp2_coadd.csv"


def table() -> pd.DataFrame:
    """One row per catalogue object, with its DP2 match, EDP2 photometry counts and coadd coverage."""
    cat = A.build_catalog("private")
    ph = A.read_phot([A.EDP2_NORM], cat)
    ph = ph[ph["kind"] != C.KIND_UL]
    g = ph.groupby(["name", "source"]).size().unstack(fill_value=0)
    t = ph.groupby("name")["mjd"].agg(["min", "max"])
    bands = ph.groupby("name")["band"].agg(lambda s: ",".join(b for b in "ugrizy" if b in set(s)))
    matched = cat["edp2_id"].notna() & cat["edp2_sep"].le(C.MATCH_RADIUS_AS)
    ids = cat["edp2_id"].where(matched).astype("string")
    if not ids.dropna().map(lambda s: bool(re.fullmatch(r"\d{17,19}", s))).all():
        sys.exit("refusing: a DP2 diaObjectId is not a plain integer string (float round-trip?)")
    n = lambda src: cat["name"].map(g[src] if src in g else pd.Series(dtype=int)).fillna(0).astype(int)  # noqa: E731
    res = pd.DataFrame({
        "tns_name": (cat["prefix"].fillna("") + " " + cat["name"]).str.strip(),
        "name": cat["name"],
        "ra": cat["ra"].round(6),
        "dec": cat["dec"].round(6),
        "tns_type": cat["type"],
        "tns_z": cat["z"],
        "disc_mjd": cat["disc_mjd"].round(4),
        "disc_date": pd.to_datetime(cat["disc_mjd"] - 40587, unit="D").dt.strftime("%Y-%m-%d %H:%M"),
        "disc_mag": cat["disc_mag"].round(2),
        "disc_filter": cat["disc_filter"],
        "reporting_group": cat["group"],
        "internal_names": cat["internal"],
        "survey_region": cat["region"],
        "debass": cat["debass"],
        "in_edp2_coadd": cat["edp2_coadd"],
        "edp2_coadd_bands": cat["edp2_coadd_bands"],
        "dp2_diaObjectId": ids,
        "dp2_sep_arcsec": cat["edp2_sep"].where(matched).round(3),
        "dp2_nDiaSources": cat["edp2_ndia"].where(matched).astype("Int64"),
        "n_edp2_dia": n("edp2_dia"),
        "n_edp2_forced": n("edp2_fp"),
        "edp2_bands": cat["name"].map(bands),
        "edp2_first_mjd": cat["name"].map(t["min"]).round(4),
        "edp2_last_mjd": cat["name"].map(t["max"]).round(4),
        "edp2_lead_days": cat["edp2_lead"].where(matched).round(2),
        "edp2_time_consistent": cat["edp2_tc"].where(matched),
        "alert_diaObjectIds": cat["alert_ids"],
        "n_tns_spectra": cat["n_spec"],
    })
    res.insert(res.columns.get_loc("dp2_diaObjectId"), "dp2_matched", matched.to_numpy())
    return res.sort_values(["disc_mjd", "name"]).reset_index(drop=True)


def summary(df: pd.DataFrame) -> str:
    return (f"typed {df['tns_type'].notna().sum():,}, SN Ia {df['tns_type'].fillna('').str.startswith('SN Ia').sum():,}, "
            f"DDF {(df['survey_region'] != 'WFD').sum():,}, DEBASS {df['debass'].notna().sum():,}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--outdir", type=Path, default=C.PRIVATE)
    a = ap.parse_args()
    outdir = a.outdir.resolve()
    if outdir.is_relative_to(C.REPO.resolve()):
        sys.exit(f"refusing: EDP2-derived lists must live outside the public repo ({outdir})")
    outdir.mkdir(parents=True, exist_ok=True)
    df = table()
    has_phot = (df["n_edp2_dia"] + df["n_edp2_forced"]) > 0
    m = df[df["dp2_matched"] & has_phot].drop(columns="dp2_matched")
    m.to_csv(outdir / MATCHED_CSV, index=False)
    print(f"{int(df['dp2_matched'].sum()):,} TNS objects with a DP2 diaObjectId <= {C.MATCH_RADIUS_AS}\"; "
          f"{len(m):,} have EDP2 photometry -> {outdir / MATCHED_CSV}\n  {summary(m)}")
    if df["in_edp2_coadd"].isna().all():
        print(f"no coadd footprint (run build/fetch_edp2_coadd.py); {COADD_CSV} not written")
        return
    c = df[df["in_edp2_coadd"].fillna(False).astype(bool)]
    c.to_csv(outdir / COADD_CSV, index=False)
    print(f"{len(c):,} of {len(df):,} TNS objects are inside the DP2 deep-coadd footprint "
          f"({int(c['dp2_matched'].sum()):,} with a DP2 diaObjectId) -> {outdir / COADD_CSV}\n  {summary(c)}")


if __name__ == "__main__":
    main()
