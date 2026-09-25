/* TNS x EDP2 Explorer — object page and lightcurve. */
(function () {
  'use strict';
  var X = window.TNSXApp, S = X.S, U = X.U, K = X.K;
  var $ = U.$, esc = U.esc, V = U.V;
  var LC = { srcOff: new Set(), famOff: new Set(), showUL: true, showFP: true, snCut: true, y: 'flux', x: 'mjd', ticks: true, merge: false };
  var O = null;       // current object's plot data
  var cur = null;     // current object index

  // ------------------------------------------------------------------ page
  function purgePlot() {
    ['lc-plot', 'spec-plot'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el && window.Plotly && el._fullLayout) window.Plotly.purge(el);
    });
  }
  function plotMessage(html) {
    purgePlot();
    var el = document.getElementById('lc-plot');
    if (el) el.innerHTML = '<div class="lc-msg"><div>' + html + '</div></div>';
  }
  function show(name) {
    var root = document.getElementById('view-object');
    var i = S.byName.get(name);
    if (i === undefined) i = S.byName.get(U.normQuery(name));
    if (i === undefined && S.byRid.has(String(name).trim())) {      // #/object/<Rubin diaObjectId>
      window.location.replace('#/object/' + encodeURIComponent(V(S.byRid.get(String(name).trim()), 'name')));
      return;
    }
    purgePlot();
    U.hover.hide();
    if (i === undefined) {
      cur = null; O = null;
      document.title = 'Not found · TNS EDP2 Explorer';
      root.innerHTML = '<div class="wrap"><div class="prose" style="margin:0"><p class="eyebrow">Not in this catalogue</p><h1 tabindex="-1">No transient named “' + esc(name) + '”</h1>' +
        '<p>This site covers ' + U.fint(S.N) + ' TNS transients inside the Rubin EDP2 footprint. <a href="https://www.wis-tns.org/object/' + encodeURIComponent(U.normQuery(name)) +
        '" target="_blank" rel="noopener">Look it up on TNS</a> or <a href="' + esc(X.exploreHash()) + '">go back to Explore</a>.</p></div></div>';
      return;
    }
    cur = i; S.lastObj = i; O = null;
    document.title = U.fullName(i) + ' · TNS EDP2 Explorer';
    root.innerHTML = '<div class="wrap">' + topHtml(i) + heroHtml(i) + hostCardHtml(i) +
      '<section class="card lc-card" aria-labelledby="lc-h"><div class="lc-head"><h2 id="lc-h">Lightcurve</h2><div class="lc-ctl" id="lc-ctl"></div></div>' +
      '<div id="lc-legend"></div>' +
      '<div class="lc-plot" id="lc-plot"><div class="lc-msg"><div><span class="sk" style="display:block;width:260px;height:10px;margin:0 auto 10px"></span>Loading lightcurve…</div></div></div>' +
      '<div class="lc-foot" id="lc-foot"></div>' +
      '<details class="pts" id="pts"><summary>' + U.icon('chev', 2) + 'Photometry table <span class="muted">· points shown in the plot</span></summary><div id="pts-table"></div></details></section>' +
      imgCardHtml(i) + clfCardHtml(i) + specCardHtml(i) +
      '<p class="sr-only" id="obj-live" aria-live="polite"></p></div>';
    wire(root);
    var h1 = root.querySelector('h1');
    if (h1 && document.activeElement && document.activeElement !== document.body) h1.focus({ preventScroll: true });
    Promise.all([X.loadShard(X.shardOf(i)), X.ensurePlotly()]).then(function (res) {
      if (cur !== i) return;
      fillHostImg(i);
      fillDp2Stamp(i);
      prepare(i, (res[0] || {})[V(i, 'name')] || {});
      renderControls();
      updatePlot();
    }).catch(function (e) {
      if (cur !== i) return;
      console.error(e);
      var msg = /plotly/i.test(e.message) ? 'The plotting library could not be loaded from cdn.jsdelivr.net (offline?).' : 'The lightcurve file could not be loaded (' + esc(e.message) + ').';
      plotMessage(msg + '<br><button type="button" class="btn btn-sm" id="lc-retry" style="margin-top:12px">Try again</button>');
      $('#lc-retry').addEventListener('click', function () { show(name); });
    });
    loadSpectra(i);
    loadClf(i);
    wireImg(i);
    if (S.visitsState === 'idle') X.loadVisits();
  }

  function topHtml(i) {
    var res = X.results(), pos = res.indexOf(i), n = res.length;
    var prev = pos > 0 ? res[pos - 1] : null, next = pos >= 0 && pos < n - 1 ? res[pos + 1] : null;
    return '<div class="obj-top"><nav class="crumbs" aria-label="Breadcrumb"><a href="' + esc(X.exploreHash()) + '">Explore</a>' + U.icon('right', 2) +
      '<span aria-current="page">' + esc(U.fullName(i)) + '</span></nav>' +
      '<nav class="prevnext" aria-label="Previous and next in the current list"><span class="pos">' + (pos >= 0 ? U.fint(pos + 1) + ' of ' + U.fint(n) : 'not in the current list') + '</span>' +
      '<button type="button" class="btn btn-sm" data-rel="-1"' + (prev == null ? ' disabled' : '') + ' title="Previous (← or [)">' + U.icon('left', 2) + (prev != null ? esc(V(prev, 'name')) : 'Previous') + '</button>' +
      '<button type="button" class="btn btn-sm" data-rel="1"' + (next == null ? ' disabled' : '') + ' title="Next (→ or ])">' + (next != null ? esc(V(next, 'name')) : 'Next') + U.icon('right', 2) + '</button></nav></div>';
  }
  function fact(label, html, sub) {
    return '<div><dt>' + esc(label) + '</dt><dd>' + html + (sub ? '<div class="sub">' + sub + '</div>' : '') + '</dd></div>';
  }
  function copyBtn(text, label) {
    return '<button type="button" class="copy" data-copy="' + esc(text) + '" aria-label="Copy ' + esc(label) + '" title="Copy ' + esc(label) + '">' + U.icon('copy', 1.8) + '</button>';
  }
  function extLink(href, label, title) {
    return '<a href="' + esc(href) + '" target="_blank" rel="noopener noreferrer"' + (title ? ' title="' + esc(title) + '"' : '') + '>' + esc(label) + U.icon('ext', 2) + '</a>';
  }
  // DEBASS status and survey region, each a link to Explore filtered the same way.
  function tagLinks(i) {
    var h = '', db = V(i, 'debass'), rg = V(i, 'region');
    if (db) h += '<a class="pill debass" href="#/explore?debass=FINISHED&amp;debass=YES" title="DEBASS follow-up target (sheet status ' + esc(db) + '). Show all DEBASS targets">DEBASS · ' + esc(K.DEBASS_LABEL[db] || db) + '</a>';
    if (rg) h += '<a class="pill outline" href="#/explore?reg=' + encodeURIComponent(rg) + '" title="' + (rg === 'WFD' ? 'Outside the LSST Deep Drilling Fields' : 'Covered by visits aimed at this LSST Deep Drilling Field') + '. Show all transients here">' + esc(U.regionLabel(rg)) + '</a>';
    return h;
  }
  function heroHtml(i) {
    var name = V(i, 'name'), pre = V(i, 'prefix'), type = V(i, 'type'), z = V(i, 'z');
    var ra = V(i, 'ra'), dec = V(i, 'dec'), disc = V(i, 'disc_mjd');
    var internal = String(V(i, 'internal') || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    var alerts = String(V(i, 'alert_ids') || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    var sexa = U.raHms(ra) + ' ' + U.decDms(dec);
    var h = '<header class="obj-hero"><div class="obj-title"><h1 tabindex="-1">' + (pre ? '<span class="pfx">' + esc(pre) + '</span>' : '') + esc(name) + '</h1>' +
      '<div class="tags">' + (type ? '<span class="pill">' + esc(type) + '</span>' : '<span class="pill outline">Untyped</span>') +
      tagLinks(i) + (U.isNum(z) ? '<span class="muted tabular">z = ' + U.fx(z, 4) + '</span>' : '') + '</div></div>';
    h += '<div class="coords">' +
      '<span class="coord"><span class="lbl">RA</span><span class="mono">' + U.fx(ra, 6) + '°</span>' + copyBtn(U.fx(ra, 6), 'RA in degrees') + '</span>' +
      '<span class="coord"><span class="lbl">Dec</span><span class="mono">' + U.signed(dec, 6) + '°</span>' + copyBtn((dec >= 0 ? '+' : '-') + Math.abs(dec).toFixed(6), 'Dec in degrees') + '</span>' +
      '<span class="coord"><span class="mono">' + esc(sexa) + '</span>' + copyBtn(sexa.replace('−', '-'), 'sexagesimal coordinates') + '</span></div>';
    // Rubin diaObjectIds: alert stream (public) and, in private or unlocked mode only, the DP2 catalogue ID.
    var rids = S.rids[i] || [];
    if (rids.length) {
      h += '<div class="coords rids">' + ['alert', 'dp2'].map(function (kind) {
        var ids = rids.filter(function (x) { return x.kind === kind; });
        if (!ids.length) return '';
        return '<span class="coord"><span class="lbl">' + esc(K.RID_LABEL[kind]) + '</span>' + ids.map(function (x) {
          return '<span class="mono">' + esc(x.id) + '</span>' + copyBtn(x.id, K.RID_LABEL[kind] + ' ' + x.id);
        }).join('') + '</span>';
      }).join('') + '</div>';
    }
    h += '<dl class="facts">';
    h += fact('Discovered', esc(U.niceDate(disc)) + ' <span class="muted">' + esc(U.isoDateTime(disc).slice(11)) + ' UTC</span>', 'MJD ' + U.fx(disc, 4));
    h += fact('Discovery magnitude', U.isNum(V(i, 'disc_mag')) ? '<span class="tabular">' + U.fx(V(i, 'disc_mag'), 2) + '</span>' + (V(i, 'disc_filter') ? ' <span class="muted">' + esc(V(i, 'disc_filter')) + '</span>' : '') : '—');
    h += fact('Reporting group', esc(V(i, 'group') || '—'));
    h += fact('Internal names', internal.length ? internal.map(function (s) { return '<span class="mono">' + esc(s) + '</span>'; }).join('<br>') : '—');
    if (U.has('n_spec')) {
      var ns = V(i, 'n_spec') || 0, st = String(V(i, 'spec_types') || '');
      h += fact('TNS spectra', ns ? U.fint(ns) : 'None reported', ns && st ? esc(st.split(',').join(', ')) : '');
    }
    if (U.has('rubin_first')) {
      var rf = V(i, 'rubin_first'), la = V(i, 'lead_alert');
      h += fact('Rubin first?', '<a href="#/explore?rf=' + esc(rf || 'none') + '">' + esc(K.RF_LABEL[rf] || '—') + '</a>',
        U.isNum(la) && rf !== 'pre' ? 'first positive Rubin alert ' + (la > 0 ? U.fx(la, 1) + ' d before' : U.fx(-la, 1) + ' d after') + ' TNS discovery' :
          rf === 'pre' ? 'the public alert stream starts ' + esc(U.isoDate((S.meta.lead || {}).alert_start_mjd)) : '');
    }
    if (U.has('n_visits')) h += fact('LSSTCam pointings', U.fint(V(i, 'n_visits')) + ' <span class="muted">within 2.1°</span>',
      U.has('n_visits_active') ? U.fint(V(i, 'n_visits_active')) + ' during [discovery − 30, + 100] d' : '');
    S.cols.filter(function (c) {
      if (K.KNOWN_COLS.indexOf(c) >= 0 || /^host_/.test(c)) return false;
      var m = /^(n|t0|t1)_(.+)$/.exec(c);
      return !(m && ((S.meta.sources || {})[m[2]] || K.SRC_SHORT[m[2]]));
    }).forEach(function (c) { var v = V(i, c); h += fact(c, v == null || v === '' ? '—' : esc(typeof v === 'object' ? JSON.stringify(v) : v)); });
    h += '</dl>';
    if (S.isPrivate) {
      var matched = X.F.isMatched(i), tc = V(i, 'edp2_tc');
      h += '<p class="private-label">' + U.icon('lock', 2).replace('<svg', '<svg width="12" height="12"') + 'Rubin DP2 · proprietary</p><dl class="facts private-facts">';
      h += fact('EDP2 match', V(i, 'edp2_id') ? (matched ? '<span class="pill private">matched</span>' : '<span class="pill outline">beyond ' + S.matchR + '″</span>') : 'No DiaObject',
        V(i, 'edp2_id') ? 'nearest dp2.DiaObject; its ID is in the header' : '');
      h += fact('EDP2 separation', U.isNum(V(i, 'edp2_sep')) ? U.fx(V(i, 'edp2_sep'), 3) + '″' : '—');
      h += fact('EDP2 nDiaSources', U.isNum(V(i, 'edp2_ndia')) ? U.fint(V(i, 'edp2_ndia')) : '—');
      h += fact('EDP2 lead time', U.isNum(V(i, 'edp2_lead')) ? U.fx(V(i, 'edp2_lead'), 2) + ' d' : '—', 'TNS discovery − first positive EDP2 detection');
      h += fact('Time-consistent', tc === true || tc === 1 ? 'Yes' : tc === false || tc === 0 ? 'No' : '—');
      if (U.has('edp2_coadd')) {
        var co = V(i, 'edp2_coadd'), cb = String(V(i, 'edp2_coadd_bands') || '');
        h += fact('EDP2 deep coadd', co === true ? 'Inside' + (cb ? ' <span class="mono">' + esc(cb.split('').join(' ')) + '</span>' : '') : co === false ? 'Outside the footprint' : '—',
          co === true ? 'bands with a DP2 deep coadd here' : '');
      }
      h += '</dl>';
    }
    var L = [extLink('https://www.wis-tns.org/object/' + encodeURIComponent(name), 'TNS'),
      extLink('https://www.wiserep.org/search?name=' + encodeURIComponent(name), 'WISeREP', 'WISeREP spectra search')];
    var ztf = [];
    internal.forEach(function (s) { var m = s.match(/\bZTF\d{2}[a-z]{7}\b/g); if (m) m.forEach(function (x) { if (ztf.indexOf(x) < 0) ztf.push(x); }); });
    ztf.forEach(function (id) { L.push(extLink('https://alerce.online/object/' + id, 'ALeRCE ' + id)); });
    alerts.forEach(function (id) { L.push(extLink('https://lsst.fink-portal.org/' + encodeURIComponent(id), 'Fink LSST ' + id)); });
    if (U.isNum(ra) && U.isNum(dec)) L.push(extLink('https://www.legacysurvey.org/viewer?ra=' + ra.toFixed(6) + '&dec=' + dec.toFixed(6) + '&layer=ls-dr10&zoom=16&mark=' + ra.toFixed(6) + ',' + dec.toFixed(6), 'Legacy Survey'));
    h += '<div class="links" aria-label="External links">' + L.join('') + '</div></header>';
    return h;
  }
  // ------------------------------------------------------------------ host galaxy (diagnostic)
  var HOST_STATUS = { associated: 'Associated', ambiguous: 'Ambiguous', 'no-host': 'No host found', failed: 'Not searched' };
  var HOST_TIER = {
    secure_consensus_pilot: 'secure: Pan-STARRS1 and Legacy Surveys agree',
    secure_single_catalog_pilot: 'secure: one catalogue',
    probable_consensus_user_accepted_diagnostic: 'probable: both catalogues agree, heuristic gates not met',
    ambiguous_catalog_disagreement: 'the catalogues disagree',
    ambiguous_legacy_only: 'ambiguous in Legacy Surveys',
    ambiguous_ps1_only: 'ambiguous in Pan-STARRS1',
    ambiguous_low_confidence: 'low confidence',
    duplicate_primary_sensitive_review_required: 'duplicate primary, needs review',
    hostless_or_no_catalog_candidate: 'no catalogue candidate',
    not_attempted: 'not attempted'
  };
  var HOST_FIT = {
    qc_pass: 'Passed QC', qc_fail: 'Withheld (QC fail)', pending: 'Fit pending',
    not_attempted_ambiguous: 'Not fitted', not_attempted_no_host: 'Not fitted', not_attempted_no_catalog_coverage: 'Not fitted',
    not_attempted_implausible_tns_z: 'Not fitted', no_host_redshift: 'Not fitted', photometry_or_handoff_failed: 'Not fitted'
  };
  var HOST_FIT_WHY = {
    qc_fail: 'The sampler ran, but the residual or prior-boundary checks failed, so the values are withheld.',
    not_attempted_ambiguous: 'No unique host, so no fit was run (candidate-mixture fits are future work).',
    not_attempted_no_host: 'No host candidate was found.',
    not_attempted_no_catalog_coverage: 'No catalogue covers this position: south of Pan-STARRS1 (Dec < −30°) and outside Legacy Surveys DR10.',
    not_attempted_implausible_tns_z: 'The TNS redshift is implausible for this type, so the object was held out.',
    no_host_redshift: 'No redshift is available to hold fixed in the fit.',
    photometry_or_handoff_failed: 'Host photometry failed, so there is nothing to fit.'
  };
  var HOST_POST = [['logm', 'log M*', 'M☉'], ['logsfr', 'log SFR', 'M☉ yr⁻¹, 100 Myr'], ['logssfr', 'log sSFR', 'yr⁻¹'],
    ['age', 'Mass-weighted age', 'Gyr'], ['av', 'A_V', 'mag, Calzetti']];
  X.HOST_STATUS = HOST_STATUS; X.HOST_FIT = HOST_FIT;
  function hostCardHtml(i) {
    if (!U.has('host_status') || V(i, 'host_status') == null) return '';
    var st = V(i, 'host_status'), fit = V(i, 'host_fit'), name = V(i, 'name'), img = V(i, 'host_img');
    var hra = V(i, 'host_ra'), hdec = V(i, 'host_dec'), team = S.hostTeam.has(String(name));
    var h = '<section class="card host-card" aria-labelledby="host-h"><div class="host-head"><h2 id="host-h">Host galaxy</h2>' +
      '<span class="pill diag">Diagnostic — not for science use</span>' +
      (team ? '<span class="pill private" title="This host row comes from the encrypted team-access layer">team access</span>' : '') + '</div>';
    var fig;
    if (img === 'file') fig = '<img src="data/hosts/' + encodeURIComponent(name) + '.webp" width="400" height="400" loading="lazy" alt="Host-selection image around ' + esc(U.fullName(i)) + '">';
    else if (img === 'shard') fig = S.hostImg[name] ? '<img src="' + S.hostImg[name] + '" width="400" height="400" alt="Host-selection image around ' + esc(U.fullName(i)) + '">' :
      '<div class="host-noimg sk" id="host-img-slot" data-name="' + esc(name) + '"></div>';
    else fig = '<div class="host-noimg">No host-selection image</div>';
    h += '<div class="host-body"><figure class="host-fig">' + fig + '<figcaption>Magenta crosshair: the transient. White ellipses: Legacy Surveys candidates (2.5 × half-light radius); ' +
      'white circles: Pan-STARRS1-only candidates. Amber: the selected host, dashed when ambiguous. North up, east left; the bar at lower left gives the scale. Background: ' +
      esc(V(i, 'host_imgsrc') || 'Legacy Surveys DR10, or Pan-STARRS1 / DSS2 where DR10 has no pixels') + '.</figcaption></figure><div class="host-info"><dl class="facts host-facts">';
    var tier = V(i, 'host_tier');
    h += fact('Association', '<span class="pill' + (st === 'associated' ? '' : ' outline') + '">' + esc(HOST_STATUS[st] || st) + '</span>', tier ? esc(HOST_TIER[tier] || tier.replace(/_/g, ' ')) : '');
    if (V(i, 'host_id')) {
      var catName = { LS_DR10: 'Legacy Surveys DR10', PS1_DR2: 'Pan-STARRS1 DR2' }[V(i, 'host_cat')] || V(i, 'host_cat') || '';
      h += fact(st === 'ambiguous' ? 'Leading candidate' : 'Host', '<span class="mono">' + esc(V(i, 'host_id')) + '</span>' + copyBtn(V(i, 'host_id'), 'host ID'), esc(catName));
    }
    if (U.isNum(V(i, 'host_sep'))) {
      h += fact('Separation', U.fx(V(i, 'host_sep'), 2) + '″', U.isNum(V(i, 'host_ddlr')) ? 'd_DLR ' + U.fx(V(i, 'host_ddlr'), 2) +
        (U.isNum(V(i, 'host_dlr')) ? ' · DLR ' + U.fx(V(i, 'host_dlr'), 1) + '″, circularised' : '') : '');
    }
    if (U.isNum(V(i, 'host_z'))) {
      h += fact('Redshift', U.fx(V(i, 'host_z'), 4) + (V(i, 'host_ztype') ? ' <span class="muted">' + esc(V(i, 'host_ztype')) + '</span>' : ''),
        esc(V(i, 'host_zsrc') || '') + (U.isNum(V(i, 'host_zcat')) ? ' · catalogue spec-z ' + U.fx(V(i, 'host_zcat'), 4) : ''));
    }
    if (V(i, 'host_bands')) h += fact('Photometry', esc(String(V(i, 'host_bands')).split(',').join(' ')), esc(V(i, 'host_phot') || ''));
    h += '</dl><div class="host-fit"><h3>Bagpipes SED fit <span class="pill ' + (fit === 'qc_pass' ? '' : 'outline') + '">' + esc(HOST_FIT[fit] || fit || '—') + '</span></h3>';
    if (fit === 'qc_pass' && U.isNum(V(i, 'host_logm_p50'))) {
      h += '<table class="data host-post"><thead><tr><th>Quantity</th><th class="num">Median</th><th class="num">16–84%</th></tr></thead><tbody>' +
        HOST_POST.map(function (q) {
          var m = V(i, 'host_' + q[0] + '_p50'), a = V(i, 'host_' + q[0] + '_p16'), b = V(i, 'host_' + q[0] + '_p84');
          return '<tr><td>' + esc(q[1]) + ' <span class="muted">' + esc(q[2]) + '</span></td><td class="num">' + U.fx(m, 2) + '</td><td class="num">' +
            (U.isNum(a) && U.isNum(b) ? U.fx(a, 2) + ' – ' + U.fx(b, 2) : '—') + '</td></tr>';
        }).join('') + '</tbody></table><p class="host-note">Delayed-τ star formation, Calzetti dust, redshift held fixed. Ages, SFRs and sSFRs depend on the model.</p>';
    } else if (fit === 'pending') {
      h += '<p class="host-note">Fit pending.' + ((S.meta.hosts || {}).fits_withheld && !S.isPrivate ? ' Fit results appear here once the host run has finished for every public object.' : '') + '</p>';
    } else if (HOST_FIT_WHY[fit]) h += '<p class="host-note">' + esc(HOST_FIT_WHY[fit]) + '</p>';
    h += '</div>';
    if (V(i, 'host_notes')) h += '<p class="host-note muted">Pipeline notes: ' + esc(V(i, 'host_notes')) + '</p>';
    if (U.isNum(hra) && U.isNum(hdec)) {
      h += '<div class="links">' + extLink('https://www.legacysurvey.org/viewer?ra=' + hra.toFixed(6) + '&dec=' + hdec.toFixed(6) + '&layer=ls-dr10&zoom=16&mark=' +
        hra.toFixed(6) + ',' + hdec.toFixed(6), 'Legacy Survey viewer at the host') + '</div>';
    }
    return h + '</div></div></section>';
  }
  function fillHostImg(i) {
    var slot = document.getElementById('host-img-slot');
    var uri = S.hostImg[V(i, 'name')];
    if (!slot) return;
    slot.outerHTML = uri ? '<img src="' + uri + '" width="400" height="400" alt="Host-selection image around ' + esc(U.fullName(i)) + '">' : '<div class="host-noimg">No host-selection image</div>';
  }

  function wire(root) {
    root.querySelector('.prevnext').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-rel]');
      if (b && !b.disabled) rel(+b.getAttribute('data-rel'));
    });
    root.addEventListener('click', function (e) {
      var c = e.target.closest('button.copy');
      if (!c) return;
      U.copyText(c.getAttribute('data-copy')).then(function () {
        c.classList.add('done'); c.innerHTML = U.icon('check', 2.2);
        $('#obj-live').textContent = 'Copied ' + c.getAttribute('data-copy');
        setTimeout(function () { c.classList.remove('done'); c.innerHTML = U.icon('copy', 1.8); }, 1400);
      }).catch(function () { $('#obj-live').textContent = 'Copy failed'; });
    });
    $('#pts', root).addEventListener('toggle', function (e) { if (e.target.open) renderPointsTable(); });
  }
  function rel(d) {
    var res = X.results(), pos = res.indexOf(cur);
    if (pos < 0) return false;
    var j = pos + d;
    if (j < 0 || j >= res.length) return false;
    X.go('#/object/' + encodeURIComponent(V(res[j], 'name')));
    return true;
  }

  // ------------------------------------------------------------------ lightcurve data
  function prepare(i, lcs) {
    var order = S.srcKeys.slice();
    Object.keys(lcs).forEach(function (k) { if (order.indexOf(k) < 0) order.push(k); });
    var pts = [], srcCount = {}, famCount = {}, famBands = {}, nUL = 0, nFP = 0;
    order.forEach(function (s) {
      var lc = lcs[s];
      if (!lc || !lc.t) return;
      for (var k = 0; k < lc.t.length; k++) {
        var b = lc.b ? lc.b[k] : '', fam = U.bandFamily(b), kind = lc.k ? lc.k[k] : 0;
        pts.push({ s: s, t: lc.t[k], b: b, fam: fam, f: lc.f ? lc.f[k] : null, e: lc.e ? lc.e[k] : null, k: kind, l: lc.l ? lc.l[k] : null, x: lc.x ? lc.x[k] : '' });
        srcCount[s] = (srcCount[s] || 0) + 1;
        famCount[fam] = (famCount[fam] || 0) + 1;
        (famBands[fam] = famBands[fam] || {})[b] = 1;
        if (kind === 2) nUL++; else if (kind === 1) nFP++;
      }
    });
    var srcs = order.filter(function (s) { return srcCount[s]; }), sym = {}, ex = 0;
    srcs.forEach(function (s) { sym[s] = K.SRC_SYMBOL[s] || K.EXTRA_SYMBOLS[ex++ % K.EXTRA_SYMBOLS.length]; });
    O = { i: i, name: V(i, 'name'), disc: V(i, 'disc_mjd'), pts: pts, srcs: srcs, srcCount: srcCount, sym: sym,
      fams: K.FAMILIES.filter(function (f) { return famCount[f]; }), famCount: famCount, famBands: famBands, nUL: nUL, nFP: nFP, shown: [], refs: [] };
  }

  function seg(name, label, opts, curv) {
    return '<span class="seg" role="radiogroup" aria-label="' + esc(label) + '">' + opts.map(function (o) {
      return '<label><input type="radio" name="' + name + '" value="' + o[0] + '"' + (o[0] === curv ? ' checked' : '') + '><span>' + esc(o[1]) + '</span></label>';
    }).join('') + '</span>';
  }
  function toggle(id, label, on, n, disabled, hidden, title) {
    return '<label class="toggle" id="' + id + '-wrap"' + (hidden ? ' hidden' : '') + (title ? ' title="' + esc(title) + '"' : '') + '><input type="checkbox" id="' + id + '"' + (on ? ' checked' : '') + (disabled ? ' disabled' : '') + '><span>' + esc(label) +
      (n != null ? ' <span class="n">' + U.fint(n) + '</span>' : '') + '</span></label>';
  }
  function renderControls() {
    var ctl = $('#lc-ctl'), leg = $('#lc-legend');
    if (!ctl || !O) return;
    ctl.innerHTML = seg('ymode', 'Y axis', [['flux', 'Flux'], ['mag', 'Magnitude']], LC.y) + seg('xmode', 'X axis', [['mjd', 'MJD'], ['rel', 'Days since discovery']], LC.x) +
      '<button type="button" class="btn btn-sm" id="lc-csv" title="Download the points shown in the plot">' + U.icon('download', 1.9) + 'CSV</button>';
    if (!O.pts.length) { leg.innerHTML = ''; wireControls(); return; }
    var ink = U.cssVar('--ink');
    leg.innerHTML = '<div class="lc-legend"><div class="grp" role="group" aria-label="Sources"><span class="gl">Sources</span>' + O.srcs.map(function (s) {
      return '<label class="lchip" title="' + esc(U.srcLabel(s) + ': ' + ((S.meta.sources[s] || {}).desc || '')) + '"><input type="checkbox" data-src="' + esc(s) + '"' + (LC.srcOff.has(s) ? '' : ' checked') + '>' +
        '<span>' + U.symbolSvg(O.sym[s], ink) + esc(U.srcShort(s)) + ' <span class="n">' + U.fint(O.srcCount[s]) + '</span></span></label>';
    }).join('') + '<button type="button" class="linkbtn" data-all="src" style="margin-left:4px">All</button></div>' +
      '<div class="grp" role="group" aria-label="Bands"><span class="gl">Bands</span>' + O.fams.map(function (f) {
        return '<label class="lchip" title="Band labels: ' + esc(Object.keys(O.famBands[f] || {}).join(', ')) + '"><input type="checkbox" data-fam="' + esc(f) + '"' + (LC.famOff.has(f) ? '' : ' checked') + '>' +
          '<span><i class="sw" style="background:' + U.famColor(f) + '"></i>' + esc(f) + ' <span class="n">' + U.fint(O.famCount[f]) + '</span></span></label>';
      }).join('') + '<button type="button" class="linkbtn" data-all="fam" style="margin-left:4px">All</button></div></div>' +
      '<div class="lc-opts">' + toggle('opt-merge', 'Merge sources', LC.merge, null, false, false,
        'Join the detections and forced photometry of every source with one line per band, in time order') +
      toggle('opt-ul', 'Upper limits', LC.showUL, O.nUL, !O.nUL) + toggle('opt-fp', 'Forced photometry', LC.showFP, O.nFP, !O.nFP) +
      toggle('opt-sn', 'Forced S/N ≥ 3 only', LC.snCut, null, false, LC.y !== 'mag') + toggle('opt-ticks', 'LSSTCam pointings', LC.ticks) + '</div>';
    wireControls();
  }
  function wireControls() {
    var card = $('.lc-card');
    card.onchange = function (e) {
      var t = e.target;
      if (t.hasAttribute('data-src')) setIn(LC.srcOff, t.getAttribute('data-src'), !t.checked);
      else if (t.hasAttribute('data-fam')) setIn(LC.famOff, t.getAttribute('data-fam'), !t.checked);
      else if (t.name === 'ymode') { LC.y = t.value; var w = $('#opt-sn-wrap'); if (w) w.hidden = LC.y !== 'mag'; }
      else if (t.name === 'xmode') LC.x = t.value;
      else if (t.id === 'opt-ul') LC.showUL = t.checked;
      else if (t.id === 'opt-fp') LC.showFP = t.checked;
      else if (t.id === 'opt-sn') LC.snCut = t.checked;
      else if (t.id === 'opt-ticks') LC.ticks = t.checked;
      else if (t.id === 'opt-merge') LC.merge = t.checked;
      else return;
      updatePlot();
    };
    card.onclick = function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      if (b.id === 'lc-csv') { downloadLc(); return; }
      var all = b.getAttribute('data-all');
      if (!all) return;
      var set = all === 'src' ? LC.srcOff : LC.famOff, keys = all === 'src' ? O.srcs : O.fams;
      var allOn = keys.every(function (k) { return !set.has(k); });
      keys.forEach(function (k) { setIn(set, k, allOn); });   // "All" toggles between all on and all off
      renderControls(); updatePlot();
    };
  }
  function setIn(set, k, add) { if (add) set.add(k); else set.delete(k); }

  function shownPoints() {
    var out = [], LN = 2.5 / Math.LN10;
    O.nLowSN = 0;
    for (var k = 0; k < O.pts.length; k++) {
      var p = O.pts[k];
      if (LC.srcOff.has(p.s) || LC.famOff.has(p.fam)) continue;
      if (p.k === 2 && !LC.showUL) continue;
      if (p.k === 1 && !LC.showFP) continue;
      var y = null, ey = null, lim = false, m = null, me = null, lm = null;
      if (p.k === 2) {
        lm = U.isNum(p.l) ? p.l : (U.isNum(p.e) && p.e > 0 ? K.ZP - 2.5 * Math.log10(5 * p.e) : null);
        if (lm == null) continue;
        lim = true;
        y = LC.y === 'mag' ? lm : U.flux(lm);
      } else {
        if (!U.isNum(p.f)) continue;
        if (p.f > 0) { m = U.mag(p.f); me = U.isNum(p.e) ? LN * p.e / p.f : null; }
        if (LC.y === 'mag') {
          if (!(p.f > 0)) continue;
          if (p.k === 1 && LC.snCut && U.isNum(p.e) && p.e > 0 && p.f / p.e < 3) { O.nLowSN++; continue; }
          y = m; ey = me;
        } else { y = p.f; ey = U.isNum(p.e) ? p.e : null; }
      }
      out.push({ p: p, x: LC.x === 'rel' ? p.t - O.disc : p.t, y: y, ey: ey, lim: lim, mag: m, magErr: me, limMag: lm });
    }
    return out;
  }
  function quantile(sorted, q) {
    if (!sorted.length) return null;
    var pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }
  // y range from detections + forced points (robust to a few wild values); limits stretch it
  // in magnitude space and are counted when they sit far above the flux range.
  function yRange(shown, mode) {
    var lo = [], hi = [], lims = [];
    shown.forEach(function (s) {
      if (s.lim) { lims.push(s.y); return; }
      var e = s.ey || 0;
      if (mode === 'mag') e = Math.min(e, 0.6);
      lo.push(s.y - e); hi.push(s.y + e);
    });
    var a, b, nAbove = 0;
    if (lo.length) {
      lo.sort(function (x, y) { return x - y; }); hi.sort(function (x, y) { return x - y; });
      var q = lo.length > 150 ? 0.003 : 0;
      a = quantile(lo, q); b = quantile(hi, 1 - q);
      if (mode === 'mag') lims.forEach(function (v) { a = Math.min(a, v); b = Math.max(b, v); });
      else {
        a = Math.min(a, 0); b = Math.max(b, 0);
        lims.forEach(function (v) { if (v > b * 1.6) nAbove++; else b = Math.max(b, v); });
      }
    } else if (lims.length) {
      a = Math.min.apply(null, lims); b = Math.max.apply(null, lims);
      if (mode !== 'mag') a = 0;
    } else return null;
    var pad = (b - a) * 0.07 || (mode === 'mag' ? 0.5 : Math.abs(b) * 0.2 || 1);
    return { range: mode === 'mag' ? [b + pad, a - pad] : [a - pad, b + pad], nAbove: nAbove };
  }

  function updatePlot() {
    var el = document.getElementById('lc-plot');
    if (!O || !el || !window.Plotly) return;
    U.hover.hide();
    var shown = shownPoints();
    O.shown = shown;
    var traces = [], refs = [], groups = new Map();
    shown.forEach(function (s) {
      var cls = s.lim ? 'l' : s.p.k === 1 ? 'f' : 'd', key = s.p.s + '|' + s.p.fam + '|' + cls, g = groups.get(key);
      if (!g) { g = { s: s.p.s, fam: s.p.fam, cls: cls, x: [], y: [], e: [], refs: [] }; groups.set(key, g); }
      g.x.push(s.x); g.y.push(s.y); g.e.push(s.ey == null ? 0 : s.ey); g.refs.push(s);
    });
    var card = U.cssVar('--card');
    // "Merge sources": one thin line per band family through every measured point shown (detections
    // and forced photometry from all sources, never limits), in time order, drawn under the markers.
    if (LC.merge) {
      var byFam = new Map();
      shown.forEach(function (s) {
        if (s.lim) return;
        var a = byFam.get(s.p.fam);
        if (!a) byFam.set(s.p.fam, a = []);
        a.push(s);
      });
      K.FAMILIES.forEach(function (fam) {
        var a = byFam.get(fam);
        if (!a || a.length < 2) return;
        a.sort(function (u, v) { return u.x - v.x; });
        traces.push({ type: 'scatter', mode: 'lines', x: a.map(function (s) { return s.x; }), y: a.map(function (s) { return s.y; }),
          line: { color: U.famColor(fam), width: 1.1 }, opacity: 0.6, hoverinfo: 'skip', showlegend: false, cliponaxis: true });
        refs.push([]);
      });
    }
    groups.forEach(function (g) {
      var col = U.famColor(g.fam), sym = O.sym[g.s] || 'circle';
      if (g.cls === 'f' && !/-open$/.test(sym)) sym += '-open';
      if (g.cls === 'l') sym = K.LIMIT_SYMBOL;
      var open = /-open$/.test(sym);
      traces.push({ type: 'scatter', mode: 'markers', x: g.x, y: g.y, hoverinfo: 'none',
        marker: { symbol: sym, size: g.cls === 'l' ? 8 : g.s === 'tns' ? 11 : 8, color: col, opacity: g.cls === 'l' ? 0.7 : g.cls === 'f' ? 0.8 : 0.95,
          line: { color: open ? col : card, width: open ? 1.5 : 0.8 } },
        error_y: g.cls === 'l' ? { visible: false } : { type: 'data', array: g.e, visible: true, thickness: 1, width: 0, color: col },
        showlegend: false, cliponaxis: true });
      refs.push(g.refs);
    });
    var disc = O.disc, win = S.meta.window || {}, near = null;
    var X_ = function (t) { return LC.x === 'rel' ? t - disc : t; };
    var ticksOn = LC.ticks && S.visits;
    if (ticksOn) {
      near = O.near || (O.near = X.nearbyVisits(O.i));
      var byBand = {};
      near.forEach(function (v) { (byBand[v.band] = byBand[v.band] || []).push(v); });
      Object.keys(byBand).sort(function (a, b) { return K.FAMILIES.indexOf(U.bandFamily(a)) - K.FAMILIES.indexOf(U.bandFamily(b)); }).forEach(function (b) {
        var vs = byBand[b], col = U.famColor(U.bandFamily(b));
        traces.push({ type: 'scatter', mode: 'markers', xaxis: 'x', yaxis: 'y2', hoverinfo: 'none',
          x: vs.map(function (v) { return X_(v.mjd); }), y: vs.map(function () { return 0.5; }),
          marker: { symbol: 'line-ns-open', size: 13, color: col, line: { color: col, width: near.length > 400 ? 1.1 : 1.6 }, opacity: near.length > 400 ? 0.6 : 0.95 },
          showlegend: false });
        refs.push(vs.map(function (v) { return { visit: v }; }));
      });
    }
    O.refs = refs;
    var line = U.cssVar('--line'), strong = U.cssVar('--line-strong'), muted = U.cssVar('--muted'), ink = U.cssVar('--ink');
    var shapes = [], ann = [];
    if (U.isNum(win.mjd_start) && U.isNum(win.mjd_end)) {
      shapes.push({ type: 'rect', xref: 'x', yref: 'paper', x0: X_(win.mjd_start), x1: X_(win.mjd_end), y0: 0, y1: 1, fillcolor: U.cssVar('--plot-window'), line: { width: 0 }, layer: 'below' });
      ann.push({ text: 'EDP2 window', xref: 'x', yref: 'paper', x: X_(win.mjd_start), y: 1, xanchor: 'left', yanchor: 'top', xshift: 6, yshift: -4,
        showarrow: false, font: { size: 11, color: muted } });
    }
    if (U.isNum(disc)) {
      shapes.push({ type: 'line', xref: 'x', yref: 'paper', x0: X_(disc), x1: X_(disc), y0: 0, y1: 1, line: { color: U.cssVar('--plot-disc'), width: 1, dash: 'dot' }, opacity: 0.7 });
      ann.push({ text: 'TNS discovery', xref: 'x', yref: 'paper', x: X_(disc), y: 1, xanchor: 'center', yanchor: 'bottom', yshift: 2, showarrow: false, font: { size: 11, color: ink } });
    }
    if (ticksOn) ann.push({ text: 'LSSTCam pointing ≤' + K.TICK_RADIUS_DEG + '° (coverage not guaranteed)', xref: 'paper', yref: 'paper', x: 0, y: 0.072,
      xanchor: 'left', yanchor: 'bottom', showarrow: false, font: { size: 10.5, color: muted } });
    var yr = yRange(shown, LC.y);
    var layout = {
      margin: { l: 60, r: 12, t: 28, b: 44 }, paper_bgcolor: card, plot_bgcolor: card,
      font: { family: 'Inter, ui-sans-serif, system-ui, sans-serif', size: 12, color: muted },
      hovermode: 'closest', dragmode: 'zoom', showlegend: false, uirevision: O.name + '|' + LC.x + '|' + LC.y,
      xaxis: { title: { text: LC.x === 'rel' ? 'Days since TNS discovery' : 'MJD', standoff: 10, font: { size: 12, color: muted } },
        gridcolor: line, gridwidth: 1, zeroline: false, showline: false, ticks: '', anchor: ticksOn ? 'y2' : 'y', automargin: true,
        exponentformat: 'none', separatethousands: false, tickformat: LC.x === 'rel' ? '' : 'd', tickfont: { color: muted } },
      yaxis: { title: { text: LC.y === 'mag' ? 'AB magnitude' : 'Flux (nJy)', standoff: 8, font: { size: 12, color: muted } }, gridcolor: line, gridwidth: 1,
        zeroline: LC.y === 'flux', zerolinecolor: strong, zerolinewidth: 1, showline: false, ticks: '', domain: ticksOn ? [0.11, 1] : [0, 1], automargin: true,
        exponentformat: 'SI', tickfont: { color: muted } },
      shapes: shapes, annotations: ann
    };
    if (yr) { layout.yaxis.range = yr.range; layout.yaxis.autorange = false; }
    else if (LC.y === 'mag') layout.yaxis.autorange = 'reversed';
    if (ticksOn) layout.yaxis2 = { domain: [0, 0.065], range: [0, 1], showticklabels: false, showgrid: false, zeroline: false, fixedrange: true, showline: false };
    var config = { responsive: true, displaylogo: false, modeBarButtonsToRemove: ['lasso2d', 'select2d', 'autoScale2d'],
      toImageButtonOptions: { filename: 'lc_' + (V(O.i, 'prefix') || '') + O.name, scale: 2 } };
    if (!O.pts.length && !traces.length) {
      plotMessage('No photometry for this transient from any source in this build.' + (S.visitsState === 'loading' ? '' : ''));
      renderFoot(near, 0);
      return;
    }
    if (el.querySelector('.lc-msg')) el.innerHTML = '';
    var first = !el._fullLayout;
    window.Plotly.react(el, traces, layout, config);
    if (first) {
      el.on('plotly_hover', function (ev) {
        var p = ev.points && ev.points[0];
        if (!p || !O || !O.refs[p.curveNumber]) return;
        var ref = O.refs[p.curveNumber][p.pointNumber];
        if (ref) U.hover.show(ref.visit ? visitHtml(ref.visit) : pointHtml(ref), ev.event.clientX, ev.event.clientY);
      });
      el.on('plotly_unhover', function () { U.hover.hide(); });
      el.on('plotly_relayout', function () { U.hover.hide(); });
    }
    renderFoot(near, yr ? yr.nAbove : 0);
    var d = $('#pts'); if (d && d.open) renderPointsTable();
  }

  function fmtFlux(v) {
    if (!U.isNum(v)) return '—';
    var a = Math.abs(v);
    return a >= 1e5 ? v.toExponential(3) : a >= 100 ? Math.round(v).toLocaleString('en-US') : v.toFixed(1);
  }
  function pointHtml(s) {
    var p = s.p, dt = p.t - O.disc, col = U.famColor(p.fam), sym = O.sym[p.s] || 'circle';
    if (s.lim) sym = K.LIMIT_SYMBOL; else if (p.k === 1 && !/-open$/.test(sym)) sym += '-open';
    var h = '<div class="hc-t">' + U.symbolSvg(sym, col).replace('<svg', '<svg width="12" height="12"') + esc(U.srcShort(p.s)) + ' <span class="hc-m" style="font-weight:500">' + esc(p.b) + ' · ' + K.KIND_LABEL[p.k] + '</span></div>' +
      '<div class="hc-r">MJD ' + p.t.toFixed(4) + ' <span class="hc-m">· ' + (dt >= 0 ? '+' : '−') + Math.abs(dt).toFixed(2) + ' d</span></div>';
    if (s.lim) h += '<div class="hc-r">limit ' + U.fx(s.limMag, 2) + ' mag' + (LC.y === 'flux' ? ' <span class="hc-m">· ' + fmtFlux(s.y) + ' nJy</span>' : '') + '</div>';
    else {
      h += '<div class="hc-r">' + fmtFlux(p.f) + (U.isNum(p.e) ? ' ± ' + fmtFlux(p.e) : '') + ' nJy' + (U.isNum(p.e) && p.e > 0 ? ' <span class="hc-m">· S/N ' + (p.f / p.e).toFixed(1) + '</span>' : '') + '</div>';
      if (s.mag != null) h += '<div class="hc-r">' + U.fx(s.mag, 3) + (s.magErr != null ? ' ± ' + U.fx(s.magErr, 3) : '') + ' mag</div>';
    }
    if (p.x) h += '<div class="hc-n">' + esc(String(p.x).slice(0, 160)) + '</div>';
    return h;
  }
  function visitHtml(v) {
    return '<div class="hc-t"><i class="sw" style="width:3px;height:12px;background:' + U.famColor(U.bandFamily(v.band)) + '"></i>LSSTCam pointing · ' + esc(v.band) + '</div>' +
      '<div class="hc-r">MJD ' + v.mjd.toFixed(4) + ' <span class="hc-m">· ' + esc(U.isoDateTime(v.mjd)) + '</span></div>' +
      '<div class="hc-m">Visit centre ' + v.sep.toFixed(2) + '° away · coverage not guaranteed</div>';
  }
  function renderFoot(near, nAbove) {
    var el = $('#lc-foot');
    if (!el || !O) return;
    var left = [];
    if (!O.pts.length) left.push('No photometry for this transient from any source in this build');
    else left.push(U.fint(O.shown.length) + ' of ' + U.fint(O.pts.length) + ' points shown');
    if (nAbove) left.push(nAbove + ' upper limit' + (nAbove > 1 ? 's' : '') + ' above the flux range (zoom out or use magnitudes)');
    if (LC.y === 'mag') left.push('magnitudes for flux > 0 only' + (O.nLowSN ? ' (' + U.fint(O.nLowSN) + ' forced points with S/N < 3 hidden)' : ''));
    if (LC.merge) left.push('lines join all sources per band');
    var right = '';
    if (LC.ticks) {
      if (S.visitsState === 'ready' && near) {
        var bands = {};
        near.forEach(function (v) { bands[v.band] = (bands[v.band] || 0) + 1; });
        right = '<span class="tick-legend"><span>' + U.plural(near.length, 'LSSTCam pointing') + ' ≤' + K.TICK_RADIUS_DEG + '° (coverage not guaranteed)</span>' +
          Object.keys(bands).sort(function (a, b) { return K.FAMILIES.indexOf(U.bandFamily(a)) - K.FAMILIES.indexOf(U.bandFamily(b)); }).map(function (b) {
            return '<span class="tk-item"><span class="tk" style="background:' + U.famColor(U.bandFamily(b)) + '"></span>' + esc(b) + ' ' + bands[b] + '</span>';
          }).join('') + '</span>';
      } else if (S.visitsState === 'error') right = 'LSSTCam pointings unavailable (data/visits.js did not load)';
      else right = 'Loading LSSTCam pointings…';
    }
    el.innerHTML = '<span>' + left.join(' · ') + '</span><span>' + right + '</span>';
  }

  // The CSV of the shown points is one combined table: every source in time order, with the
  // band family and the survey (for TNS reports, the reporting telescope/instrument) on each row.
  var LC_HEADER = ['source', 'survey', 'band', 'band_family', 'mjd', 'days_since_disc', 'kind', 'flux_njy', 'flux_err_njy', 'mag_ab', 'mag_err', 'lim_mag', 'note'];
  function surveyOf(p) {
    var sv = ((S.meta.sources || {})[p.s] || {}).survey || '';
    if (sv && sv !== 'various') return sv;
    var tel = String(p.x || '').split(' (')[0].trim();          // TNS notes start "telescope/instrument"
    if (tel) return tel;
    var b = String(p.b || '');
    return b.indexOf('-') > 0 ? b.split('-')[0] : (sv || p.s);
  }
  function lcRows() {
    return O.shown.slice().sort(function (a, b) { return a.p.t - b.p.t; }).map(function (s) {
      var p = s.p;
      return [p.s, surveyOf(p), p.b, p.fam, p.t, +(p.t - O.disc).toFixed(5), K.KIND_LABEL[p.k], p.f, p.e,
        s.mag != null ? +s.mag.toFixed(4) : null, s.magErr != null ? +s.magErr.toFixed(4) : null, s.limMag != null ? +s.limMag.toFixed(3) : null, p.x];
    });
  }
  function downloadLc() {
    if (O) U.downloadCsv((V(O.i, 'prefix') || '') + O.name + (S.isPrivate ? '_private' : '') + '_lightcurve.csv', LC_HEADER, lcRows());
  }
  function renderPointsTable() {
    var box = $('#pts-table');
    if (!O || !box) return;
    var rows = lcRows(), MAX = 3000;
    var body = rows.slice(0, MAX).map(function (r) {
      return '<tr><td>' + esc(U.srcShort(r[0])) + '</td><td>' + esc(r[1]) + '</td><td>' + esc(r[2]) + '</td><td class="num">' + U.fx(r[4], 4) + '</td><td class="num">' + U.fx(r[5], 2) +
        '</td><td>' + r[6] + '</td><td class="num">' + fmtFlux(r[7]) + '</td><td class="num">' + fmtFlux(r[8]) + '</td><td class="num">' +
        (r[9] != null ? U.fx(r[9], 3) : '') + '</td><td class="num">' + (r[10] != null ? U.fx(r[10], 3) : '') + '</td><td class="num">' +
        (r[11] != null ? U.fx(r[11], 2) : '') + '</td><td class="muted">' + esc(r[12] || '') + '</td></tr>';
    }).join('');
    box.innerHTML = '<div class="table-wrap"><table class="data"><thead><tr><th>Source</th><th>Survey</th><th>Band</th><th class="num">MJD</th><th class="num">Δt (d)</th>' +
      '<th>Kind</th><th class="num">Flux (nJy)</th><th class="num">± (nJy)</th><th class="num">AB mag</th><th class="num">±</th><th class="num">Limit</th><th>Note</th></tr></thead>' +
      '<tbody>' + (body || '<tr><td colspan="12"><div class="empty">No points shown.</div></td></tr>') + '</tbody></table></div>' +
      (rows.length > MAX ? '<p class="muted" style="margin-top:8px">First ' + MAX + ' of ' + U.fint(rows.length) + ' rows; the CSV has all of them.</p>' : '');
  }

  // ------------------------------------------------------------------ images
  // Public sky images come straight from the survey services (nothing stored here); Rubin alert cutouts are
  // data/stamps/<name>.webp strips (science | template | difference); the DP2 deep-coadd stamp exists only
  // with team access (encrypted shard) or in the private build (data/dp2stamps/).
  var IMG = { src: 'ls' };
  var RETICLE = '<svg class="reticle" viewBox="0 0 34 34" aria-hidden="true"><path d="M0 17h11M23 17h11M17 0v11M17 23v11"/></svg>';
  var SKY_SRC = {
    ls: ['Legacy Surveys DR10', function (ra, dec) { return 'https://www.legacysurvey.org/viewer/cutout.jpg?ra=' + ra.toFixed(6) + '&dec=' + dec.toFixed(6) + '&layer=ls-dr10&pixscale=0.25&size=240'; }, 'Legacy DR10'],
    ps1: ['Pan-STARRS1', function (ra, dec) { return hips('CDS/P/PanSTARRS/DR1/color-z-zg-g', ra, dec); }, 'PS1'],
    dss: ['DSS2', function (ra, dec) { return hips('CDS/P/DSS2/color', ra, dec); }, 'DSS2']
  };
  function hips(id, ra, dec) {
    return 'https://alasky.cds.unistra.fr/hips-image-services/hips2fits?hips=' + encodeURIComponent(id) +
      '&width=240&height=240&fov=' + (60 / 3600).toFixed(6) + '&projection=TAN&coordsys=icrs&ra=' + ra.toFixed(6) + '&dec=' + dec.toFixed(6) + '&format=jpg';
  }
  function imgCardHtml(i) {
    var ra = V(i, 'ra'), dec = V(i, 'dec');
    if (!U.isNum(ra) || !U.isNum(dec)) return '';
    var st = String(V(i, 'stamp') || '').split('|'), name = V(i, 'name');
    var h = '<section class="card img-card" aria-labelledby="img-h"><div class="lc-head"><h2 id="img-h">Images</h2><div class="lc-ctl" id="img-ctl">' +
      seg('imgsrc', 'Sky survey', Object.keys(SKY_SRC).map(function (k) { return [k, SKY_SRC[k][2]]; }), IMG.src) + '</div></div><div class="img-row">';
    h += '<figure class="img-fig sky"><div class="imgbox"><img id="img-sky" src="' + esc(SKY_SRC[IMG.src][1](ra, dec)) + '" width="240" height="240" loading="lazy" alt="' +
      esc(SKY_SRC[IMG.src][0]) + ' image around ' + esc(U.fullName(i)) + '">' + RETICLE + '</div>' +
      '<figcaption><b id="img-sky-cap">' + esc(SKY_SRC[IMG.src][0]) + '</b> · 60″ · north up, east left</figcaption></figure>';
    if (st.length === 4) {
      var neg = st[3] === '1';
      h += '<figure class="img-fig alert"><div class="strip" role="img" aria-label="Rubin alert cutouts: science, template and difference">' +
        ['Science', 'Template', 'Difference'].map(function (k, j) {
          return '<div class="tile" style="background-image:url(data/stamps/' + encodeURIComponent(name) + '.webp);background-position:' + (j * 50) + '% 0"><span>' + k + '</span></div>';
        }).join('') + '</div><figcaption><b>Rubin alert</b> · ' + esc(st[0]) + ' band · ' + esc(U.isoDate(+st[1])) + ' · S/N ' + esc(st[2]) +
        (neg ? ' · <span class="neg" title="The difference flux is negative: the template is brighter than the new image, usually because the transient was already in the template">negative difference</span>' : '') +
        ' · 6″, detector orientation</figcaption></figure>';
    }
    if (S.isPrivate && V(i, 'edp2_stamp')) {
      var b = String(V(i, 'edp2_stamp')), src = S.dp2Stamp[name] || (S.meta.mode === 'private' && !S.meta.team ? 'data/dp2stamps/' + encodeURIComponent(name) + '.webp' : '');
      h += '<figure class="img-fig dp2"><div class="imgbox">' + (src ? '<img id="img-dp2" src="' + src + '" width="160" height="160" alt="Rubin DP2 deep coadd around ' + esc(U.fullName(i)) + '">' :
        '<div class="sk" id="img-dp2-slot"></div>') + '' + RETICLE + '</div>' +
        '<figcaption><b>Rubin DP2 deep coadd</b> · ' + esc(b) + ' · 40″ · north up, east left · <span class="priv">proprietary</span></figcaption></figure>';
    }
    return h + '</div></section>';
  }
  function fillDp2Stamp(i) {
    var slot = document.getElementById('img-dp2-slot'), uri = S.dp2Stamp[V(i, 'name')];
    if (slot) slot.outerHTML = uri ? '<img id="img-dp2" src="' + uri + '" width="160" height="160" alt="Rubin DP2 deep coadd around ' + esc(U.fullName(i)) + '">' : '<div class="host-noimg">No stamp</div>';
  }
  function wireImg(i) {
    var ctl = document.getElementById('img-ctl');
    if (!ctl) return;
    ctl.onchange = function (e) {
      if (e.target.name !== 'imgsrc') return;
      IMG.src = e.target.value;
      var img = document.getElementById('img-sky'), s2 = SKY_SRC[IMG.src];
      img.src = s2[1](V(i, 'ra'), V(i, 'dec'));
      img.alt = s2[0] + ' image around ' + U.fullName(i);
      document.getElementById('img-sky-cap').textContent = s2[0];
    };
  }

  // ------------------------------------------------------------------ classifications (data/clf/NNN.js)
  var CLF = { track: 0, list: null, i: null };
  function expertInfo(key) {
    var ex = ((S.meta.classifiers || {}).experts || []);
    for (var k = 0; k < ex.length; k++) if (ex[k].key === key) return ex[k];
    return { key: key, label: key, sub: '', timing: 'alert', kind: 'sn' };
  }
  function trackName(t) { return t.sv === 'ZTF' ? 'ZTF · ' + t.id : 'Rubin alerts · ' + t.id; }
  function clfCardHtml(i) {
    if (!U.has('clf_n') || !(V(i, 'clf_n') > 0 || U.isNum(V(i, 'mdb_psn')))) return '';
    return '<section class="card clf-card" aria-labelledby="clf-h"><div class="lc-head"><h2 id="clf-h">Classifications</h2><div class="lc-ctl" id="clf-ctl"></div></div>' +
      '<p class="clf-lede">What each broker classifier said as the detections came in, with the metaDEBASS meta-layer’s confidences. ' +
      '<a href="#/classifiers">How often are they right?</a></p><div id="clf-body"><div class="sk" style="height:120px"></div></div></section>';
  }
  function loadClf(i) {
    CLF.list = null; CLF.i = i; CLF.track = 0;
    if (!document.getElementById('clf-body')) return;
    X.loadClf(X.shardOf(i)).then(function (d) {
      if (cur !== i) return;
      CLF.list = (d || {})[V(i, 'name')] || [];
      var best = 0;
      CLF.list.forEach(function (t, k) { if (t.mdb && (!CLF.list[best].mdb || t.t.length > CLF.list[best].t.length)) best = k; });
      CLF.track = best;
      renderClf();
    }).catch(function (e) {
      if (cur !== i) return;
      var b = document.getElementById('clf-body');
      if (b) b.innerHTML = '<p class="muted">The classifications could not be loaded (' + esc(e.message) + ').</p>';
    });
  }
  // Shade = confidence in the call itself. SuperNNova reports P(SN) and EarlySNIa P(Ia) whatever the call;
  // the others report the probability of the class they call.
  function callConf(key, call, conf) {
    if (!U.isNum(conf)) return null;
    if (key === 'fink_lsst/snn') return call === 'N' ? conf : 1 - conf;
    if (key === 'fink_lsst/early_snia') return call === 'I' ? conf : 1 - conf;
    return conf;
  }
  function clfCell(call, conf, title, isLatest) {
    if (!call) return '<td class="c-none"></td>';
    var op = U.isNum(conf) ? Math.max(0.35, Math.min(1, 0.35 + 0.65 * conf)) : 0.85;
    return '<td class="c-' + call + (isLatest ? ' latest' : '') + '" data-tip="' + esc(title) + '"><i style="opacity:' + op.toFixed(2) + '"></i></td>';
  }
  function renderClf() {
    var body = document.getElementById('clf-body'), ctl = document.getElementById('clf-ctl');
    if (!body || !CLF.list) return;
    if (!CLF.list.length) { body.innerHTML = '<p class="muted">No classifier output for this transient.</p>'; return; }
    var nsv = {};
    CLF.list.forEach(function (t2) { nsv[t2.sv] = (nsv[t2.sv] || 0) + 1; });
    ctl.innerHTML = CLF.list.length > 1 ? seg('clftrack', 'Survey object', CLF.list.map(function (t2, k) {
      return [String(k), (t2.sv === 'ZTF' ? 'ZTF' : 'Rubin') + (nsv[t2.sv] > 1 ? ' …' + String(t2.id).slice(-4) : '')];
    }), String(CLF.track)) : '';
    ctl.onchange = function (e) { if (e.target.name === 'clftrack') { CLF.track = +e.target.value; renderClf(); } };
    var t = CLF.list[CLF.track], n = t.t.length, disc = V(CLF.i, 'disc_mjd'), unit = t.b === 'alert' ? 'alert' : 'detection';
    var head = '<tr><th class="lab" scope="col">' + esc(trackName(t)) + '</th>';
    for (var k = 0; k < n; k++) {
      var dt = U.isNum(t.t[k]) && U.isNum(disc) ? t.t[k] - disc : null;
      head += '<th scope="col" data-tip="' + esc(unit + ' ' + (k + 1) + (U.isNum(t.t[k]) ? ' · ' + U.isoDate(t.t[k]) + (dt != null ? ' · ' + (dt < 0 ? '−' : '+') + Math.abs(dt).toFixed(1) + ' d from discovery' : '') : '')) + '">' + (k + 1) + '</th>';
    }
    head += '</tr>';
    var rows = '';
    if (t.mdb) {
      // metaDEBASS is a meta-layer, not a classifier: calibrated confidences as bar heights, no class call.
      var ins = t.ins ? ' <span class="pill outline" title="This object was in metaDEBASS’s training or calibration set, so its scores are in-sample">trained on it</span>' : '';
      var confRow = function (arr, label, sub, what) {
        var r = '<tr class="mdb"><th class="lab" scope="row"><b>' + label + '</b><small>' + sub + '</small>' + (what === 'sn' ? ins : '') + '</th>';
        for (var k1 = 0; k1 < n; k1++) {
          var v1 = arr[k1];
          if (!U.isNum(v1)) { r += '<td class="c-none"></td>'; continue; }
          var ia1 = t.mdb.ia ? t.mdb.ia[k1] : null;
          var tip1 = 'metaDEBASS after ' + unit + ' ' + (k1 + 1) + ': P(supernova) ' + t.mdb.sn[k1].toFixed(2) + (U.isNum(ia1) ? ' · P(SN Ia) ' + ia1.toFixed(2) : '') +
            ' (calibrated confidences, not a class call)';
          r += '<td class="conf" data-tip="' + esc(tip1) + '"><i style="height:' + Math.max(4, 100 * v1).toFixed(0) + '%"></i></td>';
        }
        return r + '</tr>';
      };
      rows += confRow(t.mdb.sn, 'metaDEBASS', 'P(supernova)', 'sn');
      if (t.mdb.ia) rows += confRow(t.mdb.ia, 'metaDEBASS', 'P(SN Ia)', 'ia');
    }
    var keys = ((S.meta.classifiers || {}).experts || []).map(function (e) { return e.key; }).filter(function (k2) { return t.x[k2]; });
    Object.keys(t.x).forEach(function (k2) { if (keys.indexOf(k2) < 0) keys.push(k2); });
    keys.forEach(function (key) {
      var e = expertInfo(key), arr = t.x[key];
      rows += '<tr><th class="lab" scope="row"><a href="' + esc(e.ref || '#/classifiers') + '" target="_blank" rel="noopener noreferrer">' + esc(e.label) + '</a><small>' + esc(e.sub || '') + '</small></th>';
      for (var k3 = 0; k3 < n; k3++) {
        var c = arr[k3];
        if (!c) { rows += '<td class="c-none"></td>'; continue; }
        var lab = t.lab[key] || (key === 'fink_lsst/cats' && t.cats ? ({ 11: 'SN-like', 12: 'Fast', 13: 'Long', 21: 'Periodic', 22: 'Non-periodic' }[t.cats[k3]] || 'CATS') + (U.isNum(c[1]) ? ' ' + c[1].toFixed(2) : '') :
          key === 'fink_lsst/early_snia' ? 'P(Ia) ' + (U.isNum(c[1]) ? c[1].toFixed(2) : '') : 'P(SN) ' + (U.isNum(c[1]) ? c[1].toFixed(2) : ''));
        var qv = t.q && t.q[key] ? t.q[key][k3] : null;
        rows += clfCell(c[0], callConf(key, c[0], c[1]), e.label + ' after ' + unit + ' ' + (k3 + 1) + ': ' + (K.CALL_LABEL[c[0]] || c[0]) + ' · ' + lab +
          (e.timing === 'latest' ? ' (object-level, from the full lightcurve)' : '') + (U.isNum(qv) ? ' · metaDEBASS trust in this call ' + qv.toFixed(2) : ''), e.timing === 'latest');
      }
      rows += '</tr>';
    });
    var hasQ = Object.keys(t.q || {}).length > 0;
    var latest = keys.map(function (key) {
      var e = expertInfo(key), arr = t.x[key], last = null, lk = -1;
      for (var k4 = arr.length - 1; k4 >= 0; k4--) if (arr[k4]) { last = arr[k4]; lk = k4; break; }
      if (!last) return '';
      var lab = t.lab[key] || (key === 'fink_lsst/cats' && t.cats ? ({ 11: 'SN-like', 12: 'Fast', 13: 'Long', 21: 'Periodic', 22: 'Non-periodic' }[t.cats[lk]] || '') + (U.isNum(last[1]) ? ' ' + last[1].toFixed(2) : '') :
        (key === 'fink_lsst/early_snia' ? 'P(Ia) ' : 'P(SN) ') + (U.isNum(last[1]) ? last[1].toFixed(2) : ''));
      var ql = t.q && t.q[key] ? t.q[key][lk] : null;
      return '<tr><td>' + esc(e.label) + ' <span class="muted">' + esc(e.sub || '') + '</span></td><td><span class="callpill c-' + last[0] + '">' + esc(K.CALL_LABEL[last[0]] || last[0]) + '</span></td><td class="mono">' + esc(lab) + '</td>' +
        (hasQ ? '<td class="num">' + (U.isNum(ql) ? ql.toFixed(2) : '<span class="none">—</span>') + '</td>' : '') + '<td class="num">' + (lk + 1) + '</td></tr>';
    }).join('');
    var tru = V(CLF.i, 'type');
    body.innerHTML = '<div class="clf-scroll"><table class="clf-grid">' + head + rows + '</table></div>' +
      '<div class="clf-legend"><span class="lg-h">Broker calls</span><span><i class="c-I"></i>SN Ia</span><span><i class="c-S"></i>SN, not Ia</span><span><i class="c-N"></i>SN (no subtype)</span><span><i class="c-O"></i>not SN</span><span><i class="c-n"></i>not Ia</span>' +
      '<span class="lg-h">metaDEBASS</span><span><i class="conf-key"></i>confidence, as bar height</span>' +
      '<span class="muted">Broker cells: stronger colour, more confident. Columns: ' + unit + ' number' + (t.b === 'det' ? ' (positive detections)' : ' (every Rubin alert, including negative differences)') + '.</span></div>' +
      '<div class="table-wrap clf-latest"><table class="data"><thead><tr><th>Classifier</th><th>Latest call</th><th>Output</th>' +
        (hasQ ? '<th class="num" title="metaDEBASS’s calibrated trust that this call is right">metaDEBASS trust</th>' : '') + '<th class="num">At ' + unit + '</th></tr></thead><tbody>' + latest + '</tbody></table></div>' +
      '<p class="clf-foot">' + (tru ? 'TNS classification: <b>' + esc(tru) + '</b>. ' : 'No TNS classification yet. ') +
      (t.b === 'alert' ? 'metaDEBASS scores Rubin objects with at least one positive detection; every alert of this one is a negative difference, so only broker outputs are shown. ' : '') +
      (t.mdb ? '<a href="https://github.com/trivialTZ/rubin_hackathon" target="_blank" rel="noopener noreferrer">metaDEBASS</a> is a meta-layer, not another classifier: it reports calibrated confidences for follow-up ranking and how far to trust each broker’s call (trust is not shown yet: its levels are not calibrated for this catalogue). ' +
        'A P(SN Ia) of 0.4 means about four in ten objects scored like this are SNe Ia, not that this one is something else.' +
        (t.sv === 'LSST' ? ' For Rubin alerts its SN Ia score does not yet beat chance on live alerts, so it gives P(supernova) only.' : '') + ' ' : '') +
      'All scores are research outputs, not classifications.</p>';
    body.onmousemove = function (e) {
      var c = e.target.closest('[data-tip]');
      if (!c) { U.hover.hide(); return; }
      U.hover.show('<div class="hc-m">' + esc(c.getAttribute('data-tip')) + '</div>', e.clientX, e.clientY);
    };
    body.onmouseleave = function () { U.hover.hide(); };
  }

  X.onVisitsChanged = function () { if (S.view === 'object' && O) { O.near = null; updatePlot(); } };
  // ------------------------------------------------------------------ TNS spectra (public, data/spec/NNN.js)
  // Each spectrum is resampled on a uniform grid (w0 + k*dw, Angstrom) and divided by its median
  // (build/fetch_tns_spectra.py), so the plot compares shapes; the original TNS file is linked.
  var SP = { frame: 'obs', stack: true, lines: true, off: new Set() };
  var SPD = null;     // current object's spectra: {i, list, z, disc}
  var SPEC_PAL = {
    light: ['#12191D', '#b3261a', '#1f6fe0', '#b88300', '#8e3fa5', '#3d8b37', '#d9534f', '#7a5c00'],
    dark: ['#EDF1F3', '#e8706b', '#6f9ff5', '#d9b550', '#c08ae0', '#7fd07a', '#f09a96', '#e0c070']
  };
  // Rest wavelengths (Angstrom) of features commonly used to classify supernovae.
  var SPEC_LINES = [[3945, 'Ca II'], [4340, 'Hγ'], [4861, 'Hβ'], [5169, 'Fe II'], [5454, 'S II'], [5640, 'S II'],
    [5876, 'He I'], [6355, 'Si II'], [6563, 'Hα'], [7774, 'O I'], [8579, 'Ca II']];
  var TELLURIC = [[6860, 6890], [7590, 7700]];     // O2 B and A bands, observed frame

  function specCardHtml(i) {
    var n = V(i, 'n_spec') || 0, np = V(i, 'n_spec_plot') || 0;
    if (!n) return '';
    var h = '<section class="card lc-card spec-card" aria-labelledby="spec-h"><div class="lc-head"><h2 id="spec-h">Spectra</h2><div class="lc-ctl" id="spec-ctl"></div></div>';
    if (!np) {
      return h + '<p class="muted" style="margin:16px 0 8px">TNS lists ' + U.plural(n, 'spectrum', 'spectra') + ', but no public file could be read in this build' +
        (V(i, 'spec_types') ? ': ' + esc(V(i, 'spec_types')) : '') + '. <a href="https://www.wis-tns.org/object/' + encodeURIComponent(V(i, 'name')) + '" target="_blank" rel="noopener">See TNS</a>.</p></section>';
    }
    return h + '<div id="spec-legend"></div>' +
      '<div class="lc-plot spec-plot" id="spec-plot"><div class="lc-msg"><div><span class="sk" style="display:block;width:220px;height:10px;margin:0 auto 10px"></span>Loading spectra…</div></div></div>' +
      '<div class="lc-foot" id="spec-foot"></div></section>';
  }
  function loadSpectra(i) {
    SPD = null;
    if (!(V(i, 'n_spec_plot') > 0)) return;
    SP.off = new Set();
    Promise.all([X.loadSpec(X.shardOf(i)), X.ensurePlotly()]).then(function (res) {
      if (cur !== i) return;
      SPD = { i: i, list: (res[0] || {})[V(i, 'name')] || [], z: V(i, 'z'), disc: V(i, 'disc_mjd') };
      renderSpecControls();
      drawSpec();
    }).catch(function (e) {
      if (cur !== i) return;
      var el = $('#spec-plot');
      if (el) el.innerHTML = '<div class="lc-msg"><div>The spectra could not be loaded (' + esc(e.message) + ').</div></div>';
    });
  }
  function specLabel(s) {
    var dt = U.isNum(s.t) && U.isNum(SPD.disc) ? s.t - SPD.disc : null;
    return { date: U.isoDate(s.t), phase: dt == null ? '' : (dt < 0 ? '−' : '+') + Math.abs(dt).toFixed(Math.abs(dt) < 10 ? 1 : 0) + ' d',
      inst: [s.tel, s.inst].filter(Boolean).join(' '), grp: s.grp || '' };
  }
  function specColor(k) { var p = SPEC_PAL[U.isDark() ? 'dark' : 'light']; return p[k % p.length]; }
  function renderSpecControls() {
    var ctl = $('#spec-ctl'), leg = $('#spec-legend');
    if (!ctl || !SPD) return;
    var hasZ = U.isNum(SPD.z) && SPD.z > 0;
    if (!hasZ) SP.frame = 'obs';
    ctl.innerHTML = (hasZ ? seg('spframe', 'Wavelength frame', [['obs', 'Observed'], ['rest', 'Rest frame']], SP.frame) : '') +
      (SPD.list.length > 1 ? seg('spstack', 'Layout', [['stack', 'Stacked'], ['over', 'Overlaid']], SP.stack ? 'stack' : 'over') : '') +
      toggle('sp-lines', 'Line markers', SP.lines && hasZ, null, !hasZ, false, hasZ ? 'Common SN features at z = ' + U.fx(SPD.z, 4) : 'Needs a TNS redshift');
    leg.innerHTML = '<div class="lc-legend spec-legend">' + SPD.list.map(function (s, k) {
      var L = specLabel(s);
      return '<span class="sp-item"><label class="lchip" title="' + esc([L.date, L.inst, L.grp].filter(Boolean).join(' · ')) + '"><input type="checkbox" data-sp="' + k + '"' + (SP.off.has(k) ? '' : ' checked') + '>' +
        '<span><i class="sw" style="background:' + specColor(k) + '"></i><b class="spl">' + esc(L.date) + (L.phase ? ' <small class="n">' + esc(L.phase) + '</small>' : '') +
        (L.inst ? ' · ' + esc(L.inst) : '') + (L.grp ? ' <small class="n">' + esc(L.grp) + '</small>' : '') + '</b></span></label>' +
        '<a class="sp-file" href="' + esc(s.url) + '" target="_blank" rel="noopener noreferrer" title="Original file on TNS" aria-label="Original file on TNS for the ' + esc(L.date) + ' spectrum">' + U.icon('ext', 2) + '</a></span>';
    }).join('') + '</div>';
    var card = $('.spec-card');
    card.onchange = function (e) {
      var t = e.target;
      if (t.name === 'spframe') SP.frame = t.value;
      else if (t.name === 'spstack') SP.stack = t.value === 'stack';
      else if (t.id === 'sp-lines') SP.lines = t.checked;
      else if (t.hasAttribute('data-sp')) { var k = +t.getAttribute('data-sp'); if (t.checked) SP.off.delete(k); else SP.off.add(k); }
      else return;
      drawSpec();
    };
  }
  function drawSpec() {
    var el = $('#spec-plot');
    if (!el || !SPD || !window.Plotly) return;
    var list = SPD.list, z = SPD.z, hasZ = U.isNum(z) && z > 0, rest = SP.frame === 'rest' && hasZ, div = rest ? 1 + z : 1;
    var shown = list.map(function (s, k) { return k; }).filter(function (k) { return !SP.off.has(k); });
    var ink = U.cssVar('--ink'), muted = U.cssVar('--muted'), line = U.cssVar('--line'), card = U.cssVar('--card'), win = U.cssVar('--plot-window');
    var stack = SP.stack && shown.length > 1, step = 0;
    if (stack) {
      var spreads = shown.map(function (k) {
        var f = list[k].f.filter(U.isNum).sort(function (a, b) { return a - b; });
        return (quantile(f, 0.98) || 1) - (quantile(f, 0.02) || 0);
      }).sort(function (a, b) { return a - b; });
      step = Math.max(0.6, quantile(spreads, 0.5) * 0.85);
    }
    var traces = [], ann = [], shapes = [], xmin = Infinity, xmax = -Infinity;
    shown.forEach(function (k, r) {
      var s = list[k], n = s.f.length, x = new Array(n), y = new Array(n), off = stack ? (shown.length - 1 - r) * step : 0, L = specLabel(s);
      for (var j = 0; j < n; j++) { x[j] = (s.w0 + j * s.dw) / div; y[j] = s.f[j] == null ? null : s.f[j] + off; }
      xmin = Math.min(xmin, x[0]); xmax = Math.max(xmax, x[n - 1]);
      traces.push({ type: 'scatter', mode: 'lines', x: x, y: y, connectgaps: false, line: { color: specColor(k), width: 1.3 },
        hovertemplate: '%{x:.0f} Å · %{y:.2f}<br>' + esc(L.date + (L.phase ? ' (' + L.phase + ')' : '') + (L.inst ? ' · ' + L.inst : '')) + '<extra></extra>' });
      if (stack) {
        var tail = s.f.slice(Math.floor(n * 0.9)).filter(U.isNum).sort(function (a, b) { return a - b; });
        ann.push({ text: L.phase || L.date, x: x[n - 1], y: (quantile(tail, 0.5) || 1) + off, xanchor: 'left', yanchor: 'middle', xshift: 6, showarrow: false,
          font: { size: 11, color: specColor(k) } });
      }
    });
    TELLURIC.forEach(function (b) {
      shapes.push({ type: 'rect', xref: 'x', yref: 'paper', x0: b[0] / div, x1: b[1] / div, y0: 0, y1: 1, fillcolor: win, line: { width: 0 }, layer: 'below' });
    });
    ann.push({ text: '⊕ telluric', xref: 'x', yref: 'paper', x: 7645 / div, y: 0, yanchor: 'bottom', showarrow: false, font: { size: 10, color: muted } });
    if (SP.lines && hasZ) {
      SPEC_LINES.forEach(function (l) {
        var xl = rest ? l[0] : l[0] * (1 + z);
        if (xl < xmin || xl > xmax) return;
        shapes.push({ type: 'line', xref: 'x', yref: 'paper', x0: xl, x1: xl, y0: 0, y1: 1, line: { color: muted, width: 1, dash: 'dot' }, opacity: 0.55 });
        ann.push({ text: l[1], xref: 'x', yref: 'paper', x: xl, y: 1, yanchor: 'bottom', textangle: -90, xanchor: 'center', showarrow: false, font: { size: 10, color: muted } });
      });
    }
    var layout = {
      margin: { l: 56, r: stack ? 64 : 12, t: SP.lines && hasZ ? 44 : 16, b: 44 }, paper_bgcolor: card, plot_bgcolor: card,
      font: { family: 'Inter, ui-sans-serif, system-ui, sans-serif', size: 12, color: muted }, hovermode: 'closest', dragmode: 'zoom', showlegend: false,
      hoverlabel: { bgcolor: card, bordercolor: line, font: { color: ink, family: 'Inter, sans-serif', size: 12 } },
      uirevision: SPD.i + '|' + SP.frame + '|' + SP.stack,
      xaxis: { title: { text: (rest ? 'Rest-frame' : 'Observed') + ' wavelength (Å)', standoff: 10, font: { size: 12, color: muted } }, gridcolor: line, zeroline: false,
        showline: false, ticks: '', automargin: true, separatethousands: false, tickformat: 'd', tickfont: { color: muted } },
      yaxis: { title: { text: 'Flux / median' + (stack ? ' + offset' : ''), standoff: 8, font: { size: 12, color: muted } }, gridcolor: line, zeroline: false,
        showline: false, ticks: '', automargin: true, showticklabels: !stack, tickfont: { color: muted } },
      shapes: shapes, annotations: ann
    };
    var config = { responsive: true, displaylogo: false, modeBarButtonsToRemove: ['lasso2d', 'select2d', 'autoScale2d'],
      toImageButtonOptions: { filename: 'spec_' + (V(SPD.i, 'prefix') || '') + V(SPD.i, 'name'), scale: 2 } };
    if (el.querySelector('.lc-msg')) el.innerHTML = '';
    if (!shown.length) { window.Plotly.purge(el); el.innerHTML = '<div class="lc-msg"><div>Pick a spectrum above to plot it.</div></div>'; }
    else window.Plotly.react(el, traces, layout, config);
    $('#spec-foot').innerHTML = '<span>' + U.fint(shown.length) + ' of ' + U.plural(list.length, 'TNS spectrum', 'TNS spectra') + ' shown · each divided by its median and resampled to ≤ 1,200 points</span>' +
      '<span>' + (hasZ ? 'z = ' + U.fx(z, 4) + ' (TNS)' : 'no TNS redshift: observed frame only') + '</span>';
  }

  X.views.object = {
    show: function (name) { show(name); },
    onTheme: function () { if (O) { renderControls(); updatePlot(); } if (SPD) { renderSpecControls(); drawSpec(); } },
    onKey: function (e) {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key === 'ArrowLeft' || e.key === '[') { if (rel(-1)) e.preventDefault(); }
      else if (e.key === 'ArrowRight' || e.key === ']') { if (rel(1)) e.preventDefault(); }
    }
  };
})();
