"""Strict, stdlib-only public-summary and encrypted-row contracts."""
from __future__ import annotations

import math
import json
import re

SUMMARY_FIELDS = {
    "n_transients", "n_selected_candidates", "n_selected_catalog_photoz",
    "n_selected_identity_matched_photoz", "n_selected_screened_photoz",
    "n_selected_missing_photoz", "n_selected_review_photoz",
    "n_selected_candidate_spectra", "n_confirmed_host_identities",
    "n_science_usable", "n_sed_targets", "n_sed_finite", "n_sed_screened",
    "n_sed_consistent", "n_sed_conflicts", "n_validation_galaxies",
    "n_selected_unique_galaxies", "n_no_selected_host", "n_new_adopted_host_redshifts",
    "n_sed_fit_groups", "n_target_aperture_fits", "n_targets_with_eligible_photometry",
    "n_existing_provisional_host_specz",
    "n_supplemental_sed_fits", "n_priority_survey_outcomes", "n_priority_survey_galaxies",
    "n_supplemental_catalog_photoz_references",
}
SUMMARY_ALIASES = {
    "n_selected_hosts": "n_selected_candidates",
    "n_targets_with_finite_sed": "n_sed_finite",
    "n_targets_with_screened_sed": "n_sed_screened",
    "n_cross_survey_disagreement": "n_sed_conflicts",
}
PUBLIC_FIELDS = {"schema_version", "release", "status", "manifest_sha256", "summary", "validation", "lineage"}
VALIDATION_FIELDS = {"method", "scope", "n", "median_bias", "nmad", "n_outliers", "outlier_fraction",
                     "coverage68", "coverage95", "independence"}
LINEAGE_FIELDS = {"local_fixed_run_blinded", "entire_ancestry_confirmed", "legacy_false_is_formal_independence"}
TEAM_COLS = ["transient_id", "name", "candidate_uid", "association_status", "confirmed_host_identity",
             "spectrum_status", "candidate_specz", "catalog_photoz", "catalog_photoz_method",
             "photoz_status", "photoz_quality_pass", "sed_status", "sed_rubin_z", "sed_rubin_pass",
             "sed_legacy_z", "sed_legacy_pass", "sed_ps1_z", "sed_ps1_pass", "sed_adopted_as_hostz", "science_usable"]
SED_DIAGNOSTIC_FIELDS = ["z16", "z84", "z025", "z975", "temperature", "temperature_calibration_available",
                         "source_validation_pass", "review_flags"]
for _source in ["rubin", "legacy", "ps1"]:
    TEAM_COLS += ["sed_"+_source+"_"+field for field in SED_DIAGNOSTIC_FIELDS]
INTERVAL_DIAGNOSTIC_FIELDS = ["low68", "high68", "low95", "high95", "support_pass"]
for _method in ["legacy_griz", "legacy_grz"]:
    TEAM_COLS += ["expanded_"+_method+"_"+field for field in INTERVAL_DIAGNOSTIC_FIELDS]
SUPPLEMENTAL_FIELDS = {
    "supplemental_sed_fits_json": {"source_catalog", "aperture", "candidate", "z_best", "z_median", "z16", "z84", "z025", "z975",
        "n_usable_bands", "review_flags", "input_photometry_review_flags", "quality_pass", "input_fit_eligible", "combined_screen_pass", "covariance_used",
        "diagnostic_only", "adopted_as_hostz", "source_fresh_validation_pass", "density_type", "temperature", "temperature_calibration_available"},
    "supplemental_photometry_outcomes_json": {"source_catalog", "neighbor_records", "identity_verified", "usable_band_count",
        "outcome", "main_limitation", "priority_reason", "diagnostic_only"},
    "supplemental_catalog_photoz_json": {"source_catalog", "method", "photoz_point", "photoz_sigma", "photoz_lo68", "photoz_hi68",
        "quality", "use_for_fitting", "diagnostic_only", "adopted_as_hostz"},
}
QUALITY_FIELDS = {"ODDS", "NBPZ_FILT", "CHI_SQUARED_BPZ", "MASK", "ast_flag", "dnf_flags", "flags_gold", "flags_foreground", "mask_flags",
                  "dnf_d1", "dnf_de1", "dnf_nneighbors", "dnf_zerr_fit", "dnf_zerr_param"}
