/* TNS x EDP2 Explorer — About (editorial long-form page). */
(function () {
  'use strict';
  var X = window.TNSXApp, S = X.S, U = X.U, K = X.K;
  var esc = U.esc;

  function fmtStat(v) {
    if (v === true) return 'yes';
    if (v === false) return 'no';
    if (v == null) return '—';
    if (typeof v === 'number') return Number.isInteger(v) ? U.fint(v) : Math.abs(v) < 1 ? v.toFixed(3) : v.toFixed(2);
    if (Array.isArray(v)) return v.map(fmtStat).join(', ');
    return esc(v);
  }
  function statRows(obj, depth) {
    var out = '';
    Object.keys(obj || {}).forEach(function (k) {
      var v = obj[k];
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        out += '<tr class="stat-group"><td colspan="2"' + (depth ? ' class="stat-indent"' : '') + '>' + esc(k) + '</td></tr>' + statRows(v, depth + 1);
      } else {
        out += '<tr><td' + (depth ? ' class="stat-indent"' : '') + '><span class="' + (/[\s]/.test(k) ? '' : 'stat-key') + '">' + esc(k) + '</span></td><td class="num">' + fmtStat(v) + '</td></tr>';
      }
    });
    return out;
  }
  function render() {
    var M = S.meta, src = M.sources || {}, win = M.window || {};
    var srcRows = Object.keys(src).map(function (k) {
      var s = src[k];
      return '<tr><td><span class="src-mark">' + U.symbolSvg(U.srcSymbol(k), 'currentColor') + esc(U.srcShort(k)) + '</span></td>' +
        '<td>' + esc(s.label || k) + '<br><span class="muted">' + esc(s.desc || '') + '</span></td><td>' + esc(s.survey || '') + '</td>' +
        '<td class="num">' + U.fint(s.n_objects) + '</td><td class="num">' + U.fint(s.n_points) + '</td></tr>';
    }).join('');
    var notes = (M.notes || []).map(function (n) { return '<li>' + esc(n) + '</li>'; }).join('');
    var stats = M.stats && Object.keys(M.stats).length ? statRows(M.stats, 0) : '';
    var span = U.isNum(S.discMin) ? U.monthYear(S.discMin) + ' and ' + U.monthYear(S.discMax) : 'the survey period';
    var built = U.fmtBuilt(M.built);
    document.getElementById('view-about').innerHTML = '<article class="wrap"><div class="prose">' +
      '<p class="eyebrow">About</p><h1>A lightcurve browser for the Rubin EDP2 footprint</h1>' +
      '<p class="lede">This site gathers the ' + U.fint(S.N) + ' transients reported to the Transient Name Server between ' + esc(span) +
      ' whose positions fall inside the Rubin EDP2 visit footprint, and overlays every lightcurve we could find for them.</p>' +
      '<p class="note">' + (M.team ? 'Public build with the team-access layer unlocked in this browser' : S.isPrivate ? 'Private build' : 'Public build') +
      (built ? ', made ' + esc(built) : '') + '.</p>' +
      (M.fixture ? '<div class="callout"><strong>Synthetic fixture.</strong> Every name, position and lightcurve in this build is randomly generated for testing.</div>' : '') +

      '<h2>How to use it</h2>' +
      '<p><a href="#/explore">Explore</a> is a faceted browser in the style of single-cell data portals: pick values in the rail on the left, drag the range sliders, and the counts beside every other value update to show what remains. Active filters sit above the results as chips, and the whole state lives in the page URL, so a filtered list can be bookmarked or shared.</p>' +
      '<p>Each transient has its own page with the TNS record, links to other archives and the lightcurve. Search from anywhere with <span class="kbd">⌘K</span> or <span class="kbd">/</span>, and step through the current list with ← and →.</p>' +
      '<h3>Rubin identifiers</h3>' +
      '<p>Rubin names each difference-image object with a <span class="mono">diaObjectId</span>. The alert stream and the DP2 catalogue use separate ID spaces, so one transient has unrelated IDs in each, and this site links both to TNS by position (within ' + S.matchR + '″). ' +
      'Search takes a full ID or any prefix of ' + K.RID_MIN_PREFIX + ' or more digits' + (S.isPrivate ? '' : ' (alert-stream IDs here' + (M.team_access ? '; DP2 catalogue IDs only with team access' : '') + ')') + ', and <span class="mono">#/object/&lt;id&gt;</span> opens the transient. ' +
      'An <span class="mono">objectId</span> is something else: it labels a deep-coadd Object row, usually the host galaxy, not the transient.</p>' +

      '<h2>Photometry sources</h2>' +
      '<div class="card table-card"><div class="table-wrap"><table class="data"><thead><tr><th>Marker</th><th>Source</th><th>Survey</th><th class="num">Transients</th><th class="num">Points</th></tr></thead>' +
      '<tbody>' + (srcRows || '<tr><td colspan="5">No sources in this build.</td></tr>') + '</tbody></table></div></div>' +
      '<h3>Reading a lightcurve</h3><ul>' +
      '<li>Fluxes are in nJy with an AB zero point of 31.4, so m = 31.4 − 2.5 log<sub>10</sub> f. Magnitudes are shown only for positive flux, and upper limits appear as down-pointing triangles at the limiting magnitude.</li>' +
      '<li>Filled markers are detections; open markers of the same shape are forced photometry from the same survey. Every source keeps epochs from 150 days before to 400 days after the TNS discovery.</li>' +
      '<li>Colours follow the band: u g r i z y use Rubin-like hues, and ZTF and TNS filters share the colour of the matching band. Broad white-light filters (w, L, Clear) are neutral, and anything unrecognised is grey.</li>' +
      '<li>Ticks along the bottom are dp2.Visit pointings whose centre lies within ' + K.TICK_RADIUS_DEG + '° of the transient. A tick means LSSTCam pointed nearby, not that the transient landed on a detector: coverage is not guaranteed.</li>' +
      (U.isNum(win.mjd_start) ? '<li>The shaded band is the EDP2 visit window, ' + esc(U.niceDate(win.mjd_start)) + ' to ' + esc(U.niceDate(win.mjd_end)) + ' (MJD ' + U.fx(win.mjd_start, 3) + '–' + U.fx(win.mjd_end, 3) + ').</li>' : '') +
      '</ul>' +

      (notes ? '<h2>Method notes</h2><ul>' + notes + '</ul>' : '') +
      (stats ? '<h2>Cross-match statistics</h2><p>Aggregate numbers from the TNS × EDP2 cross-match. They are derived data products and contain no catalogue rows.</p>' +
        '<div class="card table-card"><div class="table-wrap"><table class="data"><tbody>' + stats + '</tbody></table></div></div>' : '') +

      '<h2>Data policy</h2>' +
      (M.team
        ? '<div class="callout private"><strong>' + esc(K.PRIVATE_BANNER) + '</strong><br>You unlocked the Rubin DP2 catalogue layer (DiaObject, DiaSource and forced photometry, plus match results) with the team password. ' +
          'It is proprietary under the Rubin Data Policy: this site holds it only as ciphertext, and it was decrypted in this browser. Share it only with Rubin data-rights holders. Lock, in the top bar, forgets the key.</div>'
        : S.isPrivate
        ? '<div class="callout private"><strong>' + esc(K.PRIVATE_BANNER) + '</strong><br>This build contains Rubin DP2 catalogue data (DiaObject, DiaSource and forced photometry, plus match results), which is proprietary under the Rubin Data Policy. Share it only with Rubin data-rights holders.</div>'
        : '<p>This public build contains only public data: TNS reports, ZTF photometry served by ALeRCE, public Rubin alerts served by Fink, and dp2.Visit pointing metadata. Rubin DP2 catalogue photometry is proprietary under the Rubin Data Policy and is not included; the statistics above are aggregate numbers only.</p>' +
          (M.team_access ? '<p class="note">Rubin data-rights holders can unlock an encrypted copy of that photometry with the team password, under Team access in the top bar. It is decrypted only in your browser.</p>' : '')) +

      '<h2>Credits</h2><ul>' +
      '<li><strong>Transient Name Server (TNS)</strong>, the IAU mechanism for reporting new transients: names, positions, discovery data, classifications, redshifts and reported photometry. Discovery and classification credit belongs to the reporting groups listed on each transient. <a href="https://www.wis-tns.org/" target="_blank" rel="noopener">wis-tns.org</a></li>' +
      '<li><strong>Zwicky Transient Facility</strong> alert and forced photometry served by the <strong>ALeRCE</strong> broker (Förster et al. 2021, AJ 161, 242). ZTF is supported by the NSF and a collaboration including Caltech, IPAC and partner institutions (Bellm et al. 2019, PASP 131, 018002). <a href="https://alerce.online/" target="_blank" rel="noopener">alerce.online</a></li>' +
      '<li><strong>Rubin alerts</strong> via the <strong>Fink</strong> broker (Möller et al. 2021, MNRAS 501, 3272). <a href="https://lsst.fink-portal.org/" target="_blank" rel="noopener">lsst.fink-portal.org</a></li>' +
      '<li><strong>NSF–DOE Vera C. Rubin Observatory</strong> Data Preview 2: dp2.Visit pointing metadata' + (S.isPrivate ? ' and DP2 DiaObject, DiaSource and forced-photometry catalogues (proprietary)' : '') +
      ' (Ivezić et al. 2019, ApJ 873, 111). <a href="https://rubinobservatory.org/" target="_blank" rel="noopener">rubinobservatory.org</a></li>' +
      '<li>Link-outs to <a href="https://www.wiserep.org/" target="_blank" rel="noopener">WISeREP</a> (Yaron &amp; Gal-Yam 2012, PASP 124, 668) and the <a href="https://www.legacysurvey.org/" target="_blank" rel="noopener">DESI Legacy Imaging Surveys</a> viewer. Charts use <a href="https://plotly.com/javascript/" target="_blank" rel="noopener">Plotly.js</a>; the browsing flow follows LSST DESC FASTDB.</li>' +
      '</ul></div></article>';
  }
  X.views.about = {
    init: function () { render(); },
    show: function () { document.title = 'About · TNS EDP2 Explorer'; }
  };
})();
