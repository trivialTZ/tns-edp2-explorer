# TNS × EDP2 explorer

A static lightcurve browser for the 9,330 TNS transients discovered between
MJD 60730 and 61047 (2025-02-23 to 2026-01-17) that lie within 2.1° of a
Rubin EDP2 (Data Preview 2) visit centre. Each object's page overlays
photometry from every source we could collect, on a common nJy scale. The
design follows the flow of LSST DESC's
[FASTDB](https://github.com/LSSTDESC/FASTDB) web app: object search, then
object list, then object info, with a per-source selector in place of
FASTDB's processing version.

**Site:** https://trivialtz.github.io/tns-edp2-explorer/

## Two builds

| | public (this repo, GitHub Pages) | private (never committed) |
|---|---|---|
| TNS metadata, spectra counts, reported photometry | yes | yes |
| ZTF detections, limits, forced photometry (ALeRCE) | yes | yes |
| Rubin alert-stream photometry (Fink LSST) | yes | yes |
| LSSTCam pointing epochs (`dp2.Visit`) | yes | yes |
| Aggregate TNS × EDP2 cross-match statistics | yes | yes |
| EDP2 `DiaSource` and `ForcedSourceOnDiaObject` photometry, match IDs and separations | **no** | yes |

Rubin DP2 catalog products are proprietary for Rubin data-rights holders under
the [Rubin Data Policy](https://ls.st/rdo-013) (RDO-13, DPOL-506 and DPOL-516),
so they are excluded from this repo. `build/check_public.py` blocks them in
the pre-commit hook (and in CI once `ci/check-public.yml` is enabled). The private build is written to
`rubin_hackathon/reports/tns_edp2_explorer_private/site/`. You open it from
disk, and it may be shared only with data-rights holders.

## Rebuild

```bash
PY=~/.venvs/debass_py313/bin/python
$PY build/fetch_ztf.py          # ALeRCE ZTF      -> cache/norm/ztf.parquet
$PY build/fetch_tns_phot.py     # TNS API         -> cache/norm/tns.parquet, tns_spectra.parquet
$PY build/fetch_alerts.py       # Fink LSST       -> cache/norm/lsst_alert*.parquet
$PY build/fetch_edp2.py         # RSP TAP (dp2)   -> PRIVATE/norm/edp2*.parquet
$PY build/assemble.py --mode public    # -> docs/data/
$PY build/assemble.py --mode private   # -> PRIVATE/site/
python3 build/check_public.py docs
```

Fetchers cache raw responses and resume. `--normalize-only` rebuilds a
parquet from the cache without touching the network. Inputs such as the target
list, `dp2.Visit`, and the cross-match come from `rubin_hackathon`
(`scripts/_exp_rsp_tns_edp2_xmatch.py`). Credentials (`TNS_*`, `RSP_TOKEN`)
are read from `rubin_hackathon/.env` and never written anywhere. The data
contract is in [SCHEMA.md](SCHEMA.md). After cloning, run
`git config core.hooksPath .githooks` to enable the guard hook. To run the
same check in GitHub Actions, copy `ci/check-public.yml` to
`.github/workflows/`; pushing it needs a token with the `workflow` scope.

## Credits

Transient Name Server (wis-tns.org); ZTF data via the ALeRCE broker; Rubin
alert-stream data via the Fink broker; NSF–DOE Vera C. Rubin Observatory
(dp2.Visit metadata, and DP2 catalogs in the private build only).
