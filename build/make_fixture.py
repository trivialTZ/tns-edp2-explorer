#!/usr/bin/env python3
"""Synthetic site dataset for developing and testing the frontend.

Writes two complete static sites that follow SCHEMA.md section 2 exactly:

    cache/fixture_site/public/    public sources only, meta.mode == "public"
    cache/fixture_site/private/   plus edp2_* sources and columns, mode "private"

Each is a copy of docs/*.html|js|css plus data/catalog.js, data/visits.js and
data/lc/NNN.js. Everything is fake (random positions, names, IDs and SN-like
Bazin lightcurves); nothing is read from TNS, ZTF, Fink or Rubin.

Standard library only, so it runs with any python3:

    python3 build/make_fixture.py                 # 300 objects, seed 42, both modes
    python3 build/make_fixture.py --assets-only   # just recopy docs/*.html|js|css
    python3 -m http.server -d cache/fixture_site/public 8765
"""
from __future__ import annotations

import argparse
import ast
import datetime as dt
import json
import math
import random
import shutil
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
DOCS = REPO / "docs"
OUT = REPO / "cache" / "fixture_site"


def _common_constants() -> dict:
    """Read SOURCES and a few numbers from build/common.py without importing it
    (common.py needs numpy/pandas; this script must run on a bare python3)."""
    tree = ast.parse((REPO / "build" / "common.py").read_text())
    want = {"SOURCES", "SHARD_SIZE", "ZP_NJY", "WINDOW_PRE_D", "WINDOW_POST_D", "MATCH_RADIUS_AS"}
    out = {}

    def ev(node):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "dict":
            return {kw.arg: ev(kw.value) for kw in node.keywords}
        if isinstance(node, ast.Dict):
            return {ev(k): ev(v) for k, v in zip(node.keys, node.values)}
        return ast.literal_eval(node)

    for node in tree.body:
        if isinstance(node, ast.Assign) and len(node.targets) == 1:
            t = node.targets[0]
            if isinstance(t, ast.Name) and t.id in want:
                out[t.id] = ev(node.value)
    missing = want - set(out)
    if missing:
        raise SystemExit(f"could not read {sorted(missing)} from build/common.py")
    return out


K = _common_constants()
SOURCES = K["SOURCES"]
SHARD = int(K["SHARD_SIZE"])
ZP = float(K["ZP_NJY"])
PRE, POST = float(K["WINDOW_PRE_D"]), float(K["WINDOW_POST_D"])
MATCH_R = float(K["MATCH_RADIUS_AS"])

EDP2_WIN = (60790.117, 61047.155)       # dp2.Visit span, as in SCHEMA.md's example
DISC_RANGE = (60735.0, 61071.0)         # 2025-03-01 .. 2026-01-31
ALERT_START = 60930.0                   # fake start of public Rubin alerts
N_VISITS = 28698
TICK_R_DEG = 1.75
NVIS_R_DEG = 2.1

# Fake LSSTCam deep fields (RA, Dec, weight); the rest of the visits are scattered over a
# wide southern area like the real dp2.Visit table. Positions are invented.
FIELDS = [(53.13, -28.10, 3.0), (9.45, -44.0, 2.5), (150.10, 2.20, 2.0), (186.50, 7.00, 2.0),
          (225.0, -39.5, 4.0), (272.0, -24.0, 1.5), (95.00, -25.00, 1.0), (213.0, -6.0, 1.0)]
