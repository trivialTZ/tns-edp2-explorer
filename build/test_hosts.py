#!/usr/bin/env python3
"""Tests for the host-galaxy public/private split in build/hosts.py (needs pandas).

Synthetic rows only; the real host products are not read.

    ~/.venvs/debass_py313/bin/python build/test_hosts.py [-q]
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
import hosts as H  # noqa: E402


def rows(**over):
    base = {src: None for src in H.COLS.values()}
    base.update(host_status="associated", association_tier="secure_consensus_pilot", fit_status="qc_pass",
                logmass_p50=10.1, logmass_p16=10.0, logmass_p84=10.2, n_bands=5, bands="PS1.g",
                notes="diagnostic only (science_usable=false); association tier: x; HostPhot threshold 5")
    base.update(over)
    return base


class Split(unittest.TestCase):
    def setUp(self):
        self.cat = pd.DataFrame({"name": ["2025a", "2025b", "2025c", "2025d"],
                                 "type": ["SN Ia", "SN Ia-91T-like", None, "SN II"]})
        self.h = pd.DataFrame([
            {"name": "2025a", "in_snia_list": True, "in_good_edp2_list": False, **rows()},
            {"name": "2025b", "in_snia_list": True, "in_good_edp2_list": True, **rows(fit_status="pending")},
            {"name": "2025c", "in_snia_list": False, "in_good_edp2_list": True, **rows()},      # good-EDP2 only
            {"name": "2025d", "in_snia_list": True, "in_good_edp2_list": False, **rows()},     # retyped since
        ])

    def test_only_snia_list_rows_typed_snia_are_public(self):
        pub, priv, _ = H.split(self.h, self.cat)
        self.assertEqual(sorted(pub["name"]), ["2025a", "2025b"])
        self.assertEqual(sorted(priv["name"]), ["2025c", "2025d"])
        self.assertTrue(pub["in_snia_list"].all())

    def test_assertion_rejects_a_non_snia_list_row(self):
        with self.assertRaises(AssertionError):
            H.assert_public(self.h[self.h["name"] == "2025c"], self.cat)

    def test_assertion_rejects_a_row_not_typed_snia_here(self):
        with self.assertRaises(AssertionError):
            H.assert_public(self.h[self.h["name"] == "2025d"], self.cat)

    def test_membership_never_reaches_a_table(self):
        pub, priv, _ = H.split(self.h, self.cat)
        for t in (H.table(pub, {}), H.table(priv, {})):
            self.assertFalse(any("list" in c or "good" in c for c in t["cols"]))
            self.assertNotIn(True, [v for r in t["rows"] for v in r if isinstance(v, bool)])

    def test_pending_public_fit_withholds_all_public_fit_results(self):
        pub, _, withheld = H.split(self.h, self.cat)
        self.assertTrue(withheld)
        t = H.table(pub, {}, withheld=True)
        c = {k: i for i, k in enumerate(t["cols"])}
        for r in t["rows"]:
            self.assertEqual(r[c["host_fit"]], "pending")
            self.assertIsNone(r[c["host_logm_p50"]])
            self.assertIsNone(r[c["host_bands"]])
            self.assertNotIn("HostPhot", r[c["host_notes"]] or "")

    def test_public_guard(self):
        pub, _, _ = H.split(self.h, self.cat)
        H.public_guard(H.table(pub, {}))
        t = H.table(pub, {})
        t["rows"][0][t["cols"].index("host_notes")] = "selected via the good-EDP2 list"
        with self.assertRaises(AssertionError):
            H.public_guard(t)
        with self.assertRaises(AssertionError):
            H.public_guard({"cols": ["name", "host_status", "in_good_edp2_list"], "rows": []})


if __name__ == "__main__":
    unittest.main()
