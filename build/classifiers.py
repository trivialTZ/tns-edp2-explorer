#!/usr/bin/env python3
"""Broker classifications and metaDEBASS scores for the site (public data only).

Inputs: a metaDEBASS scoring run over this catalogue's objects (rubin_hackathon
data/tnsx_eval_*, tools/run_fetch.py + tools/run_score.sh): per survey,

  gold/snapshots_<sv>.parquet            one row per object id and detection number (<= 20)
  silver_<sv>/broker_events.parquet      native broker outputs (class names, probabilities)
  scores/predictions_tnsx_<sv>_v11.parquet   metaDEBASS fusion_v11 probabilities per row

Every input is public: Rubin alert-stream and ZTF alert data, broker outputs, TNS types.

Outputs (cache/norm/, read by assemble.py):
  classifiers.parquet        long table: name, survey, object_id, n_det, mjd, clf, call, conf, label
  classifier_objects.parquet one row per object id: name, survey, object_id, n_det_max, in_sample
  classifier_scorecard.json  how often each classifier was right on the TNS-typed objects

Calls (one letter, broker classifiers only): I = SN Ia, S = SN other than Ia, N = SN (subtype not
given), O = not a supernova, n = not Ia (EarlySNIa below threshold).

metaDEBASS is a meta-layer, not a classifier: its rows (clf = "mdb") carry no call, only its
calibrated confidences P(supernova) (conf) and, for ZTF, P(SN Ia) (p_ia). Its other output, trust
in a broker's call at that detection, is the `trust` column of that broker's rows (only where a
trust model exists; in the v11 run, the ALeRCE ZTF stamp classifiers). It is not graded in the
scorecard; its benchmark lives in the metaDEBASS repository.

Usage:
  python build/classifiers.py [--eval DIR]
"""
from __future__ import annotations

import argparse
import json
import math
import re
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common as C  # noqa: E402

EVAL = C.HACK / "data" / "tnsx_eval_20260924"
OUT = C.NORM / "classifiers.parquet"
OBJ = C.NORM / "classifier_objects.parquet"
CARD = C.NORM / "classifier_scorecard.json"
# metaDEBASS v11 train/cal splits: objects in them are in-sample for the model.
MDB_SPLITS = [C.HACK / "data/gold/split_fusion_v11.json", C.HACK / "data/gold/split_fusion_v11.local.json",
              C.HACK / "data/gold/split_fusion_v11_scc.json"]
CHECKPOINTS = [3, 5, 10]
# metaDEBASS trust columns in the predictions -> the broker they rate
TRUST = {"q__alerce__stamp_classifier": "alerce/stamp_classifier",
         "q__alerce__stamp_classifier_2025_beta": "alerce/stamp_classifier_2025_beta",
         "q__alerce__stamp_classifier_rubin_beta": "alerce/stamp_classifier_rubin_beta",
         "q__fink_lsst__snn": "fink_lsst/snn", "q__fink_lsst__cats": "fink_lsst/cats",
         "q__fink_lsst__early_snia": "fink_lsst/early_snia", "q__lasair__sherlock": "lasair/sherlock"}
JD_MJD = 2400000.5

# Fink LSST CATS broad classes (ELAsTiCC taxonomy prefixes: 111-115 SN, 121-124 fast, 131-135 long,
# 211-215 periodic, 221 AGN).
CATS = {11: "SN-like", 12: "Fast", 13: "Long", 21: "Periodic", 22: "Non-periodic"}
SN_CLASSES = {"SNIa", "SNIbc", "SNII", "SLSN", "SESN", "SNIIn", "SNIIb", "SN"}

