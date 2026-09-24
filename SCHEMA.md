# Data contract

Two layers: normalized photometry written by the fetchers, and the static JS
data files that `build/assemble.py` writes for the site. Paths come from
`build/common.py`.

## Public vs private

Rubin DP2/EDP2 catalog data (DiaObject, DiaSource, ForcedSourceOnDiaObject,
match separations, diaObjectIds) is proprietary under the Rubin Data Policy
(RDO-13, DPOL-506 and DPOL-516). It is written in readable form only under
`PRIVATE` (`rubin_hackathon/reports/tns_edp2_explorer_private/`, outside this
repo) and appears only in the private build. The public site may carry it only
as the AES-GCM ciphertext of section 3, in `docs/data/edp2/`. Public sources are TNS, ZTF via
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
`i // 100` (catalog column `shard`). `TNSX.onShard` data is not used until any
matching encrypted shard (section 3) has been merged into it.

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
 "notes": [strings shown on the About page],
 "team_access": true,   // only when the build ships the encrypted layer, data/edp2/
 "regions": ["WFD", DDF field names...],
 "debass": {"n", "statuses", "updated"},
 "hosts": {"n_rows", "n_images", "fits_withheld"}}   // only when host products exist
```

`catalog.hosts` (optional): a sparse host-galaxy table, `{"cols": ["name", "host_*"...], "rows": [[...], ...]}`,
one row per object that has a public host row (see "Host galaxies" below). The site
merges it into catalogue columns at load (null where an object has none).

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
| alert_ids | Rubin alert-stream diaObjectIds (via Fink LSST), comma separated ("" if none); searchable by exact value or a prefix of 6+ digits, and `#/object/<id>` resolves them |
| n_spec | number of TNS-reported spectra (0 if none) |
| spec_types | TNS spectra as "date instrument (group)", semicolon separated ("" if none); TNS gives no per-spectrum class, the object class is `type` |
| region | `WFD`, or the LSST Deep Drilling Field (`COSMOS`, `ECDFS`, `EDFS`, `ELAIS-S1`, `XMM-LSS`) when a dp2.Visit aimed within 1 deg of that field's centre (common.DDF_FIELDS) has its centre within 1.75 deg of the object. dp2.Visit has no survey-programme column, so `WFD` also holds commissioning science-validation fields |
| debass | `FINISHED` or `YES` from the DEBASS sheet's `Following?` column (build/fetch_debass.py; TNS name, else position <= 2"), null otherwise |
| shard | lightcurve shard index |

Private builds add `n_edp2_dia, n_edp2_fp, t0_edp2_dia, t1_edp2_dia,
edp2_id, edp2_sep, edp2_ndia, edp2_lead, edp2_tc, edp2_coadd, edp2_coadd_bands` (the unlocked
public site adds the same columns from section 3). `edp2_coadd` is true when the TNS position lies
inside a dp2.CoaddPatches patch polygon and `edp2_coadd_bands` lists that patch's ObsCore
deep_coadd bands in ugrizy order (build/fetch_edp2_coadd.py). `edp2_id` is the DP2 catalogue
diaObjectId, a different ID space from `alert_ids`. IDs are always strings:
~1e17 integers do not survive float64 or JS Number.

### Host galaxies

From the independent host pipeline (`common.HOSTS_DIR`, read by `build/hosts.py`);
diagnostic only. Columns of the `hosts` table:

| col | meaning |
|---|---|
| host_status | `associated`, `ambiguous`, `no-host` or `failed` (not searched) |
| host_tier | the pipeline's association tier |
| host_id, host_cat | selected host (`LS:<release>:<brick>:<objid>` in `LS_DR10`, or `PS1:<objID>` in `PS1_DR2`); null when ambiguous |
| host_ra, host_dec | host position (deg) |
| host_sep, host_dlr, host_ddlr | separation (arcsec), circularised light scale (arcsec), separation / light scale |
| host_z, host_ztype, host_zsrc, host_zcat | fitted (fixed) redshift, `spec`/`photo`, its source, host catalogue spec-z |
| host_nbands, host_bands, host_phot, host_arm | photometry used in the fit |
| host_fit | fit status: `qc_pass`, `qc_fail` (values withheld), `pending`, `not_attempted_*`, ... |
| host_{logm,logsfr,logssfr,age,av}_{p16,p50,p84} | Bagpipes posterior quantiles (qc_pass only) |
| host_notes | pipeline notes, minus the boilerplate and the tier |
| host_imgsrc | the imaging behind the figure (Legacy Surveys DR10, Pan-STARRS1 or DSS2) |
| host_img | `"file"`: `data/hosts/<name>.webp`; `"shard"`: a data URI in the encrypted shard; null: none |

Public rows are only those with `in_snia_list` that this site shows as TNS-typed
`SN Ia*`; `in_good_edp2_list` is never written. While any public row's fit is
pending, public rows show `host_fit = "pending"` with the fit columns null (their
real values are in the encrypted `hosts` table). `data/hosts/` holds only
`<name>.webp` files for public rows with `host_img == "file"`.

