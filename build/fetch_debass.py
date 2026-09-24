#!/usr/bin/env python3
"""DEBASS follow-up membership for the catalogue, from the DEBASS Google Sheet.

    python build/fetch_debass.py            # download the sheet, write cache/norm/debass.parquet
    python build/fetch_debass.py --offline  # re-match the cached download only

A row is a DEBASS target when its `Following?` cell is FINISHED or YES (common.DEBASS_STATUSES).
Targets join the catalogue by TNS name (`snid`, SN/AT prefix dropped), then by position
(<= common.MATCH_RADIUS_AS) for snids that are not TNS names. Output columns:
name, debass (FINISHED | YES), debass_snid. Only the status is kept; nothing else from the
sheet is published.
"""
from __future__ import annotations

import argparse
import io
import sys
import urllib.request

import numpy as np
import pandas as pd

import common as C

RAW = C.CACHE / "debass_sheet.csv"
PRIORITY = {"YES": 0, "FINISHED": 1}      # a snid listed twice keeps its most active status


def download() -> None:
    req = urllib.request.Request(C.DEBASS_SHEET_CSV, headers={"User-Agent": "tns-edp2-explorer"})
    with urllib.request.urlopen(req, timeout=60) as r:
        raw = r.read()
    s = pd.read_csv(io.BytesIO(raw), dtype=str)
    if "snid" not in s.columns or "Following?" not in s.columns:
        sys.exit(f"refusing: the sheet has no snid / Following? columns ({list(s.columns)[:8]})")
    RAW.parent.mkdir(parents=True, exist_ok=True)
    RAW.write_bytes(raw)
    print(f"downloaded {len(s):,} sheet rows -> {RAW}")


def targets() -> pd.DataFrame:
    s = pd.read_csv(RAW, dtype=str).fillna("")
    t = pd.DataFrame({
        "snid": s["snid"].str.strip(),
        "debass": s["Following?"].str.strip().str.upper(),
        "ra": pd.to_numeric(s["RA"], errors="coerce"),
        "dec": pd.to_numeric(s["DEC"], errors="coerce"),
    })
    t = t[t["debass"].isin(C.DEBASS_STATUSES) & t["snid"].ne("")]
    t = t.sort_values("debass", key=lambda c: c.map(PRIORITY)).drop_duplicates("snid")
    bad = ~t["ra"].between(0, 360, inclusive="left") | ~t["dec"].between(-90, 90) | (t["ra"].eq(0) & t["dec"].eq(0))
    t.loc[bad, ["ra", "dec"]] = np.nan                  # 999 and (0, 0) mean "unset" in the sheet
    return t.reset_index(drop=True)


def match(t: pd.DataFrame, cat: pd.DataFrame) -> pd.DataFrame:
    names = set(cat["name"])
    key = t["snid"].str.replace(r"^(SN|AT)\s*", "", regex=True)
    by_name = t.assign(name=key)[key.isin(names)]
    rest = t[~key.isin(names) & t["ra"].notna()]
    rows = []
    if len(rest):
        r = np.radians
        cr, cd = r(cat["ra"].to_numpy(float)), r(cat["dec"].to_numpy(float))
        for _, x in rest.iterrows():
            c = np.sin(r(x["dec"])) * np.sin(cd) + np.cos(r(x["dec"])) * np.cos(cd) * np.cos(cr - r(x["ra"]))
            j = int(np.argmax(c))
            if np.degrees(np.arccos(min(1.0, c[j]))) * 3600 <= C.MATCH_RADIUS_AS:
                rows.append({**x.to_dict(), "name": cat["name"].iat[j]})
    by_pos = pd.DataFrame(rows, columns=list(t.columns) + ["name"])
    out = pd.concat([f for f in (by_name, by_pos) if len(f)], ignore_index=True) if len(by_name) + len(by_pos) else by_pos
    out = out.sort_values("debass", key=lambda c: c.map(PRIORITY)).drop_duplicates("name")
    print(f"{len(t):,} DEBASS targets ({', '.join(f'{k} {v}' for k, v in t['debass'].value_counts().items())}); "
          f"{len(out)} in this catalogue: {len(by_name)} by name, {len(by_pos)} by position")
    return out.rename(columns={"snid": "debass_snid"})[["name", "debass", "debass_snid"]].sort_values("name")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--offline", action="store_true", help="use the cached sheet download")
    a = ap.parse_args()
    if not a.offline:
        download()
    elif not RAW.exists():
        sys.exit(f"--offline: no cached sheet at {RAW}")
    cat = C.load_targets()[["name", "ra", "dec"]].astype({"name": str})
    out = match(targets(), cat)
    C.DEBASS_NORM.parent.mkdir(parents=True, exist_ok=True)
    out.to_parquet(C.DEBASS_NORM, index=False)
    print(f"wrote {C.DEBASS_NORM}")


if __name__ == "__main__":
    main()
