#!/usr/bin/env python3
"""Tests for the aggregate-only and encrypted candidate-redshift publication."""
from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import pandas as pd

import common as C
import crypto_layer as CL
import host_photoz as HP
import host_photoz_schema as HS


def public_summary():
    return {"schema_version": 1, "release": "fixture v9", "status": "complete", "manifest_sha256": "a"*64,
            "summary": {"n_transients": 1}, "validation": [],
            "lineage": {"local_fixed_run_blinded": False, "entire_ancestry_confirmed": False,
                        "legacy_false_is_formal_independence": False}}


class HostPhotoz(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.release = self.root / "host_photoz_v9_fixture"
        self.release.mkdir()
        self.frame = pd.DataFrame({"transient_id": ["712345678901234567"], "name": ["2025abc"],
            "provisional_host_candidate_uid": ["rubin_dp2:dp2:712345678901234568"],
            "selected_preferred_photoz": [.21], "selected_preferred_method": ["dp2_bpz"],
            "selected_candidate_photoz_screen_pass": [False], "selected_photoz_status": ["review_required"],
            "selected_galaxy_specz": [.2], "selected_candidate_spectroscopy_status": ["verified_galaxy_specz"],
            "sed_legacy_z_best": [3.1], "sed_legacy_combined_screen_pass": [False],
            "sed_assessment": ["failed_accuracy_validation"], "confirmed_host_identity": [False],
            "raw_flux_njy": [1234.], "local_path": ["/Users/example/private"]})
        self.frame.to_parquet(self.release / "host_context.parquet", index=False)
        approved = public_summary()
        approved["internal_path"] = "/Users/example/private"
        (self.release / "website_summary.json").write_text(json.dumps(approved))
        self.seal()

    def tearDown(self):
        self.temp.cleanup()

    def seal(self):
        files = {p.name: {"sha256": HP.sha256(p)} for p in self.release.iterdir() if p.name != "final_delivery_manifest.json"}
        (self.release / "final_delivery_manifest.json").write_text(json.dumps({"sealed": True, "files": files}))

    def test_public_summary_rejects_rows_paths_and_independence_claims(self):
        for key, value in [("rows", [["712345678901234567"]]), ("local_path", "/Users/private")]:
            payload = public_summary()
            payload[key] = value
            with self.assertRaises(ValueError):
                HS.validate_public(payload)
        payload = public_summary()
        payload["lineage"]["entire_ancestry_confirmed"] = True
        with self.assertRaises(ValueError):
            HS.validate_public(payload)
        payload = public_summary()
        payload["validation"] = [{"method":"Rubin", "scope":"diagnostic", "n":1, "n_outliers":0,
                                  "median_bias":0., "nmad":.02, "outlier_fraction":0.,
                                  "coverage68":68., "coverage95":.95, "independence":"unresolved"}]
        with self.assertRaises(ValueError):
            HS.validate_public(payload)

    def test_final_public_whitelist_has_no_object_rows_or_internal_paths(self):
        public, table, _ = HP.load_release(self.release)
        rendered = json.dumps(public)
        self.assertNotIn("712345", rendered)
        self.assertNotIn("/Users/", rendered)
        self.assertNotIn("raw_flux", rendered)
        self.assertEqual(public["summary"]["n_transients"], 1)
        self.assertEqual(len(table["rows"]), 1)

    def test_summary_count_aliases_are_explicit_and_unknown_counts_fail(self):
        raw = {"n_selected_hosts": 5, "n_targets_with_screened_sed": 2,
               "n_no_selected_host": 1, "created_utc": "private metadata"}
        self.assertEqual(HS.public_counts(raw), {"n_selected_candidates": 5, "n_sed_screened": 2, "n_no_selected_host": 1})
        with self.assertRaisesRegex(ValueError, "Unrecognized public count"):
            HS.public_counts({"n_new_unmapped_count": 4})
        with self.assertRaisesRegex(ValueError, "Conflicting"):
            HS.public_counts({"n_selected_hosts": 5, "n_selected_candidates": 4})

    def test_v9_calibrated_diagnostics_do_not_replace_point_estimates(self):
        frame = self.frame.assign(sed_legacy_z16=2.7, sed_legacy_z84=3.4, sed_legacy_temperature=3.08,
            sed_legacy_temperature_calibration_available=True, sed_legacy_source_fresh_validation_pass=False,
            sed_legacy_review_flags="poor_fit", calibrated_legacy_griz_wise_expanded_z_low68=.1,
            calibrated_legacy_griz_wise_expanded_z_high68=.5,
            calibrated_legacy_griz_wise_interval_calibration_support_pass=False)
        table = HP.team_table(frame)
        row = dict(zip(table["cols"], table["rows"][0]))
        self.assertEqual(row["catalog_photoz"], .21)
        self.assertEqual(row["sed_legacy_z16"], 2.7)
        self.assertEqual(row["sed_legacy_temperature"], 3.08)
        self.assertFalse(row["sed_legacy_source_validation_pass"])
        self.assertEqual(row["expanded_legacy_griz_low68"], .1)
        self.assertFalse(row["expanded_legacy_griz_support_pass"])
        HS.validate_team(table)

    def test_supplemental_diagnostics_are_encrypted_whitelisted_and_unadopted(self):
        extra = [{"source_catalog": "fixture_survey", "aperture": "matched", "z_best": 2.3,
                  "quality_pass": False, "covariance_used": True, "review_flags": "poor_fit",
                  "raw_flux": 123., "source_file": "/Users/private/input", "source_catalog_object_id": "secret-id"}]
        frame = self.frame.assign(supplemental_sed_fits_json=json.dumps(extra))
        table = HP.team_table(frame)
        raw = table["rows"][0][table["cols"].index("supplemental_sed_fits_json")]
        self.assertNotIn("raw_flux", raw)
        self.assertNotIn("/Users/", raw)
        self.assertNotIn("secret-id", raw)
        item = HS.validate_supplemental("supplemental_sed_fits_json", raw)[0]
        self.assertEqual(item["z_best"], 2.3)
        self.assertTrue(item["covariance_used"])
        self.assertTrue(item["diagnostic_only"])
        self.assertFalse(item["adopted_as_hostz"])
        HS.validate_team(table)
        extra[0]["adopted_as_hostz"] = True
        with self.assertRaisesRegex(ValueError, "promoted"):
            HP.supplemental_json(json.dumps(extra), "supplemental_sed_fits_json")

    def test_failed_sed_kept_as_separate_unadopted_team_diagnostic(self):
        table = HP.team_table(self.frame)
        row = dict(zip(table["cols"], table["rows"][0]))
        self.assertEqual(row["catalog_photoz"], .21)
        self.assertEqual(row["sed_legacy_z"], 3.1)
        self.assertFalse(row["sed_adopted_as_hostz"])
        self.assertFalse(row["science_usable"])
        HS.validate_team(table)
        table["rows"][0][table["cols"].index("sed_adopted_as_hostz")] = True
        with self.assertRaises(ValueError):
            HS.validate_team(table)

    def test_unsealed_or_changed_release_cannot_be_published(self):
        (self.release / "final_delivery_manifest.json").unlink()
        with self.assertRaises(ValueError):
            HP.load_release(self.release)
        self.seal()
        self.frame.assign(selected_preferred_photoz=.5).to_parquet(self.release / "host_context.parquet", index=False)
        with self.assertRaisesRegex(ValueError, "not verified"):
            HP.load_release(self.release)

    def test_float_ids_and_local_paths_are_rejected(self):
        with self.assertRaises(ValueError):
            HS.validate_team({"cols": HS.TEAM_COLS, "rows": [[float(2**60)]+[None]*(len(HS.TEAM_COLS)-1)]})
        frame = self.frame.assign(selected_candidate_spectroscopy_status="/Users/private/file")
        with self.assertRaises(ValueError):
            HS.validate_team(HP.team_table(frame))

    def test_incremental_publication_preserves_old_catalog_and_lightcurve_ciphertext(self):
        site, private, cache = self.root / "site", self.root / "private", self.root / "cache"
        (site / "data/lc").mkdir(parents=True)
        (site / "data/catalog.js").write_text('TNSX.onCatalog({"meta":{"mode":"public","team_access":true},"cols":["name","shard"],"rows":[["2025abc",0]]});\n')
        (site / "data/lc/000.js").write_text('TNSX.onShard(0,{});\n')
        old = {"v": 1, "names": ["2025abc"], "cols": ["edp2_id"], "rows": [["712345678901234567"]],
               "sources": {}, "notes": ["Existing science content"]}
        password = "fixture-only-long-password"
        with patch.object(C, "PRIVATE", private), patch.object(C, "CACHE", cache), patch.object(HP, "CONFIG", private / "release.json"), patch.object(CL, "get_password", return_value=password):
            CL.write_layer(site / "data", password, old, {0: {}}, 1, {"712345678901234567"})
            original_lc = (site / "data/edp2/000.js").read_bytes()
            original_catalog = (site / "data/catalog.js").read_bytes()
            result = HP.publish(self.release, site)
            self.assertEqual(result["encrypted_rows"], 1)
            self.assertEqual((site / "data/edp2/000.js").read_bytes(), original_lc)
            self.assertEqual((site / "data/catalog.js").read_bytes(), original_catalog)
            decrypted, _, _ = HP.read_existing_layer(site, password)
            self.assertEqual(decrypted["notes"], old["notes"])
            self.assertEqual(decrypted["rows"], old["rows"])
            self.assertEqual(len(decrypted["host_photoz"]["rows"]), 1)
            ciphertext = (site / "data/edp2/catalog.js").read_bytes()
            HP.publish(self.release, site)
            self.assertEqual((site / "data/edp2/catalog.js").read_bytes(), ciphertext)


if __name__ == "__main__":
    unittest.main()
