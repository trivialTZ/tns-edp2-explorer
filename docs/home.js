/* TNS x EDP2 Explorer — Home view. */
(function () {
  'use strict';
  var X = window.TNSXApp, S = X.S, U = X.U, K = X.K;
  var $ = U.$, esc = U.esc;
  var H = { rendered: false, featured: [], mapDrawn: false };

  function surveysPhrase() {
    var s = Object.keys(S.meta.sources || {}), out = [];
    if (s.some(function (k) { return /^ztf/.test(k); })) out.push('ZTF');
    if (s.some(function (k) { return /^lsst_alert/.test(k); })) out.push('public Rubin alerts');
    if (s.indexOf('tns') >= 0) out.push('TNS');
    if (!out.length) return 'several surveys';
    return out.length === 1 ? out[0] : out.slice(0, -1).join(', ') + ' and ' + out[out.length - 1];
  }
  function render() {
    var root = document.getElementById('view-home');
    var span = U.isNum(S.discMin) ? U.monthYear(S.discMin).replace(' ', ' ') + ' – ' + U.monthYear(S.discMax) : '';
    var srcN = Object.keys(S.meta.sources || {}).length;
    var surveys = [];
    Object.keys(S.meta.sources || {}).forEach(function (k) { var sv = S.meta.sources[k].survey; if (sv && surveys.indexOf(sv) < 0) surveys.push(sv); });
    var pct = S.N ? Math.round(1000 * S.nTyped / S.N) / 10 : 0;
    root.innerHTML = '<div class="wrap">' +
      '<div class="hero"><div><p class="eyebrow" style="margin-bottom:20px">Rubin EDP2 × Transient Name Server</p>' +
      '<h1>Lightcurves for every TNS transient in the Rubin EDP2 footprint</h1></div>' +
      '<p class="lede">' + U.fint(S.N) + ' transients reported to the Transient Name Server between ' + esc(span.replace(' – ', ' and ')) +
      ', each inside the area Rubin observed for its second data preview. Every page overlays photometry from ' + esc(surveysPhrase()) + ' on one flux scale.' +
      (S.meta.team ? ' Team access is unlocked, so pages add proprietary Rubin DP2 catalogue photometry.' :
        S.isPrivate ? ' This private build adds proprietary Rubin DP2 catalogue photometry.' : '') + '</p>' +
      '<div class="hero-search"><div class="spot"><div class="spot-field">' + U.icon('search', 2) +
      '<input type="search" id="hero-q" placeholder="Search a TNS name, internal name, Rubin diaObjectId or “RA Dec”" aria-label="Search transients" autocomplete="off" spellcheck="false"></div>' +
      '<ul class="suggest" id="hero-suggest" hidden></ul></div></div>' +
      '<div class="hero-actions"><a class="btn btn-primary btn-lg" href="#/explore">Explore all ' + U.fint(S.N) + ' ' + U.icon('arrow', 2) + '</a>' +
      '<button type="button" class="btn btn-lg" id="hero-random">' + U.icon('shuffle', 1.8) + 'Random transient</button></div></div>' +
      '<div class="stats">' +
      stat(U.fint(S.N), 'Transients', span ? 'discovered ' + span : '') +
      stat(U.fint(srcN), 'Photometry sources', surveysPhrase().replace(/^./, function (c) { return c.toUpperCase(); })) +
      stat(U.fint(S.totalPoints), 'Photometry points', 'detections, forced photometry and limits') +
      stat(U.fint(S.nTyped), 'Spectroscopically typed', pct + '% carry a TNS classification') + '</div>' +
      '<section class="section" aria-labelledby="h-sky"><div class="section-head"><h2 id="h-sky">The sky</h2>' +
      '<p>Every transient on a Mollweide projection of the celestial sphere, east to the left. Narrow it by survey region or by what an object has; click a dot to open its lightcurve.</p></div>' +
      '<div class="card map-card"><div class="sky-tools" id="sky-tools"></div>' +
      '<div class="map-head"><div class="legend" id="sky-legend"></div><span class="muted" style="font-size:12px">RA 0h at centre · dotted line: Galactic plane</span></div>' +
      '<div class="skymap" id="skymap" role="img" aria-label="Sky map of transients"><div class="sk"></div></div></div></section>' +
      '<section class="section" aria-labelledby="h-disc"><div class="section-head"><h2 id="h-disc">Discoveries over time</h2>' +
      '<p>TNS discoveries per week. The shaded band is the EDP2 visit window. Click a week to explore it.</p></div>' +
      '<div class="card hist-card"><svg class="dhist" id="dhist" role="img" aria-label="Histogram of discovery dates by week"></svg></div></section>' +
      '<section class="section" aria-labelledby="h-src"><div class="section-head"><h2 id="h-src">Photometry sources</h2>' +
      '<p>Each lightcurve overlays every source below; filter the catalogue by any of them.</p></div><div class="src-grid">' + sourceCards() + '</div></section>' +
      '<section class="section" aria-labelledby="h-feat"><div class="section-head"><h2 id="h-feat">Well-sampled transients</h2>' +
      '<p>Spectroscopically typed supernovae with the most measurements across sources.</p></div><div class="feat-grid" id="feat">' + featuredCards() + '</div></section>' +
      '</div>';
    X.attachSuggest($('#hero-q'), $('#hero-suggest'), { limit: 7 });
    renderSkyTools();
    wireSkyTools();
    drawMap();                     // counts and legend now; the map itself once Plotly loads
    $('#hero-random').addEventListener('click', function () {
      var pool = [];
      for (var i = 0; i < S.N; i++) if (S.srcKeys.some(function (s) { return U.V(i, 'n_' + s) > 0; })) pool.push(i);
      if (!pool.length) pool = null;
      var i2 = pool ? pool[Math.floor(Math.random() * pool.length)] : Math.floor(Math.random() * S.N);
      X.go('#/object/' + encodeURIComponent(U.V(i2, 'name')));
    });
    drawHist();
    wireHist();
    H.rendered = true;
  }
  function stat(v, k, d) {
    return '<div class="card stat"><div class="v">' + v + '</div><div class="k">' + esc(k) + '</div>' + (d ? '<div class="d">' + esc(d) + '</div>' : '') + '</div>';
  }

  // ------------------------------------------------------------------ sources
  function sourceCards() {
    var src = S.meta.sources || {};
    return Object.keys(src).map(function (k) {
      var s = src[k], frac = S.N ? (s.n_objects || 0) / S.N : 0;
      return '<a class="card src-card" href="#/explore?src=' + encodeURIComponent(k) + '">' +
        '<div class="top">' + U.symbolSvg(U.srcSymbol(k), 'currentColor') + '<h3>' + esc(s.label || k) + '</h3></div>' +
        '<p>' + esc(s.desc || '') + '</p>' +
        '<div class="nums"><div><b>' + U.fint(s.n_objects) + '</b><span>transients</span></div><div><b>' + U.fint(s.n_points) + '</b><span>points</span></div></div>' +
        '<div class="cov" title="' + (frac * 100).toFixed(1) + '% of the catalogue"><i style="width:' + Math.max(1, frac * 100).toFixed(1) + '%"></i></div>' +
        '<span class="go">Explore ' + esc(U.srcShort(k)) + U.icon('arrow', 2) + '</span></a>';
    }).join('');
  }

  // ------------------------------------------------------------------ featured
  function pickFeatured() {
    var C = S.C, cand = [];
    for (var i = 0; i < S.N; i++) {
      var tot = 0, ns = 0;
      for (var a = 0; a < S.srcKeys.length; a++) { var n = S.rows[i][C['n_' + S.srcKeys[a]]] || 0; tot += n; if (n) ns++; }
      if (!tot) continue;
      var t = U.V(i, 'type');
      cand.push({ i: i, tot: tot, ns: ns, sn: U.isSN(t), typed: !!t, type: t || '', score: tot * (ns >= 2 ? 1.5 : 1) });
    }
    cand.sort(function (a, b) {
      return (b.sn - a.sn) || (b.typed - a.typed) || (b.score - a.score);
    });
    var out = [], shards = [], types = {};
    function take(c) {
      var sh = X.shardOf(c.i);
      if (shards.indexOf(sh) < 0 && shards.length >= 4) return false;
      if (shards.indexOf(sh) < 0) shards.push(sh);
      out.push(c.i); types[c.type] = (types[c.type] || 0) + 1;
      return true;
    }
    // first pass: at most two of any one type, so the row shows some variety
    for (var k = 0; k < cand.length && out.length < 8; k++) if ((types[cand[k].type] || 0) < 2) take(cand[k]);
    for (k = 0; k < cand.length && out.length < 8; k++) if (out.indexOf(cand[k].i) < 0) take(cand[k]);
    return out;
  }
  function featuredCards() {
    H.featured = pickFeatured();
    if (!H.featured.length) return '<p class="muted">No photometry in this build.</p>';
    return H.featured.map(function (i) {
      var t = U.V(i, 'type'), pts = S.srcKeys.filter(function (s) { return U.V(i, 'n_' + s) > 0; });
      return '<a class="card feat" href="#/object/' + encodeURIComponent(U.V(i, 'name')) + '">' +
        '<div class="row1"><h3><span class="pfx" style="font:500 13px var(--font);margin-right:6px">' + esc(U.V(i, 'prefix') || '') + '</span>' + esc(U.V(i, 'name')) + '</h3>' +
        (t ? '<span class="pill">' + esc(t) + '</span>' : '') + '</div>' +
        '<div class="meta">Discovered ' + esc(U.niceDate(U.V(i, 'disc_mjd'))) + (U.isNum(U.V(i, 'z')) ? ' · z = ' + U.fx(U.V(i, 'z'), 3) : '') + '</div>' +
        '<svg class="spark" data-spark="' + i + '" viewBox="0 0 300 64" preserveAspectRatio="none" aria-hidden="true"></svg>' +
        '<div class="foot">' + pts.map(function (s) { return '<span class="pill outline">' + esc(U.srcShort(s)) + ' ' + U.fint(U.V(i, 'n_' + s)) + '</span>'; }).join('') + '</div></a>';
    }).join('');
  }
  function loadSparks() {
    var shards = [];
    H.featured.forEach(function (i) { var s = X.shardOf(i); if (shards.indexOf(s) < 0) shards.push(s); });
    shards.forEach(function (sh) { X.loadShard(sh).then(drawSparks).catch(function () { /* sparkline stays empty */ }); });
  }
  function drawSparks() {
    H.featured.forEach(function (i) {
      var el = document.querySelector('svg[data-spark="' + i + '"]'), sh = S.shards[X.shardOf(i)];
      if (!el || !sh) return;
      var lcs = sh[U.V(i, 'name')] || {}, byFam = {};
      Object.keys(lcs).forEach(function (s) {
        var lc = lcs[s];
        for (var k = 0; k < lc.t.length; k++) {
          if (lc.k[k] === 2 || !U.isNum(lc.f[k])) continue;
          var f = U.bandFamily(lc.b[k]);
          (byFam[f] = byFam[f] || []).push([lc.t[k], lc.f[k]]);
        }
      });
      var fams = Object.keys(byFam).sort(function (a, b) { return byFam[b].length - byFam[a].length; }).slice(0, 2);
      if (!fams.length) return;
      var t0 = Infinity, t1 = -Infinity, fmax = 0, fmin = 0, NB = 48, lines = [];
      fams.forEach(function (f) { byFam[f].forEach(function (p) { if (p[0] < t0) t0 = p[0]; if (p[0] > t1) t1 = p[0]; }); });
      if (!(t1 > t0)) t1 = t0 + 1;
      fams.forEach(function (f) {
        var sum = new Array(NB).fill(0), cnt = new Array(NB).fill(0);
        byFam[f].forEach(function (p) { var b = Math.min(NB - 1, Math.floor((p[0] - t0) / (t1 - t0) * NB)); sum[b] += p[1]; cnt[b]++; });
        var pts = [];
        for (var b = 0; b < NB; b++) if (cnt[b]) { var v = sum[b] / cnt[b]; pts.push([b, v]); if (v > fmax) fmax = v; if (v < fmin) fmin = v; }
        lines.push({ f: f, pts: pts });
      });
      var span = (fmax - fmin) || 1, zeroY = 60 - (0 - fmin) / span * 54;
      el.innerHTML = '<line x1="0" x2="300" y1="' + zeroY.toFixed(1) + '" y2="' + zeroY.toFixed(1) + '" stroke="var(--line-strong)" stroke-width="1" vector-effect="non-scaling-stroke"/>' +
        lines.map(function (l) {
          return '<polyline fill="none" stroke="' + U.famColor(l.f) + '" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke" points="' +
            l.pts.map(function (p) { return (p[0] / (NB - 1) * 300).toFixed(1) + ',' + (60 - (p[1] - fmin) / span * 54).toFixed(1); }).join(' ') + '"/>';
        }).join('');
    });
  }

  // ------------------------------------------------------------------ discovery histogram (SVG)
  function drawHist() {
    var svg = $('#dhist');
    if (!svg) return;
    var W = Math.max(320, svg.clientWidth || 900), Hh = 200, ml = 40, mr = 8, mt = 22, mb = 26;
    var jd = S.C.disc_mjd, d0 = Math.floor(S.discMin), d1 = Math.ceil(S.discMax) + 1, bw = 7;
    var nb = Math.ceil((d1 - d0) / bw), h = new Array(nb).fill(0);
    for (var i = 0; i < S.N; i++) { var v = S.rows[i][jd]; if (U.isNum(v)) h[Math.min(nb - 1, Math.floor((v - d0) / bw))]++; }
    var mx = Math.max.apply(null, h.concat([1]));
    var st = mx > 400 ? 200 : mx > 200 ? 100 : mx > 80 ? 50 : mx > 40 ? 20 : mx > 16 ? 10 : 5;
    var top = Math.ceil(mx / st) * st, pw = W - ml - mr, ph = Hh - mt - mb;
    var x = function (m) { return ml + (m - d0) / (nb * bw) * pw; }, y = function (c) { return mt + ph - c / top * ph; };
    var out = '';
    for (var g = 0; g <= top; g += st) out += '<line class="grid" x1="' + ml + '" x2="' + (W - mr) + '" y1="' + y(g).toFixed(1) + '" y2="' + y(g).toFixed(1) + '"/><text x="' + (ml - 8) + '" y="' + (y(g) + 4).toFixed(1) + '" text-anchor="end">' + g + '</text>';
    var win = S.meta.window || {};
    if (U.isNum(win.mjd_start)) {
      var wx0 = Math.max(ml, x(win.mjd_start)), wx1 = Math.min(W - mr, x(win.mjd_end));
      out += '<rect class="win" x="' + wx0.toFixed(1) + '" y="' + mt + '" width="' + Math.max(0, wx1 - wx0).toFixed(1) + '" height="' + ph + '"/>' +
        '<text x="' + (wx0 + 6).toFixed(1) + '" y="' + (mt - 8) + '">EDP2 window · ' + esc(U.niceDate(win.mjd_start)) + ' – ' + esc(U.niceDate(win.mjd_end)) + '</text>';
    }
    var bpx = pw / nb, gap = bpx > 6 ? 2 : 1;
    for (var k = 0; k < nb; k++) {
      if (!h[k]) continue;
      var bx = ml + k * bpx + gap / 2, by = y(h[k]);
      out += '<rect class="bar" data-k="' + k + '" x="' + bx.toFixed(1) + '" y="' + by.toFixed(1) + '" width="' + Math.max(1, bpx - gap).toFixed(1) + '" height="' + (mt + ph - by).toFixed(1) + '" rx="1.5"/>';
    }
    out += '<line class="axis" x1="' + ml + '" x2="' + (W - mr) + '" y1="' + (mt + ph) + '" y2="' + (mt + ph) + '"/>';
    // month ticks
    var dt = U.mjdDate(d0), yy = dt.getUTCFullYear(), mm = dt.getUTCMonth() + 1, first = true;
    for (var n = 0; n < 40; n++) {
      var m = U.dateToMjd(yy, mm, 1);
      if (m > d0 + nb * bw) break;
      if (m >= d0) {
        var label = U.MONTHS[mm - 1] + (first || mm === 1 ? ' ' + yy : '');
        if (W < 560 && mm % 2 === 0 && !first) label = '';
        if (label) out += '<text x="' + x(m).toFixed(1) + '" y="' + (Hh - 6) + '" text-anchor="start">' + label + '</text>';
        out += '<line class="axis" x1="' + x(m).toFixed(1) + '" x2="' + x(m).toFixed(1) + '" y1="' + (mt + ph) + '" y2="' + (mt + ph + 5) + '"/>';
        first = false;
      }
      mm++; if (mm > 12) { mm = 1; yy++; }
    }
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + Hh);
    svg.innerHTML = out;
    H.hist = { d0: d0, bw: bw, h: h };
  }
  function wireHist() {
    var svg = $('#dhist');
    svg.addEventListener('mousemove', function (e) {
      var b = e.target.closest('rect.bar');
      if (!b) { U.hover.hide(); return; }
      var k = +b.getAttribute('data-k'), a = H.hist.d0 + k * H.hist.bw;
      U.hover.show('<div class="hc-t">' + U.fint(H.hist.h[k]) + ' ' + (H.hist.h[k] === 1 ? 'discovery' : 'discoveries') + '</div><div class="hc-m">Week of ' + esc(U.niceDate(a)) + '</div>', e.clientX, e.clientY);
    });
    svg.addEventListener('mouseleave', function () { U.hover.hide(); });
    svg.addEventListener('click', function (e) {
      var b = e.target.closest('rect.bar');
      if (!b) return;
      var k = +b.getAttribute('data-k'), a = H.hist.d0 + k * H.hist.bw;
      X.go('#/explore?disc=' + U.isoDate(a) + '..' + U.isoDate(a + H.hist.bw - 1));
    });
  }

  // ------------------------------------------------------------------ sky map: survey region + "has" chips
  // The region is all / WFD / DDF; chips AND together. Each maps onto Explore facets, so
  // "Open in Explore" carries the same selection over.
  H.sky = { reg: '', on: {} };
  var REGIONS = [['', 'All'], ['WFD', 'WFD'], ['DDF', 'DDF']];
  function hasData(i) {
    for (var a = 0; a < S.srcKeys.length; a++) if (U.V(i, 'n_' + S.srcKeys[a]) > 0) return true;
    return false;
  }
  function skyDefs() {
    if (H.defs) return H.defs;
    var d = [], team = S.isPrivate, offer = !S.isPrivate && !!S.meta.team_access;
    var ek = S.srcKeys.filter(function (k) { return /^edp2_/.test(k); });
    if (U.has('alert_ids')) d.push({ id: 'rid', label: 'Rubin alert diaObjectId', test: function (i) { return X.hasRid(i, 'alert'); }, p: [['rid', 'yes']] });
    if (team && U.has('edp2_id')) d.push({ id: 'dp2', label: 'DP2 diaObjectId', priv: true, test: X.F.isMatched, p: [['em', '1']] });
    else if (offer) d.push({ id: 'dp2', label: 'DP2 diaObjectId', locked: true });
    if (team && ek.length) {
      d.push({ id: 'edp2', label: 'EDP2 photometry', priv: true, test: function (i) { return ek.some(function (k) { return U.V(i, 'n_' + k) > 0; }); },
        p: ek.map(function (k) { return ['src', k]; }).concat([['srcmode', 'any']]) });
    } else if (offer) d.push({ id: 'edp2', label: 'EDP2 photometry', locked: true });
    if (U.has('debass')) d.push({ id: 'debass', label: 'DEBASS target', test: function (i) { return !!U.V(i, 'debass'); }, p: [['debass', 'FINISHED'], ['debass', 'YES']] });
    d.push({ id: 'ia', label: 'SN Ia', test: function (i) { return U.classGroup(U.V(i, 'type')) === 'Ia'; }, p: [['cg', 'Ia']] });
    d.push({ id: 'lc', label: 'Lightcurve data', test: hasData, p: S.srcKeys.map(function (k) { return ['src', k]; }).concat([['srcmode', 'any']]) });
    H.defs = d;
    return d;
  }
  function isWfd(i) { return (U.V(i, 'region') || 'WFD') === 'WFD'; }
  // One pass: the selection, and what each chip and region option would give if chosen.
  function skyEval() {
    var defs = skyDefs().filter(function (d) { return !d.locked; });
    var on = defs.filter(function (d) { return H.sky.on[d.id]; }), reg = U.has('region') ? H.sky.reg : '';
    var sel = [], other = [], chipN = {}, regN = { '': 0, WFD: 0, DDF: 0 };
    defs.forEach(function (d) { chipN[d.id] = 0; });
    for (var i = 0; i < S.N; i++) {
      var ok = true;
      for (var a = 0; a < on.length && ok; a++) ok = on[a].test(i);
      var w = isWfd(i), inReg = !reg || (reg === 'WFD') === w;
      if (ok) {
        regN['']++; regN[w ? 'WFD' : 'DDF']++;
        if (inReg) for (var b = 0; b < defs.length; b++) if (H.sky.on[defs[b].id] || defs[b].test(i)) chipN[defs[b].id]++;
      }
      if (ok && inReg) sel.push(i); else other.push(i);
    }
    return { sel: sel, other: other, chipN: chipN, regN: regN, active: on.length > 0 || !!reg };
  }
  function skyLink() {
    var p = new URLSearchParams(), on = skyDefs().filter(function (d) { return H.sky.on[d.id] && !d.locked; });
    var edp2 = on.some(function (d) { return d.id === 'edp2'; });   // EDP2 photometry already implies lightcurve data
    on.forEach(function (d) {
      if (d.id === 'lc' && edp2) return;
      d.p.forEach(function (kv) { if (!(kv[0] === 'srcmode' && p.has('srcmode'))) p.append(kv[0], kv[1]); });
    });
    if (H.sky.reg === 'WFD') p.append('reg', 'WFD');
    else if (H.sky.reg === 'DDF') (X.F.ddfFields || []).forEach(function (f) { p.append('reg', f); });
    return '#/explore?' + p.toString();
  }
  function renderSkyTools() {
    var h = '';
    if (U.has('region')) {
      h += '<span class="seg sm" role="radiogroup" aria-label="Survey region">' + REGIONS.map(function (r) {
        return '<label title="' + (r[0] === 'DDF' ? 'LSST Deep Drilling Fields: ' + esc((X.F.ddfFields || []).join(', ')) : r[0] === 'WFD' ? 'Outside the Deep Drilling Fields' : 'Every region') + '">' +
          '<input type="radio" name="skyreg" value="' + r[0] + '"' + (H.sky.reg === r[0] ? ' checked' : '') + '><span>' + r[1] +
          '<b class="n" data-regn="' + (r[0] || 'all') + '"></b></span></label>';
      }).join('') + '</span>';
    }
    h += '<span class="tchips" role="group" aria-label="Only transients with">' + skyDefs().map(function (d) {
      if (d.locked) return '<button type="button" class="tchip locked" data-sky-lock title="Unlock team access to filter by Rubin DP2 data">' + U.icon('lock', 2) + esc(d.label) + '</button>';
      return '<button type="button" class="tchip' + (d.priv ? ' priv' : '') + '" data-sky="' + d.id + '" aria-pressed="' + (H.sky.on[d.id] ? 'true' : 'false') + '">' +
        esc(d.label) + '<span class="n"></span></button>';
    }).join('') + '</span>';
    $('#sky-tools').innerHTML = h;
  }
  function wireSkyTools() {
    var box = $('#sky-tools');
    box.addEventListener('change', function (e) { if (e.target.name === 'skyreg') { H.sky.reg = e.target.value; drawMap(); } });
    box.addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      if (b.hasAttribute('data-sky-lock')) { if (X.team && X.team.openDialog) X.team.openDialog(); return; }
      var id = b.getAttribute('data-sky');
      if (H.sky.on[id]) delete H.sky.on[id]; else H.sky.on[id] = true;
      b.setAttribute('aria-pressed', H.sky.on[id] ? 'true' : 'false');
      drawMap();
    });
    $('#sky-legend').addEventListener('click', function (e) {
      if (!e.target.closest('[data-sky-clear]')) return;
      H.sky = { reg: '', on: {} };
      renderSkyTools();
      drawMap();
    });
  }
  function drawMap() {
    var ev = skyEval(), legend, layers;
    U.$all('[data-sky]').forEach(function (b) {
      var n = ev.chipN[b.getAttribute('data-sky')] || 0;
      b.querySelector('.n').textContent = U.fint(n);
      b.classList.toggle('zero', !n && b.getAttribute('aria-pressed') !== 'true');
    });
    U.$all('[data-regn]').forEach(function (b) { var k = b.getAttribute('data-regn'); b.textContent = U.fint(ev.regN[k === 'all' ? '' : k]); });
    if (ev.active) {
      legend = '<span class="li"><span class="dot" style="background:var(--dot-data)"></span>Selected · ' + U.fint(ev.sel.length) + '</span>' +
        '<span class="li"><span class="dot" style="background:var(--dot-none)"></span>Other transients · ' + U.fint(ev.other.length) + '</span>' +
        (ev.sel.length ? '<a class="li go" href="' + esc(skyLink()) + '">Open ' + U.fint(ev.sel.length) + ' in Explore' + U.icon('arrow', 2) + '</a>' : '') +
        '<button type="button" class="linkbtn" data-sky-clear>Clear</button>';
      layers = [{ idx: ev.other, dot: '--dot-none', size: 3.2, opacity: 0.9 }, { idx: ev.sel, dot: '--dot-data', size: X.skySize(ev.sel.length), opacity: 0.92 }];
    } else {
      var yes = [], no = [];
      for (var i = 0; i < S.N; i++) (hasData(i) ? yes : no).push(i);
      legend = '<span class="li"><span class="dot" style="background:var(--dot-data)"></span>With lightcurve data · ' + U.fint(yes.length) + '</span>' +
        '<span class="li"><span class="dot" style="background:var(--dot-none)"></span>No photometry in this build · ' + U.fint(no.length) + '</span>';
      layers = [{ idx: no, dot: '--dot-none', size: 3.4, opacity: 0.95 }, { idx: yes, dot: '--dot-data', size: 4.4, opacity: 0.9 }];
    }
    $('#sky-legend').innerHTML = legend;
    if (!window.Plotly) return;
    X.skyMap($('#skymap'), layers);
    H.mapDrawn = true;
  }

  var onResize = U.debounce(function () { if (S.view === 'home' && H.rendered) drawHist(); }, 150);
  window.addEventListener('resize', onResize);

  X.views.home = {
    show: function () {
      document.title = 'TNS EDP2 Explorer';
      if (!H.rendered) {
        render();
        U.idle(loadSparks);
        X.ensurePlotly().then(drawMap).catch(function () {
          var el = $('#skymap');
          if (el) el.innerHTML = '<div class="lc-msg">The sky map needs Plotly from cdn.jsdelivr.net, which did not load.</div>';
        });
      } else {
        drawHist();
        if (window.Plotly && H.mapDrawn) window.Plotly.Plots.resize($('#skymap'));
      }
    },
    onTheme: function () { if (H.mapDrawn) drawMap(); drawSparks(); }
  };
})();