TEAM_COLS += list(SUPPLEMENTAL_FIELDS)
_SAFE_TEXT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 _:+.;()\-]{0,140}$")
_SECRET_OR_PATH = re.compile(r"RSP_TOKEN|TNSX_SITE_PASSWORD|(?:/Users/|/home/|/project|file://)|\d{15,20}", re.I)


def _number(value, *, count=False):
    if value is None:
        return True
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        return False
    return (0 <= value <= 10_000_000 and float(value).is_integer()) if count else True


def public_counts(raw):
    """Export known counts; never silently drop a new meaningful count key."""
    if not isinstance(raw, dict):
        raise ValueError("Invalid public summary counts")
    result = {}
    for key, value in raw.items():
        dest = SUMMARY_ALIASES.get(key, key)
        if dest not in SUMMARY_FIELDS:
            if key.startswith("n_"):
                raise ValueError("Unrecognized public count field: "+key)
            continue
        if dest in result and result[dest] != value:
            raise ValueError("Conflicting public count aliases: "+dest)
        result[dest] = value
    supplemental = raw.get("supplemental", {})
    for source, dest, key in [
        ("supplemental_sed_fits_json", "n_supplemental_sed_fits", "records"),
        ("supplemental_photometry_outcomes_json", "n_priority_survey_outcomes", "records"),
        ("supplemental_photometry_outcomes_json", "n_priority_survey_galaxies", "unique_galaxies"),
        ("supplemental_catalog_photoz_json", "n_supplemental_catalog_photoz_references", "records"),
    ]:
        if source in supplemental and key in supplemental[source]:
            value = supplemental[source][key]
            if dest in result and result[dest] != value:
                raise ValueError("Conflicting supplemental counts: "+dest)
            result[dest] = value
    return result


def validate_public(data):
    if not isinstance(data, dict) or set(data) - PUBLIC_FIELDS or data.get("schema_version") != 1:
        raise ValueError("Unexpected public host photo-z summary fields")
    if data.get("status") not in {"pending", "complete"}:
        raise ValueError("Unexpected host photo-z publication status")
    release = data.get("release")
    if not isinstance(release, str) or not _SAFE_TEXT.fullmatch(release) or _SECRET_OR_PATH.search(release):
        raise ValueError("Invalid public release label")
    digest = data.get("manifest_sha256")
    if digest is not None and not re.fullmatch(r"[0-9a-f]{64}", str(digest)):
        raise ValueError("Invalid public manifest digest")
    if data["status"] == "complete" and digest is None:
        raise ValueError("Completed public summaries require a final manifest digest")
    summary = data.get("summary", {})
    if not isinstance(summary, dict) or set(summary) - SUMMARY_FIELDS or not all(_number(x, count=True) for x in summary.values()):
        raise ValueError("Public host photo-z summary accepts aggregate counts only")
    rows = data.get("validation", [])
    if not isinstance(rows, list):
        raise ValueError("Invalid public validation summary")
    for row in rows:
        if not isinstance(row, dict) or set(row) != VALIDATION_FIELDS:
            raise ValueError("Unexpected public validation fields")
        for column in ("method", "scope"):
            value = row[column]
            if not isinstance(value, str) or not _SAFE_TEXT.fullmatch(value) or _SECRET_OR_PATH.search(value):
                raise ValueError("Invalid public validation label")
        if row["independence"] not in {"unresolved", "known_overlap_excluded", "local_run_holdout"}:
            raise ValueError("Invalid independence scope")
        if not all(_number(row[c], count=c in {"n", "n_outliers"}) for c in VALIDATION_FIELDS - {"method", "scope", "independence"}):
            raise ValueError("Invalid public validation metric")
        if row["n_outliers"] > row["n"] or (row["nmad"] is not None and row["nmad"] < 0):
            raise ValueError("Invalid public validation count or scatter")
        if any(row[column] is not None and not 0 <= row[column] <= 1 for column in ["outlier_fraction", "coverage68", "coverage95"]):
            raise ValueError("Validation fractions must be between zero and one")
    lineage = data.get("lineage", {})
    if not isinstance(lineage, dict) or set(lineage) != LINEAGE_FIELDS or any(x is not None and not isinstance(x, bool) for x in lineage.values()):
        raise ValueError("Invalid lineage declarations")
    if lineage["entire_ancestry_confirmed"] or lineage["legacy_false_is_formal_independence"]:
        raise ValueError("This diagnostic publication cannot claim full training independence")
    return data


