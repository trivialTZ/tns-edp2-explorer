#!/usr/bin/env python3
"""Fetch TNS-reported photometry (and spectra metadata) for the target list.

For every name in common.load_targets() order this calls TNS `get/object`
with photometry=1 and spectra=1, caches the raw reply as
cache/raw/tns/<name>.json, then normalizes:

  cache/norm/tns.parquet          common.NORM_COLUMNS, source "tns"
  cache/norm/tns_spectra.parquet  name, n_spectra, first_spec_mjd, spec_types

Rate limits: single-threaded; every response's x-rate-limit-remaining /
x-rate-limit-reset headers are read and the fetcher sleeps until the window
resets before the quota is exhausted. HTTP 429 sleeps until reset and retries.

Credentials come from common.read_env() (TNS_API_KEY, TNS_TNS_ID,
TNS_MARKER_NAME, TNS_MARKER_TYPE). They are secrets: nothing here prints
them, and every log line / stored error string goes through _scrub().

Usage:
  python build/fetch_tns_phot.py                 # fetch all missing, then normalize
  python build/fetch_tns_phot.py --limit 20      # first 20 targets only
  python build/fetch_tns_phot.py --names 2025gyf,2025mjx
  python build/fetch_tns_phot.py --normalize-only
"""
from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402

SOURCE = "tns"
RAW_DIR = common.CACHE / "raw" / "tns"
FAIL_FILE = RAW_DIR / "_failures.json"
OUT_PHOT = common.NORM / "tns.parquet"
OUT_SPEC = common.NORM / "tns_spectra.parquet"
OBJECT_URL = "https://www.wis-tns.org/api/get/object"
JD_MJD = 2400000.5

MAX_ATTEMPTS_PER_RUN = 3      # transient errors, per object per pass
RATE_MARGIN = 1               # stop when this many requests are left in the window
DEFAULT_WAIT_S = 60.0

# --------------------------------------------------------------------------- #
# secrets hygiene                                                              #
# --------------------------------------------------------------------------- #

_SECRETS: list[str] = []


def _scrub(s: object) -> str:
    s = str(s)
    for v in _SECRETS:
        if v and len(v) >= 3:
            s = s.replace(v, "***")
    return s


def log(msg: str) -> None:
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts}] {_scrub(msg)}", flush=True)


# --------------------------------------------------------------------------- #
# TNS client (header / marker / rate-limit logic adapted from                 #
# rubin_hackathon/src/debass_meta/access/tns.py)                              #
# --------------------------------------------------------------------------- #


class TNSAuthError(RuntimeError):
    pass


class TNSTransient(RuntimeError):
    pass