# Display registry, in the order shown. kind: ternary (Ia / other SN / not SN), sn (SN or not),
# ia (Ia or not). timing: alert (per detection), static (fixed from the first detection or host
# context), latest (object-level snapshot from the full lightcurve: shown, never scored early).
EXPERTS = [
    {"key": "mdb", "label": "metaDEBASS", "sub": "meta-layer, fusion v11", "surveys": ["LSST", "ZTF"], "kind": "meta", "timing": "alert",
     "ref": "https://github.com/trivialTZ/rubin_hackathon"},
    {"key": "fink_lsst/snn", "label": "Fink SuperNNova", "sub": "SN vs other", "surveys": ["LSST"], "kind": "sn", "timing": "alert",
     "ref": "https://doi.org/10.1093/mnras/stz3312"},
    {"key": "fink_lsst/cats", "label": "Fink CATS", "sub": "broad class", "surveys": ["LSST"], "kind": "sn", "timing": "alert",
     "ref": "https://doi.org/10.1051/0004-6361/202450370"},
    {"key": "fink_lsst/early_snia", "label": "Fink EarlySNIa", "sub": "SN Ia score", "surveys": ["LSST"], "kind": "ia", "timing": "alert",
     "ref": "https://doi.org/10.1051/0004-6361/202142715"},
    {"key": "alerce/stamp_classifier_rubin_beta", "label": "ALeRCE stamp", "sub": "Rubin, beta", "surveys": ["LSST"], "kind": "sn", "timing": "static",
     "ref": "https://doi.org/10.3847/1538-3881/ac0ef1"},
    {"key": "alerce/stamp_classifier", "label": "ALeRCE stamp", "sub": "ZTF", "surveys": ["ZTF"], "kind": "sn", "timing": "static",
     "ref": "https://doi.org/10.3847/1538-3881/ac0ef1"},
    {"key": "alerce/stamp_classifier_2025_beta", "label": "ALeRCE stamp 2025", "sub": "ZTF, beta", "surveys": ["ZTF"], "kind": "sn", "timing": "static",
     "ref": "https://alerce.online/"},
    {"key": "lasair/sherlock", "label": "Lasair Sherlock", "sub": "host context", "surveys": ["LSST", "ZTF"], "kind": "sn", "timing": "static",
     "ref": "https://doi.org/10.1093/rasti/rzae024"},
    {"key": "alerce/lc_classifier_transient", "label": "ALeRCE LC classifier", "sub": "ZTF transient branch, latest", "surveys": ["ZTF"], "kind": "ia", "timing": "latest",
     "ref": "https://doi.org/10.3847/1538-3881/abd5c1"},
    {"key": "alerce/lc_classifier_BHRF_forced_phot_transient", "label": "ALeRCE BHRF", "sub": "ZTF forced phot, latest", "surveys": ["ZTF"], "kind": "ternary",
     "timing": "latest", "ref": "https://alerce.online/"},
    {"key": "alerce/LC_classifier_ATAT_forced_phot(beta)", "label": "ALeRCE ATAT", "sub": "ZTF forced phot, beta, latest", "surveys": ["ZTF"], "kind": "ternary",
     "timing": "latest", "ref": "https://alerce.online/"},
]
BY_KEY = {e["key"]: e for e in EXPERTS}


def _f(v) -> float:
    try:
        v = float(v)
    except (TypeError, ValueError):
        return math.nan
    return v


def in_sample_ids() -> set[str]:
    out = set()
    for p in MDB_SPLITS:
        if p.exists():
            d = json.loads(p.read_text())
            for k in ("train_ids", "cal_ids"):
                out |= {str(x) for x in d.get(k, [])}
    return out


def static_labels(silver: pd.DataFrame) -> dict[tuple[str, str], tuple[str, float, str]]:
    """{(object_id, expert): (call, conf, label)} for static and latest experts, from native outputs."""
    out = {}
    s = silver[silver["availability"].astype(bool) & silver["expert_key"].isin(BY_KEY)]
    for (oid, key), g in s.groupby(["object_id", "expert_key"]):
        e = BY_KEY[key]
        if key == "lasair/sherlock":
            lab = str(g["raw_label_or_score"].dropna().iloc[-1] if g["raw_label_or_score"].notna().any() else g["class_name"].dropna().iloc[-1])
            out[(str(oid), key)] = ("N" if lab == "SN" else "O", math.nan, f"context {lab}")
            continue
        g = g.assign(p=g["canonical_projection"].map(_f)).dropna(subset=["p"])
        g = g[g["class_name"].notna()]
        if not len(g):
            continue
        # one row per class: the latest classifier version wins
        if "classifier_version" in g:
            g = g.sort_values("classifier_version").drop_duplicates("class_name", keep="last")
        top = g.loc[g["p"].idxmax()]
        cls, p = str(top["class_name"]), float(top["p"])
        if e["kind"] in ("ternary", "ia"):     # "ia": the transient branch ranks SN subtypes only
            call = "I" if cls == "SNIa" else "S" if cls in SN_CLASSES else "O"
        else:
            call = "N" if cls in SN_CLASSES else "O"
        out[(str(oid), key)] = (call, p, f"{cls} {p:.2f}")
    return out


