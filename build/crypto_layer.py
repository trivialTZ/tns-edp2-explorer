"""Encrypted EDP2 ("team access") layer for the public site: build side.

Rubin DP2/EDP2 catalogue data may reach docs/ only as AES-256-GCM ciphertext in
docs/data/edp2/. The key comes from a password shared with Rubin data-rights
holders (TNSX_SITE_PASSWORD in rubin_hackathon/.env). The password is a secret:
never print, log or write it, and never put it in an error message.

Format (SCHEMA.md section 3; docs/team.js is the reader):

    key = PBKDF2-HMAC-SHA256(NFC(password) as UTF-8, salt, iter, 32 bytes)
    ct  = AES-256-GCM(key, iv, plaintext, aad="tnsx-edp2/v1/<name>")  (16-byte tag appended)

    keyinfo.js  TNSX.onKeyInfo({"v":1,"kdf":"PBKDF2-SHA256","iter":600000,"salt":b64,"check":{"iv":b64,"ct":b64}})
    catalog.js  TNSX.onEnc("catalog",{"iv":b64,"ct":b64})
    NNN.js      TNSX.onEnc("lc-NNN",{"iv":b64,"ct":b64})

A new random salt is drawn on every build and every blob gets a fresh 12-byte IV.
Plaintexts are UTF-8 JSON padded with trailing spaces to a multiple of 4096 bytes;
the check blob holds CHECK_TEXT so a browser can verify a password quickly.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import shutil
import tempfile
import unicodedata
from pathlib import Path

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

import check_public as CP
import common as C

ENV_KEY = "TNSX_SITE_PASSWORD"
ITERATIONS = 600_000
CHECK_TEXT = "tnsx-edp2 key check v1"     # docs/team.js compares against the same constant
AAD_PREFIX = "tnsx-edp2/v1/"
MIN_PASSWORD_LEN = 12
PAD = CP.PAD_BYTES


class LayerError(RuntimeError):
    """Raised when the encrypted layer cannot be built or fails its self-check."""


def get_password() -> str:
    """TNSX_SITE_PASSWORD from the rubin_hackathon .env (or the environment). Never print it."""
    pw = (C.read_env().get(ENV_KEY) or os.environ.get(ENV_KEY) or "").strip()   # the site trims input too
    if not pw:
        raise LayerError(f"{ENV_KEY} is not set in {C.ENV_FILE} or the environment")
    if len(pw) < MIN_PASSWORD_LEN:
        raise LayerError(f"{ENV_KEY} is shorter than {MIN_PASSWORD_LEN} characters; use a long random password")
    return pw


def derive_key(password: str, salt: bytes, iterations: int = ITERATIONS) -> bytes:
    pw = unicodedata.normalize("NFC", password).encode("utf-8")
    return hashlib.pbkdf2_hmac("sha256", pw, salt, iterations, dklen=32)


def b64(b: bytes) -> str:
    return base64.b64encode(b).decode("ascii")


def pad_json(obj) -> bytes:
    raw = json.dumps(obj, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode("utf-8")
    return raw + b" " * ((-len(raw)) % PAD)


def seal(key: bytes, name: str, plaintext: bytes) -> dict:
    iv = os.urandom(CP.IV_BYTES)
    ct = AESGCM(key).encrypt(iv, plaintext, (AAD_PREFIX + name).encode("ascii"))
    return {"iv": b64(iv), "ct": b64(ct)}


def unseal(key: bytes, name: str, iv: bytes, ct: bytes) -> bytes:
    return AESGCM(key).decrypt(iv, ct, (AAD_PREFIX + name).encode("ascii"))


def keyinfo_js(salt: bytes, iterations: int, check: dict) -> str:
    info = {"v": 1, "kdf": "PBKDF2-SHA256", "iter": iterations, "salt": b64(salt), "check": check}
    return f"TNSX.onKeyInfo({json.dumps(info, separators=(',', ':'))});\n"


def enc_js(name: str, blob: dict) -> str:
    return f"TNSX.onEnc({json.dumps(name)},{json.dumps(blob, separators=(',', ':'))});\n"


def _roundtrip(obj):
    return json.loads(json.dumps(obj, ensure_ascii=False, allow_nan=False))


def write_layer(data_dir: Path, password: str, catalog: dict, shards: dict[int, dict], n_shards: int,
                secret_ids: set[str]) -> int:
    """Encrypt `catalog` and one blob per shard 0..n_shards-1 into data_dir/edp2/.

    Written to a scratch directory under cache/ first, self-checked, then moved into
    place; on any failure nothing is left under data_dir/edp2. Returns bytes written.
    """
    final = data_dir / CP.ENC_DIR
    C.CACHE.mkdir(parents=True, exist_ok=True)
    tmp = Path(tempfile.mkdtemp(prefix="edp2_layer_", dir=C.CACHE))
    try:
        salt = os.urandom(CP.SALT_BYTES)
        key = derive_key(password, salt)
        files = {"keyinfo.js": keyinfo_js(salt, ITERATIONS, seal(key, "check", CHECK_TEXT.encode("utf-8"))),
                 "catalog.js": enc_js("catalog", seal(key, "catalog", pad_json(catalog)))}
        for sh in range(n_shards):
            name = f"lc-{sh:03d}"
            files[f"{sh:03d}.js"] = enc_js(name, seal(key, name, pad_json(shards.get(sh, {}))))
        size = 0
        for fn, txt in files.items():
            (tmp / fn).write_text(txt)
            size += len(txt)
        self_check(tmp, password, catalog, shards, n_shards, secret_ids)
        if final.exists():
            shutil.rmtree(final)
        shutil.move(str(tmp), str(final))
        final.chmod(0o755)                       # mkdtemp creates 0700
    except BaseException:
        shutil.rmtree(tmp, ignore_errors=True)
        raise
    try:
        site_scan(data_dir.parent, password, secret_ids)
    except BaseException:
        shutil.rmtree(final, ignore_errors=True)
        raise
    return size


def self_check(d: Path, password: str, catalog: dict, shards: dict[int, dict], n_shards: int,
               secret_ids: set[str]) -> None:
    """Decrypt every file with the password and compare to the source; a wrong password
    and a swapped blob name must fail; the files must hold nothing but ciphertext."""
    names = sorted(p.name for p in d.iterdir())
    want = sorted(["keyinfo.js", "catalog.js"] + [f"{sh:03d}.js" for sh in range(n_shards)])
    if names != want:
        raise LayerError(f"self-check: unexpected file set in the layer ({len(names)} files, want {len(want)})")
    try:
        ki = CP.parse_keyinfo((d / "keyinfo.js").read_text())
        blobs = {}
        for fn in names:
            if fn != "keyinfo.js":
                name, iv, ct = CP.parse_enc((d / fn).read_text())
                blobs[name] = (iv, ct)
    except ValueError as e:
        raise LayerError(f"self-check: output does not have the public shape: {e}") from None
    key = derive_key(password, ki["salt"], ki["iter"])
    try:
        if unseal(key, "check", ki["iv"], ki["ct"]).decode("utf-8") != CHECK_TEXT:
            raise LayerError("self-check: key-check plaintext differs")
        got = json.loads(unseal(key, "catalog", *blobs["catalog"]).decode("utf-8"))
        if got != _roundtrip(catalog):
            raise LayerError("self-check: decrypted catalog differs from the source")
        for sh in range(n_shards):
            name = f"lc-{sh:03d}"
            got = json.loads(unseal(key, name, *blobs[name]).decode("utf-8"))
            if got != _roundtrip(shards.get(sh, {})):
                raise LayerError(f"self-check: decrypted {name} differs from the source")
    except InvalidTag:
        raise LayerError("self-check: a blob did not decrypt with the build password") from None
    # A wrong password must fail on every blob kind, and a blob must not open under another name.
    wrong = derive_key(password + "\u0000not-the-password", ki["salt"], ki["iter"])
    attempts = [("check blob, wrong password", wrong, "check", ki["iv"], ki["ct"]),
                ("catalog, wrong password", wrong, "catalog", *blobs["catalog"]),
                ("catalog opened as lc-000", key, "lc-000", *blobs["catalog"])]
    if n_shards:
        attempts.append(("lc-000, wrong password", wrong, "lc-000", *blobs["lc-000"]))
    for label, k, name, iv, ct in attempts:
        try:
            unseal(k, name, iv, ct)
        except InvalidTag:
            continue
        raise LayerError(f"self-check: {label} decrypted")
    _scan_files(d, password, secret_ids)


_LONG_INT = re.compile(r"(?<!\d)\d{15,20}(?!\d)")


def _scan_files(root: Path, password: str, secret_ids: set[str]) -> None:
    """No password and no EDP2 diaObjectId anywhere under root (base64 cannot hold either by chance)."""
    pw = password.encode("utf-8")
    for f in sorted(root.rglob("*")):
        if not f.is_file():
            continue
        raw = f.read_bytes()
        rel = f.relative_to(root)
        if pw in raw:
            raise LayerError(f"leak scan: the site password appears in {rel}")
        txt = raw.decode("utf-8", errors="ignore")
        hit = secret_ids.intersection(_LONG_INT.findall(txt))
        if hit:
            raise LayerError(f"leak scan: {len(hit)} EDP2 diaObjectId(s) in plaintext in {rel}")


def site_scan(site: Path, password: str, secret_ids: set[str]) -> None:
    """Whole-site checks after the layer is in place: no password, no EDP2 IDs anywhere,
    no 'edp2_' field names in any data file, and check_public passes."""
    _scan_files(site, password, secret_ids)
    for f in sorted((site / "data").rglob("*")):
        if f.is_file() and "edp2_" in f.read_text(errors="ignore"):
            raise LayerError(f"leak scan: plaintext 'edp2_' in {f.relative_to(site)}")
    if CP.main(site) != 0:
        raise LayerError("check_public failed on the site after writing the layer")