class TNS:
    def __init__(self, env: dict[str, str], timeout_s: float = 60.0):
        self.api_key = env.get("TNS_API_KEY", "")
        self.tns_id = env.get("TNS_TNS_ID", "")
        self.marker_name = env.get("TNS_MARKER_NAME", "")
        self.marker_type = env.get("TNS_MARKER_TYPE", "") or "bot"
        if not (self.api_key and self.tns_id and self.marker_name):
            raise SystemExit("TNS_API_KEY / TNS_TNS_ID / TNS_MARKER_NAME missing from the env file")
        _SECRETS.extend([self.api_key, self.tns_id, self.marker_name])
        self.timeout_s = timeout_s
        self.session = requests.Session()
        self._set_marker(self.marker_type)
        self._marker_checked = False
        self.wait_until = 0.0          # monotonic
        self.last_limit = None
        self.last_remaining = None
        self.n_requests = 0
        self.n_429 = 0
        self.slept_s = 0.0

    def _set_marker(self, mtype: str) -> None:
        self.marker_type = mtype
        marker = {"tns_id": str(self.tns_id), "type": mtype, "name": str(self.marker_name)}
        self.session.headers["User-Agent"] = "tns_marker" + json.dumps(marker, separators=(",", ":"))

    @staticmethod
    def _reset_seconds(r: requests.Response) -> float:
        hdr = r.headers.get("x-rate-limit-reset")
        if hdr:
            try:
                v = float(hdr)
                now = time.time()
                wait = (v - now) if v > now + 5 * 60 else v  # absolute epoch vs relative seconds
                return max(1.0, wait)
            except (TypeError, ValueError):
                pass
        return DEFAULT_WAIT_S

    def _sleep(self, s: float, why: str) -> None:
        if s <= 0:
            return
        if s > 5:
            log(f"rate limit: sleeping {s:.0f}s ({why})")
        self.slept_s += s
        time.sleep(s)

    def _obey(self) -> None:
        now = time.monotonic()
        if self.wait_until > now:
            self._sleep(self.wait_until - now, "window exhausted")

    def _note_headers(self, r: requests.Response) -> None:
        try:
            lim = r.headers.get("x-rate-limit-limit")
            rem = r.headers.get("x-rate-limit-remaining")
            self.last_limit = int(float(lim)) if lim is not None else None
            self.last_remaining = int(float(rem)) if rem is not None else None
        except (TypeError, ValueError):
            self.last_remaining = None
        if self.last_remaining is not None and self.last_remaining <= RATE_MARGIN:
            self.wait_until = time.monotonic() + self._reset_seconds(r) + 1.0

    def post_object(self, name: str) -> dict:
        """One get/object call. Returns the reply dict (has 'objname').

        Raises TNSAuthError (401/403), TNSTransient (retryable), or
        LookupError (object not found / unusable reply).
        """
        payload = {
            "api_key": self.api_key,
            "data": json.dumps({"objname": name, "photometry": "1", "spectra": "1"}),
        }
        while True:
            self._obey()
            try:
                r = self.session.post(OBJECT_URL, data=payload, timeout=self.timeout_s)
            except requests.RequestException as e:
                raise TNSTransient(f"{type(e).__name__}: {_scrub(e)[:200]}") from None
            self.n_requests += 1
            self._note_headers(r)
            try:
                raw = r.json()
            except ValueError:
                raw = {}
            code = raw.get("id_code", r.status_code)
            try:
                code = int(code)
            except (TypeError, ValueError):
                code = r.status_code
            if r.status_code == 429 or code == 429:
                self.n_429 += 1
                wait = self._reset_seconds(r) + 1.0
                self.wait_until = time.monotonic() + wait
                log(f"HTTP 429 on {name}; waiting {wait:.0f}s")
                continue
            if r.status_code in (401, 403) or code in (401, 403):
                if not self._marker_checked:
                    # .env marker type may be wrong (bot vs user): try the other once.
                    self._marker_checked = True
                    alt = "user" if self.marker_type == "bot" else "bot"
                    log(f"HTTP {code} with marker type '{self.marker_type}'; retrying once with '{alt}'")
                    self._set_marker(alt)
                    continue
                raise TNSAuthError(f"TNS auth failed (HTTP {r.status_code}, id_code {code})")
            if r.status_code >= 500 or not raw:
                raise TNSTransient(f"HTTP {r.status_code}, unparseable/empty reply")
            self._marker_checked = True
            if code != 200:
                msg = _scrub(raw.get("id_message", ""))[:120]
                if code in (400, 404, 110):
                    raise LookupError(f"id_code {code}: {msg}")
                raise TNSTransient(f"id_code {code}: {msg}")
            data = raw.get("data")
            if isinstance(data, dict) and "reply" in data and isinstance(data["reply"], dict):
                data = data["reply"]
            if not isinstance(data, dict) or not data.get("objname"):
                snippet = _scrub(json.dumps(data)[:160]) if data is not None else "None"
                raise LookupError(f"no object in reply: {snippet}")
            return data


# --------------------------------------------------------------------------- #
# cache                                                                        #
# --------------------------------------------------------------------------- #


def raw_path(name: str) -> Path:
    return RAW_DIR / f"{name}.json"


def load_failures() -> dict:
    if FAIL_FILE.exists():
        try:
            return json.loads(FAIL_FILE.read_text())
        except ValueError:
            return {}
    return {}


def save_json_atomic(path: Path, obj) -> None:
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")))
    os.replace(tmp, path)


