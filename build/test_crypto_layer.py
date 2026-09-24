#!/usr/bin/env python3
"""Tests for the key-stability rules of build/crypto_layer.py.

Needs the `cryptography` package (the build venv), so it is not part of the stdlib
pre-commit hook. Uses a throwaway password and a synthetic site in a temp dir; the
real TNSX_SITE_PASSWORD and EDP2 data are never touched.

    ~/.venvs/debass_py313/bin/python build/test_crypto_layer.py [-q]
"""
from __future__ import annotations

import contextlib
import io
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import check_public as CP  # noqa: E402
import crypto_layer as CL  # noqa: E402

PW = "throwaway test password, not a secret"
LC = lambda n: {"t": [60800.0 + k for k in range(n)], "b": ["r"] * n, "f": [1.5] * n,  # noqa: E731
                "e": [0.5] * n, "k": [0] * n, "l": [None] * n, "x": [""] * n}


class Layer(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.site, self.state = root / "site", root / "private" / "crypto_state.json"
        (self.site / "data" / "lc").mkdir(parents=True)
        (self.site / "data" / "catalog.js").write_text(
            'TNSX.onCatalog({"meta":{"mode":"public","sources":{}},"cols":["name"],"rows":[]});\n')
        for sh in range(3):
            (self.site / "data" / "lc" / f"{sh:03d}.js").write_text(f"TNSX.onShard({sh},{{}});\n")
        self.catalog = {"v": 1, "names": ["2025a", "2025b"], "cols": ["edp2_sep"], "rows": [[0.1], [None]],
                        "sources": {}, "notes": [], "match_radius_arcsec": 2.0}
        self.shards = {0: {"2025a": {"edp2_dia": LC(3)}}, 1: {"2025b": {"edp2_fp": LC(5)}}, 2: {}}
        self.seen = {}   # iv -> plaintext sha256, across every build in a test

    def tearDown(self):
        self.tmp.cleanup()

    @property
    def enc(self) -> Path:
        return self.site / "data" / "edp2"

    def build(self, password=PW, rotate=False):
        with contextlib.redirect_stdout(io.StringIO()):
            _, info = CL.write_layer(self.site / "data", password, self.catalog, self.shards, 3,
                                     {"700000000000000001"}, rotate=rotate, state_file=self.state)
        key = CL.derive_key(password, CP.parse_keyinfo((self.enc / "keyinfo.js").read_text())["salt"])
        for f in sorted(self.enc.glob("*.js")):
            if f.name != "keyinfo.js":
                name, iv, ct = CP.parse_enc(f.read_text())
                h = CL.sha256(CL.unseal(key, name, iv, ct))
                self.assertEqual(self.seen.setdefault(iv, h), h, "an IV was reused for a different plaintext")
        return info

    def files(self) -> dict[str, bytes]:
        return {f.name: f.read_bytes() for f in sorted(self.enc.iterdir())}

    def salt(self) -> str:
        return CP.parse_keyinfo((self.enc / "keyinfo.js").read_text())["salt_b64"]

    def test_no_change_rebuild_is_byte_identical(self):
        self.assertEqual(self.build()["key"], "new")
        before = self.files()
        info = self.build()
        self.assertEqual((info["key"], info["sealed"], info["reused"]), ("kept", 0, 4))
        self.assertEqual(self.files(), before)

    def test_changed_shard_rewrites_only_that_file_with_a_new_iv(self):
        self.build()
        before = self.files()
        self.shards[1] = {"2025b": {"edp2_fp": LC(6)}}
        info = self.build()
        self.assertEqual((info["key"], info["sealed"]), ("kept", 1))
        after = self.files()
        self.assertEqual([f for f in after if after[f] != before[f]], ["001.js"])
        self.assertNotEqual(CP.parse_enc(after["001.js"].decode())[1], CP.parse_enc(before["001.js"].decode())[1])

    def test_reverting_a_change_still_gets_a_fresh_iv(self):
        self.build()
        orig = self.files()["001.js"]
        self.shards[1] = {"2025b": {"edp2_fp": LC(6)}}
        self.build()
        self.shards[1] = {"2025b": {"edp2_fp": LC(5)}}
        self.build()
        self.assertNotEqual(self.files()["001.js"], orig)

    def test_password_change_rotates_everything(self):
        self.build()
        before, salt = self.files(), self.salt()
        info = self.build(password=PW + " v2")
        self.assertEqual((info["key"], info["reason"]), ("new", "password changed"))
        self.assertNotEqual(self.salt(), salt)
        self.assertTrue(all(self.files()[f] != before[f] for f in before))

    def test_rotate_flag_rotates_everything(self):
        self.build()
        before, salt = self.files(), self.salt()
        info = self.build(rotate=True)
        self.assertEqual(info["key"], "new")
        self.assertNotEqual(self.salt(), salt)
        self.assertTrue(all(self.files()[f] != before[f] for f in before))

    def test_lost_state_keeps_the_key_by_decrypting_the_existing_files(self):
        self.build()
        before = self.files()
        self.state.unlink()
        info = self.build()
        self.assertTrue(info["key"].startswith("kept") and info["sealed"] == 0)
        self.assertEqual(self.files(), before)

    def test_a_replaced_file_on_disk_is_re_encrypted(self):
        self.build()
        (self.enc / "002.js").write_text(CL.enc_js("lc-002", {"iv": CL.b64(os.urandom(12)), "ct": CL.b64(os.urandom(4112))}))
        info = self.build()
        self.assertEqual((info["key"], info["sealed"]), ("kept", 1))

    def test_state_is_private(self):
        self.build()
        self.assertEqual(self.state.stat().st_mode & 0o777, 0o600)
        with self.assertRaises(CL.LayerError):
            CL.write_layer(self.site / "data", PW, self.catalog, self.shards, 3, set(),
                           state_file=CL.C.REPO / "cache" / "state.json")


if __name__ == "__main__":
    unittest.main()
