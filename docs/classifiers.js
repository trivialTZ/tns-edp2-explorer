/* TNS x EDP2 Explorer — Classifiers page: how often each broker classifier was right
 * on the TNS-typed transients, after 3, 5 and 10 detections and at its latest output.
 * Data: catalog meta.classifiers (build/classifiers.py scorecard). */
(function () {
  'use strict';
  var X = window.TNSXApp, S = X.S, U = X.U;
  var esc = U.esc;
  var rendered = false;
  var SV_LABEL = { LSST: 'Rubin alert stream', ZTF: 'ZTF' };
  var Q_LABEL = { sn: 'Is it a supernova?', ia: 'Is it a Type Ia?' };
  var TIMING = { alert: 'per detection', static: 'fixed from the first detection or host context', latest: 'object-level, from the full lightcurve' };

  function pct(x) { return Math.round(100 * x) + '%'; }
  function cell(c) {
    if (!c) return '<td class="sc-none">—</td>';
    var acc = c.k / c.n, few = c.n < 5;
    var tip = c.k + ' of ' + c.n + ' right' + (c.ci ? ' · 95% interval ' + pct(c.ci[0]) + '–' + pct(c.ci[1]) : '') +
      ' · always giving the majority answer would score ' + pct(c.base) + ' (' + c.n_pos + ' of ' + c.n + ' are “yes”)';
    return '<td class="sc' + (few ? ' few' : '') + '" data-tip="' + esc(tip) + '" style="--acc:' + acc.toFixed(3) + '"><b>' + pct(acc) + '</b><small>' + c.k + '/' + c.n + ' · base ' + pct(c.base) + '</small></td>';
  }
  function table(sv, res, experts, cps) {
    var cols = cps.map(String).concat(['latest']);
    var head = '<tr><th rowspan="2" scope="col">Classifier</th>' + ['sn', 'ia'].map(function (q) { return '<th colspan="' + cols.length + '" scope="colgroup" class="qh">' + esc(Q_LABEL[q]) + '</th>'; }).join('') + '</tr><tr>' +
      ['sn', 'ia'].map(function () { return cols.map(function (c) { return '<th scope="col" class="num">' + (c === 'latest' ? 'latest' : 'n = ' + c) + '</th>'; }).join(''); }).join('') + '</tr>';
    var body = experts.filter(function (e) { return res[e.key]; }).map(function (e) {
      var r = res[e.key];
      return '<tr><th scope="row" class="lab"><a href="' + esc(e.ref || '#') + '" target="_blank" rel="noopener noreferrer">' + esc(e.label) + '</a><small>' + esc(e.sub) + ' · ' + esc(TIMING[e.timing] || e.timing) + '</small></th>' +
        ['sn', 'ia'].map(function (q) { return cols.map(function (c) { return r[q] ? cell(r[q][c]) : '<td class="sc-na" title="This classifier does not answer this question">n/a</td>'; }).join(''); }).join('') + '</tr>';
    }).join('');
    return '<div class="card table-card sc-card"><div class="table-wrap"><table class="data sc-table">' + head + body + '</table></div></div>';
  }
  function render() {
    var root = document.getElementById('view-classifiers');
    var M = S.meta.classifiers;
    if (!M) {
      root.innerHTML = '<div class="wrap"><article class="prose"><p class="eyebrow">Classifiers</p><h1 tabindex="-1">No classifier data in this build</h1>' +
        '<p>Run <code class="mono">build/classifiers.py</code> and rebuild the site.</p></article></div>';
      rendered = true;
      return;
    }
    var nT = M.n_typed || {}, nO = M.n_objects || {};
    var secs = Object.keys(M.surveys || {}).map(function (sv) {
      return '<h2>' + esc(SV_LABEL[sv] || sv) + '</h2><p>' + U.fint(nO[sv] || 0) + ' transients have ' + (sv === 'LSST' ? 'a Rubin alert-stream' : 'a ZTF') + ' object with classifier output; ' +
        U.fint(nT[sv] || 0) + ' of them have a TNS classification. ' +
        (sv === 'LSST' ? 'The public alert stream began in late October 2025, after most of this catalogue was discovered, so these numbers are small.' : '') + '</p>' +
        table(sv, M.surveys[sv], M.experts || [], M.checkpoints || [3, 5, 10]);
    }).join('');
    root.innerHTML = '<div class="wrap"><article class="prose wide sc-page">' +
      '<p class="eyebrow">Classifiers</p><h1 tabindex="-1">How often are the classifiers right?</h1>' +
      '<p class="lede">For the transients here that TNS has classified from a spectrum, we asked every broker classifier two questions: ' +
      'is it a supernova, and is it a Type Ia? We checked the answers after the 3rd, 5th and 10th detection and at each classifier’s latest output.</p>' +
      '<div class="sc-legend"><span><i style="--acc:0.95"></i>mostly right</span><span><i style="--acc:0.6"></i>often wrong</span><span class="muted">Cells show the share right, right/total, and the baseline: the score of always giving the majority answer (the typed objects here are nearly all supernovae, so on the first question the baseline is often close to 100%). Hover for the 95% interval. Faded: fewer than 5 objects.</span></div>' +
      secs +
      '<h2>How to read this</h2><ul>' +
      '<li><strong>Truth</strong> is the TNS classification, mapped to SN Ia, other supernova (including superluminous) or not a supernova. Untyped transients are not scored.</li>' +
      '<li><strong>A “yes”</strong> is a supernova call (or an SN Ia call) at probability 0.5 or more, or a supernova top class for classifiers that report a class. ' +
      'Fink CATS counts as “supernova” only for its SN-like class; its Long class also holds superluminous supernovae and tidal disruption events.</li>' +
      '<li><strong>Detections</strong> are positive detections counted the way metaDEBASS counts them, up to 20. Rubin objects whose alerts are all negative differences appear on their pages but are not scored.</li>' +
      '<li><strong>metaDEBASS is not graded here.</strong> It is a meta-layer, not another classifier: for each object it reports calibrated confidences for follow-up ranking (P(supernova), and P(SN Ia) for ZTF) and, where it has a trust model, how far to trust each broker’s call. ' +
      'Object pages show both. Its own benchmark, on objects it never trained on, is in the <a href="https://github.com/trivialTZ/rubin_hackathon" target="_blank" rel="noopener noreferrer">metaDEBASS repository</a>: on live Rubin alerts it separates supernovae from other transients well, and its Ia-versus-other separation is not yet better than chance. ' +
      'Its v11 inputs read Fink CATS Periodic as a non-Ia supernova and Long as not a supernova, a known input-mapping issue.</li>' +
      '<li><strong>Latest-only</strong> ALeRCE lightcurve classifiers are object-level snapshots computed from the full lightcurve, so they are scored only at “latest”.</li>' +
      '<li>Brokers may have trained on some of these transients; this page cannot check that.</li>' +
      '<li>Every object page shows the full sequence of calls. The per-detection table is in <a href="#/data">classifiers.csv.gz</a>.</li></ul>' +
      '</article></div>';
    root.onmousemove = function (e) {
      var c = e.target.closest('[data-tip]');
      if (!c) { U.hover.hide(); return; }
      U.hover.show('<div class="hc-m">' + esc(c.getAttribute('data-tip')) + '</div>', e.clientX, e.clientY);
    };
    root.onmouseleave = function () { U.hover.hide(); };
    rendered = true;
  }
  X.views.classifiers = {
    show: function () {
      document.title = 'Classifiers · TNS EDP2 Explorer';
      if (!rendered) render();
    }
  };
})();
