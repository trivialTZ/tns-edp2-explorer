"""Team-only list: Rubin DP2 SALT-pass candidates (PROPRIETARY; encrypted layer only).

Source: the whole-DP2 SN search on NERSC (recall_salt_completion_v1_20260928: every one of the
1,450,723 recall-pool objects fitted with SALT3). Its final_salt_pass catalogue (2,857) and the
nested good (2,316) and strict (564) subsets are SALT fit-quality tiers, not spectroscopic
classifications. rubin_hackathon/reports/tns_edp2_explorer_private/dp2_salt/ holds the export
(export_site.py on NERSC) and overlap.py (TNS cross-match). Everything here is Rubin DP2 data or
derived from it, so it reaches the site only through crypto_layer (assemble.py --encrypt-edp2) or the
private build.

Candidates within 2" of a TNS object in this catalogue get the SALT columns on that TNS row (no
duplicate row). The others become rows of their own (name = the DP2 diaObjectId, prefix "DP2"),
which exist only in the encrypted catalogue ("extra" payload) and live in extra shards
x000.js, x001.js ... (shard index XSHARD_BASE + k in the catalogue).

Per object the shards carry:
  edp2_night   the nightly inverse-variance forced-photometry points the SALT fit used (DP2-only rows;
               TNS rows keep their per-visit EDP2 photometry)
  edp2_salt    the SALT3 model + fitted per-band baseline {"t0", "dt", "m": {band: [nJy]}, "bl": {band: nJy}}
Host rows come from the DP2 run of the host pipeline (rubin_hackathon reports/tns_edp2_hosts, HOSTRUN=dp2).
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd

import common as C

SALT_DIR = C.PRIVATE / "dp2_salt"
HOSTS_DP2 = C.HACK / "reports/tns_edp2_hosts/dp2_private/salt_v1/site"
XSHARD_BASE = 10000          # catalogue shard index of extra shard k (docs/app.js K.XSHARD_BASE)
MODEL_DT = 2.0               # days between model samples on the site
TIERS = ["strict", "good", "broad"]
SOURCE = {"edp2_night": dict(label="EDP2 forced, nightly (SALT fit input)", survey="LSST", public=False,
                             desc="Rubin DP2 ForcedSourceOnDiaObject difference flux, usable points (seven quality flags "
                                  "clear) combined per band and night by inverse variance: the points the SALT3 fit used")}
# site column -> cands.parquet column
COLS = {
    "edp2_salt": "tier_site", "edp2_salt_id": "diaObjectId",
    "edp2_salt_z": "exact_z", "edp2_salt_zerr": "exact_z_err", "edp2_salt_t0": "exact_t0", "edp2_salt_t0err": "exact_t0_err",
    "edp2_salt_x1": "exact_x1", "edp2_salt_x1err": "exact_x1_err", "edp2_salt_c": "exact_c", "edp2_salt_cerr": "exact_c_err",
    "edp2_salt_x0": "exact_x0", "edp2_salt_rchi2": "exact_rchi2", "edp2_salt_dof": "exact_dof",
    "edp2_salt_nsig5": "n_sig5_nights", "edp2_salt_nights": "n_nights_grid", "edp2_salt_new": "new_salt_pass",
    "edp2_salt_mi": "in_mi621", "edp2_salt_iac": "flag_ia_consistent", "edp2_salt_dmu": "ia_dmu",
    "edp2_salt_alt": "exact_alt_competitive", "edp2_salt_mwebv": "ebv",
}
ROUND = {"edp2_salt_z": 4, "edp2_salt_zerr": 4, "edp2_salt_t0": 3, "edp2_salt_t0err": 3, "edp2_salt_x1": 3,
         "edp2_salt_x1err": 3, "edp2_salt_c": 4, "edp2_salt_cerr": 4, "edp2_salt_rchi2": 3, "edp2_salt_dmu": 3,
         "edp2_salt_mwebv": 4, "edp2_salt_tnssep": 3}
EXTRA_COLS = ["edp2_salt_tns", "edp2_salt_tnssep", "edp2_salt_tnstype"]   # TNS object within 2" (not in this catalogue)
SALT_COLS = list(COLS) + EXTRA_COLS


def available() -> bool:
    return all((SALT_DIR / f).exists() for f in ("cands.parquet", "lc.parquet", "model.parquet", "overlap.parquet"))


def _x0_sci(v):
    return None if not np.isfinite(v) else float(f"{v:.4e}")


def load() -> dict:
    c = pd.read_parquet(SALT_DIR / "cands.parquet")
    o = pd.read_parquet(SALT_DIR / "overlap.parquet")
    if not (c["diaObjectId"].is_unique and c["diaObjectId"].str.fullmatch(r"\d{15,20}").all()):
        raise SystemExit("refusing: dp2_salt cands.parquet diaObjectIds are not unique digit strings")
    c = c.merge(o, on="diaObjectId", how="left", validate="1:1")
    c["_rank"] = c["tier_site"].map({t: k for k, t in enumerate(TIERS)})
    # a TNS object matched by two candidates keeps the higher tier (then the smaller separation)
    c = c.sort_values(["_rank", "tns_sep", "diaObjectId"]).reset_index(drop=True)
    dup = c["site_name"].notna() & c.duplicated("site_name")
    c.loc[dup, "site_name"] = None
    c["row_name"] = c["site_name"].where(c["site_name"].notna(), c["diaObjectId"])
    return {"c": c, "n_dup_site": int(dup.sum())}


def _vals(r: dict) -> dict:
    out = {}
    for col, src in COLS.items():
        v = r.get(src)
        if col == "edp2_salt_x0":
            out[col] = _x0_sci(float(v))
        elif isinstance(v, (bool, np.bool_)):
            out[col] = bool(v)
        elif isinstance(v, (float, np.floating)):
            out[col] = None if not np.isfinite(v) else round(float(v), ROUND.get(col, 4))
        elif isinstance(v, (np.integer, int)):
            out[col] = int(v)
        else:
            out[col] = None if v is None or v is pd.NA else str(v)
    in_site = isinstance(r.get("site_name"), str)
    out["edp2_salt_tns"] = None if in_site or not isinstance(r.get("tns_name"), str) else \
        (str(r.get("tns_prefix") or "") + " " + r["tns_name"]).strip()
    out["edp2_salt_tnssep"] = None if out["edp2_salt_tns"] is None else round(float(r["tns_sep"]), 3)
    out["edp2_salt_tnstype"] = None if out["edp2_salt_tns"] is None or not isinstance(r.get("tns_type"), str) else r["tns_type"]
    return out


def tns_columns(S: dict, names: pd.Series) -> pd.DataFrame:
    """SALT columns for the catalogue's TNS rows (null where no candidate matches)."""
    c = S["c"][S["c"]["site_name"].notna()]
    by = {r["site_name"]: _vals(r) for r in c.to_dict("records")}
    return pd.DataFrame([by.get(n, {k: None for k in SALT_COLS}) for n in names], columns=SALT_COLS)


