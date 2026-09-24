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
      (S.isPrivate ? ' This private build adds proprietary Rubin DP2 catalogue photometry.' : '') + '</p>' +
      '<div class="hero-search"><div class="spot"><div class="spot-field">' + U.icon('search', 2) +
      '<input type="search" id="hero-q" placeholder="Search a TNS name, internal name or “RA Dec”" aria-label="Search transients" autocomplete="off" spellcheck="false"></div>' +
      '<ul class="suggest" id="hero-suggest" hidden></ul></div></div>' +
      '<div class="hero-actions"><a class="btn btn-primary btn-lg" href="#/explore">Explore all ' + U.fint(S.N) + ' ' + U.icon('arrow', 2) + '</a>' +
      '<button type="button" class="btn btn-lg" id="hero-random">' + U.icon('shuffle', 1.8) + 'Random transient</button></div></div>' +
      '<div class="stats">' +
      stat(U.fint(S.N), 'Transients', span ? 'discovered ' + span : '') +
      stat(U.fint(srcN), 'Photometry sources', surveysPhrase().replace(/^./, function (c) { return c.toUpperCase(); })) +
      stat(U.fint(S.totalPoints), 'Photometry points', 'detections, forced photometry and limits') +
      stat(U.fint(S.nTyped), 'Spectroscopically typed', pct + '% carry a TNS classification') + '</div>' +
      '<section class="section" aria-labelledby="h-sky"><div class="section-head"><h2 id="h-sky">The sky</h2>' +
      '<p>Every transient on a Mollweide projection of the celestial sphere, east to the left. Click one to open its lightcurve.</p></div>' +
      '<div class="card map-card"><div class="map-head"><div class="legend" id="sky-legend"></div><span class="muted" style="font-size:12px">RA 0h at centre · dotted line: Galactic plane</span></div>' +
      '<div class="skymap" id="skymap" role="img" aria-label="Sky map of all transients"><div class="sk"></div></div></div></section>' +
      '<section class="section" aria-labelledby="h-disc"><div class="section-head"><h2 id="h-disc">Discoveries over time</h2>' +
      '<p>TNS discoveries per week. The shaded band is the EDP2 visit window. Click a week to explore it.</p></div>' +
      '<div class="card hist-card"><svg class="dhist" id="dhist" role="img" aria-label="Histogram of discovery dates by week"></svg></div></section>' +
      '<section class="section" aria-labelledby="h-src"><div class="section-head"><h2 id="h-src">Photometry sources</h2>' +
      '<p>Each lightcurve overlays every source below; filter the catalogue by any of them.</p></div><div class="src-grid">' + sourceCards() + '</div></section>' +
      '<section class="section" aria-labelledby="h-feat"><div class="section-head"><h2 id="h-feat">Well-sampled transients</h2>' +
      '<p>Spectroscopically typed supernovae with the most measurements across sources.</p></div><div class="feat-grid" id="feat">' + featuredCards() + '</div></section>' +
      '</div>';
    X.attachSuggest($('#hero-q'), $('#hero-suggest'), { limit: 7 });
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

  // ------------------------------------------------------------------ sky map (Plotly scattergeo, Mollweide)
  function lonOf(ra) { return ((-ra % 360) + 540) % 360 - 180; }   // RA 0h at centre, east to the left
  function galacticPlane() {
    var r = Math.PI / 180, raG = 192.85948 * r, decG = 27.12825 * r, lN = 122.93192 * r, lon = [], lat = [], prev = null;
    for (var l = 0; l <= 360; l += 2) {
      var dl = lN - l * r;
      var dec = Math.asin(Math.cos(decG) * Math.cos(dl));
      var ra = raG + Math.atan2(Math.sin(dl), -Math.sin(decG) * Math.cos(dl));
      var lo = lonOf((ra / r + 360) % 360);
      if (prev !== null && Math.abs(lo - prev) > 180) { lon.push(null); lat.push(null); }
      lon.push(lo); lat.push(dec / r); prev = lo;
    }
    return { lon: lon, lat: lat };
  }
  function drawMap() {
    var el = $('#skymap');
    if (!el || !window.Plotly) return;
    var sk = el.querySelector(':scope > .sk');
    if (sk) sk.remove();
    var C = S.C, yes = { lon: [], lat: [], i: [] }, no = { lon: [], lat: [], i: [] };
    for (var i = 0; i < S.N; i++) {
      var r = S.rows[i], has = false;
      for (var a = 0; a < S.srcKeys.length; a++) if (r[C['n_' + S.srcKeys[a]]] > 0) { has = true; break; }
      var t = has ? yes : no;
      t.lon.push(lonOf(r[C.ra])); t.lat.push(r[C.dec]); t.i.push(i);
    }
    var line = U.cssVar('--line'), strong = U.cssVar('--line-strong'), muted = U.cssVar('--muted');
    var gp = galacticPlane();
    var labLon = [], labLat = [], labTxt = [];
    [0, 4, 8, 16, 20].forEach(function (h) { labLon.push(lonOf(h * 15)); labLat.push(3); labTxt.push(h + 'h'); });
    [-60, -30, 30, 60].forEach(function (d) { labLon.push(4); labLat.push(d); labTxt.push((d > 0 ? '+' : '−') + Math.abs(d) + '°'); });
    var traces = [
      { type: 'scattergeo', mode: 'lines', lon: gp.lon, lat: gp.lat, line: { color: muted, width: 1, dash: 'dot' }, hoverinfo: 'skip', connectgaps: false },
      { type: 'scattergeo', mode: 'text', lon: labLon, lat: labLat, text: labTxt, textfont: { family: 'Inter, sans-serif', size: 10, color: muted }, hoverinfo: 'skip', textposition: 'middle right' },
      { type: 'scattergeo', mode: 'markers', lon: no.lon, lat: no.lat, customdata: no.i, hoverinfo: 'none',
        marker: { size: 3.4, color: U.cssVar('--dot-none'), opacity: 0.95, line: { width: 0 } } },
      { type: 'scattergeo', mode: 'markers', lon: yes.lon, lat: yes.lat, customdata: yes.i, hoverinfo: 'none',
        marker: { size: 4.4, color: U.cssVar('--dot-data'), opacity: 0.9, line: { width: 0 } } }
    ];
    var layout = {
      margin: { l: 0, r: 0, t: 0, b: 0 }, paper_bgcolor: 'rgba(0,0,0,0)', showlegend: false, dragmode: false,
      geo: { projection: { type: 'mollweide' }, bgcolor: 'rgba(0,0,0,0)', showland: false, showcoastlines: false, showocean: false,
        showlakes: false, showrivers: false, showcountries: false, showsubunits: false, showframe: true, framecolor: strong, framewidth: 1,
        lonaxis: { showgrid: true, gridcolor: line, gridwidth: 1, dtick: 30 }, lataxis: { showgrid: true, gridcolor: line, gridwidth: 1, dtick: 30 } },
      font: { family: 'Inter, sans-serif' }
    };
    window.Plotly.react(el, traces, layout, { displayModeBar: false, responsive: true, scrollZoom: false });
    $('#sky-legend').innerHTML = '<span class="li"><span class="dot" style="background:var(--dot-data)"></span>With lightcurve data · ' + U.fint(yes.i.length) + '</span>' +
      '<span class="li"><span class="dot" style="background:var(--dot-none)"></span>No photometry in this build · ' + U.fint(no.i.length) + '</span>';
    if (!H.mapDrawn) {
      el.on('plotly_hover', function (ev) {
        var p = ev.points && ev.points[0];
        if (!p || p.customdata == null) return;
        var i = p.customdata, t = U.V(i, 'type');
        var pts = S.srcKeys.filter(function (s) { return U.V(i, 'n_' + s) > 0; }).map(function (s) { return U.srcShort(s); });
        U.hover.show('<div class="hc-t"><span class="pfx">' + esc(U.V(i, 'prefix') || '') + '</span>' + esc(U.V(i, 'name')) + '</div>' +
          '<div class="hc-r">' + (t ? esc(t) + ' · ' : '') + esc(U.niceDate(U.V(i, 'disc_mjd'))) + '</div>' +
          '<div class="hc-m">' + (pts.length ? esc(pts.join(' · ')) : 'no photometry') + '</div>', ev.event.clientX, ev.event.clientY);
        el.style.cursor = 'pointer';
      });
      el.on('plotly_unhover', function () { U.hover.hide(); el.style.cursor = ''; });
      el.on('plotly_click', function (ev) {
        var p = ev.points && ev.points[0];
        if (p && p.customdata != null) X.go('#/object/' + encodeURIComponent(U.V(p.customdata, 'name')));
      });
    }
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
