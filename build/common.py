"""Shared paths, source registry and the normalized photometry contract.

Every fetcher writes one parquet per source with exactly NORM_COLUMNS (see
SCHEMA.md). assemble.py turns those into the static site's JS data files.

Public caches live in <repo>/cache (gitignored). Anything derived from Rubin
DP2/EDP2 catalogs is proprietary (Rubin Data Policy RDO-13, DPOL-506/516) and
must only ever be written under PRIVATE, which sits outside this public repo.
"""
from __future__ import annotations

import os
from pathlib import Path

import numpy as np
import pandas as pd

REPO = Path(__file__).resolve().parents[1]
HACK = Path(os.environ.get("TNSX_HACKATHON", Path.home() / "Documents/GitHub/rubin_hackathon"))

# Inputs produced by rubin_hackathon/scripts/_exp_rsp_tns_edp2_xmatch.py
MATCH_CSV = HACK / "reports/rsp_tns_edp2/tns_edp2_match.csv"      # mixes TNS + EDP2 columns
VISITS_CSV = HACK / "reports/rsp_tns_edp2/visits.csv"             # dp2.Visit (public metadata)
SUMMARY_JSON = HACK / "reports/rsp_tns_edp2/summary.json"         # aggregate stats (DDP)
EDP2_DIA_PARQUET = HACK / "reports/rsp_tns_edp2/diasources.parquet"  # PROPRIETARY
TNS_DUMP = HACK / "data/truth/tns_public.parquet"                 # 2026-07-07 TNS public objects
# Host-galaxy products (independent public-data pipeline, diagnostic): hosts.parquet, img/<name>.png.
# Read-only here. `in_good_edp2_list` in it is DP2-derived and is never published (build/hosts.py).
HOSTS_DIR = Path(os.environ.get("TNSX_HOSTS_DIR", HACK / "reports/tns_edp2_hosts/site"))
ENV_FILE = Path(os.environ.get("TNSX_ENV_FILE", HACK / ".env"))   # TNS creds, RSP_TOKEN: never print

CACHE = REPO / "cache"
NORM = CACHE / "norm"
SITE = REPO / "docs"                                              # served by GitHub Pages

PRIVATE = Path(os.environ.get("TNSX_PRIVATE_DIR", HACK / "reports/tns_edp2_explorer_private"))
PRIVATE_CACHE = PRIVATE / "cache"
PRIVATE_NORM = PRIVATE / "norm"
PRIVATE_SITE = PRIVATE / "site"

ZP_NJY = 31.4            # AB magnitude of 1 nJy
MATCH_RADIUS_AS = 2.0    # TNS <-> EDP2 DiaObject match radius used everywhere
SHARD_SIZE = 100         # objects per lightcurve shard file
# Every source keeps only epochs in [disc_mjd - WINDOW_PRE_D, disc_mjd + WINDOW_POST_D]
# (ZTF forced photometry back to 2018 would otherwise dominate the site size).
WINDOW_PRE_D = 150.0
WINDOW_POST_D = 400.0

KIND_DET, KIND_FORCED, KIND_UL = 0, 1, 2

NORM_COLUMNS = {
    "name": "string",      # TNS name without prefix, e.g. "2025abc" (join key everywhere)
    "source": "string",    # key of SOURCES
    "mjd": "float64",
    "band": "string",      # see SCHEMA.md "Band labels"
    "flux": "float64",     # nJy (AB ZP 31.4); NaN for pure upper limits
    "flux_err": "float64", # nJy; NaN if unknown
    "kind": "int8",        # 0 detection, 1 forced photometry, 2 upper limit
    "lim_mag": "float64",  # limiting AB mag for kind==2, else NaN
    "note": "string",      # free text: instrument/telescope, alert id, flags ("" if none)
}

