#!/bin/sh
# Re-normalize cached fetches, rebuild both sites, and publish the public one.
# The public site gets the EDP2 team-access layer as ciphertext only (docs/data/edp2/,
# keyed by TNSX_SITE_PASSWORD). The key and unchanged files are kept while the password
# is unchanged, so only changed files are committed; add --rotate for a new key.
# The pre-commit hook re-runs check_public.py before anything is committed.
set -e
cd "$(dirname "$0")/.."
PY=${PY:-$HOME/.venvs/debass_py313/bin/python}
$PY build/fetch_tns_phot.py --normalize-only
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