def extra_frame(S: dict) -> pd.DataFrame:
    """One row per DP2-only candidate: identity, position, first detection and SALT columns."""
    c = S["c"][S["c"]["site_name"].isna()].copy()
    c = c.sort_values(["_rank", "diaObjectId"]).reset_index(drop=True)
    lc = pd.read_parquet(SALT_DIR / "lc.parquet", columns=["diaObjectId", "mjd", "flux", "flux_err"])
    det = lc[lc["flux"] / lc["flux_err"] >= 5].groupby("diaObjectId")["mjd"].min()
    first = lc.groupby("diaObjectId")["mjd"].min()
    rows = []
    for k, r in enumerate(c.to_dict("records")):
        v = _vals(r)
        d = det.get(r["diaObjectId"], first.get(r["diaObjectId"]))
        rows.append({"name": r["diaObjectId"], "prefix": "DP2", "ra": float(r["ra"]), "dec": float(r["dec"]),
                     "disc_mjd": round(float(d), 4), "edp2_id": r["diaObjectId"], "shard": XSHARD_BASE + k // C.SHARD_SIZE, **v})
    return pd.DataFrame(rows)


def _night_lc(g: pd.DataFrame) -> dict:
    f = lambda a, nd: [None if not np.isfinite(x) else round(float(x), nd) for x in a]   # noqa: E731
    return {"t": f(g["mjd"].to_numpy(float), 5), "b": g["band"].astype(str).tolist(), "f": f(g["flux"].to_numpy(float), 1),
            "e": f(g["flux_err"].to_numpy(float), 1), "k": [1] * len(g), "l": [None] * len(g),
            "x": [f"n={int(n)}" for n in g["n"]]}      # visits in the nightly mean


def _model(g: pd.DataFrame) -> dict:
    t = np.sort(g["mjd"].unique())
    t = t[::int(round(MODEL_DT))] if len(t) > 2 else t
    m, bl = {}, {}
    for b, gb in g.groupby("band"):
        s = gb.set_index("mjd").reindex(t)
        m[b] = [None if not np.isfinite(x) else int(round(float(x))) for x in (s["flux_sn"] + s["baseline"]).to_numpy(float)]
        bl[b] = round(float(gb["baseline"].iloc[0]), 1)
    return {"t0": float(t[0]), "dt": float(t[1] - t[0]) if len(t) > 1 else MODEL_DT, "m": m, "bl": bl}


def shard_data(S: dict, extra: pd.DataFrame, cat_shard: pd.Series) -> tuple[dict[int, dict], dict[int, dict]]:
    """({catalogue shard: {tns name: {edp2_salt}}}, {extra shard k: {id: {edp2_night, edp2_salt}}})."""
    c = S["c"]
    model = pd.read_parquet(SALT_DIR / "model.parquet")
    mod = {k: _model(g) for k, g in model.groupby("diaObjectId", sort=False)}
    lc = pd.read_parquet(SALT_DIR / "lc.parquet").sort_values(["diaObjectId", "mjd"])
    lcs = {k: _night_lc(g) for k, g in lc.groupby("diaObjectId", sort=False)}
    tns, xs = {}, {}
    for r in c[c["site_name"].notna()].to_dict("records"):
        if r["diaObjectId"] in mod and r["site_name"] in cat_shard.index:
            tns.setdefault(int(cat_shard[r["site_name"]]), {})[r["site_name"]] = {"edp2_salt": mod[r["diaObjectId"]]}
    for r in extra.to_dict("records"):
        k = int(r["shard"]) - XSHARD_BASE
        o = {"edp2_night": lcs[r["name"]]}
        if r["name"] in mod:
            o["edp2_salt"] = mod[r["name"]]
        xs.setdefault(k, {})[r["name"]] = o
    return tns, xs


def hosts(S: dict, have: set[str]) -> pd.DataFrame | None:
    """DP2 host-run rows renamed to the row names shown on the site; TNS rows that already have a
    host row from the TNS run keep it."""
    p = HOSTS_DP2 / "hosts.parquet"
    if not p.exists():
        return None
    h = pd.read_parquet(p)
    h["name"] = h["name"].astype(str)
    ren = S["c"].set_index("diaObjectId")["row_name"]
    h["src_name"] = h["name"]
    h["name"] = h["name"].map(ren)
    return h[h["name"].notna() & ~h["name"].isin(have)].drop_duplicates("name").reset_index(drop=True)


def meta(S: dict, extra: pd.DataFrame, n_hosts: int) -> dict:
    c = S["c"]
    tier = c["tier_site"]
    return {"source": "whole-DP2 SN search, recall_salt_completion_v1_20260928 (NERSC)",
            "n": int(len(c)), "tiers": {t: int((tier == t).sum()) for t in TIERS},
            "nested": {"broad": int(len(c)), "good": int(tier.isin(["strict", "good"]).sum()), "strict": int((tier == "strict").sum())},
            "in_catalogue": int(c["site_name"].notna().sum()), "dp2_only": int(len(extra)),
            "tns_outside": int((c["site_name"].isna() & c["tns_name"].notna()).sum()),
            "new_fits": int(c["new_salt_pass"].astype(bool).sum()), "mi621": int(c["in_mi621"].astype(bool).sum()),
            "hosts": n_hosts, "xshard_base": XSHARD_BASE}
