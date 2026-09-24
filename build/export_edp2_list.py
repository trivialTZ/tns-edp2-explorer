#!/usr/bin/env python3
"""CSV of the TNS objects that have a DP2 diaObjectId (<= 2") and EDP2 photometry.

    python build/export_edp2_list.py            # -> PRIVATE/tns_with_edp2_diaobjectid.csv
    python build/export_edp2_list.py --out X.csv

PROPRIETARY: DP2 diaObjectIds and EDP2 counts are Rubin DP2 catalogue data (Rubin Data Policy
RDO-13). The file is written outside this public repo only; share it with Rubin data-rights
holders only.
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

import pandas as pd

import assemble as A
import common as C

OUT = C.PRIVATE / "tns_with_edp2_diaobjectid.csv"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", type=Path, default=OUT)
    a = ap.parse_args()
    out = a.out.resolve()
    if out.is_relative_to(C.REPO.resolve()):
        sys.exit(f"refusing: EDP2-derived lists must live outside the public repo ({out})")

    cat = A.build_catalog("private")
    ph = A.read_phot([A.EDP2_NORM], cat)
    ph = ph[ph["kind"] != C.KIND_UL]
    g = ph.groupby(["name", "source"]).size().unstack(fill_value=0)
    t = ph.groupby("name")["mjd"].agg(["min", "max"])
    bands = ph.groupby("name")["band"].agg(lambda s: ",".join(b for b in "ugrizy" if b in set(s)))

    matched = cat["edp2_id"].notna() & cat["edp2_sep"].le(C.MATCH_RADIUS_AS)
    df = cat[matched].copy()
    df["n_edp2_dia"] = df["name"].map(g.get("edp2_dia", pd.Series(dtype=int))).fillna(0).astype(int)
    df["n_edp2_fp"] = df["name"].map(g.get("edp2_fp", pd.Series(dtype=int))).fillna(0).astype(int)
    df = df[(df["n_edp2_dia"] + df["n_edp2_fp"]) > 0]
    ids = df["edp2_id"].astype(str)
    if not ids.map(lambda s: bool(re.fullmatch(r"\d{17,19}", s))).all():
        sys.exit("refusing: a DP2 diaObjectId is not a plain integer string (float round-trip?)")

    res = pd.DataFrame({
        "tns_name": (df["prefix"].fillna("") + " " + df["name"]).str.strip(),
        "name": df["name"],
        "ra": df["ra"].round(6),
        "dec": df["dec"].round(6),
        "tns_type": df["type"],
        "tns_z": df["z"],
        "disc_mjd": df["disc_mjd"].round(4),
        "disc_date": pd.to_datetime(df["disc_mjd"] - 40587, unit="D").dt.strftime("%Y-%m-%d %H:%M"),
        "disc_mag": df["disc_mag"].round(2),
        "disc_filter": df["disc_filter"],
        "reporting_group": df["group"],
        "internal_names": df["internal"],
        "survey_region": df["region"],
        "debass": df["debass"],
        "dp2_diaObjectId": ids,
        "dp2_sep_arcsec": df["edp2_sep"].round(3),
        "dp2_nDiaSources": df["edp2_ndia"].astype("Int64"),
        "n_edp2_dia": df["n_edp2_dia"],
        "n_edp2_forced": df["n_edp2_fp"],
        "edp2_bands": df["name"].map(bands),
        "edp2_first_mjd": df["name"].map(t["min"]).round(4),
        "edp2_last_mjd": df["name"].map(t["max"]).round(4),
        "edp2_lead_days": df["edp2_lead"].round(2),
        "edp2_time_consistent": df["edp2_tc"],
        "alert_diaObjectIds": df["alert_ids"],
        "n_tns_spectra": df["n_spec"],
    }).sort_values(["disc_mjd", "name"])
    out.parent.mkdir(parents=True, exist_ok=True)
    res.to_csv(out, index=False)
    print(f"{int(matched.sum()):,} TNS objects with a DP2 diaObjectId <= {C.MATCH_RADIUS_AS}\"; "
          f"{len(res):,} of them have EDP2 photometry -> {out}")
    print(f"  typed: {res['tns_type'].notna().sum():,}  SN Ia: {res['tns_type'].fillna('').str.startswith('SN Ia').sum():,}  "
          f"DDF: {(res['survey_region'] != 'WFD').sum():,}  DEBASS: {res['debass'].notna().sum():,}")


if __name__ == "__main__":
    main()
