# Data contract

Two layers: normalized photometry written by the fetchers, and the static JS
data files that `build/assemble.py` writes for the site. Paths come from
`build/common.py`.

## Public vs private

Rubin DP2/EDP2 catalog data (DiaObject, DiaSource, ForcedSourceOnDiaObject,
match separations, diaObjectIds) is proprietary under the Rubin Data Policy
(RDO-13, DPOL-506 and DPOL-516). It is written only under `PRIVATE`
(`rubin_hackathon/reports/tns_edp2_explorer_private/`, outside this repo)
and appears only in the private build. Public sources are TNS, ZTF via
ALeRCE, public Rubin alerts via Fink, and `dp2.Visit` pointing metadata, which is
public in Rubin's tutorial-notebooks-data. Aggregate statistics from the
cross-match (recovery fractions, histograms) are derived data products and
may appear publicly. `build/check_public.py` enforces this on `docs/`.

## 1. Normalized photometry (fetcher output)

One parquet per fetcher, columns exactly `common.NORM_COLUMNS`, written with
`common.write_norm()`:

| column | type | meaning |
|---|---|---|
| name | string | TNS name without prefix (`2025abc`), the join key |
| source | string | key of `common.SOURCES` |
| mjd | float64 | MJD (TAI for LSST, as given for others) |
| band | string | filter label, see below |
| flux | float64 | nJy, AB zero point 31.4; NaN for pure upper limits |
| flux_err | float64 | nJy |
| kind | int8 | 0 detection, 1 forced photometry, 2 upper limit |
| lim_mag | float64 | limiting AB mag when kind == 2, else NaN |
| note | string | instrument/telescope, alert id, flags; "" if none |

Files:

| file | sources | writer |
|---|---|---|
| `cache/norm/ztf.parquet` | ztf, ztf_fp | `build/fetch_ztf.py` |
| `cache/norm/tns.parquet` | tns | `build/fetch_tns_phot.py` |
| `cache/norm/lsst_alert.parquet` | lsst_alert, lsst_alert_fp | `build/fetch_alerts.py` |
| `PRIVATE/norm/edp2.parquet` | edp2_dia, edp2_fp | `build/fetch_edp2.py` |

Side tables that feed catalog columns:

| file | columns |
|---|---|
| `cache/norm/lsst_alert_ids.parquet` | name, alert_id (string), sep_arcsec, broker |
| `PRIVATE/norm/edp2_objects.parquet` | name, diaObjectId (string), sep_arcsec, nDiaSources, n_fp, lead_days, time_consistent |

Every source keeps only epochs within `[disc_mjd - 150, disc_mjd + 400]` d
(`common.WINDOW_PRE_D`, `WINDOW_POST_D`), using the object's TNS discovery MJD.

Mag to flux: `flux = 10**((31.4 - mag)/2.5)`, `flux_err = flux*ln(10)/2.5*magerr`
(`common.mag_to_njy`). ZTF forced difference flux in DN with zero point
`magzpsci`: `nJy = DN * 10**((31.4 - magzpsci)/2.5)`.

### Band labels

- LSST (EDP2, alerts): `u g r i z y`
- ZTF: `ztf-g ztf-r ztf-i`
- TNS: `<filter>` or `<system>-<filter>` as TNS names it, e.g. `ATLAS-o`,
  `ATLAS-c`, `ZTF-g`, `PS1-w`, `GOTO-L`, `Clear`, `g`, `r`, `V`. The site
  colours bands by family: the last token after `-`, case-insensitive, is
  mapped as u g r i z y o c w L V B R I Clear, and anything else is grey.

## 2. Site data files (assemble output)

All data is loaded through `<script>` tags that call a global `TNSX` object,
so the same site works on GitHub Pages and when opened from disk
(`file://`, private build). `docs/app.js` must define these callbacks before
it inserts any data script.

```
docs/data/catalog.js   TNSX.onCatalog({meta, cols, rows})
docs/data/visits.js    TNSX.onVisits({cols:["mjd","band","ra","dec"], rows:[[...], ...]})
docs/data/lc/NNN.js    TNSX.onShard(NNN, {"2025abc": {"ztf": LC, "tns": LC, ...}, ...})
```

`NNN` is zero-padded to 3 digits; object `i` in catalog order lives in shard
`i // 100` (catalog column `shard`).

LC (columnar, one per source per object; arrays have equal length):

```
{"t": [mjd...], "b": [band...], "f": [nJy or null], "e": [nJy or null],
 "k": [0|1|2...], "l": [limit mag or null], "x": [note...]}
```

`catalog.meta`:

```
{"mode": "public"|"private", "built": ISO timestamp, "n_objects": int,
 "window": {"mjd_start": 60790.117, "mjd_end": 61047.155},
 "sources": {key: {"label", "desc", "survey", "n_objects", "n_points"}},  // only sources present
 "stats": {...aggregate cross-match numbers, from summary.json...},
 "notes": [strings shown on the About page]}
```

`catalog.cols` and `rows`: one row per object, in catalog order. Public columns:

| col | meaning |
|---|---|
| name | `2025abc` |
| prefix | `SN` or `AT` |
| ra, dec | deg (TNS) |
| type | TNS type or null |
| z | TNS redshift or null |
| group | TNS reporting group |
| disc_mjd, disc_mag, disc_filter | TNS discovery |
| internal | TNS internal names, comma separated |
| n_visits | dp2.Visit centres within 2.1 deg, any time |
| n_visits_active | same, within [disc-30, disc+100] d |
| n_<source> | number of measurements (kind 0 or 1; limits excluded) per public source (0 if none) |
| t0_<source>, t1_<source> | first and last MJD per public source (null if none) |
| alert_ids | Fink LSST alert diaObjectIds, comma separated ("" if none) |
| n_spec | number of TNS-reported spectra (0 if none) |
| spec_types | TNS spectra as "date instrument (group)", semicolon separated ("" if none); TNS gives no per-spectrum class, the object class is `type` |
| shard | lightcurve shard index |

Private builds add `n_edp2_dia, n_edp2_fp, t0_edp2_dia, t1_edp2_dia,
edp2_id, edp2_sep, edp2_ndia, edp2_lead, edp2_tc`. IDs are always strings:
~1e17 integers do not survive float64 or JS Number.
