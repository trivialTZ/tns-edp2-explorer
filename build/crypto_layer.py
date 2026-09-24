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

Plaintexts are UTF-8 JSON padded with trailing spaces to a multiple of 4096 bytes;
the check blob holds CHECK_TEXT so a browser can verify a password quickly.

Key stability. While the password is unchanged the salt (and so the key) is kept,
and a file whose padded plaintext is unchanged is left byte-identical, so a data
refresh only rewrites what changed and stored browser keys stay valid. A private
state file under common.PRIVATE (never in the repo) records the salt, a manifest of
plaintext SHA-256 -> ciphertext-file SHA-256 per file, and every IV used under the
key. A changed plaintext is always sealed with a fresh random IV that has never been
used under the key. A new password, or rotate=True (assemble.py --rotate), draws a
new salt and re-encrypts everything.
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
STATE_VERSION = 1


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


def sha256(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def pad_json(obj) -> bytes:
    raw = json.dumps(obj, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode("utf-8")
    return raw + b" " * ((-len(raw)) % PAD)


def seal(key: bytes, name: str, plaintext: bytes, used_ivs: set[str]) -> dict:
    """Encrypt with a fresh random IV never used under this key (recorded in used_ivs)."""
    while True:
        iv = os.urandom(CP.IV_BYTES)
        if b64(iv) not in used_ivs:
            break
    used_ivs.add(b64(iv))
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


# ------------------------------------------------------------------ private state (salt, manifest, IVs)
def state_path(site: Path) -> Path:
    """PRIVATE/crypto_state.json for docs/; a separate file for any other --out site."""
    site = site.resolve()
    if site == C.SITE.resolve():
        return C.PRIVATE / "crypto_state.json"
    return C.PRIVATE / f"crypto_state.{sha256(str(site).encode())[:12]}.json"


def _load_state(path: Path) -> dict | None:
    try:
        st = json.loads(path.read_text())
    except (OSError, ValueError):
        return None
    ok = (isinstance(st, dict) and st.get("v") == STATE_VERSION and isinstance(st.get("salt"), str)
          and isinstance(st.get("files"), dict) and isinstance(st.get("ivs"), list))
    return st if ok else None


def _save_state(path: Path, st: dict) -> None:
    if path.resolve().is_relative_to(C.REPO.resolve()):
        raise LayerError("refusing to write the crypto state inside the public repo")
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh:
        json.dump(st, fh, indent=1, sort_keys=True)
    os.replace(tmp, path)


def _plan(final: Path, password: str, plain: dict[str, tuple[str, bytes]], state: dict | None,
          rotate: bool) -> tuple[dict[str, str], dict, dict]:
    """Decide the key and every file's text. Returns (files, new_state, info).

    The key is kept when the password still opens the existing keyinfo.js check blob and
    no rotation is asked for. The manifest comes from the state file when its salt matches
    the existing keyinfo.js; otherwise (state lost or out of date) it is rebuilt by
    decrypting the existing files. A file is reused byte-identically only when its padded
    plaintext hash and its ciphertext-file hash both match; anything else gets a new IV.
    """
    info = {"key": "new", "reason": "", "reused": 0, "sealed": 0}
    key = salt = keyinfo_txt = None
    manifest: dict[str, dict] = {}
    ivs: set[str] = set()
    kf = final / "keyinfo.js"
    if rotate:
        info["reason"] = "rotation requested"
    elif not kf.is_file():
        info["reason"] = "no previous layer"
    else:
        try:
            txt = kf.read_text()
            ki = CP.parse_keyinfo(txt)
            if ki["iter"] != ITERATIONS:
                raise ValueError("iteration count changed")
            k = derive_key(password, ki["salt"], ki["iter"])
            if unseal(k, "check", ki["iv"], ki["ct"]) != CHECK_TEXT.encode("utf-8"):
                raise ValueError("unexpected check plaintext")
            key, salt, keyinfo_txt = k, ki["salt"], txt
            ivs.add(b64(ki["iv"]))
            for fn in plain:                      # IVs already on disk under this key are taken
                try:
                    ivs.add(b64(CP.parse_enc((final / fn).read_text())[1]))
                except (OSError, ValueError):
                    pass
            if state and state["salt"] == ki["salt_b64"]:
                manifest, info["key"] = dict(state["files"]), "kept"
                ivs.update(state["ivs"])
            else:
                info["key"] = "kept (manifest rebuilt from the existing files)"
                for fn, (name, _) in plain.items():
                    f = final / fn
                    try:
                        raw = f.read_bytes()
                        _, iv, ct = CP.parse_enc(raw.decode("ascii"))
                        manifest[fn] = {"sha256": sha256(unseal(key, name, iv, ct)), "file_sha256": sha256(raw)}
                        ivs.add(b64(iv))
                    except (OSError, ValueError, InvalidTag):
                        continue
        except InvalidTag:
            info["reason"] = "password changed"
        except (OSError, ValueError) as e:
            info["reason"] = f"previous keyinfo.js unusable ({e})"
    if key is None:
        salt = os.urandom(CP.SALT_BYTES)
        key = derive_key(password, salt)
        keyinfo_txt = keyinfo_js(salt, ITERATIONS, seal(key, "check", CHECK_TEXT.encode("utf-8"), ivs))
    files = {"keyinfo.js": keyinfo_txt}
    new_manifest = {}
    for fn, (name, pt) in plain.items():
        h, old, f = sha256(pt), manifest.get(fn), final / fn
        txt = None
        if old and old.get("sha256") == h and f.is_file():
            raw = f.read_bytes()
            if sha256(raw) == old.get("file_sha256"):
                txt = raw.decode("ascii")
                info["reused"] += 1
        if txt is None:
            txt = enc_js(name, seal(key, name, pt, ivs))
            info["sealed"] += 1
        files[fn] = txt
        new_manifest[fn] = {"sha256": h, "file_sha256": sha256(txt.encode("ascii"))}
    new_state = {"v": STATE_VERSION, "salt": b64(salt), "iter": ITERATIONS, "files": new_manifest, "ivs": sorted(ivs)}
    return files, new_state, info


def write_layer(data_dir: Path, password: str, catalog: dict, shards: dict[int, dict], n_shards: int,
                secret_ids: set[str], rotate: bool = False, state_file: Path | None = None) -> tuple[int, dict]:
    """Encrypt `catalog` and one blob per shard 0..n_shards-1 into data_dir/edp2/.

    Files are staged in a scratch directory under cache/, self-checked, then swapped in.
    On any failure the previous layer is put back unchanged (so the key is not lost and
    the next build does not rotate) and the state file is untouched. Returns
    (bytes written, plan info).
    """
    final = data_dir / CP.ENC_DIR
    state_file = state_file or state_path(data_dir.parent)
    if state_file.resolve().is_relative_to(C.REPO.resolve()):
        raise LayerError("refusing to keep the crypto state inside the public repo")
    plain = {"catalog.js": ("catalog", pad_json(catalog))}
    for sh in range(n_shards):
        plain[f"{sh:03d}.js"] = (f"lc-{sh:03d}", pad_json(shards.get(sh, {})))
    files, new_state, info = _plan(final, password, plain, _load_state(state_file), rotate)
    C.CACHE.mkdir(parents=True, exist_ok=True)
    tmp = Path(tempfile.mkdtemp(prefix="edp2_layer_", dir=C.CACHE))
    backup, moved_in = None, False
    try:
        size = 0
        for fn, txt in files.items():
            (tmp / fn).write_text(txt)
            size += len(txt)
        self_check(tmp, password, catalog, shards, n_shards, secret_ids)
        if final.exists():
            backup = Path(tempfile.mkdtemp(prefix="edp2_layer_prev_", dir=C.CACHE)) / "edp2"
            shutil.move(str(final), str(backup))
        shutil.move(str(tmp), str(final))
        moved_in = True
        final.chmod(0o755)                       # mkdtemp creates 0700
        site_scan(data_dir.parent, password, secret_ids)
    except BaseException:
        shutil.rmtree(tmp, ignore_errors=True)
        if moved_in:
            shutil.rmtree(final, ignore_errors=True)       # never leave a layer that failed its checks
        if backup is not None and backup.exists():
            shutil.move(str(backup), str(final))           # put the previous layer back unchanged
        raise
    finally:
        if backup is not None:
            shutil.rmtree(backup.parent, ignore_errors=True)
    _save_state(state_file, new_state)
    # Stability: an immediate rebuild from the same inputs must leave every file byte-identical
    # (a zero diff under data/edp2/), so a no-change refresh commits nothing here.
    again, _, info2 = _plan(final, password, plain, _load_state(state_file), rotate=False)
    if info2["sealed"] or info2["key"] != "kept" or any((final / fn).read_text() != t for fn, t in again.items()):
        raise LayerError("self-check: a no-change rebuild would rewrite files under data/edp2/")
    return size, info


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
