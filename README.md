# TNS × EDP2 explorer

A static lightcurve browser for the 9,330 TNS transients discovered between
MJD 60730 and 61047 (2025-02-24 to 2026-01-07) that lie within 2.1° of a
Rubin EDP2 (Data Preview 2) visit centre. Each object's page overlays
photometry from every source we could collect, on a common nJy scale. The
design follows the flow of LSST DESC's
[FASTDB](https://github.com/LSSTDESC/FASTDB) web app: object search, then
object list, then object info, with a per-source selector in place of
FASTDB's processing version.

**Site:** https://trivialtz.github.io/tns-edp2-explorer/

## What each page has

- **Explore**: faceted filters (type, region, DEBASS, sources, Rubin first?, metaDEBASS confidence and more), a table or sky view, all in the URL.
- **Object pages**: TNS record, lightcurve, sky images (Legacy Surveys / Pan-STARRS1 / DSS2) and Rubin
  alert cutouts, broker classifications per detection with metaDEBASS confidences (P(supernova), P(SN Ia)
  for ZTF) and its trust in broker calls where it has a trust model, and public TNS spectra.
- **Classifiers**: how often each broker classifier was right on the TNS-typed objects after 3, 5 and
  10 detections (`build/classifiers.py`). metaDEBASS is a meta-layer, not a classifier, so it is not graded.
- **Data**: `docs/data/download/` (catalogue, all public photometry, classifier outputs, MANIFEST.json),
  a Python example, and how to cite. `CITATION.cff` and `.zenodo.json` describe the repository for GitHub's
  "Cite this repository" and for Zenodo.

Broker classifications come from a metaDEBASS scoring run over this catalogue's ZTF and Rubin alert IDs
(`rubin_hackathon/data/tnsx_eval_20260924/`: `tools/make_cohort.py`, `tools/run_fetch.py`,
`tools/run_score.sh`); `build/classifiers.py` exports it. Pitt-Google is not queried (BigQuery bills the
project), and the Fink ZTF API did not answer during the 2026-09-24 run, so Fink classifiers are Rubin-only.

## Two builds and a locked layer

| | public (this repo, GitHub Pages) | public, unlocked with the team password | private (never committed) |
|---|---|---|---|
| TNS metadata, spectra counts, reported photometry | yes | yes | yes |
| ZTF detections, limits, forced photometry (ALeRCE) | yes | yes | yes |
| Rubin alert-stream photometry and diaObjectIds (Fink LSST) | yes | yes | yes |
| LSSTCam pointing epochs (`dp2.Visit`) | yes | yes | yes |
| Aggregate TNS × EDP2 cross-match statistics | yes | yes | yes |
| Rubin alert cutouts, broker classifications, metaDEBASS scores, bulk downloads | yes | yes | yes |
| EDP2 `DiaSource` and `ForcedSourceOnDiaObject` photometry, DP2 diaObjectIds and separations | **no** (ciphertext only) | yes, decrypted in the browser | yes |
| DP2 deep-coadd image stamps | **no** (ciphertext only) | yes, decrypted in the browser | yes |

Rubin DP2 catalog products are proprietary for Rubin data-rights holders under
the [Rubin Data Policy](https://ls.st/rdo-013) (RDO-13, DPOL-506 and DPOL-516),
so they never appear in this repo in readable form. `build/check_public.py`
blocks them in the pre-commit hook (and in CI once `ci/check-public.yml` is
enabled). The private build is written to
`rubin_hackathon/reports/tns_edp2_explorer_private/site/`. You open it from
disk, and it may be shared only with data-rights holders.

## Team access: the encrypted EDP2 layer

The public site can also carry the EDP2 data as ciphertext, which Rubin
data-rights holders unlock in the browser with a shared team password.

- **Build.** `assemble.py --mode public --encrypt-edp2` reads the private EDP2
  inputs and writes only `docs/data/edp2/`: `keyinfo.js`, `catalog.js` and one
  `NNN.js` per lightcurve shard, including empty ones. Each is AES-256-GCM
  ciphertext under a key derived from `TNSX_SITE_PASSWORD` (in
  `rubin_hackathon/.env`) by PBKDF2-HMAC-SHA256 with 600,000 iterations and a
  random salt. Plaintexts are padded to multiples of 4 KB. The build then
  decrypts everything again and compares it with the source, checks that a
  wrong password fails, scans the whole site for plaintext IDs and the
  password, and checks that an immediate rebuild would change nothing. Without
  `--encrypt-edp2`, `docs/data/edp2/` is deleted. `check_public.py` accepts
  files in that folder only if they have the exact ciphertext shapes (SCHEMA.md
  section 3).
- **Stable key.** While the password is unchanged the salt, and so the key, is
  kept, and every file whose data did not change stays byte-identical. A data
  refresh therefore commits only the files that changed, and stored browser
  keys keep working. A changed file always gets a new random IV that was never
  used under that key. The salt, a manifest of plaintext and ciphertext
  SHA-256 per file, and the used IVs live in `PRIVATE/crypto_state.json`
  (mode 600, never in the repo). If that file is lost, the build rebuilds it by
  decrypting the committed files. `build/test_crypto_layer.py` tests these
  rules with a throwaway password.
- **Rotation.** Change `TNSX_SITE_PASSWORD` and rebuild: the old password no
  longer opens `keyinfo.js`, so the build draws a new salt and re-encrypts
  every file. `assemble.py --mode public --encrypt-edp2 --rotate` does the same
  without a password change. Either way every stored browser key stops working,
  and holders must unlock again.
- **Browser.** "Team access" in the top bar asks for the password. WebCrypto
  derives the key and checks it against a known blob, then stores the raw key
  bytes with the build's salt in `sessionStorage`, or in `localStorage` when
  "Remember on this device" is ticked. The page then reloads in the existing
  private view: proprietary banner, EDP2 sources, facets and columns, and DP2
  diaObjectIds, all decrypted in memory. "Lock" forgets the key. If anything
  fails (a rebuilt salt, a bad key, a file that does not decrypt), the key is
  forgotten and the site falls back to public mode with a short notice. When
  locked, the only trace of the layer is the button and a short note on the
  About page.

What this does and does not protect:

- It is only as strong as the password. Anyone can download the ciphertext and
  try passwords offline; PBKDF2 slows each guess but cannot save a short or
  reused password. Use a long random one.
- Ciphertext stays in public git history for good. Rotation (above) protects
  only later builds: files committed under the old password stay readable to
  anyone who has it, so a leaked password exposes everything ever encrypted
  with it. Because the key now stays the same across refreshes, that means
  every build since the last rotation.
- The password goes only to Rubin data-rights holders. Never put it in this
  repo, an issue, a commit message or a channel with anyone else. Everyone who
  unlocks is bound by the Rubin Data Policy, as for the private build.
  Encryption keeps the public from reading the data; it cannot stop a rights
  holder from passing on the password or what they decrypted.
- Without the password you still see that the layer exists, the number of
  shards, and each file's size rounded up to 4 KB, a coarse hint of how much
  EDP2 photometry each block of 100 transients has.
- A refresh adds only the files whose EDP2 data changed to git history; a
  rotation re-encrypts all of them (about 10 MB). Git also shows which files
  changed between commits, a coarse hint of where EDP2 data was updated.

## Rebuild

```bash
PY=~/.venvs/debass_py313/bin/python
$PY build/fetch_ztf.py          # ALeRCE ZTF      -> cache/norm/ztf.parquet
$PY build/fetch_tns_phot.py     # TNS API         -> cache/norm/tns.parquet, tns_spectra.parquet
$PY build/fetch_alerts.py       # Fink LSST       -> cache/norm/lsst_alert*.parquet
$PY build/fetch_edp2.py         # RSP TAP (dp2)   -> PRIVATE/norm/edp2*.parquet
$PY build/assemble.py --mode public --encrypt-edp2   # -> docs/data/ (+ ciphertext in docs/data/edp2/; add --rotate for a new key)
$PY build/assemble.py --mode private                 # -> PRIVATE/site/
python3 build/check_public.py docs                   # and build/test_check_public.py for the guard itself
```

`build/refresh.sh` re-normalizes the TNS cache, runs both assemble steps (the
public one with `--encrypt-edp2`) and the check, then commits and pushes the
public data. Fetchers cache raw responses and resume. `--normalize-only` rebuilds a
parquet from the cache without touching the network. Inputs such as the target
list, `dp2.Visit`, and the cross-match come from `rubin_hackathon`
(`scripts/_exp_rsp_tns_edp2_xmatch.py`). Credentials (`TNS_*`, `RSP_TOKEN`)
are read from `rubin_hackathon/.env` and never written anywhere. The data
contract is in [SCHEMA.md](SCHEMA.md). After cloning, run
`git config core.hooksPath .githooks` to enable the guard hook. To run the
same check in GitHub Actions, copy `ci/check-public.yml` to
`.github/workflows/`; pushing it needs a token with the `workflow` scope.

## Host galaxies (diagnostic)

Object pages can show a host-galaxy card: the host-selection figure, the
association (catalogue and ID, separation, d_DLR, tier, redshift) and Bagpipes
posteriors (median and 16–84%) for log M*, log SFR, log sSFR, mass-weighted age
and A_V. Explore gets host facets and columns. The products come from an
independent public-data host pipeline in `rubin_hackathon`
(`common.HOSTS_DIR` = `reports/tns_edp2_hosts/site/`: `hosts.parquet`,
`img/<name>.png`). `assemble.py` reads them on every run, so one re-assemble
(or `refresh.sh`) picks up new rows, figures and fits. The pipeline is
diagnostic only: association weights are uncalibrated and the fits depend on
the model. It uses no TITAN code or products.

The products hold no DP2 value, but one of the two target lists, the
good-EDP2 list, is selected with proprietary DP2 detections. So
(`build/hosts.py`):

- **Public:** only rows on the SN Ia list (spectroscopic SNe Ia with a TNS
  redshift, selected from public TNS data) that this site also shows as
  TNS-typed SN Ia. They form a sparse `hosts` table in `data/catalog.js`, with
  figures in `data/hosts/<name>.webp` (400 px WebP). `assemble.py` asserts that
  every public row is on the SN Ia list. `check_public.py` rejects host rows for
  objects not typed SN Ia here, figures without a public row, and any
  list-membership or DP2 field.
- **Encrypted only:** every other row (the good-EDP2-only objects) goes into
  the encrypted catalogue, and its figure is embedded as a 256 px WebP data URI
  in the encrypted lightcurve shard. So those cards appear only with team access.
- **Never published:** `in_good_edp2_list`, in any form.
- **Held back while the host run is going:** the pipeline fitted sub-lists at
  different times, so partial fit progress correlates with good-EDP2
  membership. While any public row's fit is still pending, every public fit
  shows as pending (no posteriors). The real values travel only in the
  encrypted layer, and the gate lifts on the first rebuild after the run ends.

`build/test_hosts.py` (venv) tests the split and the withholding, and
`build/test_check_public.py` tests the guards.

## Using the site

Search (top bar, home page, Explore name box) takes TNS names, internal names,
"RA Dec", and Rubin diaObjectIds, either whole or as a prefix of at least 6
digits; `#/object/<diaObjectId>` opens the matching transient. Alert-stream IDs
are public. DP2 catalogue IDs are searchable only when unlocked or in the
private build. On an object page, "Merge sources" joins each band's detections
and forced photometry from every source with one line in time order. The CSV
button saves the points shown as one combined table, with `survey` and
`band_family` columns.

## Credits

Transient Name Server (wis-tns.org); ZTF data via the ALeRCE broker; Rubin
alert-stream data via the Fink broker; NSF–DOE Vera C. Rubin Observatory
(dp2.Visit metadata, and DP2 catalogs in the private build only).