DEEP_FRAC = 0.35
N_WIDE_POINTINGS = 1500
LSST_BANDS = ["u", "g", "r", "i", "z", "y"]
LSST_BAND_W = [0.07, 0.145, 0.17, 0.28, 0.20, 0.135]
LSST_DEPTH = {"u": 23.6, "g": 24.4, "r": 24.2, "i": 23.8, "z": 23.2, "y": 22.3}
# colour relative to r at peak, and reddening per 100 d after peak
COLOUR = {"u": (0.9, 1.6), "g": (0.15, 1.0), "r": (0.0, 0.0), "i": (0.05, -0.2), "z": (0.2, -0.3),
          "y": (0.35, -0.3), "o": (0.05, 0.1), "c": (0.08, 0.5), "w": (0.05, 0.2), "L": (0.06, 0.3),
          "Clear": (0.05, 0.3), "V": (0.08, 0.6), "B": (0.3, 1.2), "R": (-0.05, -0.1), "I": (0.0, -0.3),
          "G": (0.0, 0.2), "q": (0.03, 0.2)}

TYPES = [("SN Ia", 50), ("SN II", 15), ("SN Ic", 5), ("SLSN-I", 4), ("SN Ia-91T-like", 3),
         ("SN IIn", 3), ("CV", 4), ("AGN", 4), ("TDE", 3), ("SN IIP", 3), ("SN", 2), ("SN IIb", 2),
         ("Varstar", 1), ("SN Ia-CSM", 1)]
# group -> (weight, discovery filter choices, disc mag range, internal-name maker key)
GROUPS = {
    "ATLAS": (30, ["ATLAS-o", "ATLAS-c"], (17.6, 19.6), "atlas"),
    "ZTF": (12, ["ZTF-g", "ZTF-r"], (18.2, 20.4), "ztf"),
    "ALeRCE": (9, ["ZTF-g", "ZTF-r"], (18.4, 20.4), "ztf"),
    "Pan-STARRS": (12, ["PS1-w", "PS1-i"], (19.2, 21.6), "ps"),
    "GOTO": (7, ["GOTO-L"], (17.6, 19.6), "goto"),
    "Fink": (7, ["ZTF-r", "ZTF-g"], (18.6, 20.3), "ztf"),
    "LSST": (12, ["g", "r", "i"], (20.0, 23.6), "lsst"),
    "BlackGEM": (4, ["BlackGEM-q"], (18.4, 20.8), "bg"),
    "GaiaAlerts": (2, ["Gaia-G"], (17.0, 19.0), "gaia"),
    "YSE": (3, ["PS1-g", "PS1-r"], (19.0, 21.4), "ps"),
    "MASTER": (2, ["Clear"], (16.8, 18.6), "master"),
}
TNS_FOLLOWUP = [("ATLAS-o", "ATLAS / ACAM1", 19.6), ("ATLAS-c", "ATLAS / ACAM1", 19.6),
                ("PS1-w", "Pan-STARRS1 / GPC1", 21.5), ("GOTO-L", "GOTO / GOTO-North", 19.8),
                ("ZTF-g", "P48 / ZTF-Cam", 20.5), ("ZTF-r", "P48 / ZTF-Cam", 20.5),
                ("Clear", "MASTER / MASTER-Net", 18.8), ("V", "LCO 1m / Sinistro", 20.5),
                ("g", "LCO 1m / Sinistro", 20.8), ("r", "LCO 1m / Sinistro", 20.8),
                ("R", "Kryoneri / ProLine", 19.5), ("B", "Swift / UVOT", 19.5)]
TNS_NOTE = {"ATLAS": "ATLAS / ACAM1", "ZTF": "P48 / ZTF-Cam", "ALeRCE": "P48 / ZTF-Cam",
            "Fink": "P48 / ZTF-Cam", "Pan-STARRS": "Pan-STARRS1 / GPC1", "GOTO": "GOTO / GOTO-North",
            "LSST": "Rubin / LSSTCam", "BlackGEM": "BlackGEM / BG-Cam", "GaiaAlerts": "Gaia / Gaia-photometric",
            "YSE": "Pan-STARRS1 / GPC1", "MASTER": "MASTER / MASTER-Net"}
LETTERS = "abcdefghijklmnopqrstuvwxyz"


# ---------------------------------------------------------------- helpers

def mag2flux(m):
    return 10 ** ((ZP - m) / 2.5)


