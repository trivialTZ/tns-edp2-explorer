#!/usr/bin/env python3
"""Tests for check_public.py (stdlib only; runs in the pre-commit hook and CI).

Each test builds a tiny synthetic site in a temp dir. The encrypted blobs are random
bytes of the right lengths, which is indistinguishable from real AES-GCM output to
the checker, so no key or password is needed.

    python3 build/test_check_public.py [-q]
"""
from __future__ import annotations

import base64
import contextlib
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import check_public as CP  # noqa: E402

B = lambda b: base64.b64encode(b).decode("ascii")  # noqa: E731


def enc_blob(name: str, plain_len: int = 4096) -> str:
    return f'TNSX.onEnc("{name}",{{"iv":"{B(os.urandom(12))}","ct":"{B(os.urandom(plain_len + 16))}"}});\n'


def keyinfo(iterations: int = 600000) -> str:
    return (f'TNSX.onKeyInfo({{"v":1,"kdf":"PBKDF2-SHA256","iter":{iterations},"salt":"{B(os.urandom(16))}",'
            f'"check":{{"iv":"{B(os.urandom(12))}","ct":"{B(os.urandom(38))}"}}}});\n')


WEBP = b"RIFF\x24\x00\x00\x00WEBPVP8 " + bytes(24)
PLAIN_LC = {"2025abc": {"edp2_dia": {"t": [60800.1], "b": ["r"], "f": [1234.5], "e": [50.0], "k": [0],
                                     "l": [None], "x": [""]}}}


