"""Host-galaxy products -> site tables and images (diagnostic; read-only inputs).

Inputs come from an independent public-data host pipeline in rubin_hackathon
(common.HOSTS_DIR: hosts.parquet, img/<name>.png, README.md). They hold no Rubin DP2
value, but membership of the good-EDP2 list (`in_good_edp2_list`) is derived from
proprietary DP2 detections. So:

- public: only rows of the SN Ia list (spectroscopic SNe Ia with a TNS z, a selection
  made from public TNS data) whose public TNS type on this site starts with "SN Ia".
  assert_public() enforces it; check_public.py re-checks the committed output.
- everything else (the good-EDP2-only rows) goes only into the encrypted layer,
  with its images embedded as data URIs in the encrypted shards.
- in_good_edp2_list itself is never written anywhere.

While any public row's SED fit is still pending, public fit results are withheld
(fit_status shown as "pending", no posteriors): the host run fitted sub-lists at
different times, so partial fit progress correlates with good-EDP2 membership. The
full values then travel in the encrypted layer, and become public once the run is done.
"""
from __future__ import annotations

import hashlib
import io
import shutil
from pathlib import Path

import numpy as np
import pandas as pd

import common as C

PUBLIC_IMG = (400, 80)      # px, WebP quality: data/hosts/<name>.webp
SHARD_IMG = (256, 55)       # px, WebP quality: data URIs inside encrypted shards (base64 twice: keep small)
SHARD_IMG_KEY = "_hosts"    # reserved key in an encrypted shard: {name: data URI}
FIT_OUTCOMES = {"qc_pass", "qc_fail", "pending", "no_host_redshift", "photometry_or_handoff_failed"}

# site column -> hosts.parquet column (whitelist; nothing else is ever copied)
COLS = {
    "host_status": "host_status", "host_tier": "association_tier", "host_id": "host_id", "host_cat": "host_catalog",
    "host_ra": "host_ra", "host_dec": "host_dec", "host_sep": "host_sep_arcsec", "host_dlr": "host_dlr",
    "host_ddlr": "host_d_dlr", "host_z": "host_z", "host_ztype": "host_z_type", "host_zsrc": "host_z_source",
    "host_zcat": "host_catalog_zspec", "host_nbands": "n_bands", "host_bands": "bands", "host_phot": "photometry",
    "host_arm": "fit_arm", "host_fit": "fit_status", "host_imgsrc": "img_background", "host_notes": "notes",
}
for _q, _src in [("logm", "logmass"), ("logsfr", "logsfr"), ("logssfr", "logssfr"), ("age", "age_mw_gyr"), ("av", "av")]:
    for _p in ("p16", "p50", "p84"):
        COLS[f"host_{_q}_{_p}"] = f"{_src}_{_p}"
POSTERIOR_COLS = [c for c in COLS if c.endswith(("_p16", "_p50", "_p84"))]
FIT_COLS = ["host_nbands", "host_bands", "host_phot", "host_arm"] + POSTERIOR_COLS   # blanked while withheld
ROUND = {"host_ra": 6, "host_dec": 6, "host_sep": 3, "host_dlr": 3, "host_ddlr": 3, "host_z": 5, "host_zcat": 5,
         **{c: 3 for c in POSTERIOR_COLS}}
BOILERPLATE = {"diagnostic only (science_usable=false)",
               "independent public-data host pipeline, no TITAN code or products"}   # stated on every card
FORBIDDEN = ("edp2", "good_edp2", "good-edp2", "dp2", "diaobject")                    # never in a public host value
OUT_COLS = ["name", *COLS, "host_img"]
# Pipeline redshift-source tags -> the wording shown on the site.
ZSRC_LABEL = {
    "TNS-reported (ge3dp)": "TNS redshift (3+ decimals)",
    "TNS-reported (le2dp_likely_sn_template)": "TNS redshift, 2 decimals (likely an SN-template fit)",
    "TNS-reported (no_z)": "no TNS redshift",
    "LS DR10 z_spec": "Legacy Surveys DR10 spectroscopic",
    "LS DR10 photo-z median": "Legacy Surveys DR10 photo-z (median)",
}


def load(cat: pd.DataFrame) -> pd.DataFrame | None:
    """hosts.parquet rows for catalogue objects, or None when the products are absent."""
    p = C.HOSTS_DIR / "hosts.parquet"
    if not p.exists():
        return None
    h = pd.read_parquet(p)
    need = {"name", "in_snia_list", "in_good_edp2_list", *COLS.values()}
    missing = need - set(h.columns)
    if missing:
        raise SystemExit(f"refusing: {p} lacks columns {sorted(missing)}")
    h = h.drop_duplicates("name")
    h["host_z_source"] = h["host_z_source"].map(lambda s: ZSRC_LABEL.get(s, s) if isinstance(s, str) else s)
    return h[h["name"].isin(set(cat["name"]))].reset_index(drop=True)