def flux2mag(f):
    return ZP - 2.5 * math.log10(f) if f and f > 0 else None


def unit(ra, dec):
    a, d = math.radians(ra), math.radians(dec)
    return (math.cos(d) * math.cos(a), math.cos(d) * math.sin(a), math.sin(d))


def offset(ra, dec, r_deg, rng):
    """Uniform point in a disc of radius r_deg around (ra, dec)."""
    rr = r_deg * math.sqrt(rng.random())
    th = rng.uniform(0, 2 * math.pi)
    d = dec + rr * math.sin(th)
    a = ra + rr * math.cos(th) / max(math.cos(math.radians(d)), 0.05)
    return a % 360.0, max(min(d, 89.9), -89.9)


def wchoice(rng, items, weights):
    return rng.choices(items, weights=weights, k=1)[0]


def rnd(x, n):
    return None if x is None else round(x, n)


def mjd_iso(mjd):
    return (dt.datetime(1858, 11, 17) + dt.timedelta(days=mjd)).strftime("%Y-%m-%d")


def family(band):
    tok = band.split("-")[-1]
    return tok if tok in COLOUR else "r"


class Model:
    """Transient flux model in nJy as a function of (mjd, band)."""

    def __init__(self, rng, kind, disc_mjd, disc_band, disc_mag):
        self.kind = kind
        self.tp = disc_mjd + (rng.uniform(4, 18) if kind == "sn" else rng.uniform(-5, 10))
        self.tr = rng.uniform(2.5, 6.0) if kind == "sn" else 3.0
        self.tf = rng.uniform(12, 45) if kind == "sn" else rng.uniform(8, 25)
        self.t0 = self.tp - self.tr * math.log(self.tf / self.tr - 1) if self.tf > self.tr else self.tp
        self.phase = rng.uniform(0, 6.3)
        self.period = rng.uniform(20, 200)
        self.norm = 1.0
        n = max(self._shape(t) for t in [self.tp + i * 0.25 for i in range(-80, 80)])
        self.norm = 1.0 / n
        # choose the amplitude so the model reproduces the discovery magnitude
        want = mag2flux(disc_mag)
        have = self._band_flux(disc_mjd, disc_band, 1.0)
        self.amp = want / have if have > 0 else want

    def _shape(self, t):
        if self.kind == "agn":
            return 0.6 + 0.4 * math.sin(2 * math.pi * t / self.period + self.phase)
        x = (t - self.t0)
        rise = 1.0 / (1.0 + math.exp(-x / self.tr)) if x / self.tr > -50 else 0.0
        fall = math.exp(-(t - self.t0) / self.tf) if (t - self.t0) / self.tf > -50 else math.exp(50)
        return rise * fall * self.norm

    def _band_flux(self, t, band, amp):
        c0, c1 = COLOUR.get(family(band), (0.0, 0.0))
        dm = c0 + c1 * max(t - self.tp, 0) / 100.0
        return amp * self._shape(t) * 10 ** (-dm / 2.5)

    def flux(self, t, band):
        return self._band_flux(t, band, self.amp)


def noisy(rng, f, depth5):
    sig = mag2flux(depth5) / 5.0
    return f + rng.gauss(0, sig), sig


# ---------------------------------------------------------------- generation

def make_names(rng, n):
    names, used = [], set()
    while len(names) < n:
        year = "2025" if rng.random() < 0.93 else "2026"
        k = 3 if rng.random() < 0.35 else 4
        s = year + "".join(rng.choice(LETTERS) for _ in range(k))
        if s not in used:
            used.add(s)
            names.append(s)
    return names


