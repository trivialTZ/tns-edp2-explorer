/* TNS x EDP2 Explorer — shared sky map (Plotly scattergeo, Mollweide), used by Home and Explore. */
(function () {
  'use strict';
  var X = window.TNSXApp, S = X.S, U = X.U;
  var esc = U.esc, gp = null;

  function lonOf(ra) { return ((-ra % 360) + 540) % 360 - 180; }   // RA 0h at centre, east to the left
  function galacticPlane() {
    if (gp) return gp;
    var r = Math.PI / 180, raG = 192.85948 * r, decG = 27.12825 * r, lN = 122.93192 * r, lon = [], lat = [], prev = null;
    for (var l = 0; l <= 360; l += 2) {
      var dl = lN - l * r;
      var dec = Math.asin(Math.cos(decG) * Math.cos(dl));
      var ra = raG + Math.atan2(Math.sin(dl), -Math.sin(decG) * Math.cos(dl));
      var lo = lonOf((ra / r + 360) % 360);
      if (prev !== null && Math.abs(lo - prev) > 180) { lon.push(null); lat.push(null); }
      lon.push(lo); lat.push(dec / r); prev = lo;
    }
    gp = { lon: lon, lat: lat };
    return gp;
  }
  function hoverHtml(i) {
    var t = U.V(i, 'type'), db = U.V(i, 'debass'), rg = U.V(i, 'region');
    var pts = S.srcKeys.filter(function (s) { return U.V(i, 'n_' + s) > 0; }).map(function (s) { return U.srcShort(s); });
    var tags = [];
    if (rg && rg !== 'WFD') tags.push(U.regionLabel(rg));
    if (db) tags.push('DEBASS · ' + (X.K.DEBASS_LABEL[db] || db));
    return '<div class="hc-t"><span class="pfx">' + esc(U.V(i, 'prefix') || '') + '</span>' + esc(U.V(i, 'name')) + '</div>' +
      '<div class="hc-r">' + (t ? esc(t) + ' · ' : '') + esc(U.niceDate(U.V(i, 'disc_mjd'))) + '</div>' +
      (tags.length ? '<div class="hc-r">' + esc(tags.join(' · ')) + '</div>' : '') +
      '<div class="hc-m">' + (pts.length ? esc(pts.join(' · ')) : 'no photometry') + '</div>';
  }

  // Draw catalogue rows on `el` in layers, bottom to top:
  //   [{idx: [row indices], dot: CSS colour token, size: px, opacity}]
  // Hovering a dot shows the transient; clicking opens it.
  X.skyMap = function (el, layers) {
    if (!el || !window.Plotly) return;
    var sk = el.querySelector(':scope > .sk');
    if (sk) sk.remove();
    var jra = S.C.ra, jdec = S.C.dec;
    var line = U.cssVar('--line'), strong = U.cssVar('--line-strong'), muted = U.cssVar('--muted');
    var g = galacticPlane(), labLon = [], labLat = [], labTxt = [];
    [0, 4, 8, 16, 20].forEach(function (h) { labLon.push(lonOf(h * 15)); labLat.push(3); labTxt.push(h + 'h'); });
    [-60, -30, 30, 60].forEach(function (d) { labLon.push(4); labLat.push(d); labTxt.push((d > 0 ? '+' : '−') + Math.abs(d) + '°'); });
    var traces = [
      { type: 'scattergeo', mode: 'lines', lon: g.lon, lat: g.lat, line: { color: muted, width: 1, dash: 'dot' }, hoverinfo: 'skip', connectgaps: false },
      { type: 'scattergeo', mode: 'text', lon: labLon, lat: labLat, text: labTxt, textfont: { family: 'Inter, sans-serif', size: 10, color: muted }, hoverinfo: 'skip', textposition: 'middle right' }
    ];
    layers.forEach(function (L) {
      var n = L.idx.length, lon = new Array(n), lat = new Array(n);
      for (var k = 0; k < n; k++) { var r = S.rows[L.idx[k]]; lon[k] = lonOf(r[jra]); lat[k] = r[jdec]; }
      traces.push({ type: 'scattergeo', mode: 'markers', lon: lon, lat: lat, customdata: L.idx, hoverinfo: 'none',
        marker: { size: L.size, color: U.cssVar(L.dot), opacity: L.opacity, line: { width: 0 } } });
    });
    var layout = {
      margin: { l: 0, r: 0, t: 0, b: 0 }, paper_bgcolor: 'rgba(0,0,0,0)', showlegend: false, dragmode: false,
      geo: { projection: { type: 'mollweide' }, bgcolor: 'rgba(0,0,0,0)', showland: false, showcoastlines: false, showocean: false,
        showlakes: false, showrivers: false, showcountries: false, showsubunits: false, showframe: true, framecolor: strong, framewidth: 1,
        lonaxis: { showgrid: true, gridcolor: line, gridwidth: 1, dtick: 30 }, lataxis: { showgrid: true, gridcolor: line, gridwidth: 1, dtick: 30 } },
      font: { family: 'Inter, sans-serif' }
    };
    window.Plotly.react(el, traces, layout, { displayModeBar: false, responsive: true, scrollZoom: false });
    if (el.getAttribute('data-sky-wired')) return;
    el.setAttribute('data-sky-wired', '1');
    el.on('plotly_hover', function (ev) {
      var p = ev.points && ev.points[0];
      if (!p || p.customdata == null) return;
      U.hover.show(hoverHtml(p.customdata), ev.event.clientX, ev.event.clientY);
      el.style.cursor = 'pointer';
    });
    el.on('plotly_unhover', function () { U.hover.hide(); el.style.cursor = ''; });
    el.on('plotly_click', function (ev) {
      var p = ev.points && ev.points[0];
      if (p && p.customdata != null) X.go('#/object/' + encodeURIComponent(U.V(p.customdata, 'name')));
    });
  };
  // Marker size for the highlighted layer: small selections get bigger dots so they stand out.
  X.skySize = function (n) { return n < 60 ? 7.5 : n < 400 ? 5.6 : 4.4; };
})();