def fetch(names: list[str], normalize_every: int, retry_notfound: bool) -> dict:
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    fails = load_failures()
    todo = [n for n in names if not raw_path(n).exists()]
    if not retry_notfound:
        skipped_nf = [n for n in todo if fails.get(n, {}).get("kind") == "not_found"]
        todo = [n for n in todo if fails.get(n, {}).get("kind") != "not_found"]
    else:
        skipped_nf = []
    log(f"targets requested {len(names)}; cached {len(names) - len(todo) - len(skipped_nf)}; "
        f"to fetch {len(todo)}; skipped not-found {len(skipped_nf)}")
    if not todo:
        return {"ok": 0, "fail": 0}

    env = common.read_env()
    # Non-secret marker fields can be overridden from the process environment,
    # e.g. TNS_TNS_ID=<bot id> TNS_MARKER_NAME=<bot name> TNS_MARKER_TYPE=bot (bot quota).
    env.update({k: os.environ[k] for k in ("TNS_TNS_ID", "TNS_MARKER_NAME", "TNS_MARKER_TYPE")
                if os.environ.get(k)})
    client = TNS(env)
    t0 = time.time()
    ok = fail = 0
    retry_later: list[str] = []

    def one(name: str, final_pass: bool) -> bool:
        nonlocal ok, fail
        for attempt in range(1, MAX_ATTEMPTS_PER_RUN + 1):
            try:
                data = client.post_object(name)
            except TNSAuthError as e:
                save_json_atomic(FAIL_FILE, fails)
                log(f"FATAL: {e}. Stopping.")
                raise SystemExit(2)
            except LookupError as e:
                rec = fails.get(name, {})
                fails[name] = {"kind": "not_found", "attempts": rec.get("attempts", 0) + 1,
                               "error": _scrub(e)[:200], "last_try": _now()}
                log(f"not found: {name}: {_scrub(e)[:120]}")
                fail += 1
                return False
            except TNSTransient as e:
                wait = 5.0 * 3 ** (attempt - 1)
                log(f"transient error on {name} (attempt {attempt}): {_scrub(e)[:160]}")
                if attempt < MAX_ATTEMPTS_PER_RUN:
                    time.sleep(wait)
                    continue
                rec = fails.get(name, {})
                fails[name] = {"kind": "transient", "attempts": rec.get("attempts", 0) + attempt,
                               "error": _scrub(e)[:200], "last_try": _now()}
                if not final_pass:
                    retry_later.append(name)
                fail += 1
                return False
            if str(data.get("objname")) != name:
                log(f"warning: asked {name}, got objname {data.get('objname')}")
            data["_fetched_utc"] = _now()
            save_json_atomic(raw_path(name), data)
            fails.pop(name, None)
            ok += 1
            return True
        return False

    try:
        for i, name in enumerate(todo, 1):
            one(name, final_pass=False)
            if i % 25 == 0 or i == len(todo):
                el = time.time() - t0
                rate = i / el * 3600 if el > 0 else float("nan")
                left = len(todo) - i
                eta_h = left / rate if rate > 0 else float("nan")
                log(f"progress {i}/{len(todo)} ok={ok} fail={fail} | {rate:.0f} obj/h | "
                    f"requests={client.n_requests} 429s={client.n_429} slept={client.slept_s:.0f}s | "
                    f"window limit={client.last_limit} remaining={client.last_remaining} | "
                    f"ETA {eta_h:.2f} h")
                save_json_atomic(FAIL_FILE, fails)
            if normalize_every and i % normalize_every == 0:
                try:
                    normalize()
                except Exception as e:  # never kill the fetch loop over normalization
                    log(f"normalize failed mid-run: {type(e).__name__}: {_scrub(e)[:200]}")
        if retry_later:
            log(f"retrying {len(retry_later)} transient failures")
            for name in retry_later:
                if one(name, final_pass=True):
                    fail -= 1
    finally:
        save_json_atomic(FAIL_FILE, fails)
    el = time.time() - t0
    log(f"fetch done: ok={ok} fail={fail} in {el / 60:.1f} min; requests={client.n_requests} "
        f"429s={client.n_429}; window limit seen={client.last_limit}")
    return {"ok": ok, "fail": fail}


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# --------------------------------------------------------------------------- #
# normalization                                                                #
# --------------------------------------------------------------------------- #