def make_visits(rng):
    items = list(range(len(FIELDS)))
    weights = [f[2] for f in FIELDS]
    wide = []
    while len(wide) < N_WIDE_POINTINGS:
        ra, sd = rng.uniform(0, 360), rng.uniform(math.sin(math.radians(-75)), math.sin(math.radians(12)))
        wide.append((ra, math.degrees(math.asin(sd))))
    vis = []
    for _ in range(N_VISITS):
        if rng.random() < DEEP_FRAC:
            fi = wchoice(rng, items, weights)
            ra, dec = offset(FIELDS[fi][0], FIELDS[fi][1], 1.2, rng)
        else:
            ra, dec = offset(*rng.choice(wide), 0.25, rng)
        night = rng.randint(int(EDP2_WIN[0]), int(EDP2_WIN[1]) - 1)
        mjd = min(max(night + rng.uniform(0.0, 0.38), EDP2_WIN[0]), EDP2_WIN[1])
        vis.append((mjd, wchoice(rng, LSST_BANDS, LSST_BAND_W), ra, dec))
    vis.sort()
    return vis


def internal_name(rng, key, year2):
    tail3 = "".join(rng.choice(LETTERS) for _ in range(3))
    if key == "atlas":
        return f"ATLAS{year2}{tail3}"
    if key == "ztf":
        return f"ZTF{year2}" + "".join(rng.choice(LETTERS) for _ in range(7))
    if key == "ps":
        return f"PS{year2}{tail3}"
    if key == "goto":
        return f"GOTO{year2}{tail3}"
    if key == "bg":
        return f"BGEM{year2}{tail3}"
    if key == "gaia":
        return f"Gaia{year2}{tail3}"
    if key == "master":
        return f"MASTER OT J{rng.randint(0, 235959):06d}.{rng.randint(10, 99)}-{rng.randint(0, 895959):06d}.{rng.randint(1, 9)}"
    return ""


def lc_dict(points):
    """points: list of (t, band, flux, err, kind, lim, note) -> columnar LC."""
    points.sort(key=lambda p: p[0])
    return {"t": [round(p[0], 5) for p in points], "b": [p[1] for p in points],
            "f": [rnd(p[2], 1) for p in points], "e": [rnd(p[3], 1) for p in points],
            "k": [p[4] for p in points], "l": [rnd(p[5], 3) for p in points],
            "x": [p[6] for p in points]}


def fake_id(rng):
    return "17003" + "".join(str(rng.randint(0, 9)) for _ in range(13))


