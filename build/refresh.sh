#!/bin/sh
# Re-normalize cached fetches, rebuild both sites, and publish the public one.
# The public site gets the EDP2 team-access layer as ciphertext only (docs/data/edp2/,
# keyed by TNSX_SITE_PASSWORD). The key and unchanged files are kept while the password
# is unchanged, so only changed files are committed; add --rotate for a new key.
# Host-galaxy products (common.HOSTS_DIR) are read on every run: SN Ia-list hosts are
# public (docs/data/hosts/), all other host rows go only into the encrypted layer.
# DEBASS membership comes from the link-shared DEBASS sheet (FINISHED / YES only).
# Rubin alert cutouts and broker classifications are public; DP2 deep-coadd stamps are private and reach
# the public site only inside the encrypted layer.
# The pre-commit hook re-runs check_public.py before anything is committed.
set -e
cd "$(dirname "$0")/.."
PY=${PY:-$HOME/.venvs/debass_py313/bin/python}
$PY build/fetch_tns_phot.py --normalize-only
(cd build && $PY fetch_debass.py) || echo "DEBASS sheet not refreshed; keeping the cached list"
(cd build && $PY fetch_tns_spectra.py) || echo "TNS spectra not refreshed; keeping the cached files"
(cd build && $PY fetch_edp2_coadd.py)   # private: DP2 deep-coadd footprint per object (cached TAP download)
(cd build && $PY fetch_alert_stamps.py) || echo "Rubin alert cutouts not refreshed; keeping the cached ones"
(cd build && $PY fetch_edp2_stamps.py) || echo "DP2 coadd stamps not refreshed"   # private, ~32 cutouts/min, fetches only missing ones
# Classifications: rerun the metaDEBASS scoring over the cohort first when broker data should be refreshed
# (rubin_hackathon/data/tnsx_eval_*/tools: make_cohort.py, run_fetch.py, run_score.sh); this step only re-exports it.
(cd build && $PY classifiers.py) || echo "classifier export not refreshed; keeping the cached one"
(cd build && $PY assemble.py --mode public --encrypt-edp2 && python3 check_public.py ../docs && $PY assemble.py --mode private)
git add docs/data
if git diff --cached --quiet; then
  echo "no data changes"
else
  git commit -q -m "Refresh site data ($(date -u +%Y-%m-%d))

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  git push -q
  echo "pushed $(git rev-parse --short HEAD)"
fi