def validate_team(table):
    if not isinstance(table, dict) or set(table) != {"cols", "rows"} or table.get("cols") != TEAM_COLS:
        raise ValueError("Unexpected encrypted candidate-redshift table fields")
    if not isinstance(table["rows"], list):
        raise ValueError("Invalid encrypted candidate-redshift rows")
    seen = set()
    for row in table["rows"]:
        if not isinstance(row, list) or len(row) != len(TEAM_COLS) or not isinstance(row[0], str) or not row[0] or row[0] in seen:
            raise ValueError("Encrypted rows require unique exact string transient IDs")
        seen.add(row[0])
        for value in row:
            if value is not None and not isinstance(value, (str, bool, int, float)):
                raise ValueError("Nested raw data cannot enter candidate-redshift rows")
            if isinstance(value, str) and re.search(r"RSP_TOKEN|TNSX_SITE_PASSWORD|/Users/|/home/|file://", value, re.I):
                raise ValueError("Secrets or local paths cannot enter site rows")
            if isinstance(value, float) and not math.isfinite(value):
                raise ValueError("Nonfinite values cannot enter site rows")
        by_col = dict(zip(TEAM_COLS, row))
        if by_col["sed_adopted_as_hostz"] is not False or by_col["science_usable"] is not False:
            raise ValueError("SED diagnostics cannot be adopted or promoted to science redshifts")
        for column in SUPPLEMENTAL_FIELDS:
            validate_supplemental(column, by_col[column])
    return table


def validate_supplemental(column, raw):
    if raw is None:
        return []
    if not isinstance(raw, str):
        raise ValueError("Supplemental diagnostics must use JSON text")
    items = json.loads(raw)
    if not isinstance(items, list) or len(items) > 100:
        raise ValueError("Invalid supplemental diagnostic list")
    for item in items:
        if not isinstance(item, dict) or set(item) - SUPPLEMENTAL_FIELDS[column]:
            raise ValueError("Unexpected supplemental diagnostic fields")
        if item.get("diagnostic_only") is not True or item.get("adopted_as_hostz", False) is not False or item.get("use_for_fitting", False) is not False:
            raise ValueError("Supplemental results must remain unadopted diagnostics")
        for key, value in item.items():
            if isinstance(value, dict) and key == "quality":
                if set(value) - QUALITY_FIELDS:
                    raise ValueError("Unexpected supplemental quality fields")
                values = value.values()
            else:
                values = [value]
            for scalar in values:
                if scalar is not None and not isinstance(scalar, (str, bool, int, float)):
                    raise ValueError("Nested raw data cannot enter supplemental diagnostics")
                if isinstance(scalar, float) and not math.isfinite(scalar):
                    raise ValueError("Nonfinite supplemental diagnostics")
                if isinstance(scalar, str) and re.search(r"RSP_TOKEN|TNSX_SITE_PASSWORD|/Users/|/home/|file://", scalar, re.I):
                    raise ValueError("Secrets or local paths cannot enter supplemental diagnostics")
    return items