def build(n_obj: int, seed: int, extra_col: bool):
    rng = random.Random(seed)
    visits = make_visits(rng)
    vu = [unit(v[2], v[3]) for v in visits]
    cos_tick, cos_nvis = math.cos(math.radians(TICK_R_DEG)), math.cos(math.radians(NVIS_R_DEG))
    names = sorted(make_names(rng, n_obj))
    tnames, tweights = [t for t, _ in TYPES], [w for _, w in TYPES]
    gnames, gweights = list(GROUPS), [g[0] for g in GROUPS.values()]

    objects, lcs = [], []
    for name in names:
        anchor = rng.choice(visits)          # "in the footprint": near some visit centre
        ra, dec = offset(anchor[2], anchor[3], 1.6, rng)
        disc = rng.uniform(*DISC_RANGE)
        if name.startswith("2026"):
            disc = rng.uniform(61041.0, DISC_RANGE[1])
        elif disc > 61040.5:
            disc = rng.uniform(DISC_RANGE[0], 61040.5)
        group = wchoice(rng, gnames, gweights)
        _, dfilters, drange, ikey = GROUPS[group]
        if group in ("ZTF", "ALeRCE", "Fink") and dec < -28:
            group, (_, dfilters, drange, ikey) = "ATLAS", GROUPS["ATLAS"]
        dfilt = rng.choice(dfilters)
        dmag = rng.uniform(*drange)
        typ = wchoice(rng, tnames, tweights) if rng.random() < 0.16 else None
        prefix = "SN" if typ and (typ.startswith("SN") or typ.startswith("SLSN")) else "AT"
        z = None
        if typ in ("SN Ia", "SN Ia-91T-like", "SN Ia-CSM", "SN Ic", "SN IIb", "SN"):
            z = rng.uniform(0.015, 0.16)
        elif typ in ("SN II", "SN IIP", "SN IIn"):
            z = rng.uniform(0.008, 0.08)
        elif typ == "SLSN-I":
            z = rng.uniform(0.1, 0.6)
        elif typ == "TDE":
            z = rng.uniform(0.02, 0.12)
        elif typ == "AGN":
            z = rng.uniform(0.1, 1.8)
        elif typ is None and rng.random() < 0.04:
            z = rng.uniform(0.02, 0.2)
        mkind = "agn" if typ in ("AGN", "Varstar") else "sn"
        model = Model(rng, mkind, disc, dfilt, dmag)

        y2 = name[2:4]
        internal = [internal_name(rng, ikey, y2)] if ikey != "lsst" else []
        has_ztf = dec > -28 and (ikey == "ztf" or rng.random() < 0.35)
        if has_ztf and ikey != "ztf":
            internal.append(internal_name(rng, "ztf", y2))
        if ikey != "atlas" and rng.random() < 0.4:
            internal.append(internal_name(rng, "atlas", y2))
        if ikey != "ps" and rng.random() < 0.15:
            internal.append(internal_name(rng, "ps", y2))
        internal = [s for s in internal if s]

        # visits near the object
        u = unit(ra, dec)
        near, n_vis, n_act = [], 0, 0
        for v, w in zip(visits, vu):
            if abs(v[3] - dec) > NVIS_R_DEG + 0.01:
                continue
            c = u[0] * w[0] + u[1] * w[1] + u[2] * w[2]
            if c >= cos_nvis:
                n_vis += 1
                if disc - 30 <= v[0] <= disc + 100:
                    n_act += 1
                if c >= cos_tick:
                    near.append(v)
        lo, hi = disc - PRE, disc + POST
        # which LSST visits actually cover the object (chip gaps etc.)
        covered = [v for v in near if rng.random() < 0.6]

        lc = {}
        # --- ZTF alerts (ALeRCE) and forced photometry
        if has_ztf and rng.random() < 0.92:
            epochs = []
            t = lo + rng.uniform(0, 3)
            gap0 = rng.uniform(lo, hi)  # seasonal gap
            while t < hi:
                if not (gap0 <= t <= gap0 + 110):
                    for b in ("ztf-g", "ztf-r") + (("ztf-i",) if rng.random() < 0.08 else ()):
                        if rng.random() < 0.8:
                            epochs.append((t + rng.uniform(0, 0.1), b))
                t += rng.choice([1, 2, 2, 3, 3, 4])
            depth = 20.6
            det, ul, fp = [], [], []
            for t, b in epochs:
                d5 = depth + rng.gauss(0, 0.35)
                f, s = noisy(rng, model.flux(t, b), d5)
                fp.append((t, b, f, s, 1, None, "forced diff; procstatus 0" if rng.random() > 0.03 else "procstatus 56"))
                if f / s >= 5:
                    det.append((t, b, f, s, 0, None, f"candid {rng.randint(10**18, 10**19 - 1)}"))
                elif rng.random() < 0.35:
                    ul.append((t, b, None, None, 2, d5, "non-detection"))
            if det:
                t_first, t_last = det[0][0], det[-1][0]
                ul = [p for p in ul if t_first - 45 <= p[0] <= t_last + 30]
                lc["ztf"] = lc_dict(det + ul)
                if rng.random() < 0.85:
                    lc["ztf_fp"] = lc_dict(fp)
        # --- TNS reported photometry
        if rng.random() < 0.9:
            pts = []
            dflux = mag2flux(dmag)
            derr = dflux * math.log(10) / 2.5 * rng.uniform(0.03, 0.2)
            pts.append((disc, dfilt, dflux, derr, 0, None, TNS_NOTE[group] + " (discovery)"))
            for _ in range(rng.choice([0, 1, 1, 2, 3])):
                tl = disc - rng.uniform(1, 12)
                pts.append((tl, dfilt, None, None, 2, rng.uniform(19.0, 21.5), TNS_NOTE[group] + " last non-detection"))
            for _ in range(rng.choice([0, 0, 1, 2, 4, 8, 14])):
                b, note, d5 = rng.choice(TNS_FOLLOWUP)
                t = disc + rng.uniform(0.5, 120)
                f = model.flux(t, b)
                m = flux2mag(f)
                if m is not None and m < d5:
                    me = rng.uniform(0.02, 0.25)
                    ff = f * 10 ** (-rng.gauss(0, me) / 2.5)
                    pts.append((t, b, ff, ff * math.log(10) / 2.5 * me, 0, None, note))
                else:
                    pts.append((t, b, None, None, 2, d5 + rng.gauss(0, 0.2), note))
            lc["tns"] = lc_dict(pts)
        # --- Public Rubin alerts via Fink
        alert_ids = []
        al = [v for v in covered if v[0] >= ALERT_START and lo <= v[0] <= hi]
        if al and rng.random() < 0.9:
            det = []
            for v in al:
                f, s = noisy(rng, model.flux(v[0], v[1]), LSST_DEPTH[v[1]] + rng.gauss(0, 0.3))
                if f / s >= 5:
                    det.append((v[0], v[1], f, s, 0, None, f"diaSourceId {fake_id(rng)}"))
            if det:
                alert_ids = [fake_id(rng)] + ([fake_id(rng)] if rng.random() < 0.12 else [])
                lc["lsst_alert"] = lc_dict(det)
                t_first = det[0][0]
                fpv = [v for v in covered if t_first - 30 <= v[0] <= det[-1][0] and lo <= v[0] <= hi]
                if fpv and rng.random() < 0.8:
                    fp = []
                    for v in fpv:
                        f, s = noisy(rng, model.flux(v[0], v[1]), LSST_DEPTH[v[1]] + rng.gauss(0, 0.3))
                        fp.append((v[0], v[1], f, s, 1, None, ""))
                    lc["lsst_alert_fp"] = lc_dict(fp)
        # --- Rubin DP2 (private only; kept separate, merged in for the private build)
        priv = {"edp2_id": None, "edp2_sep": None, "edp2_ndia": None, "edp2_lead": None, "edp2_tc": None}
        plc = {}
        ev = [v for v in covered if lo <= v[0] <= hi] if rng.random() < 0.6 else []
        if ev:
            det, fp = [], []
            for v in ev:
                f, s = noisy(rng, model.flux(v[0], v[1]), LSST_DEPTH[v[1]] + rng.gauss(0, 0.25))
                fp.append((v[0], v[1], f, s, 1, None, f"visit {int(v[0] * 1e5) % 10**9}"))
                if f / s >= 5:
                    det.append((v[0], v[1], f, s, 0, None, f"diaSourceId {fake_id(rng)}"))
            if det:
                plc["edp2_dia"] = lc_dict(det)
                plc["edp2_fp"] = lc_dict(fp)
                pos = [p[0] for p in det if p[2] > 0]
                lead = disc - min(pos) if pos else None
                priv = {"edp2_id": fake_id(rng), "edp2_sep": round(abs(rng.gauss(0, 0.25)) + 0.02, 3),
                        "edp2_ndia": len(det) + rng.randint(0, 3), "edp2_lead": rnd(lead, 2),
                        "edp2_tc": bool(pos) and -30 <= (max(det, key=lambda p: p[2])[0] - disc) <= 100}
        if not plc and rng.random() < 0.05:   # unrelated DiaObject just outside the match radius
            priv = {"edp2_id": fake_id(rng), "edp2_sep": round(rng.uniform(MATCH_R + 0.1, 6.0), 3),
                    "edp2_ndia": rng.randint(1, 4), "edp2_lead": None, "edp2_tc": False}

        n_spec = 0
        spec_types = []
        if typ:
            n_spec = rng.choice([1, 1, 1, 2, 2, 3])
            spec_types = [typ] * n_spec
            if typ == "SN Ia" and n_spec > 1 and rng.random() < 0.3:
                spec_types[0] = "SN Ia-91T-like"
        elif rng.random() < 0.03:
            n_spec, spec_types = 1, ["Other"]

        objects.append(dict(
            name=name, prefix=prefix, ra=round(ra, 6), dec=round(dec, 6), type=typ, z=rnd(z, 4),
            group=group, disc_mjd=round(disc, 5), disc_mag=round(dmag, 2), disc_filter=dfilt,
            internal=",".join(internal), n_visits=n_vis, n_visits_active=n_act,
            alert_ids=",".join(alert_ids), n_spec=n_spec, spec_types=",".join(spec_types),
            priv=priv))
        lcs.append((lc, plc))
    return objects, lcs, visits