# Order here is the default legend / toggle order on the site.
SOURCES = {
    "edp2_dia": dict(label="EDP2 DiaSource (detections)", public=False, survey="LSST",
                     desc="Rubin DP2 difference-image detections (dp2.DiaSource). Proprietary."),
    "edp2_fp": dict(label="EDP2 forced (ForcedSourceOnDiaObject)", public=False, survey="LSST",
                    desc="Rubin DP2 forced difference-image photometry at the DiaObject position "
                         "on every overlapping visit (psfDiffFlux). Proprietary."),
    "lsst_alert": dict(label="LSST alerts (Fink)", public=True, survey="LSST",
                       desc="Public Rubin alert-stream DiaSources served by the Fink LSST broker."),
    "lsst_alert_fp": dict(label="LSST alert forced (Fink)", public=True, survey="LSST",
                          desc="Forced photometry carried in public Rubin alert packets."),
    "ztf": dict(label="ZTF alerts (ALeRCE)", public=True, survey="ZTF",
                desc="ZTF alert detections and non-detection limits from ALeRCE."),
    "ztf_fp": dict(label="ZTF forced (ALeRCE)", public=True, survey="ZTF",
                   desc="ZTF forced photometry from ALeRCE."),
    "tns": dict(label="TNS reported", public=True, survey="various",
                desc="Photometry reported to the Transient Name Server (discovery and follow-up)."),
}
PUBLIC_SOURCES = [k for k, v in SOURCES.items() if v["public"]]
PRIVATE_SOURCES = [k for k, v in SOURCES.items() if not v["public"]]


def mag_to_njy(mag, magerr=None):
    """AB mag -> nJy (and its 1-sigma error when magerr is given)."""
    mag = np.asarray(mag, dtype=float)
    f = 10 ** ((ZP_NJY - mag) / 2.5)
    if magerr is None:
        return f
    return f, f * np.log(10) / 2.5 * np.asarray(magerr, dtype=float)


def njy_to_mag(flux):
    flux = np.asarray(flux, dtype=float)
    with np.errstate(divide="ignore", invalid="ignore"):
        return np.where(flux > 0, ZP_NJY - 2.5 * np.log10(flux), np.nan)


def load_targets() -> pd.DataFrame:
    """The 9,330 TNS objects in the EDP2 visit footprint, public columns only.

    `edp2_matched` is exposed ONLY so fetchers can process matched objects first;
    it must never be written to a public output.
    """
    m = pd.read_csv(MATCH_CSV, low_memory=False)
    t = pd.DataFrame({
        "name": m["name"].astype("string"),
        "ra": m["tns_ra"].astype(float),
        "dec": m["tns_dec"].astype(float),
        "disc_mjd": m["disc_mjd"].astype(float),
        "internal_names": m["internal_names"].fillna("").astype("string"),
        "edp2_matched": m["sep_arcsec"].le(MATCH_RADIUS_AS).fillna(False).astype(bool),
    })
    return t.sort_values(["edp2_matched", "name"], ascending=[False, True]).reset_index(drop=True)


def empty_norm() -> pd.DataFrame:
    return pd.DataFrame({c: pd.Series(dtype=d) for c, d in NORM_COLUMNS.items()})


def write_norm(df: pd.DataFrame, path: Path) -> Path:
    """Validate against NORM_COLUMNS and write parquet."""
    missing = set(NORM_COLUMNS) - set(df.columns)
    if missing:
        raise ValueError(f"missing columns: {sorted(missing)}")
    out = df[list(NORM_COLUMNS)].copy()
    out["note"] = out["note"].fillna("")
    out = out.astype(NORM_COLUMNS)
    bad = ~out["source"].isin(list(SOURCES))
    if bad.any():
        raise ValueError(f"unknown source keys: {sorted(out.loc[bad, 'source'].unique())}")
    if not out["kind"].isin([KIND_DET, KIND_FORCED, KIND_UL]).all():
        raise ValueError("kind must be 0, 1 or 2")
    if (out["mjd"].isna()).any():
        raise ValueError("mjd must not be NaN")
    path.parent.mkdir(parents=True, exist_ok=True)
    out.sort_values(["name", "source", "mjd"]).to_parquet(path, index=False)
    return path


def read_env(path: Path = ENV_FILE) -> dict[str, str]:
    """Parse KEY=VALUE lines. Values are secrets: never print or log them."""
    env = {}
    if path.exists():
        for line in path.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip().strip('"').strip("'")
    return env