class CheckPublic(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        data = self.root / "data"
        (data / "lc").mkdir(parents=True)
        self.cat = {"meta": {"mode": "public", "sources": {"ztf": {}}, "team_access": True},
                    "cols": ["name", "type", "n_ztf", "shard"],
                    "rows": [["2025abc", "SN Ia", 3, 0], ["2025abd", None, 0, 1]],
                    "hosts": {"cols": ["name", "host_status", "host_sep", "host_img"],
                              "rows": [["2025abc", "associated", 1.2, "file"]]}}
        self.write_cat()
        (data / "hosts").mkdir()
        (data / "hosts" / "2025abc.webp").write_bytes(WEBP)
        for sh in (0, 1):
            (data / "lc" / f"{sh:03d}.js").write_text(f"TNSX.onShard({sh},{{}});\n")
        self.enc = data / "edp2"
        self.enc.mkdir()
        (self.enc / "keyinfo.js").write_text(keyinfo())
        (self.enc / "catalog.js").write_text(enc_blob("catalog", 3 * 4096))
        for sh in (0, 1):
            (self.enc / f"{sh:03d}.js").write_text(enc_blob(f"lc-{sh:03d}"))

    def tearDown(self):
        self.tmp.cleanup()

    def write_cat(self):
        (self.root / "data" / "catalog.js").write_text(f"TNSX.onCatalog({json.dumps(self.cat)});\n")

    def run_check(self) -> int:
        with contextlib.redirect_stderr(io.StringIO()), contextlib.redirect_stdout(io.StringIO()):
            return CP.main(self.root)

    def assertFails(self):
        self.assertNotEqual(self.run_check(), 0)

    # ---- the encrypted layer
    def test_valid_encrypted_layer_passes(self):
        self.assertEqual(self.run_check(), 0)

    def test_no_layer_passes(self):
        for f in self.enc.iterdir():
            f.unlink()
        self.enc.rmdir()
        self.assertEqual(self.run_check(), 0)

    def test_plaintext_file_dropped_into_edp2_fails(self):
        (self.enc / "lightcurves.json").write_text(json.dumps(PLAIN_LC))
        self.assertFails()

    def test_plaintext_shard_in_edp2_fails(self):
        (self.enc / "000.js").write_text(f"TNSX.onShard(0,{json.dumps(PLAIN_LC)});\n")
        self.assertFails()

    def test_plaintext_behind_onEnc_fails(self):
        (self.enc / "000.js").write_text(f'TNSX.onEnc("lc-000",{json.dumps(PLAIN_LC)});\n')
        self.assertFails()

    def test_base64_encoded_plaintext_fails(self):
        raw = json.dumps(PLAIN_LC).encode()
        raw += b" " * (4096 - len(raw)) + b" " * 16          # padded like a real blob, but not encrypted
        (self.enc / "000.js").write_text(f'TNSX.onEnc("lc-000",{{"iv":"{B(os.urandom(12))}","ct":"{B(raw)}"}});\n')
        self.assertFails()

    def test_extra_field_fails(self):
        (self.enc / "000.js").write_text(
            f'TNSX.onEnc("lc-000",{{"iv":"{B(os.urandom(12))}","ct":"{B(os.urandom(4112))}","n":17}});\n')
        self.assertFails()

    def test_unpadded_ciphertext_fails(self):
        (self.enc / "000.js").write_text(enc_blob("lc-000", 4000))
        self.assertFails()

    def test_blob_name_must_match_file(self):
        (self.enc / "000.js").write_text(enc_blob("lc-001"))
        self.assertFails()

    def test_missing_shard_fails(self):
        (self.enc / "001.js").unlink()
        self.assertFails()

    def test_extra_shard_fails(self):
        (self.enc / "002.js").write_text(enc_blob("lc-002"))
        self.assertFails()

    def test_missing_keyinfo_fails(self):
        (self.enc / "keyinfo.js").unlink()
        self.assertFails()

    def test_weak_kdf_fails(self):
        (self.enc / "keyinfo.js").write_text(keyinfo(100000))
        self.assertFails()

    def test_subdirectory_fails(self):
        (self.enc / "extra").mkdir()
        self.assertFails()

    # ---- existing plaintext checks still apply
    def test_private_source_key_fails(self):
        (self.root / "data" / "lc" / "000.js").write_text(f"TNSX.onShard(0,{json.dumps(PLAIN_LC)});\n")
        self.assertFails()

    def test_dp2_id_fails(self):
        (self.root / "data" / "lc" / "000.js").write_text('TNSX.onShard(0,{"x":"' + "7" + "1" * 17 + '"});\n')
        self.assertFails()

    def test_private_column_fails(self):
        cat = {"meta": {"mode": "public", "sources": {}}, "cols": ["name", "edp2_sep"], "rows": []}
        (self.root / "data" / "catalog.js").write_text(f"TNSX.onCatalog({json.dumps(cat)});\n")
        self.assertFails()

    # ---- host galaxies: only SN Ia-list (TNS-typed SN Ia) rows may be public
    def test_host_row_for_an_untyped_object_fails(self):
        self.cat["hosts"]["rows"].append(["2025abd", "associated", 0.5, None])   # e.g. a good-EDP2-only object
        self.write_cat()
        self.assertFails()

    def test_host_membership_column_fails(self):
        self.cat["hosts"]["cols"] = ["name", "host_status", "host_sep", "host_img", "host_in_good_edp2_list"]
        self.cat["hosts"]["rows"] = [["2025abc", "associated", 1.2, "file", False]]
        self.write_cat()
        self.assertFails()

    def test_host_sep_arcsec_column_fails(self):
        self.cat["hosts"]["cols"][2] = "host_sep_arcsec"
        self.write_cat()
        self.assertFails()

    def test_host_value_mentioning_edp2_fails(self):
        self.cat["hosts"]["rows"][0][1] = "associated (good-EDP2 list)"
        self.write_cat()
        self.assertFails()

    def test_host_figure_without_public_row_fails(self):
        (self.root / "data" / "hosts" / "2025abd.webp").write_bytes(WEBP)
        self.assertFails()

    def test_non_webp_host_figure_fails(self):
        (self.root / "data" / "hosts" / "2025abc.webp").write_bytes(b"\x89PNG\r\n" + bytes(40))
        self.assertFails()

    def test_host_row_pointing_at_missing_figure_fails(self):
        (self.root / "data" / "hosts" / "2025abc.webp").unlink()
        self.assertFails()

    def test_private_mode_catalog_fails(self):
        cat = {"meta": {"mode": "private", "sources": {}}, "cols": ["name"], "rows": []}
        (self.root / "data" / "catalog.js").write_text(f"TNSX.onCatalog({json.dumps(cat)});\n")
        self.assertFails()


if __name__ == "__main__":
    unittest.main()