# Filter-name tokens that name a survey / photometric system -> canonical label.
SYSTEMS = {
    "ztf": "ZTF", "atlas": "ATLAS", "ps1": "PS1", "p1": "PS1", "ps2": "PS2", "p2": "PS2",
    "goto": "GOTO", "blackgem": "BlackGEM", "bg": "BlackGEM", "meerlicht": "MeerLICHT",
    "ml": "MeerLICHT", "gaia": "Gaia", "sm": "SkyMapper", "skymapper": "SkyMapper",
    "lsst": "LSST", "rubin": "LSST", "decam": "DECam", "wfst": "WFST", "crts": "CRTS",
    "asassn": "ASASSN", "asas": "ASASSN", "last": "LAST", "uvot": "UVOT", "swift": "UVOT",
    "2mass": "2MASS", "wise": "WISE", "neowise": "WISE", "tess": "TESS", "kait": "KAIT",
    "mosfit": "MOSFiT", "des": "DES", "hsc": "HSC", "kmtnet": "KMTNet", "tnts": "TNTS",
    "xoss": "XOSS", "sn2.0": "SN2.0", "mephisto": "Mephisto", "tomoe": "Tomo-e",
    "kiso": "Kiso", "lco": "LCO", "megacam": "MegaCam", "ptf": "PTF", "bgem": "BlackGEM",
    "ogle": "OGLE", "moa": "MOA", "master": "MASTER", "ztf-cam": "ZTF", "ukirt": "UKIRT",
    "vista": "VISTA", "euclid": "Euclid", "jwst": "JWST", "hst": "HST", "wtp": "WTP",
}
# Standard systems: drop the system and keep the plain filter letter.
STANDARD = {"johnson", "cousins", "bessell", "sloan", "sdss", "landolt", "jc", "kron"}
COLOUR_WORDS = {"orange": "o", "cyan": "c", "white": "Clear"}
CLEAR = {"clear", "open", "unfiltered", "none", "white", "cl", "lum", "luminance", "unf"}
RADIO_RE = re.compile(r"(band$|mhz|ghz|radio|x-?ray|kev)", re.I)

# Instrument / telescope substrings -> survey label, used only when the filter
# name itself carries no system (e.g. filter "r" from "ZTF-Cam").
INSTRUMENT_SURVEY = [
    (re.compile(r"^ztf|p48", re.I), "ZTF"),
    (re.compile(r"atlas|^acam", re.I), "ATLAS"),
    (re.compile(r"^ps1$|^gpc1$|pan-?starrs", re.I), "PS1"),
    (re.compile(r"^ps2$|^gpc2$", re.I), "PS2"),
    (re.compile(r"goto", re.I), "GOTO"),
    (re.compile(r"blackgem|^bg\d", re.I), "BlackGEM"),
    (re.compile(r"meerlicht", re.I), "MeerLICHT"),
    (re.compile(r"lsstcam|rubin|simonyi", re.I), "LSST"),
    (re.compile(r"wfst", re.I), "WFST"),
    (re.compile(r"gaia", re.I), "Gaia"),
]

# Vega -> AB offsets (m_AB - m_Vega), Blanton & Roweis 2007 (AJ 133, 734), table 1.
# Applied ONLY for unambiguous Johnson-Cousins / 2MASS filters.
VEGA_TO_AB = {"U": 0.79, "B": -0.09, "V": 0.02, "R": 0.21, "I": 0.45,
              "J": 0.91, "H": 1.39, "K": 1.85, "Ks": 1.85}

# f_nu units -> nJy multiplier
FNU_UNITS = {"jy": 1e9, "mjy": 1e6, "ujy": 1e3, "µjy": 1e3, "μjy": 1e3, "njy": 1.0,
             "erg cm(-2) sec(-1) hz(-1)": 1e32, "erg/cm2/s/hz": 1e32, "erg cm-2 s-1 hz-1": 1e32}


