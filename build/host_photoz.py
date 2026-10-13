#!/usr/bin/env python3
"""Publish audited aggregate counts and encrypted candidate-galaxy redshifts.

No raw photometry, PDFs, local paths or object rows enter the public summary.
An incremental publication preserves the old catalogue and every encrypted
lightcurve shard. The source release must already have its final manifest.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path

import pandas as pd

import common as C
import host_photoz_schema as HS

CONFIG = C.PRIVATE / "host_photoz_release.json"


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def boolean(value):
    if value is True or str(value).strip().lower() == "true":
        return True
    if value is False or str(value).strip().lower() == "false":
        return False
    return None


def clean(value):
    if value is None or value is pd.NA:
        return None
    if isinstance(value, str):
        return value or None
    if pd.isna(value):
        return None
    if isinstance(value, bool) or str(type(value)).endswith("bool_'>"):
        return bool(value)
    if isinstance(value, (int, float)) or hasattr(value, "item"):
        value = value.item() if hasattr(value, "item") else value
        return value if isinstance(value, (int, float, bool)) and math.isfinite(value) else None
    return None


def selected_release():
    if os.environ.get("TNSX_HOST_PHOTOZ_RELEASE"):
        return Path(os.environ["TNSX_HOST_PHOTOZ_RELEASE"])
    if CONFIG.exists():
        return Path(json.loads(CONFIG.read_text())["release_dir"])
    return None


def method_label(method):
    text = str(method).lower()
    if "fsps" in text:
        source = "Legacy" if "legacy" in text else "Rubin" if "rubin" in text or "dp2" in text else "Pan-STARRS"
        return source + " fixed-template SED"
    if text.startswith("dp2_"):
        return "Rubin " + text.removeprefix("dp2_").upper()
    if text.startswith("legacy_"):
        return "Legacy griz and WISE" if "griz" in text else "Legacy grz and WISE"
    return "Catalog photo-z"


def count(frame, column):
    return int(frame[column].map(boolean).eq(True).sum()) if column in frame else None


def numeric(value):
    try:
        result = float(value)
        return result if math.isfinite(result) and result >= 0 else None
    except (TypeError, ValueError):
        return None


def metric_row(method, scope, metrics, independence):
    intervals = metrics.get("intervals", {})
    return {"method": method_label(method), "scope": scope.replace("_", " "),
            "n": metrics.get("n", 0), "median_bias": metrics.get("median_bias"), "nmad": metrics.get("nmad"),
            "n_outliers": metrics.get("n_outliers", 0), "outlier_fraction": metrics.get("outlier_fraction"),
            "coverage68": intervals.get("68", {}).get("coverage"),
            "coverage95": intervals.get("95", {}).get("coverage"), "independence": independence}


def validation_rows(release):
    rows = []
    path = release / "photoz_validation.json"
    if path.exists():
        report = json.loads(path.read_text())
        for method in report.get("methods", []):
            for scope in method.get("scopes", []):
                if scope["photoz_quality_scope"] != "measurement_screen_pass":
                    continue
                for group in scope["metrics"].get("groups", []):
                    if group["selection"] == "independence_confirmed":
                        continue
                    tier = "known_overlap_excluded" if group["selection"] == "known_training_overlap_excluded" else "unresolved"
                    rows.append(metric_row(method["method"], group["selection"], group, tier))
    path = release / "validation/sed_validation.json"
    if path.exists():
        report = json.loads(path.read_text())
        for row in report.get("results", []):
            if not row["method"].endswith("_floor0.020") or row["quality_scope"] != "blind_quality_pass":
                continue
            tier = "local_run_holdout" if report.get("local_blind_policy_verified") else "unresolved"
            rows.append(metric_row(row["method"], row["quality_scope"], row["metrics"], tier))
    return rows


def load_release(release):
    release = Path(release).resolve()
    final = release / "final_delivery_manifest.json"
    if not final.is_file():
        raise ValueError("Host photo-z publication requires a sealed final release")
    manifest = json.loads(final.read_text())
    if manifest.get("sealed") is not True:
        raise ValueError("Host photo-z publication requires sealed=true")
    host_path = next((release / name for name in ["host_context.parquet", "host_photoz.parquet", "host_photoz_sed.parquet"] if (release / name).exists()), None)
    if host_path is None:
        raise ValueError("Final release lacks its host photo-z table")
    hosts = pd.read_parquet(host_path)
    if "transient_id" not in hosts or hosts.transient_id.duplicated().any():
        raise ValueError("Host table requires unique exact transient IDs")
    if any(isinstance(x, float) for x in hosts.transient_id):
        raise ValueError("Float-encoded transient IDs cannot be published")
    summary = {"n_transients": len(hosts), "n_selected_candidates": count(hosts, "has_selected_host_candidate"),
               "n_selected_catalog_photoz": count(hosts, "selected_catalog_photoz_available"),
               "n_selected_identity_matched_photoz": count(hosts, "selected_identity_matched_photoz_available"),
               "n_selected_screened_photoz": count(hosts, "selected_candidate_photoz_screen_pass"),
               "n_selected_candidate_spectra": count(hosts, "selected_has_source_secure_galaxy_redshift"),
               "n_confirmed_host_identities": count(hosts, "confirmed_host_identity"),
               "n_science_usable": count(hosts, "photoz_science_usable")}
    if "selected_photoz_status" in hosts:
        statuses = hosts.selected_photoz_status.fillna("").astype(str)
        summary["n_selected_missing_photoz"] = int(statuses.str.contains("missing|unavailable|no_photoz", case=False).sum())
        summary["n_selected_review_photoz"] = int(statuses.str.contains("review", case=False).sum())
    metric_path = release / "metrics.json"
    if metric_path.exists():
        metrics = json.loads(metric_path.read_text())
        for dest, source in {"n_sed_targets": "targets", "n_sed_finite": "targets_with_finite_sed_fit",
                             "n_sed_screened": "targets_with_screened_fit", "n_sed_consistent": "targets_with_consistent_provisional_constraint",
                             "n_sed_conflicts": "cross_survey_disagreements", "n_validation_galaxies": "controls"}.items():
            if source in metrics:
                summary[dest] = metrics[source]
    local = None
    audit = release / "validation/local_blinding_audit.json"
    if audit.exists():
        local = bool(json.loads(audit.read_text()).get("all_pass"))
    public = {"schema_version": 1, "release": release.name, "status": "complete", "manifest_sha256": sha256(final),
              "summary": summary, "validation": validation_rows(release),
              "lineage": {"local_fixed_run_blinded": local, "entire_ancestry_confirmed": False,
                          "legacy_false_is_formal_independence": False}}
    summary_path = release / "website_summary.json"
    if summary_path.exists():
        approved = json.loads(summary_path.read_text())
        public["summary"] = HS.public_counts(approved.get("summary", {}))
        public["validation"] = [{key: value for key, value in row.items() if key in HS.VALIDATION_FIELDS}
                                for row in approved.get("validation", [])]
        public["lineage"] = {key: value for key, value in approved.get("lineage", public["lineage"]).items() if key in HS.LINEAGE_FIELDS}
    sed_path = release / "target_sed_summary.parquet"
    if sed_path.exists():
        sed = pd.read_parquet(sed_path)
        add = [c for c in sed if c == "transient_id" or c.startswith("sed_")]
        hosts = hosts.merge(sed[add], on="transient_id", how="left", validate="one_to_one", suffixes=("", "_extra"))
    table = team_table(hosts)
    used_paths = [host_path, *[p for p in [summary_path, metric_path, sed_path,
        release / "photoz_validation.json", release / "validation/sed_validation.json", audit] if p.exists()]]
    for path in used_paths:
        record = manifest.get("files", {}).get(str(path.relative_to(release)))
        if not isinstance(record, dict) or record.get("sha256") != sha256(path):
            raise ValueError("Consumed website input is not verified by the final manifest")
    return HS.validate_public(public), HS.validate_team(table), {"release_dir": str(release), "manifest_sha256": sha256(final),
        "host_table_sha256": sha256(host_path), "host_table_file": host_path.name}


def team_table(hosts):
    rows = []
    for record in hosts.to_dict("records"):
        def get(column):
            return clean(record.get(column))
        row = {"transient_id": str(record["transient_id"]), "name": get("name") or get("tns_name"),
               "candidate_uid": get("provisional_host_candidate_uid"),
               "association_status": get("host_redshift_status"), "confirmed_host_identity": boolean(record.get("confirmed_host_identity")) is True,
               "spectrum_status": get("selected_candidate_spectroscopy_status"), "candidate_specz": numeric(record.get("selected_galaxy_specz")),
               "catalog_photoz": numeric(record.get("selected_preferred_photoz")), "catalog_photoz_method": get("selected_preferred_method"),
               "photoz_status": get("selected_photoz_status"), "photoz_quality_pass": boolean(record.get("selected_candidate_photoz_screen_pass")) is True,
               "sed_status": get("sed_assessment"), "sed_adopted_as_hostz": False, "science_usable": False}
        for source, stem in [("rubin", "rubin_dp2"), ("legacy", "legacy"), ("ps1", "ps1")]:
            passed = boolean(record.get(f"sed_{stem}_combined_screen_pass")) is True
            row[f"sed_{source}_pass"] = passed
            row[f"sed_{source}_z"] = numeric(record.get(f"sed_{stem}_z_best"))
            for field in HS.SED_DIAGNOSTIC_FIELDS:
                key = f"sed_{source}_{field}"
                if field == "source_validation_pass":
                    row[key] = boolean(record.get(f"sed_{stem}_source_fresh_validation_pass")) is True
                elif field == "temperature_calibration_available":
                    row[key] = boolean(record.get(f"sed_{stem}_{field}")) is True
                elif field == "review_flags":
                    row[key] = get(f"sed_{stem}_{field}")
                else:
                    row[key] = numeric(record.get(f"sed_{stem}_{field}"))
        for short, method in [("legacy_griz", "legacy_griz_wise"), ("legacy_grz", "legacy_grz_wise")]:
            for field in HS.INTERVAL_DIAGNOSTIC_FIELDS:
                column = f"calibrated_{method}_interval_calibration_support_pass" if field == "support_pass" else f"calibrated_{method}_expanded_z_{field}"
                row[f"expanded_{short}_{field}"] = boolean(record.get(column)) is True if field == "support_pass" else numeric(record.get(column))
        for column in HS.SUPPLEMENTAL_FIELDS:
            row[column] = supplemental_json(record.get(column), column)
        rows.append([row.get(column) for column in HS.TEAM_COLS])
    return {"cols": HS.TEAM_COLS, "rows": rows}


def supplemental_json(raw, column):
    if raw is None or raw is pd.NA or (isinstance(raw, float) and not math.isfinite(raw)):
        return None
    items = json.loads(raw) if isinstance(raw, str) else raw
    if not isinstance(items, list):
        raise ValueError("Supplemental diagnostics must be a list")
    result = []
    for item in items:
        if not isinstance(item, dict):
            raise ValueError("Supplemental diagnostic items must be records")
        if boolean(item.get("adopted_as_hostz")) is True or boolean(item.get("use_for_fitting")) is True:
            raise ValueError("Supplemental diagnostic unexpectedly promoted")
        entry = {key: clean(value) for key, value in item.items() if key in HS.SUPPLEMENTAL_FIELDS[column] and key != "quality"}
        entry["diagnostic_only"] = True
        if column != "supplemental_photometry_outcomes_json":
            entry["adopted_as_hostz"] = False
        if column == "supplemental_catalog_photoz_json":
            entry["use_for_fitting"] = False
            quality = item.get("quality")
            if isinstance(quality, str):
                try:
                    quality = json.loads(quality)
                except ValueError:
                    quality = None
            if isinstance(quality, dict):
                entry["quality"] = {key: clean(value) for key, value in quality.items() if key in HS.QUALITY_FIELDS}
        for key in ["z_best", "z_median", "z16", "z84", "z025", "z975", "photoz_point", "photoz_sigma", "photoz_lo68", "photoz_hi68"]:
            if key in entry:
                entry[key] = numeric(entry[key])
        result.append(entry)
    raw = json.dumps(result, separators=(",", ":"), allow_nan=False)
    HS.validate_supplemental(column, raw)
    return raw


def attach_to_payload(payload):
    release = selected_release()
    if release is None:
        return payload
    _, table, _ = load_release(release)
    payload["host_photoz"] = table
    return payload


def read_existing_layer(site, password):
    import crypto_layer as CL
    import check_public as CP
    directory = site / "data/edp2"
    ki = CP.parse_keyinfo((directory / "keyinfo.js").read_text())
    key = CL.derive_key(password, ki["salt"], ki["iter"])
    payload, shards, extras = None, {}, {}
    for path in sorted(directory.glob("*.js")):
        if path.name == "keyinfo.js":
            continue
        name, iv, ciphertext = CP.parse_enc(path.read_text())
        value = json.loads(CL.unseal(key, name, iv, ciphertext).decode("utf-8"))
        if name == "catalog":
            payload = value
        elif name.startswith("lc-x"):
            extras[int(name[4:])] = value
        elif name.startswith("lc-"):
            shards[int(name[3:])] = value
    if payload is None or sorted(shards) != list(range(len(shards))) or sorted(extras) != list(range(len(extras))):
        raise ValueError("Existing encrypted layer is incomplete")
    return payload, shards, extras


def publish(release, site):
    import crypto_layer as CL
    import check_public as CP
    public, table, receipt = load_release(release)
    password = CL.get_password()  # stays in memory; never logged or written
    payload, shards, extras = read_existing_layer(site, password)
    payload["host_photoz"] = table
    secret_ids = {row[0] for row in table["rows"] if row[0].isdigit()}
    for column in ["edp2_id"]:
        if column in payload.get("cols", []):
            j = payload["cols"].index(column)
            secret_ids.update(str(row[j]) for row in payload["rows"] if row[j])
    public_path = site / "data/host_photoz.js"
    previous = public_path.read_bytes() if public_path.exists() else None
    public_path.write_text("TNSX.onHostPhotoz("+json.dumps(public, separators=(",", ":"), allow_nan=False)+");\n")
    try:
        _, info = CL.write_layer(site / "data", password, payload, shards, len(shards), secret_ids, xshards=extras)
        if CP.main(site):
            raise ValueError("Public data guard failed")
    except BaseException:
        if previous is None:
            public_path.unlink(missing_ok=True)
        else:
            public_path.write_bytes(previous)
        raise
    C.PRIVATE.mkdir(parents=True, exist_ok=True)
    CONFIG.write_text(json.dumps(receipt, indent=2)+"\n")
    CONFIG.chmod(0o600)
    return {"release": public["release"], "public_summary_only": True, "encrypted_rows": len(table["rows"]),
            "encrypted_files_rewritten": info.get("sealed"), "manifest_sha256": receipt["manifest_sha256"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--release-dir", type=Path, required=True)
    parser.add_argument("--site", type=Path, default=C.SITE)
    parser.add_argument("--publish", action="store_true", help="Write aggregate summary and existing encrypted team layer")
    args = parser.parse_args()
    if args.publish:
        result = publish(args.release_dir, args.site.resolve())
    else:
        public, table, receipt = load_release(args.release_dir)
        result = {"release": public["release"], "summary": public["summary"], "validation_rows": len(public["validation"]),
                  "encrypted_rows": len(table["rows"]), "manifest_sha256": receipt["manifest_sha256"], "written": False}
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
