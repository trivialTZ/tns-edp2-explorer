#!/usr/bin/env python3
"""Assemble the site's JS data files from the normalized photometry.

    python build/assemble.py --mode public                  # -> docs/data/ (committed, GitHub Pages)
    python build/assemble.py --mode public --encrypt-edp2   # + docs/data/edp2/ (ciphertext only)
    python build/assemble.py --mode public --encrypt-edp2 --rotate   # same, with a new salt/key
    python build/assemble.py --mode private                 # -> PRIVATE/site/ (full copy, EDP2 included)

Public mode refuses to emit private sources or columns in plaintext. Without
--encrypt-edp2 it never reads anything under PRIVATE and removes docs/data/edp2/.
With --encrypt-edp2 it also reads the private EDP2 inputs and writes them only as
AES-256-GCM ciphertext (build/crypto_layer.py, SCHEMA.md section 3), keyed by the
TNSX_SITE_PASSWORD team password, then self-checks the result. The key and every
unchanged file are kept while the password is unchanged; --rotate forces a new key. Private mode
refuses to write inside this repo.
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
import hosts as H

PUBLIC_NORM_FILES = ["ztf.parquet", "tns.parquet", "lsst_alert.parquet"]
SPEC_NORM = C.NORM / "tns_spec.parquet"                    # build/fetch_tns_spectra.py (public TNS spectra)
EDP2_NORM = C.PRIVATE_NORM / "edp2.parquet"
EDP2_OBJECTS = C.PRIVATE_NORM / "edp2_objects.parquet"
EDP2_COADD = C.PRIVATE_NORM / "edp2_coadd.parquet"         # build/fetch_edp2_coadd.py
EDP2_COLS = ["edp2_id", "edp2_sep", "edp2_ndia", "edp2_lead", "edp2_tc", "edp2_coadd", "edp2_coadd_bands"]
CODE_SUFFIXES = {".html", ".js", ".css", ".svg", ".png", ".ico", ".txt"}
ROUND = {"ra": 6, "dec": 6, "z": 5, "disc_mjd": 4, "disc_mag": 2, "edp2_sep": 3, "edp2_lead": 2}


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
    cat["region"] = survey_region(cat)
    cat["debass"] = pd.Series(pd.NA, index=cat.index, dtype="string")
    if C.DEBASS_NORM.exists():
        d = pd.read_parquet(C.DEBASS_NORM).drop_duplicates("name").set_index("name")
        cat["debass"] = cat["name"].map(d["debass"]).astype("string")
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
        cat["edp2_coadd"], cat["edp2_coadd_bands"] = None, None
        if EDP2_COADD.exists():
            k = pd.read_parquet(EDP2_COADD).drop_duplicates("name").set_index("name")
            cat["edp2_coadd"] = cat["name"].map(k["edp2_coadd"]).astype("boolean")
            cat["edp2_coadd_bands"] = cat["name"].map(k["edp2_coadd_bands"]).astype("string")
    return cat.sort_values(["disc_mjd", "name"]).reset_index(drop=True)


def _unit(ra, dec) -> np.ndarray:
    ra, dec = np.radians(np.asarray(ra, float)), np.radians(np.asarray(dec, float))
    return np.stack([np.cos(dec) * np.cos(ra), np.cos(dec) * np.sin(ra), np.sin(dec)], -1)


def survey_region(cat: pd.DataFrame) -> list[str]:
    """DDF field name when a dp2.Visit aimed at an LSST Deep Drilling Field covers the object, else "WFD".

    dp2.Visit has no survey-programme column, so this is positional (common.DDF_FIELDS). "WFD"
    therefore also holds the commissioning science-validation fields outside the DDFs.
    """
    v = pd.read_csv(C.VISITS_CSV, usecols=["ra", "dec"])
    vu = _unit(v["ra"], v["dec"])
    field = np.full(len(v), "", dtype=object)
    for name, centres in C.DDF_FIELDS.items():
        for c in centres:
            near = vu @ _unit(*c) >= np.cos(np.radians(C.DDF_POINTING_DEG))
            field[near & (field == "")] = name
    ddf = field != ""
    vu, field = vu[ddf], field[ddf]
    cos_r, out = np.cos(np.radians(C.TICK_RADIUS_DEG)), []
    for o in _unit(cat["ra"], cat["dec"]):
        f = pd.Series(field[vu @ o >= cos_r])
        out.append(f.value_counts().index[0] if len(f) else "WFD")
    return out


def load_phot(mode: str, cat: pd.DataFrame) -> pd.DataFrame:
    files = [C.NORM / f for f in PUBLIC_NORM_FILES]
    if mode == "private":
        files.append(EDP2_NORM)
    ph = read_phot(files, cat)
    if mode == "public" and ph["source"].isin(C.PRIVATE_SOURCES).any():
        sys.exit("refusing: private sources found in public inputs")
    return ph


def read_phot(files: list[Path], cat: pd.DataFrame) -> pd.DataFrame:
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
        "Survey region: DDF when a dp2.Visit pointed within 1 deg of an LSST Deep Drilling Field centre "
        "(COSMOS, ECDFS, EDFS, ELAIS-S1, XMM-LSS) covers the object, otherwise WFD. dp2.Visit has no "
        "survey-programme column, so WFD here also includes commissioning science-validation fields.",
        "DEBASS: objects whose `Following?` status in the DEBASS follow-up sheet is FINISHED or YES.",
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
        n.append("EDP2 deep coadd: the TNS position lies inside a dp2.CoaddPatches patch polygon; bands are "
                 "the ivoa.ObsCore LSST.DP2 deep_coadd bands of that patch. Being within 2.1 deg of a visit "
                 "centre (this catalogue) is a wider area than the deep-coadd footprint.")
    return n


def table_rows(df: pd.DataFrame, cols: list[str]) -> list[list]:
    return [[_clean(v, ROUND.get(c) if isinstance(v, (float, np.floating)) else None)
             for c, v in zip(cols, r)] for r in df[cols].itertuples(index=False, name=None)]


def source_meta(ph: pd.DataFrame, sources: list[str]) -> dict:
    return {s: {**{k: C.SOURCES[s][k] for k in ("label", "desc", "survey")},
                "n_objects": int(ph.loc[ph["source"] == s, "name"].nunique()),
                "n_points": int((ph["source"] == s).sum())} for s in sources}


def add_source_columns(cat: pd.DataFrame, ph: pd.DataFrame, sources: list[str]) -> None:
    """n_<source> (measurements, limits excluded), t0_<source>, t1_<source> per object."""
    meas = ph[ph["kind"] != C.KIND_UL]
    for s in sources:
        g = meas[meas["source"] == s].groupby("name")["mjd"]
        cat[f"n_{s}"] = cat["name"].map(g.size()).fillna(0).astype(int)
        cat[f"t0_{s}"] = cat["name"].map(g.min())
        cat[f"t1_{s}"] = cat["name"].map(g.max())


def shard_payloads(ph: pd.DataFrame, cat: pd.DataFrame) -> dict[int, dict]:
    """{shard: {name: {source: LC}}} for every shard of the catalogue (empty dict if no data)."""
    shard_of = cat.set_index("name")["shard"]
    ph = ph.assign(shard=ph["name"].map(shard_of))
    out = {sh: {} for sh in range(int(cat["shard"].max()) + 1)}
    for (sh, name, src), g in ph.groupby(["shard", "name", "source"], sort=False):
        out[int(sh)].setdefault(name, {})[src] = encode_lc(g)
    return out


def edp2_layer(cat: pd.DataFrame, host_split=None) -> tuple[dict, dict[int, dict], set[str]]:
    """Plaintext of the encrypted team-access layer, aligned with the public catalogue.

    Returns (catalog payload, {shard: {name: {edp2_dia|edp2_fp: LC}}}, diaObjectIds for the
    leak scan). These objects are PROPRIETARY: they may only be handed to crypto_layer.
    host_split = (public rows, encrypted-only rows, public images, fits_withheld) adds the
    encrypted-only host rows (and, while public fits are withheld, the public rows' full
    values) to the catalogue payload, and their figures as data URIs to the shards.
    """
    for f in (EDP2_NORM, EDP2_OBJECTS):
        if not f.exists():
            sys.exit(f"refusing --encrypt-edp2: missing private input {f}")
    priv = build_catalog("private").drop_duplicates("name").set_index("name")
    e = pd.DataFrame({"name": cat["name"].to_numpy()})
    for c in EDP2_COLS:
        e[c] = e["name"].map(priv[c])
    print("[edp2] photometry")
    ph = read_phot([EDP2_NORM], cat)
    if not ph["source"].isin(C.PRIVATE_SOURCES).all():
        sys.exit("refusing --encrypt-edp2: edp2.parquet holds non-EDP2 sources")
    sources = [s for s in C.PRIVATE_SOURCES if s in set(ph["source"])]
    add_source_columns(e, ph, sources)
    cols = [c for c in e.columns if c != "name"]
    payload = {                    # no timestamp: unchanged data must give an unchanged plaintext
        "v": 1,
        "names": e["name"].tolist(),
        "cols": cols,
        "rows": table_rows(e, cols),
        "sources": source_meta(ph, sources),
        "notes": notes("private"),
        "match_radius_arcsec": C.MATCH_RADIUS_AS,
    }
    ids = set(pd.read_parquet(EDP2_OBJECTS, columns=["diaObjectId"])["diaObjectId"].dropna().astype(str))
    matched = int(e["edp2_id"].notna().sum())
    print(f"[edp2] {matched:,} objects with a DiaObject, {len(ph):,} points, "
          f"{len(sources)} sources (encrypting; nothing is written in plaintext)")
    shards = shard_payloads(ph, cat)
    if host_split is not None:
        pub, priv, pub_imgs, withheld = host_split
        uris = {n: u for n in priv["name"] if (u := H.data_uri(n, C.PRIVATE_CACHE / "hosts_webp"))}
        rows = pd.concat([priv, pub]) if withheld else priv
        payload["hosts"] = H.table(rows, {**{n: "shard" for n in uris}, **{n: "file" for n in pub_imgs}})
        shard_of = cat.set_index("name")["shard"]
        for n, u in uris.items():
            shards[int(shard_of[n])].setdefault(H.SHARD_IMG_KEY, {})[n] = u
        print(f"[edp2] hosts: {len(priv)} encrypted-only rows, {len(uris)} embedded figures"
              + (f", plus the withheld fits of {len(pub)} public rows" if withheld else ""))
    return payload, shards, ids


def spectra_shards(cat: pd.DataFrame) -> dict[int, dict]:
    """{shard: {name: [spectrum, ...]}} of the plottable public TNS spectra; sets cat["n_spec_plot"]."""
    cat["n_spec_plot"] = 0
    if not SPEC_NORM.exists():
        return {}
    s = pd.read_parquet(SPEC_NORM)
    shard_of = cat.set_index("name")["shard"]
    s = s[s["name"].isin(shard_of.index)].sort_values(["name", "mjd"])
    cat["n_spec_plot"] = cat["name"].map(s.groupby("name").size()).fillna(0).astype(int)
    out: dict[int, dict] = {}
    for r in s.itertuples(index=False):
        out.setdefault(int(shard_of[r.name]), {}).setdefault(r.name, []).append({
            "t": _clean(r.mjd, 4), "tel": r.tel, "inst": r.inst, "grp": r.grp, "url": r.url,
            "w0": r.w0, "dw": r.dw, "f": [None if v is None or not np.isfinite(v) else float(v) for v in r.f]})
    return out


def write_js(path: Path, call: str, payload) -> int:
    txt = f"{call}{json.dumps(payload, separators=(',', ':'), allow_nan=False)});\n"
    path.write_text(txt)
    return len(txt)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--mode", choices=["public", "private"], required=True)
    ap.add_argument("--out", type=Path, help="site root (default: docs/ or PRIVATE/site)")
    ap.add_argument("--encrypt-edp2", action="store_true",
                    help="public mode: also write the EDP2 layer as AES-GCM ciphertext under data/edp2/, "
                         "keyed by TNSX_SITE_PASSWORD from the rubin_hackathon .env")
    ap.add_argument("--rotate", action="store_true",
                    help="with --encrypt-edp2: draw a new salt and re-encrypt every file. A changed "
                         "TNSX_SITE_PASSWORD does this automatically; --rotate forces it")
    a = ap.parse_args()
    if a.encrypt_edp2 and a.mode != "public":
        sys.exit("--encrypt-edp2 applies to --mode public only")
    if a.rotate and not a.encrypt_edp2:
        sys.exit("--rotate needs --encrypt-edp2")
    password = None
    if a.encrypt_edp2:
        import crypto_layer as CL
        try:
            password = CL.get_password()      # a secret: never print it
        except CL.LayerError as e:
            sys.exit(f"refusing --encrypt-edp2: {e}")

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
    add_source_columns(cat, ph, sources)
    cat["shard"] = np.arange(len(cat)) // C.SHARD_SIZE
    spec = spectra_shards(cat)

    meta = {
        "mode": a.mode,
        "built": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "n_objects": len(cat),
        "window": {"mjd_start": 60790.117, "mjd_end": 61047.155},
        "sources": source_meta(ph, sources),
        "stats": stats_block(),
        "notes": notes(a.mode),
        "regions": ["WFD", *C.DDF_FIELDS],
        "spectra": {"n_objects": int((cat["n_spec_plot"] > 0).sum()), "n_spectra": int(cat["n_spec_plot"].sum())},
        "debass": {"n": int(cat["debass"].notna().sum()), "statuses": list(C.DEBASS_STATUSES),
                   "updated": (datetime.fromtimestamp(C.DEBASS_NORM.stat().st_mtime, timezone.utc).date().isoformat()
                               if C.DEBASS_NORM.exists() else None)},
    }
    if a.encrypt_edp2:
        meta["team_access"] = True   # the site offers the password-unlocked layer in data/edp2/
    cols = list(cat.columns)
    if a.mode == "public":
        leak = [c for c in cols if "edp2" in c] + [s for s in sources if not C.SOURCES[s]["public"]]
        if leak:
            sys.exit(f"refusing: private fields in public build: {leak}")
    rows = table_rows(cat, cols)

    data = out / "data"
    catalog = {"meta": meta, "cols": cols, "rows": rows}
    # Host galaxies (diagnostic): public mode gets only SN Ia-list rows (hosts.py); the
    # encrypted-only rows are added to the EDP2 layer below. Private mode gets every row.
    host_split, host_dir, hosts = None, data / "hosts", H.load(cat)
    if hosts is None:
        if host_dir.exists():
            shutil.rmtree(host_dir)
        print(f"[{a.mode}] hosts: no {C.HOSTS_DIR / 'hosts.parquet'}; host card off")
    else:
        pub, priv, withheld = H.split(hosts, cat)
        if a.mode == "public":
            shown, cache = pub, C.CACHE / "hosts_webp"
        else:
            shown, cache, withheld = hosts, C.PRIVATE_CACHE / "hosts_webp", False
        imgs = H.write_images(shown["name"], host_dir, cache)
        t = H.table(shown, {n: "file" for n in imgs}, withheld=withheld)
        if a.mode == "public":
            H.public_guard(t)
            host_split = (pub, priv, imgs, withheld)
        catalog["hosts"] = t
        meta["hosts"] = {"n_rows": len(shown), "n_images": len(imgs), "fits_withheld": withheld}
        print(f"[{a.mode}] hosts: {len(shown)} rows, {len(imgs)} figures in {host_dir}"
              + ("; fit results withheld until the host run completes" if withheld else ""))
    if (data / "lc").exists():
        shutil.rmtree(data / "lc")
    (data / "lc").mkdir(parents=True)
    size = write_js(data / "catalog.js", "TNSX.onCatalog(", catalog)

    v = pd.read_csv(C.VISITS_CSV, usecols=["expMidptMJD", "band", "ra", "dec"])
    vrows = [[round(t, 5), b, round(r, 4), round(d, 4)]
             for t, b, r, d in v[["expMidptMJD", "band", "ra", "dec"]].itertuples(index=False, name=None)]
    size += write_js(data / "visits.js", "TNSX.onVisits(", {"cols": ["mjd", "band", "ra", "dec"], "rows": vrows})

    shards = shard_payloads(ph, cat)
    for sh, objs in shards.items():
        size += write_js(data / "lc" / f"{sh:03d}.js", f"TNSX.onShard({sh},", objs)
    n_lc = len(shards)
    if (data / "spec").exists():
        shutil.rmtree(data / "spec")
    if spec:
        (data / "spec").mkdir(parents=True)
        for sh, objs in spec.items():
            size += write_js(data / "spec" / f"{sh:03d}.js", f"TNSX.onSpec({sh},", objs)
        print(f"[{a.mode}] spectra: {meta['spectra']['n_spectra']} TNS spectra of {meta['spectra']['n_objects']} objects "
              f"in {len(spec)} files")
    print(f"[{a.mode}] wrote {out}/data: {len(cat):,} objects, {n_lc} shards, "
          f"{len(ph):,} points, {size / 1e6:.1f} MB")
    for s in sources:
        print(f"    {s:14s} objects {meta['sources'][s]['n_objects']:5d}  points {meta['sources'][s]['n_points']:8,d}")

    if a.mode != "public":
        return
    enc_dir = data / "edp2"
    if not a.encrypt_edp2:
        if enc_dir.exists():
            shutil.rmtree(enc_dir)
            print(f"[public] removed {enc_dir} (no --encrypt-edp2)")
        return
    plain, enc_shards, ids = edp2_layer(cat, host_split)
    try:
        n, info = CL.write_layer(data, password, plain, enc_shards, n_lc, ids, rotate=a.rotate)
    except CL.LayerError as e:
        sys.exit(f"refusing: encrypted EDP2 layer not written: {e}")
    key = "key kept (same salt)" if info["key"].startswith("kept") else f"NEW key and salt ({info['reason']})"
    print(f"[public] wrote {enc_dir}: {n_lc + 2} files, {n / 1e6:.1f} MB ciphertext; {key}; "
          f"{info['reused']} unchanged, {info['sealed']} re-encrypted with fresh IVs")
    print("[public] self-check passed: decrypts to the source, wrong password fails, no plaintext "
          "leaks, and a no-change rebuild leaves data/edp2/ byte-identical")


if __name__ == "__main__":
    main()