def split(h: pd.DataFrame, cat: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame, bool]:
    """(public rows, encrypted-only rows, fits_withheld)."""
    typ = cat.set_index("name")["type"].astype("string").fillna("")
    public_typed = h["name"].map(typ).fillna("").str.startswith("SN Ia")
    pub = h[h["in_snia_list"].astype(bool) & public_typed].copy()
    priv = h[~h["name"].isin(set(pub["name"]))].copy()
    assert_public(pub, cat)
    withheld = bool(pub["fit_status"].eq("pending").any())
    return pub, priv, withheld


def assert_public(pub: pd.DataFrame, cat: pd.DataFrame) -> None:
    """Every public host row is on the SN Ia list and typed SN Ia on this site."""
    if not pub["in_snia_list"].astype(bool).all():
        raise AssertionError("public host rows must all have in_snia_list")
    typ = cat.set_index("name")["type"].astype("string").fillna("")
    if not pub["name"].map(typ).fillna("").str.startswith("SN Ia").all():
        raise AssertionError("public host rows must all be TNS-typed SN Ia on this site")


def _clean(v, nd=None):
    if v is None or v is pd.NA or (isinstance(v, (float, np.floating)) and not np.isfinite(v)):
        return None
    if isinstance(v, (np.floating, float)):
        return round(float(v), nd) if nd is not None else float(v)
    if isinstance(v, (np.integer, int)) and not isinstance(v, bool):
        return int(v)
    if isinstance(v, (np.bool_, bool)):
        return bool(v)
    return str(v)


def _notes(s, withheld: bool):
    if s is None or (isinstance(s, float) and not np.isfinite(s)):
        return None
    segs = [x.strip() for x in str(s).split(";") if x.strip() and x.strip() not in BOILERPLATE
            and not x.strip().startswith("association tier:")]           # the card shows the tier itself
    if withheld:
        segs = [x for x in segs if not x.startswith("HostPhot")]
    return "; ".join(segs) or None


def table(rows: pd.DataFrame, img: dict[str, str], withheld: bool = False) -> dict:
    """{"cols": OUT_COLS, "rows": [...]} for the site. img: name -> "file" | "shard"."""
    out = []
    for r in rows.to_dict("records"):
        v = {c: _clean(r[src], ROUND.get(c)) for c, src in COLS.items()}
        v["host_notes"] = _notes(r["notes"], withheld)
        if withheld and v["host_fit"] in FIT_OUTCOMES:
            v["host_fit"] = "pending"
            for c in FIT_COLS:
                v[c] = None
        v["host_img"] = img.get(r["name"])
        out.append([r["name"]] + [v[c] for c in OUT_COLS[1:]])
    return {"cols": OUT_COLS, "rows": out}


def public_guard(t: dict) -> None:
    """No list-membership field and no DP2 wording in anything that goes public."""
    bad = [c for c in t["cols"] if c != "name" and not c.startswith("host_")]
    bad += [c for c in t["cols"] if any(k in c.lower() for k in ("list", "good", "edp2", "sep_arcsec"))]
    if bad:
        raise AssertionError(f"public host table has forbidden columns {bad}")
    for row in t["rows"]:
        for x in row:
            if isinstance(x, str) and any(k in x.lower() for k in FORBIDDEN):
                raise AssertionError(f"public host value for {row[0]} mentions DP2/EDP2")


# ------------------------------------------------------------------ images
def _webp(png: Path, px: int, quality: int, cache: Path) -> bytes:
    """Resized WebP of a host figure, cached by source hash and settings (deterministic)."""
    raw = png.read_bytes()
    key = f"{hashlib.sha256(raw).hexdigest()[:24]}_{px}_{quality}.webp"
    f = cache / key
    if f.exists():
        return f.read_bytes()
    from PIL import Image
    im = Image.open(io.BytesIO(raw)).convert("RGB")
    if im.size != (px, px):
        im = im.resize((px, px), Image.LANCZOS)
    b = io.BytesIO()
    im.save(b, "WEBP", quality=quality, method=6)
    cache.mkdir(parents=True, exist_ok=True)
    f.write_bytes(b.getvalue())
    return b.getvalue()


def png_of(name: str) -> Path | None:
    p = C.HOSTS_DIR / "img" / f"{name}.png"
    return p if p.is_file() else None


def write_images(names, dest: Path, cache: Path, size=PUBLIC_IMG) -> set[str]:
    """dest/<name>.webp for every name with a figure; other files in dest are removed."""
    dest.mkdir(parents=True, exist_ok=True)
    done = set()
    for n in sorted(set(names)):
        png = png_of(n)
        if png is None:
            continue
        b = _webp(png, *size, cache)
        f = dest / f"{n}.webp"
        if not f.exists() or f.read_bytes() != b:
            f.write_bytes(b)
        done.add(n)
    for f in dest.iterdir():
        if f.is_file() and f.stem not in done:
            f.unlink()
        elif f.is_dir():
            shutil.rmtree(f)
    return done


def data_uri(name: str, cache: Path, size=SHARD_IMG) -> str | None:
    import base64
    png = png_of(name)
    if png is None:
        return None
    return "data:image/webp;base64," + base64.b64encode(_webp(png, *size, cache)).decode("ascii")
