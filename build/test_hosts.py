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


class V2Columns(unittest.TestCase):
    """v2 candidate posterior: second candidate, candidate list, withholding."""

    def setUp(self):
        self.cat = pd.DataFrame({"name": ["2025a", "2025b"], "type": ["SN Ia", "SN Ia"]})
        cands = '[["LS:10000:1:2", "legacy", 10.0, -5.0, 1.2, 0.4, 0.62, "EXP", 2.1, 0.7, 30.0],' \
                ' ["PS1:123", "ps1", 10.001, -5.0, 4.0, 1.9, 0.35, "PS1", 1.0, 1.0, 0.0]]'
        self.h = pd.DataFrame([
            {"name": "2025a", "in_snia_list": True, "in_good_edp2_list": False,
             **rows(host_confidence="low", host_p=0.62, host2_id="PS1:123", host2_p=0.35, host2_fit_status="qc_pass",
                    host2_logmass_p50=9.5, candidates=cands)},
            {"name": "2025b", "in_snia_list": True, "in_good_edp2_list": False, **rows(candidates="[]")},
        ])

    def test_candidates_become_nested_lists(self):
        pub, _, withheld = H.split(self.h, self.cat)
        self.assertFalse(withheld)
        t = H.table(pub, {})
        c = {k: i for i, k in enumerate(t["cols"])}
        r = {row[0]: row for row in t["rows"]}
        self.assertEqual(len(r["2025a"][c["host_cands"]]), 2)
        self.assertEqual(r["2025a"][c["host_cands"]][1][0], "PS1:123")
        self.assertIsNone(r["2025b"][c["host_cands"]])
        self.assertEqual(r["2025a"][c["host_2_p"]], 0.35)
        self.assertEqual(r["2025a"][c["host_2_logm_p50"]], 9.5)
        H.public_guard(t)

    def test_second_host_pending_withholds_every_public_fit(self):
        self.h.loc[0, "host2_fit_status"] = "pending"
        pub, _, withheld = H.split(self.h, self.cat)
        self.assertTrue(withheld)
        t = H.table(pub, {}, withheld=True)
        c = {k: i for i, k in enumerate(t["cols"])}
        for r in t["rows"]:
            self.assertEqual(r[c["host_fit"]], "pending")
            self.assertIsNone(r[c["host_2_logm_p50"]])
            self.assertIsNone(r[c["host_logm_p50"]])

    def test_guard_scans_inside_the_candidate_list(self):
        pub, _, _ = H.split(self.h, self.cat)
        t = H.table(pub, {})
        k = t["cols"].index("host_cands")
        t["rows"][0][k][0][0] = "dp2:1234"
        with self.assertRaises(AssertionError):
            H.public_guard(t)

    def test_malformed_candidate_entry_is_refused(self):
        self.h.loc[0, "candidates"] = '[["LS:1", "legacy"]]'
        pub, _, _ = H.split(self.h, self.cat)
        with self.assertRaises(ValueError):
            H.table(pub, {})


if __name__ == "__main__":
    unittest.main()