def write_site(mode: str, objects, lcs, visits, seed: int, extra_col: bool):
    private = mode == "private"
    site = OUT / mode
    if site.exists():
        shutil.rmtree(site)
    (site / "data" / "lc").mkdir(parents=True)
    copy_assets(site)

    order = [k for k, v in SOURCES.items() if v["public"] or private]
    counts = {k: [0, 0] for k in order}
    rows, shards = [], {}
    for i, (o, (lc, plc)) in enumerate(zip(objects, lcs)):
        full = dict(lc)
        if private:
            full.update(plc)
        shard = i // SHARD
        if full:
            shards.setdefault(shard, {})[o["name"]] = {k: full[k] for k in order if k in full}
        for k in order:
            if k in full:
                counts[k][0] += 1
                counts[k][1] += len(full[k]["t"])
        o["_lc"], o["_shard"] = full, shard

    present = [k for k in order if counts[k][0] > 0]
    pub_src = [k for k in present if SOURCES[k]["public"]]
    cols = ["name", "prefix", "ra", "dec", "type", "z", "group", "disc_mjd", "disc_mag",
            "disc_filter", "internal", "n_visits", "n_visits_active"]
    cols += [f"n_{k}" for k in pub_src]
    for k in pub_src:
        cols += [f"t0_{k}", f"t1_{k}"]
    cols += ["alert_ids", "n_spec", "spec_types", "shard"]
    if private:
        cols += ["n_edp2_dia", "n_edp2_fp", "t0_edp2_dia", "t1_edp2_dia",
                 "edp2_id", "edp2_sep", "edp2_ndia", "edp2_lead", "edp2_tc"]
    if extra_col:
        cols += ["host_name"]
    for i, o in enumerate(objects):
        r = []
        full = o["_lc"]
        for c in cols:
            if c.startswith("n_") and c[2:] in SOURCES:   # measurements: kind 0 or 1, limits excluded
                r.append(sum(1 for k in full[c[2:]]["k"] if k != 2) if c[2:] in full else 0)
            elif c[:3] in ("t0_", "t1_") and c[3:] in SOURCES:
                s = c[3:]
                r.append((full[s]["t"][0] if c[1] == "0" else full[s]["t"][-1]) if s in full else None)
            elif c == "shard":
                r.append(o["_shard"])
            elif c.startswith("edp2_"):
                r.append(o["priv"][c])
            elif c == "host_name":
                r.append(f"WISEA J{i:06d}" if i % 7 == 0 else None)
            else:
                r.append(o[c])
        rows.append(r)

    typed = sum(1 for o in objects if o["type"])
    by_type = {}
    for o in objects:
        if o["type"]:
            by_type[o["type"]] = by_type.get(o["type"], 0) + 1
    stats = {"fixture": True, "n_objects": len(objects), "typed": typed,
             "with_lsst_alerts": counts.get("lsst_alert", [0])[0],
             "with_ztf": counts.get("ztf", [0])[0],
             "typed_by_type": dict(sorted(by_type.items(), key=lambda kv: -kv[1])),
             "recovery_fraction_example": 0.7042}
    if private:
        matched = sum(1 for o in objects if o["priv"]["edp2_sep"] is not None and o["priv"]["edp2_sep"] <= MATCH_R)
        stats["private_example"] = {"matched_2as": matched, "sep_arcsec_median": 0.21}
    meta = {
        "mode": mode,
        "built": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat(),
        "n_objects": len(objects),
        "window": {"mjd_start": EDP2_WIN[0], "mjd_end": EDP2_WIN[1]},
        "sources": {k: {"label": SOURCES[k]["label"], "desc": SOURCES[k]["desc"],
                        "survey": SOURCES[k]["survey"], "n_objects": counts[k][0],
                        "n_points": counts[k][1]} for k in present},
        "stats": stats,
        "notes": [
            "SYNTHETIC FIXTURE: every name, position, ID and lightcurve here is randomly generated "
            f"by build/make_fixture.py (seed {seed}). Not real data.",
            "Discovery dates span 2025-03-01 to 2026-01-31; the EDP2 window is "
            f"{mjd_iso(EDP2_WIN[0])} to {mjd_iso(EDP2_WIN[1])}.",
            f"Every source keeps epochs within [disc - {PRE:g} d, disc + {POST:g} d].",
        ],
        "fixture": True,
    }
    js_write(site / "data" / "catalog.js", "TNSX.onCatalog(", {"meta": meta, "cols": cols, "rows": rows}, ");")
    vrows = [[round(v[0], 5), v[1], round(v[2], 5), round(v[3], 5)] for v in visits]
    js_write(site / "data" / "visits.js", "TNSX.onVisits(", {"cols": ["mjd", "band", "ra", "dec"], "rows": vrows}, ");")
    n_shards = (len(objects) + SHARD - 1) // SHARD
    for s in range(n_shards):
        js_write(site / "data" / "lc" / f"{s:03d}.js", f"TNSX.onShard({s}, ", shards.get(s, {}), ");")
    return site, n_shards, counts