def _name(obj) -> str:
    if isinstance(obj, dict):
        return str(obj.get("name") or "").strip()
    return str(obj or "").strip()


def _num(v) -> float:
    if v is None or v == "":
        return math.nan
    try:
        f = float(v)
    except (TypeError, ValueError):
        return math.nan
    return f if math.isfinite(f) else math.nan


def instrument_survey(tel: str, inst: str) -> str | None:
    for s in (inst, tel):
        if not s:
            continue
        for rx, lab in INSTRUMENT_SURVEY:
            if rx.search(s):
                return lab
    return None


def band_label(filt: str, tel: str = "", inst: str = "") -> tuple[str, str | None]:
    """TNS filter name -> (band label per SCHEMA.md, standard filter letter or None).

    'r-ZTF' -> 'ZTF-r', 'orange-ATLAS' -> 'ATLAS-o', 'w-P1' -> 'PS1-w',
    'L-GOTO' -> 'GOTO-L', 'BG-q-BlackGem' -> 'BlackGEM-q', 'V-Johnson' -> 'V',
    'Clear-' -> 'Clear'. A system-less filter from a known survey instrument
    gets the survey prefix ('r' on ZTF-Cam -> 'ZTF-r'). The second value is the
    Johnson/Cousins/2MASS letter when the filter is one (used for Vega->AB).
    """
    f = (filt or "").strip()
    if not f:
        return "Other", None
    toks = [t for t in f.split("-") if t]
    if not toks or (len(toks) == 1 and toks[0].lower() in CLEAR):
        return "Clear", None
    system, std, band_toks = None, False, []
    for t in toks:
        tl = t.lower()
        if tl in SYSTEMS and len(toks) > 1:
            if system is None:
                system = SYSTEMS[tl]
            elif SYSTEMS[tl] != system:
                band_toks.append(t)
        elif tl in STANDARD:
            std = True
        else:
            band_toks.append(t)
    if not band_toks:                 # filter literally named after a system
        band_toks, system = [toks[0]], None
    if system is None and not std and len(band_toks) == 2:
        # TNS convention '<band>-<system>' for a system not in SYSTEMS
        band_toks, system = [band_toks[0]], band_toks[1]
    band = "-".join(band_toks)
    band = COLOUR_WORDS.get(band.lower(), band)
    if band.lower() in CLEAR:
        return "Clear", None
    if system is None and not std:
        sv = instrument_survey(tel, inst)
        if sv and len(band) <= 2:
            system = sv
    std_letter = band if band in VEGA_TO_AB and (std or system in (None, "2MASS")) else None
    return (f"{system}-{band}" if system else band), std_letter


def make_note(tel: str, inst: str, extra: str = "") -> str:
    parts = []
    for s in (tel, inst):
        if s and s not in parts and s.lower() not in ("other", "none"):
            parts.append(s)
    note = "/".join(parts)
    if extra:
        note = f"{note} ({extra})" if note else extra
    return note


