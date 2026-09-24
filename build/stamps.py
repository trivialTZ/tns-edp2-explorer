"""Image stamps for the object page's Images card.

Public:  Rubin alert cutouts (build/fetch_alert_stamps.py) -> cache/alert_stamps_webp/<name>.webp,
         copied to data/stamps/ and described by the catalogue column `stamp`.
Private: Rubin DP2 deep-coadd cutouts (build/fetch_edp2_stamps.py) -> PRIVATE/cache/edp2_stamps/,
         rendered here to one colour WebP per object. PROPRIETARY pixels: they go only to the
         private site (data/dp2stamps/) or, as data URIs, into the encrypted team-layer shards
         under SHARD_KEY. Never to docs/ in plaintext.
"""
from __future__ import annotations

import base64
import shutil
from io import BytesIO
from pathlib import Path

import numpy as np
import pandas as pd

import common as C

ALERT_NORM = C.NORM / "alert_stamps.parquet"
ALERT_WEBP = C.CACHE / "alert_stamps_webp"
DP2_NPZ = C.PRIVATE_CACHE / "edp2_stamps"
DP2_WEBP = C.PRIVATE_CACHE / "edp2_stamps_webp"
SHARD_KEY = "_stamps"            # reserved key in an encrypted shard: {name: data URI}
DP2_PX, DP2_Q = 144, 55           # data URIs inside encrypted shards: keep small (~2.7 kB each)
BAND_PREF = ["g", "r", "i", "z", "y", "u"]


# ------------------------------------------------------------------ public alert stamps
def alert_column(cat: pd.DataFrame) -> set[str]:
    """Sets cat["stamp"] = "band|mjd|snr|neg" for objects with an alert strip; returns their names."""
    cat["stamp"] = None
    if not ALERT_NORM.exists():
        return set()
    s = pd.read_parquet(ALERT_NORM).drop_duplicates("name").set_index("name")
    have = {p.stem for p in ALERT_WEBP.glob("*.webp")} if ALERT_WEBP.exists() else set()
    s = s[s.index.isin(have) & s.index.isin(set(cat["name"]))]
    val = {n: f"{r.band}|{r.mjd:.5f}|{r.snr:.1f}|{int(r.neg)}" for n, r in s.iterrows()}
    cat["stamp"] = cat["name"].map(val)
    return set(val)


def write_alert(names: set[str], out_dir: Path) -> int:
    if out_dir.exists():
        shutil.rmtree(out_dir)
    if not names:
        return 0
    out_dir.mkdir(parents=True)
    for n in sorted(names):
        shutil.copy2(ALERT_WEBP / f"{n}.webp", out_dir / f"{n}.webp")
    return len(names)


# ------------------------------------------------------------------ private DP2 deep-coadd stamps
def _dp2_bands(name: str) -> list[str]:
    return [b for b in BAND_PREF if (DP2_NPZ / f"{name}_{b}.npz").exists()][:3]


def _stretch(img: np.ndarray, sky: float, noise: float, top: float) -> np.ndarray:
    x = (img - sky) / max(top - sky, noise * 5, 1e-9)
    return np.arcsinh(np.clip(x, 0, None) * 10) / np.arcsinh(10)


def render_dp2(name: str) -> bytes | None:
    """Colour (or single-band grey) WebP of the DP2 deep coadd around `name`; None if no cutouts."""
    from PIL import Image  # noqa: PLC0415
    bands = _dp2_bands(name)
    if not bands:
        return None
    arrs = [np.load(DP2_NPZ / f"{name}_{b}.npz")["img"].astype(float) for b in bands]
    h = min(a.shape[0] for a in arrs)
    w = min(a.shape[1] for a in arrs)
    arrs = [a[:h, :w] for a in arrs]
    chans = []
    for a in arrs:
        f = np.isfinite(a)
        if not f.any():
            chans.append(np.zeros((h, w)))
            continue
        v = a[f]
        sky = float(np.median(v))
        noise = float(1.4826 * np.median(np.abs(v - sky))) or 1e-9
        top = float(np.percentile(v, 99.7))
        chans.append(np.where(f, _stretch(a, sky, noise, top), 0.0))
    if len(chans) >= 3:              # bluest -> B, reddest -> R
        rgb = np.stack([chans[2], chans[1], chans[0]], -1)
    else:
        rgb = np.stack([chans[-1]] * 3, -1)
    im = Image.fromarray((np.clip(rgb, 0, 1) * 255).astype(np.uint8), mode="RGB")
    im = im.transpose(Image.FLIP_TOP_BOTTOM)   # FITS row 0 is the bottom (deep coadds: north up, east left)
    im = im.resize((DP2_PX, DP2_PX), Image.LANCZOS)
    buf = BytesIO()
    im.save(buf, format="WEBP", quality=DP2_Q, method=6)
    return buf.getvalue()


def dp2_images(names) -> dict[str, tuple[bytes, str]]:
    """{name: (webp bytes, band string)} for every name with DP2 cutouts, cached by input mtime."""
    out = {}
    if not DP2_NPZ.exists():
        return out
    cdir = DP2_WEBP / f"{DP2_PX}_q{DP2_Q}"            # a new size or quality re-renders
    cdir.mkdir(parents=True, exist_ok=True)
    for n in names:
        bands = _dp2_bands(n)
        if not bands:
            continue
        cache = cdir / f"{n}.webp"
        src_t = max((DP2_NPZ / f"{n}_{b}.npz").stat().st_mtime for b in bands)
        if cache.exists() and cache.stat().st_mtime >= src_t:
            b = cache.read_bytes()
        else:
            b = render_dp2(n)
            if b is None:
                continue
            cache.write_bytes(b)
        out[n] = (b, "".join(bands))
    return out


def data_uri(b: bytes) -> str:
    return "data:image/webp;base64," + base64.b64encode(b).decode("ascii")