def js_write(path: Path, head: str, obj, tail: str):
    txt = json.dumps(obj, separators=(",", ":"), allow_nan=False)
    path.write_text(head + txt + tail + "\n")


def copy_assets(site: Path):
    n = 0
    for p in sorted(DOCS.iterdir()):
        if p.is_file() and p.suffix in (".html", ".js", ".css", ".svg", ".ico", ".png"):
            shutil.copy2(p, site / p.name)
            n += 1
    if n == 0:
        print("  warning: no docs/*.html|js|css to copy yet")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--n", type=int, default=300, help="number of objects (default 300)")
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--mode", choices=["public", "private", "both"], default="both")
    ap.add_argument("--extra-col", action="store_true",
                    help="add an undocumented catalog column (host_name) to test unknown-column display")
    ap.add_argument("--assets-only", action="store_true",
                    help="only recopy docs/*.html|js|css into existing fixture sites")
    a = ap.parse_args()
    modes = ["public", "private"] if a.mode == "both" else [a.mode]
    if a.assets_only:
        for m in modes:
            site = OUT / m
            if not (site / "data" / "catalog.js").exists():
                raise SystemExit(f"{site} has no data yet; run without --assets-only first")
            copy_assets(site)
            print(f"recopied assets into {site}")
        return
    objects, lcs, visits = build(a.n, a.seed, a.extra_col)
    for m in modes:
        # build() output is reused; write_site adds per-mode keys, so give each a fresh copy
        objs = [dict(o) for o in objects]
        site, n_shards, counts = write_site(m, objs, lcs, visits, a.seed, a.extra_col)
        summary = ", ".join(f"{k}={v[0]}obj/{v[1]}pt" for k, v in counts.items() if v[0])
        print(f"{m}: {site}  ({len(objs)} objects, {n_shards} shards, {len(visits)} visits; {summary})")


if __name__ == "__main__":
    main()