def normalize_object(name: str, data: dict, disc_mjd: float, stats: Counter,
                     bands: Counter) -> list[dict]:
    rows = []
    lo, hi = disc_mjd - common.WINDOW_PRE_D, disc_mjd + common.WINDOW_POST_D
    phot = data.get("photometry") or []
    if isinstance(phot, dict):
        phot = list(phot.values())
    for p in phot:
        if not isinstance(p, dict):
            stats["skip_malformed"] += 1
            continue
        stats["raw_points"] += 1
        jd = _num(p.get("jd"))
        if not math.isfinite(jd):
            try:
                jd = pd.Timestamp(p.get("obsdate")).to_julian_date()
            except Exception:
                stats["skip_no_time"] += 1
                continue
        mjd = jd - JD_MJD
        unit = _name(p.get("flux_unit"))
        unit_l = unit.lower()
        stats[f"unit:{unit or '(none)'}"] += 1
        filt, tel, inst = _name(p.get("filters")), _name(p.get("telescope")), _name(p.get("instrument"))
        flux, ferr, lim = _num(p.get("flux")), _num(p.get("fluxerr")), _num(p.get("limflux"))
        if not (lo <= mjd <= hi):
            stats["skip_outside_window"] += 1
            continue
        if RADIO_RE.search(filt) or RADIO_RE.search(inst):
            stats["skip_radio_xray"] += 1
            continue
        band, std_letter = band_label(filt, tel, inst)
        rem = re.sub(r"\s+", " ", str(p.get("remarks") or "")).strip()
        note = make_note(tel, inst, rem if 0 < len(rem) <= 40 else "")

        # --- unit handling -> AB mags (mag, magerr, limmag) or nJy directly
        mag = magerr = limmag = math.nan
        fnjy = fnjy_err = math.nan
        if unit_l in ("abmag", "ab mag", "ab"):
            mag, magerr, limmag = flux, ferr, lim
        elif unit_l in ("vegamag", "vega mag", "vega"):
            if std_letter is None:
                stats["skip_vega_nonstandard"] += 1
                continue
            off = VEGA_TO_AB[std_letter]
            mag, magerr, limmag = flux + off, ferr, lim + off
            note = f"{note}; Vega->AB {off:+.2f}" if note else f"Vega->AB {off:+.2f}"
            stats["vega_converted"] += 1
        elif unit_l in FNU_UNITS:
            k = FNU_UNITS[unit_l]
            fnjy, fnjy_err = flux * k, ferr * k
            limmag = common.njy_to_mag(lim * k).item() if math.isfinite(lim) and lim > 0 else math.nan
            stats["fnu_converted"] += 1
        else:
            stats["skip_unit_other"] += 1
            continue

        if math.isfinite(fnjy):
            if not math.isfinite(fnjy_err) or fnjy_err < 0:
                fnjy_err = math.nan
            rows.append(dict(mjd=mjd, band=band, flux=fnjy, flux_err=fnjy_err,
                             kind=common.KIND_DET, lim_mag=math.nan, note=note))
            stats["kind0"] += 1
        elif math.isfinite(mag) and 0.0 < mag < 30.0:
            if not math.isfinite(magerr) or magerr < 0 or magerr > 5:
                magerr = math.nan
            f, fe = common.mag_to_njy(mag, magerr)
            rows.append(dict(mjd=mjd, band=band, flux=float(f), flux_err=float(fe),
                             kind=common.KIND_DET, lim_mag=math.nan, note=note))
            stats["kind0"] += 1
        elif math.isfinite(limmag) and 0.0 < limmag < 35.0:
            if math.isfinite(mag):
                stats["det_bad_mag_used_limit"] += 1
            rows.append(dict(mjd=mjd, band=band, flux=math.nan, flux_err=math.nan,
                             kind=common.KIND_UL, lim_mag=limmag, note=note))
            stats["kind2"] += 1
        else:
            stats["skip_no_value"] += 1
            continue
        bands[band] += 1
    for r in rows:
        r["name"] = name
        r["source"] = SOURCE
    return rows


def spectra_summary(name: str, data: dict) -> dict:
    spec = data.get("spectra") or []
    if isinstance(spec, dict):
        spec = list(spec.values())
    spec = [s for s in spec if isinstance(s, dict)]
    items = []
    for s in spec:
        jd = _num(s.get("jd"))
        if not math.isfinite(jd):
            try:
                jd = pd.Timestamp(s.get("obsdate")).to_julian_date()
            except Exception:
                jd = math.nan
        tel, inst = _name(s.get("telescope")), _name(s.get("instrument"))
        grp = _name(s.get("source_group")) or str(s.get("source_group_name") or "").strip()
        if grp.lower() in ("none", "other", "null"):
            grp = ""
        typ = ""
        for k in ("type", "spectype", "spec_type", "classification", "obj_type"):
            v = s.get(k)
            v = _name(v) if isinstance(v, dict) else (str(v).strip() if v else "")
            if v:
                typ = v
                break
        items.append((jd, tel, inst, grp, typ))
    items.sort(key=lambda x: (not math.isfinite(x[0]), x[0]))
    descs = []
    for jd, tel, inst, grp, typ in items:
        d = pd.to_datetime(jd, unit="D", origin="julian").strftime("%Y-%m-%d") if math.isfinite(jd) else "?"
        ti = make_note(tel if tel.lower() != "object" else "", inst)
        s = f"{d} {ti}".strip()
        if grp:
            s += f" ({grp})"
        if typ:
            s += f": {typ}"
        descs.append(s)
    jds = [x[0] for x in items if math.isfinite(x[0])]
    return {"name": name, "n_spectra": len(items),
            "first_spec_mjd": (min(jds) - JD_MJD) if jds else math.nan,
            "spec_types": "; ".join(descs)}