def rows_for_survey(sv: str, names: dict[str, str], insample: set[str]) -> tuple[list[dict], list[dict]]:
    gold_p = EVAL / f"gold/snapshots_{sv.lower()}.parquet"
    pred_p = EVAL / f"scores/predictions_tnsx_{sv.lower()}_v11.parquet"
    silv_p = EVAL / f"silver_{sv.lower()}/broker_events.parquet"
    if not (gold_p.exists() and pred_p.exists()):
        print(f"  {sv}: no metaDEBASS run in {EVAL} (skipped)")
        return [], []
    g = pd.read_parquet(gold_p)
    g["object_id"] = g["object_id"].astype(str)
    pr = pd.read_parquet(pred_p)
    pr["object_id"] = pr["object_id"].astype(str)
    qcols = [c for c in TRUST if c in pr.columns and pr[c].notna().any()]
    g = g.merge(pr[["object_id", "n_det", "p_snia", "p_nonia", "p_other", *qcols]], on=["object_id", "n_det"], how="left")
    trust_of = {TRUST[c]: c for c in qcols}
    stat = static_labels(pd.read_parquet(silv_p).assign(object_id=lambda d: d["object_id"].astype(str))) if silv_p.exists() else {}
    col = lambda k, f: f"proj__{k.replace('/', '__')}__{f}"  # noqa: E731
    rows, objs = [], []
    for oid, og in g.sort_values(["object_id", "n_det"]).groupby("object_id", sort=False):
        name = names.get(oid)
        if name is None:
            continue
        nmax = int(og["n_det"].max())
        for d in og.to_dict("records"):
            base = {"name": name, "survey": sv, "object_id": oid, "n_det": int(d["n_det"]),
                    "mjd": round(float(d["alert_jd"]) - JD_MJD, 5) if pd.notna(d["alert_jd"]) else math.nan}
            # metaDEBASS: confidences only, no call (v11 has no LSST Ia head, so no P(Ia) for Rubin IDs)
            pi, pn, po = _f(d.get("p_snia")), _f(d.get("p_nonia")), _f(d.get("p_other"))
            if np.isfinite([pi, pn, po]).all():
                lab = f"P(SN) {pi + pn:.2f}" + (f" · P(Ia) {pi:.2f}" if sv == "ZTF" else "")
                rows.append({**base, "clf": "mdb", "call": None, "conf": round(pi + pn, 4),
                             "p_ia": round(pi, 4) if sv == "ZTF" else math.nan, "label": lab})
            if sv == "LSST":
                s = _f(d.get(col("fink_lsst/snn", "raw_snn_sn_vs_others")))
                if np.isfinite(s):
                    rows.append({**base, "clf": "fink_lsst/snn", "call": "N" if s >= 0.5 else "O", "conf": round(s, 4), "label": f"P(SN) {s:.2f}"})
                cc, cs = _f(d.get(col("fink_lsst/cats", "raw_cats_class"))), _f(d.get(col("fink_lsst/cats", "raw_cats_score")))
                if np.isfinite(cc):
                    nm = CATS.get(int(cc), f"class {int(cc)}")
                    rows.append({**base, "clf": "fink_lsst/cats", "call": "N" if int(cc) == 11 else "O", "conf": round(cs, 4) if np.isfinite(cs) else math.nan,
                                 "label": f"{nm} {cs:.2f}" if np.isfinite(cs) else nm})
                es = _f(d.get(col("fink_lsst/early_snia", "raw_early_snia_score")))
                if np.isfinite(es) and es >= 0:
                    rows.append({**base, "clf": "fink_lsst/early_snia", "call": "I" if es >= 0.5 else "n", "conf": round(es, 4), "label": f"P(Ia) {es:.2f}"})
            for key in [e["key"] for e in EXPERTS if e["timing"] in ("static", "latest") and sv in e["surveys"]]:
                if (oid, key) in stat and (BY_KEY[key]["timing"] == "static" or int(d["n_det"]) == nmax):
                    c, p, lab = stat[(oid, key)]
                    q = _f(d.get(trust_of[key])) if key in trust_of else math.nan
                    rows.append({**base, "clf": key, "call": c, "conf": round(p, 4) if np.isfinite(p) else math.nan, "label": lab,
                                 "trust": round(q, 4) if np.isfinite(q) else math.nan})
        objs.append({"name": name, "survey": sv, "object_id": oid, "n_det_max": int(og["n_det"].max()),
                     "in_sample": oid in insample, "basis": "det"})
    n_gold = len(objs)
    if sv == "LSST" and silv_p.exists():
        extra = alert_rows(pd.read_parquet(silv_p), set(g["object_id"]), names, stat)
        rows += extra
        for oid, n in pd.DataFrame(extra).groupby("object_id")["n_det"].max().items() if extra else []:
            objs.append({"name": names[oid], "survey": sv, "object_id": oid, "n_det_max": int(n), "in_sample": oid in insample, "basis": "alert"})
    print(f"  {sv}: {len(objs)} object ids ({n_gold} scored by metaDEBASS), {len(rows):,} classifier rows")
    return rows, objs


