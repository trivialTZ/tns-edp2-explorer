/* TNS x EDP2 Explorer — Data page: bulk downloads, a Python quick start, and how to cite. */
(function () {
  'use strict';
  var X = window.TNSXApp, S = X.S, U = X.U;
  var esc = U.esc;
  var rendered = false;

  var FILE_DESC = {
    'catalog.csv': 'One row per transient: TNS metadata, survey region, DEBASS status, Rubin alert IDs, the Rubin-first comparison and per-source counts.',
    'photometry.csv.gz': 'Every public photometry point on the site: TNS-reported, ZTF (ALeRCE) alerts and forced photometry, Rubin alerts and alert forced photometry (Fink).',
    'classifiers.csv.gz': 'Broker classifier outputs and metaDEBASS probabilities per object and detection number (the Classifiers page).'
  };
  // References for the data behind the site. Keep in step with About and README.
  var REFS = [
    ['Transient Name Server', 'Cite the TNS discovery and classification reports of the objects you use (ADS bibcodes YYYYTNSTR… and YYYYTNSCR…).', 'https://www.wis-tns.org/'],
    ['Zwicky Transient Facility', 'Bellm et al. 2019, PASP 131, 018002; Masci et al. 2019, PASP 131, 018003; and the ZTF acknowledgement.', 'https://www.ztf.caltech.edu/'],
    ['ALeRCE', 'Förster et al. 2021, AJ 161, 242. Classifiers: Sánchez-Sáez et al. 2021, AJ 161, 141 (light curve); Carrasco-Davis et al. 2021, AJ 162, 231 (stamp).', 'https://alerce.online/'],
    ['Fink', 'Möller et al. 2021, MNRAS 501, 3272. Classifiers: SuperNNova, Möller & de Boissière 2020, MNRAS 491, 4277; CATS, Fraga et al. 2024, A&A 692, A208; EarlySNIa, Leoni et al. 2022, A&A 663, A13.', 'https://fink-broker.org/'],
    ['Lasair', 'Williams et al. 2024, RASTI 3, 362 (Sherlock context classifications).', 'https://lasair.lsst.ac.uk/'],
    ['Rubin Observatory', 'Ivezić et al. 2019, ApJ 873, 111; Data Preview 2, doi:10.71929/rubin/3382528; and the Rubin funding acknowledgement.', 'https://citations.lsst.io/acknowledgements/index.html'],
    ['Legacy Surveys', 'Dey et al. 2019, AJ 157, 168 (image cutouts and host catalogue).', 'https://www.legacysurvey.org/acknowledgment/'],
    ['Pan-STARRS1', 'Chambers et al. 2016, arXiv:1612.05560 (image cutouts and host catalogue).', 'https://panstarrs.stsci.edu/'],
    ['Bagpipes', 'Carnall et al. 2018, MNRAS 480, 4379 (host SED fits).', 'https://bagpipes.readthedocs.io/']
  ];

  function fmtBytes(b) { return !U.isNum(b) ? '' : b >= 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' kB'; }
  function exampleName() {
    var best = null, bn = -1;
    for (var i = 0; i < S.N; i++) {
      if (!U.V(i, 'type')) continue;
      var n = 0;
      S.srcKeys.forEach(function (s) { n += U.V(i, 'n_' + s) || 0; });
      if ((U.V(i, 'n_lsst_alert') || 0) > 0) n += 1000;          // prefer one with Rubin alerts
      if (n > bn) { bn = n; best = i; }
    }
    return best == null ? '2025abc' : U.V(best, 'name');
  }
  function codeBlock(id, code) {
    return '<div class="codebox"><button type="button" class="btn btn-sm copy-code" data-code="' + id + '">' + U.icon('copy', 1.8) + 'Copy</button>' +
      '<pre id="' + id + '"><code>' + esc(code) + '</code></pre></div>';
  }
  function bibtex() {
    var c = S.meta.cite || {}, v = String(S.meta.built || '').slice(0, 10), y = v.slice(0, 4) || '2026';
    return '@misc{tnsx_edp2_explorer,\n' +
      '  author       = {Tang, Xianzhe},\n' +
      '  title        = {{TNS $\\times$ EDP2 Explorer: lightcurves of TNS transients in the Rubin EDP2 footprint}},\n' +
      '  year         = {' + y + '},\n' +
      '  version      = {' + v + '},\n' +
      (c.doi ? '  doi          = {' + c.doi + '},\n' : '') +
      '  howpublished = {\\url{' + (c.site || location.href.split('#')[0]) + '}},\n' +
      '  note         = {Code and data: \\url{' + (c.repo || '') + '}}\n}';
  }

  function render() {
    var root = document.getElementById('view-data');
    var M = S.meta, dl = M.download || {}, c = M.cite || {}, base = (c.site || '') + 'data/download/';
    var files = Object.keys(dl);
    var rows = files.map(function (f) {
      var d = dl[f];
      return '<tr><td><a class="mono" href="data/download/' + esc(f) + '" download>' + esc(f) + '</a></td><td>' + esc(FILE_DESC[f] || '') + '</td>' +
        '<td class="num">' + U.fint(d.rows) + '</td><td class="num">' + fmtBytes(d.bytes) + '</td></tr>';
    }).join('');
    var ex = exampleName();
    var py = 'import numpy as np\nimport pandas as pd\n\n' +
      'base = "' + base + '"\n' +
      'cat = pd.read_csv(base + "catalog.csv", dtype={"rubin_alert_ids": str})\n' +
      'phot = pd.read_csv(base + "photometry.csv.gz")\n\n' +
      '# one lightcurve in AB magnitudes (flux in nJy, zero point 31.4)\n' +
      'lc = phot[(phot["name"] == "' + ex + '") & (phot["kind"] != "upper_limit") & (phot["flux_njy"] > 0)]\n' +
      'lc = lc.assign(mag=31.4 - 2.5 * np.log10(lc["flux_njy"]))\n' +
      'print(lc.groupby(["source", "band"]).size())';
    var cols = files.map(function (f) {
      var cc = (dl[f] || {}).columns || {};
      return '<details class="colref"><summary>' + U.icon('chev', 2) + '<span class="mono">' + esc(f) + '</span> <span class="muted">· ' + Object.keys(cc).length + ' columns</span></summary>' +
        '<table class="data"><tbody>' + Object.keys(cc).map(function (k) { return '<tr><td class="mono">' + esc(k) + '</td><td>' + esc(cc[k]) + '</td></tr>'; }).join('') + '</tbody></table></details>';
    }).join('');
    var refs = REFS.map(function (r) {
      return '<li><strong><a href="' + esc(r[2]) + '" target="_blank" rel="noopener noreferrer">' + esc(r[0]) + '</a>.</strong> ' + esc(r[1]) + '</li>';
    }).join('');
    root.innerHTML = '<div class="wrap"><article class="prose data-page">' +
      '<p class="eyebrow">Data &amp; citation</p><h1 tabindex="-1">Download the catalogue</h1>' +
      '<p class="lede">Everything public on this site as plain files: the catalogue and every photometry point, version ' + esc(String(M.built || '').slice(0, 10)) +
      '. They are rebuilt with the site, and <a href="data/download/MANIFEST.json">MANIFEST.json</a> lists column meanings, row counts and SHA-256 checksums.</p>' +
      (files.length ? '<div class="card table-card"><div class="table-wrap"><table class="data"><thead><tr><th>File</th><th>Contents</th><th class="num">Rows</th><th class="num">Size</th></tr></thead><tbody>' +
        rows + '</tbody></table></div></div>' : '<p class="note">This build has no download files.</p>') +
      '<p class="note">Rubin DP2 (EDP2) catalogue data are proprietary and are not in these files. ' +
      (S.isPrivate ? 'With team access, each object page’s CSV button exports its EDP2 points too.' : 'Rubin data-rights holders can unlock them per object with team access.') + '</p>' +
      '<h2>Python</h2><p>pandas reads the files straight from the site. Keep Rubin IDs as strings: they are 18-digit integers that do not survive a float.</p>' +
      codeBlock('py-code', py) +
      '<h2>Columns</h2>' + cols +
      '<h2>How to cite</h2><p>If this site or its files help your work, please cite it' + (c.doi ? ' (DOI <a href="https://doi.org/' + esc(c.doi) + '">' + esc(c.doi) + '</a>)' : '') +
      ' and the surveys and brokers whose data you use.' + (c.doi ? '' : ' A Zenodo DOI will be added with the first tagged release; until then, cite the version date.') + '</p>' +
      codeBlock('bib-code', bibtex()) +
      '<h3>Data sources</h3><ul class="refs">' + refs + '</ul>' +
      '<p class="note">Rubin alerts are public. Work that uses the proprietary DP2 data unlocked by team access must follow the Rubin data rights policy and use its proprietary-data acknowledgement.</p>' +
      '</article></div>';
    root.addEventListener('click', function (e) {
      var b = e.target.closest('button.copy-code');
      if (!b) return;
      var pre = document.getElementById(b.getAttribute('data-code'));
      U.copyText(pre.textContent).then(function () {
        b.innerHTML = U.icon('check', 2.2) + 'Copied';
        setTimeout(function () { b.innerHTML = U.icon('copy', 1.8) + 'Copy'; }, 1400);
      });
    });
    rendered = true;
  }

  X.views.data = {
    show: function () {
      document.title = 'Data & citation · TNS EDP2 Explorer';
      if (!rendered) render();
    }
  };
})();