def normalize() -> dict:
    targets = common.load_targets()[["name", "disc_mjd"]]   # edp2_matched never leaves here
    rows, specs = [], []
    stats, bands = Counter(), Counter()
    n_obj = 0
    for name, disc in zip(targets["name"].astype(str), targets["disc_mjd"].astype(float)):
        p = raw_path(name)
        if not p.exists():
            continue
        try:
            data = json.loads(p.read_text())
        except ValueError:
            stats["bad_cache_file"] += 1
            continue
        n_obj += 1
        rows.extend(normalize_object(name, data, disc, stats, bands))
        specs.append(spectra_summary(name, data))
    df = pd.DataFrame(rows) if rows else common.empty_norm()
    if len(df):
        before = len(df)
        df["_k"] = df["mjd"].round(5)
        df = df.drop_duplicates(["name", "_k", "band", "kind", "flux", "lim_mag", "note"]).drop(columns="_k")
        stats["dup_dropped"] = before - len(df)
    tmp = OUT_PHOT.with_name(f"{OUT_PHOT.name}.{os.getpid()}.tmp")
    common.write_norm(df, tmp)
    os.replace(tmp, OUT_PHOT)
    sp = pd.DataFrame(specs, columns=["name", "n_spectra", "first_spec_mjd", "spec_types"])
    sp = sp.astype({"name": "string", "n_spectra": "int32", "first_spec_mjd": "float64",
                    "spec_types": "string"})
    tmp = OUT_SPEC.with_name(f"{OUT_SPEC.name}.{os.getpid()}.tmp")
    sp.to_parquet(tmp, index=False)
    os.replace(tmp, OUT_SPEC)
    kinds = df["kind"].value_counts().to_dict() if len(df) else {}
    log(f"normalized {n_obj} cached objects -> {len(df)} rows "
        f"({df['name'].nunique() if len(df) else 0} objects with points) kinds={kinds}; "
        f"spectra rows {len(sp)} ({int((sp['n_spectra'] > 0).sum())} with spectra)")
    log("stats: " + json.dumps(dict(sorted(stats.items()))))
    log("top bands: " + json.dumps(dict(bands.most_common(25))))
    return {"stats": stats, "bands": bands, "n_obj": n_obj, "n_rows": len(df)}


# --------------------------------------------------------------------------- #


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--limit", type=int, default=None, help="only the first N targets (load_targets order)")
    ap.add_argument("--names", default=None, help="comma-separated TNS names (without prefix)")
    ap.add_argument("--normalize-only", action="store_true", help="skip fetching; rebuild parquets from cache")
    ap.add_argument("--normalize-every", type=int, default=500,
                    help="re-run normalization every N fetched objects (0 = only at end)")
    ap.add_argument("--retry-notfound", action="store_true", help="also retry objects TNS said were not found")
    args = ap.parse_args()

    if not args.normalize_only:
        names = common.load_targets()["name"].astype(str).tolist()
        if args.names:
            want = [n.strip().removeprefix("SN").removeprefix("AT").strip() for n in args.names.split(",") if n.strip()]
            known = set(names)
            unknown = [n for n in want if n not in known]
            if unknown:
                log(f"note: not in targets (fetched anyway): {unknown}")
            names = want
        if args.limit is not None:
            names = names[: args.limit]
        fetch(names, args.normalize_every, args.retry_notfound)
    normalize()


if __name__ == "__main__":
    main()