def alert_rows(silver: pd.DataFrame, done: set[str], names: dict[str, str], stat: dict) -> list[dict]:
    """Fink LSST per-alert outputs for alert ids metaDEBASS did not score (no positive detection).

    n_det here is the alert index (every DiaSource, including negative difference detections)."""
    s = silver[silver["expert_key"].str.startswith("fink_lsst/") & silver["n_det"].notna()].copy()
    s["object_id"] = s["object_id"].astype(str)
    s = s[~s["object_id"].isin(done) & s["object_id"].isin(names)]
    rows = []
    for (oid, n), g in s.groupby(["object_id", "n_det"]):
        jd = g["event_time_jd"].dropna()
        base = {"name": names[oid], "survey": "LSST", "object_id": oid, "n_det": int(n),
                "mjd": round(float(jd.iloc[0]) - JD_MJD, 5) if len(jd) else math.nan}
        f = {r["field"]: r["raw_label_or_score"] for r in g.to_dict("records")}
        v = _f(f.get("clf_snnSnVsOthers_score"))
        if np.isfinite(v):
            rows.append({**base, "clf": "fink_lsst/snn", "call": "N" if v >= 0.5 else "O", "conf": round(v, 4), "label": f"P(SN) {v:.2f}"})
        cc, cs = _f(f.get("clf_cats_class")), _f(f.get("clf_cats_score"))
        if np.isfinite(cc):
            nm = CATS.get(int(cc), f"class {int(cc)}")
            rows.append({**base, "clf": "fink_lsst/cats", "call": "N" if int(cc) == 11 else "O", "conf": round(cs, 4) if np.isfinite(cs) else math.nan,
                         "label": f"{nm} {cs:.2f}" if np.isfinite(cs) else nm})
        v = _f(f.get("clf_earlySNIa_score"))
        if np.isfinite(v) and v >= 0:
            rows.append({**base, "clf": "fink_lsst/early_snia", "call": "I" if v >= 0.5 else "n", "conf": round(v, 4), "label": f"P(Ia) {v:.2f}"})
        for key in ("alerce/stamp_classifier_rubin_beta", "lasair/sherlock"):
            if (oid, key) in stat:
                c, p, lab = stat[(oid, key)]
                rows.append({**base, "clf": key, "call": c, "conf": round(p, 4) if np.isfinite(p) else math.nan, "label": lab})
    return rows


def truth_of(cat_types: dict[str, str | None]) -> dict[str, str]:
    sys.path.insert(0, str(C.HACK / "src"))
    from debass_meta.access.tns import map_tns_type_to_ternary  # noqa: PLC0415
    out = {}
    for n, t in cat_types.items():
        tern = map_tns_type_to_ternary(t) if t else None
        if tern:
            out[n] = tern
    return out


def wilson(k: int, n: int) -> list[float] | None:
    if not n:
        return None
    z, p = 1.96, k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return [round(c - h, 3), round(c + h, 3)]