## 3. Encrypted EDP2 layer (team access)

Written by `build/assemble.py --mode public --encrypt-edp2` through
`build/crypto_layer.py` and read by `docs/team.js`. Nothing else may sit in
`docs/data/edp2/`, and `build/check_public.py` enforces these exact shapes
(base64 fields only):

```
docs/data/edp2/keyinfo.js   TNSX.onKeyInfo({"v":1,"kdf":"PBKDF2-SHA256","iter":600000,"salt":B64,"check":{"iv":B64,"ct":B64}});
docs/data/edp2/catalog.js   TNSX.onEnc("catalog",{"iv":B64,"ct":B64});
docs/data/edp2/NNN.js       TNSX.onEnc("lc-NNN",{"iv":B64,"ct":B64});   one per data/lc/NNN.js, empty shards included
```

Crypto:

- key = PBKDF2-HMAC-SHA256(password, salt, iter, 32 bytes). The password is
  `TNSX_SITE_PASSWORD` from the rubin_hackathon `.env`, trimmed, Unicode NFC,
  UTF-8. `salt` is 16 random bytes (see "Key lifetime and rotation"); `iter` is
  at least 600,000.
- Each blob is AES-256-GCM with a random 12-byte `iv` that is never used for a
  second plaintext under the same key. `ct` is the ciphertext
  with the 16-byte tag appended (the WebCrypto layout). The additional data is
  the ASCII string `tnsx-edp2/v1/<name>`, with `name` being `check`, `catalog`
  or `lc-NNN`, so a blob cannot be passed off under another name.
- The `check` plaintext is the constant `tnsx-edp2 key check v1`; decrypting it
  verifies a password quickly.
- Every other plaintext is UTF-8 JSON followed by spaces up to a multiple of
  4096 bytes.

Key lifetime and rotation:

- While the password still opens the existing `keyinfo.js` check blob, a build
  keeps that salt, key and `keyinfo.js`. A file whose padded plaintext is
  unchanged keeps its existing bytes (same `iv` and `ct`), so a no-change
  rebuild leaves `docs/data/edp2/` byte-identical, which the build checks
  before it finishes. A changed plaintext is sealed again with a new random
  `iv` that is not in the key's used-IV list.
- A new password, or `assemble.py --rotate`, draws a new salt and re-encrypts
  every file. Stored browser keys then no longer match `keyinfo.salt` and are
  forgotten.
- Build state lives outside the repo in `PRIVATE/crypto_state.json` (mode
  600): `{"v":1, "salt", "iter", "files": {file: {"sha256": padded-plaintext
  hash, "file_sha256": ciphertext-file hash}}, "ivs": [every IV used under
  the key]}`. A file is reused only when both hashes match. If the state is
  missing or its salt differs from `keyinfo.js`, the build decrypts the
  existing files to rebuild the manifest. Builds to another `--out` keep a
  separate `crypto_state.<hash>.json`.

Plaintexts (no timestamps, so unchanged data gives an unchanged plaintext):

```
catalog  {"v":1,
          "names":[name, ...],                     // public catalogue order
          "cols":["edp2_id","edp2_sep","edp2_ndia","edp2_lead","edp2_tc",
                  "n_edp2_dia","t0_edp2_dia","t1_edp2_dia","n_edp2_fp",...],
          "rows":[[...], ...],                     // one per name, aligned with names
          "sources":{"edp2_dia":{label,desc,survey,n_objects,n_points}, "edp2_fp":{...}},
          "notes":[private-build About notes], "match_radius_arcsec":2.0,
          "hosts":{"cols":[...], "rows":[...]}}   // optional: encrypted-only host rows, plus the
                                                  // full values of public rows while fits are withheld
lc-NNN   {"2025abc": {"edp2_dia": LC, "edp2_fp": LC}, ...,  // LC as in section 2; {} if none
          "_hosts": {"2025xyz": "data:image/webp;base64,..."}}  // optional: figures of encrypted-only host rows
```

The site merges the encrypted `hosts` rows into the host columns by name. Rows
that only the encrypted table has are marked "team access" on their cards.

Browser side: the derived key's raw bytes are stored with the salt as
`{"v":1,"salt":B64,"key":B64}` under `tnsx-team-key` in `sessionStorage`
(default) or `localStorage` ("Remember on this device"). At boot, a stored key
whose salt equals `keyinfo.salt` must decrypt the check blob and `catalog`
before the catalogue is initialised. The columns are then merged by name,
sources are merged with EDP2 first, `meta.notes` is replaced and `meta.mode`
becomes `"private"` (plus `meta.team = true`). Each shard load also decrypts
`data/edp2/NNN.js` and adds its sources to the shard's objects. Any failure
forgets the key and falls back to the public site.