def scorecard(df: pd.DataFrame, objs: pd.DataFrame, truth: dict[str, str]) -> dict:
    """Per survey, classifier, question and checkpoint: n, correct, Wilson 95% CI, majority baseline."""
    ins = set(objs.loc[objs["in_sample"], "object_id"])
    det = set(objs.loc[objs["basis"] == "det", "object_id"])     # n_det = positive detections, as metaDEBASS counts
    df = df[df["name"].isin(truth) & df["object_id"].isin(det)].copy()
    df["truth"] = df["name"].map(truth)
    last = df.groupby(["object_id", "clf"])["n_det"].transform("max") == df["n_det"]
    out = {"checkpoints": CHECKPOINTS, "surveys": {}}
    for sv in ("LSST", "ZTF"):
        s = df[df["survey"] == sv]
        if not len(s):
            continue
        res = {}
        for e in EXPERTS:
            if sv not in e["surveys"] or e["kind"] == "meta":      # metaDEBASS is not graded as a classifier
                continue
            x = s[s["clf"] == e["key"]]
            if e["key"] == "mdb":
                x = x[~x["object_id"].isin(ins)]          # held-out objects only
            qs = {}
            for q in ("sn", "ia"):
                if q == "sn" and e["kind"] == "ia":
                    continue
                if q == "ia" and (e["kind"] == "sn" or (e["key"] == "mdb" and sv == "LSST")):
                    continue
                cells = {}
                for cp in [*CHECKPOINTS, "latest"]:
                    if cp == "latest":
                        y = x[last.loc[x.index]]
                    elif e["timing"] == "latest":
                        continue
                    else:
                        y = x[x["n_det"] == cp]
                    y = y.drop_duplicates("object_id")
                    if q == "sn":
                        pred, true = y["call"].isin(["I", "S", "N"]), y["truth"].isin(["snia", "nonIa_snlike"])
                    else:
                        pred, true = y["call"].eq("I"), y["truth"].eq("snia")
                    n, k = int(len(y)), int((pred == true).sum())
                    if not n:
                        continue
                    maj = max(int(true.sum()), n - int(true.sum()))
                    cells[str(cp)] = {"n": n, "k": k, "ci": wilson(k, n), "base": round(maj / n, 3),
                                      "n_pos": int(true.sum())}
                if cells:
                    qs[q] = cells
            if qs:
                res[e["key"]] = qs
        out["surveys"][sv] = res
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--eval", type=Path, default=None, help=f"metaDEBASS run directory (default {EVAL})")
    a = ap.parse_args()
    if a.eval:
        globals()["EVAL"] = a.eval
    coh = pd.read_csv(EVAL / "cohort/cohort.csv", dtype=str)
    names = dict(zip(coh["object_id"], coh["tns_name"]))
    insample = in_sample_ids()
    rows, objs = [], []
    for sv in ("LSST", "ZTF"):
        r, o = rows_for_survey(sv, names, insample)
        rows += r
        objs += o
    df = pd.DataFrame(rows, columns=["name", "survey", "object_id", "n_det", "mjd", "clf", "call", "conf", "p_ia", "trust", "label"])
    ob = pd.DataFrame(objs, columns=["name", "survey", "object_id", "n_det_max", "in_sample", "basis"])
    import assemble as A  # noqa: PLC0415
    cat = A.build_catalog("public")
    truth = truth_of(dict(zip(cat["name"], cat["type"].where(cat["type"].notna(), None))))
    card = scorecard(df, ob, truth)
    card["experts"] = [{k: e[k] for k in ("key", "label", "sub", "surveys", "kind", "timing", "ref")} for e in EXPERTS]
    card["n_typed"] = {sv: int(ob[(ob["survey"] == sv) & ob["name"].isin(truth)]["name"].nunique()) for sv in ("LSST", "ZTF")}
    card["n_objects"] = {sv: int(ob[ob["survey"] == sv]["name"].nunique()) for sv in ("LSST", "ZTF")}
    card["n_in_sample"] = int(ob["in_sample"].sum())
    C.NORM.mkdir(parents=True, exist_ok=True)
    df.to_parquet(OUT, index=False)
    ob.to_parquet(OBJ, index=False)
    CARD.write_text(json.dumps(card, indent=1))
    print(f"{len(df):,} rows for {df['name'].nunique():,} objects -> {OUT}; scorecard -> {CARD}")
    for sv, res in card["surveys"].items():
        for k, qs in res.items():
            for q, cells in qs.items():
                print(f"  {sv:4s} {k:48s} {q}: " + "  ".join(f"{cp}:{c['k']}/{c['n']}" for cp, c in cells.items()))


if __name__ == "__main__":
    main()
