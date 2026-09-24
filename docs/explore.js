/* TNS x EDP2 Explorer — Explore view (CELLxGENE-style faceted browser). */
(function () {
  'use strict';
  var X = window.TNSXApp, S = X.S, U = X.U, K = X.K, F;
  var $ = U.$, $all = U.$all, esc = U.esc;
  var E = { page: 0, pageSize: 100, built: false, ptsTab: null, open: {}, facetMore: {}, find: {} };
  var PAGE_SIZES = [50, 100, 250, 500];
  var HW = 280, HH = 44;   // facet histogram viewBox
  var COLS_KEY = 'tnsx-cols-v3';   // v3: Rubin lead and metaDEBASS columns; older saved choices would hide them

  // ------------------------------------------------------------------ columns
  function columnDefs() {
    var c = [{ id: 'name', label: 'Name', fixed: true, always: true }];
    // Rubin IDs right after Name; the DP2 catalogue ID only exists in private or unlocked mode.
    if (U.has('alert_ids')) c.push({ id: 'alert_ids', label: 'Rubin diaObjectId', sub: 'alert stream', on: true, mono: true, title: K.RID_LABEL.alert });
    if (S.isPrivate && U.has('edp2_id')) c.push({ id: 'edp2_id', label: 'Rubin DP2 diaObjectId', sub: 'DP2 catalogue', on: true, priv: true, mono: true, title: K.RID_LABEL.dp2 });
    c.push({ id: '_sep', label: 'Separation', sub: 'arcsec', num: true, cone: true, always: true });
    c.push({ id: 'type', label: 'Type', on: true }, { id: 'z', label: 'Redshift', num: true, on: true },
      { id: 'disc_mjd', label: 'Discovered', sub: 'UTC', on: true }, { id: 'disc_mag', label: 'Disc. mag', sub: 'filter', num: true, on: true },
      { id: 'group', label: 'Group', on: true });
    if (U.has('region')) c.push({ id: 'region', label: 'Region', sub: 'WFD / DDF', on: true, title: 'DDF: covered by visits aimed at an LSST Deep Drilling Field; WFD: everything else' });
    if (U.has('debass')) c.push({ id: 'debass', label: 'DEBASS', on: true, title: 'DEBASS follow-up status (sheet “Following?” = FINISHED or YES)' });
    if (U.has('n_spec')) c.push({ id: 'n_spec', label: 'Spectra', num: true, on: true });
    if (U.has('mdb_call')) c.push({ id: 'mdb_call', label: 'metaDEBASS', sub: 'latest call', on: true,
      title: 'Latest metaDEBASS fusion v11 call and its P(SN-like) (research output, not a classification)' });
    if (U.has('lead_alert')) c.push({ id: 'lead_alert', label: 'Rubin lead', sub: 'alerts, days', num: true, on: true,
      title: 'TNS discovery − first positive Rubin alert detection (> 0: Rubin saw it first). “Rubin”: the TNS discovery was made in Rubin data' });
    S.srcKeys.forEach(function (s) { c.push({ id: 'n_' + s, label: U.srcShort(s), sub: 'measurements', num: true, src: s, on: true, title: U.srcLabel(s) }); });
    if (U.has('n_visits_active')) c.push({ id: 'n_visits_active', label: 'Pointings', sub: 'active / all', num: true, on: true,
      title: 'dp2.Visit centres within 2.1° during [discovery − 30, + 100] d / at any time' });
    if (U.has('host_status')) {
      c.push({ id: 'host_status', label: 'Host', sub: 'diagnostic', on: true, title: 'Host association and SED fit status (diagnostic, not for science use)' },
        { id: 'host_z', label: 'Host z', num: true, on: false }, { id: 'host_logm_p50', label: 'Host log M*', num: true, on: false },
        { id: 'host_sep', label: 'Host sep.', sub: 'arcsec', num: true, on: false }, { id: 'host_ddlr', label: 'Host d_DLR', num: true, on: false },
        { id: 'host_fit', label: 'Host fit', on: false }, { id: 'host_id', label: 'Host ID', mono: true, on: false });
    }
    if (S.isPrivate) {
      if (U.has('edp2_sep')) c.push({ id: 'edp2_sep', label: 'EDP2 sep.', sub: 'arcsec', num: true, on: true, priv: true });
      if (U.has('edp2_ndia')) c.push({ id: 'edp2_ndia', label: 'EDP2 nDia', num: true, on: true, priv: true });
      if (U.has('edp2_lead')) c.push({ id: 'edp2_lead', label: 'EDP2 lead', sub: 'days', num: true, on: true, priv: true });
      if (U.has('edp2_tc')) c.push({ id: 'edp2_tc', label: 'EDP2 time-consistent', on: false, priv: true });
      if (U.has('edp2_coadd_bands')) c.push({ id: 'edp2_coadd_bands', label: 'EDP2 coadd', sub: 'bands', on: true, priv: true, title: 'Bands with a DP2 deep coadd at this position' });
    }
    c.push({ id: 'ra', label: 'RA', sub: 'deg', num: true, on: false, mono: true }, { id: 'dec', label: 'Dec', sub: 'deg', num: true, on: false, mono: true },
      { id: 'internal', label: 'Internal names', on: false });
    c.push({ id: '_ranges', label: 'First–last MJD under counts', pseudo: true, on: false });
    return c;
  }
  function visibleCols() {
    var chosen = F.state.cols || (U.lsGet(COLS_KEY) ? U.lsGet(COLS_KEY).split(',') : null);
    return E.cols.filter(function (c) {
      if (c.cone) return !!(F.last && F.last.sep);
      if (c.always) return true;
      return chosen ? chosen.indexOf(c.id) >= 0 : c.on;
    });
  }
  function colOn(id) { return visibleCols().some(function (c) { return c.id === id; }); }

  // ------------------------------------------------------------------ build (once)
  function facetShell(id, label, body, open, extraClass) {
    var isOpen = E.open[id] !== undefined ? E.open[id] : open;
    return '<div class="facet ' + (extraClass || '') + '" data-facet="' + esc(id) + '">' +
      '<button type="button" class="facet-h" aria-expanded="' + (isOpen ? 'true' : 'false') + '" aria-controls="fb-' + esc(id) + '">' +
      '<span>' + esc(label) + '</span><span class="ct" hidden></span>' + U.icon('chev', 2).replace('<svg', '<svg class="chev"') + '</button>' +
      '<div class="facet-b" id="fb-' + esc(id) + '"' + (isOpen ? '' : ' hidden') + '>' + body + '</div></div>';
  }
  function catBody(d) {
    var h = '';
    if (d.id === 'src') {
      h += '<div class="facet-tools"><span class="muted" style="font-size:12px" id="lbl-srcmode">Match</span>' +
        '<span class="seg sm" role="radiogroup" aria-labelledby="lbl-srcmode">' +
        '<label><input type="radio" name="srcmode" value="all"><span>all selected</span></label>' +
        '<label><input type="radio" name="srcmode" value="any"><span>any</span></label></span></div>';
    }
    if (d.search && d.values.length > 10) {
      h += '<input type="search" class="input input-sm facet-find" data-find="' + d.id + '" placeholder="Search ' + d.values.length + ' values" aria-label="Search ' + esc(d.label) + ' values">';
    }
    h += '<div class="opt-list" role="group" aria-label="' + esc(d.label) + '">' + d.values.map(function (v, k) {
      return '<label class="opt" data-k="' + k + '"><input type="checkbox" data-cat="' + d.id + '" value="' + esc(v.v) + '">' +
        (v.sym ? U.symbolSvg(v.sym, 'currentColor') : '') + '<span class="l" title="' + esc(v.label) + '">' + esc(v.label) + '</span><span class="n">0</span></label>';
    }).join('') + '</div>';
    if (d.show && d.values.length > d.show) h += '<button type="button" class="linkbtn facet-more" data-more="' + d.id + '"></button>';
    if (d.note) h += '<p class="facet-note">' + esc(d.note) + '</p>';
    return h;
  }
  function numWidget(d, withTitle) {
    var last = d.edges.length - 1, ph = d.type === 'date' ? 'YYYY-MM-DD' : '';
    return '<div class="nfacet" data-num="' + d.id + '">' + (withTitle ? '<p class="muted" style="font-size:12px;margin:0 0 6px">' + esc(d.label) + '</p>' : '') +
      '<svg class="hist" viewBox="0 0 ' + HW + ' ' + HH + '" preserveAspectRatio="none" aria-hidden="true"></svg>' +
      '<div class="range"><div class="track"></div><div class="fill"></div>' +
      '<input type="range" min="0" max="' + last + '" step="1" value="0" data-lo="' + d.id + '" aria-label="Minimum ' + esc(d.label.toLowerCase()) + '">' +
      '<input type="range" min="0" max="' + last + '" step="1" value="' + last + '" data-hi="' + d.id + '" aria-label="Maximum ' + esc(d.label.toLowerCase()) + '"></div>' +
      '<div class="nf-inputs"><input class="input input-sm num" data-min="' + d.id + '" placeholder="' + (ph || 'min') + '" aria-label="' + esc(d.label) + ' from">' +
      '<span class="dash">–</span><input class="input input-sm num" data-max="' + d.id + '" placeholder="' + (ph || 'max') + '" aria-label="' + esc(d.label) + ' to"></div>' +
      '<div class="nf-read"><span data-read="' + d.id + '"></span><span data-inrange="' + d.id + '"></span></div>' +
      (d.note ? '<p class="facet-note">' + esc(d.note) + '</p>' : '') + '</div>';
  }
  function buildRail() {
    var h = '<div class="rail-search">' + U.icon('search', 2) + '<input type="search" class="input" id="f-q" placeholder="Name, internal name or Rubin ID" aria-label="Filter by TNS name, internal name or Rubin diaObjectId (6+ digits)" autocomplete="off" spellcheck="false"></div>';
    var cat = F.byId, num = F.byId;
    h += facetShell('type', cat.type.label, catBody(cat.type), true);
    h += facetShell('cg', cat.cg.label, catBody(cat.cg), false);
    h += facetShell('pre', cat.pre.label, catBody(cat.pre), true);
    h += facetShell('src', cat.src.label, catBody(cat.src), true);
    ['reg', 'debass', 'rid'].forEach(function (id) { if (cat[id]) h += facetShell(id, cat[id].label, catBody(cat[id]), cat[id].open); });
    ['mdb', 'clf'].forEach(function (id) { if (cat[id]) h += facetShell(id, cat[id].label, catBody(cat[id]), false); });
    if (cat.rf) h += facetShell('rf', cat.rf.label, catBody(cat.rf) + (num.alead ? '<div style="height:14px"></div>' + numWidget(num.alead, true) : ''), false);
    var pts = F.num.filter(function (d) { return d.group === 'pts'; });
    if (pts.length) {
      E.ptsTab = E.ptsTab || pts[0].id;
      var tabs = '<div class="seg sm tabs-mini" role="radiogroup" aria-label="Source">' + pts.map(function (d) {
        return '<label><input type="radio" name="ptstab" value="' + d.id + '"' + (d.id === E.ptsTab ? ' checked' : '') + '><span data-tab="' + d.id + '">' + esc(d.short) + '</span></label>';
      }).join('') + '</div>';
      h += facetShell('pts', 'Measurements per source', tabs + pts.map(function (d) {
        return '<div data-ptspane="' + d.id + '"' + (d.id === E.ptsTab ? '' : ' hidden') + '>' + numWidget(d) + '</div>';
      }).join('') + '<p class="facet-note">Detections and forced photometry; upper limits are not counted.</p>', false);
    }
    h += facetShell('disc', num.disc.label, numWidget(num.disc), true);
    h += facetShell('mag', num.mag.label, numWidget(num.mag), false);
    h += facetShell('z', num.z.label, numWidget(num.z), false);
    if (cat.spec) h += facetShell('spec', cat.spec.label, catBody(cat.spec), false);
    h += facetShell('grp', cat.grp.label, catBody(cat.grp), false);
    h += facetShell('pos', 'Position', '<div class="pos-grid">' +
      '<label for="f-ra">RA</label><input class="input input-sm" id="f-ra" data-pos="ra" placeholder="deg or hh:mm:ss" autocomplete="off">' +
      '<label for="f-dec">Dec</label><input class="input input-sm" id="f-dec" data-pos="dec" placeholder="deg or ±dd:mm:ss" autocomplete="off">' +
      '<label for="f-rad">Radius</label><input class="input input-sm" id="f-rad" data-pos="rad" placeholder="' + K.DEFAULT_CONE_AS + ' arcsec" inputmode="decimal" autocomplete="off"></div>' +
      '<p class="facet-note" id="cone-hint" aria-live="polite">Cone search. Paste “RA Dec” into the RA box to fill both.</p>', false);
    if (num.nva) h += facetShell('nva', num.nva.label, numWidget(num.nva), false);
    if (cat.hst) {
      h += '<p class="rail-group">Host galaxy <span class="pill diag">diagnostic</span></p>';
      ['hst', 'hfit'].forEach(function (id) { if (cat[id]) h += facetShell(id, cat[id].label, catBody(cat[id]), false); });
      ['hz', 'hlogm'].forEach(function (id) { if (num[id]) h += facetShell(id, num[id].label, numWidget(num[id]), false); });
    }
    var tf = F.num.filter(function (d) { return d.group === 'time'; });
    if (tf.length) h += facetShell('time', 'Photometry dates', tf.map(function (d) { return numWidget(d, true); }).join('<div style="height:14px"></div>'), false);
    if (S.isPrivate) {
      h += '<p class="private-label" style="margin:24px 0 0">' + U.icon('lock', 2).replace('<svg', '<svg width="12" height="12"') + ' Rubin DP2 · proprietary</p>';
      if (cat.ecov) h += facetShell('ecov', cat.ecov.label, catBody(cat.ecov), true, 'private');
      h += facetShell('em', cat.em.label, catBody(cat.em), true, 'private');
      h += facetShell('etc', cat.etc.label, catBody(cat.etc), false, 'private');
      ['esep', 'endia', 'elead'].forEach(function (id) { if (num[id]) h += facetShell(id, num[id].label, numWidget(num[id]), false, 'private'); });
    }
    return h;
  }

  function sortOptions() {
    var o = [['', 'Automatic'], ['_npts', 'Most data'], ['disc_mjd', 'Discovery date'], ['name', 'Name'], ['type', 'Type'], ['z', 'Redshift'], ['disc_mag', 'Discovery mag'], ['group', 'Reporting group']];
    if (U.has('n_spec')) o.push(['n_spec', 'Spectra']);
    if (U.has('lead_alert')) o.push(['lead_alert', 'Rubin alert lead time']);
    if (U.has('mdb_psn')) o.push(['mdb_psn', 'metaDEBASS P(SN-like)']);
    S.srcKeys.forEach(function (k) { o.push(['n_' + k, U.srcShort(k) + ' measurements']); });
    S.srcKeys.forEach(function (k) { if (U.has('t0_' + k)) o.push(['t0_' + k, U.srcShort(k) + ' first point']); });
    if (U.has('n_visits_active')) o.push(['n_visits_active', 'Active pointings']);
    if (U.has('host_z')) o.push(['host_z', 'Host redshift']);
    if (U.has('host_logm_p50')) o.push(['host_logm_p50', 'Host log M*']);
    if (S.isPrivate) {
      if (U.has('edp2_sep')) o.push(['edp2_sep', 'EDP2 separation']);
      if (U.has('edp2_ndia')) o.push(['edp2_ndia', 'EDP2 nDiaSources']);
      if (U.has('edp2_lead')) o.push(['edp2_lead', 'EDP2 lead time']);
    }
    o.push(['_sep', 'Cone separation']);
    return o;
  }

  function build() {
    F = X.F;
    E.cols = columnDefs();
    var ps = +U.lsGet('tnsx-pagesize');
    if (PAGE_SIZES.indexOf(ps) >= 0) E.pageSize = ps;
    try { E.open = JSON.parse(U.lsGet('tnsx-facets') || '{}') || {}; } catch (e) { E.open = {}; }
    var root = document.getElementById('view-explore');
    root.innerHTML = '<div class="wrap explore">' +
      '<aside class="rail" id="rail" aria-label="Filters"><div class="rail-head"><h2>Filters</h2><span style="display:flex;gap:8px;align-items:center">' +
      '<button type="button" class="linkbtn" id="rail-clear">Clear all</button><button type="button" class="iconbtn rail-close" id="rail-close" aria-label="Close filters">' + U.icon('x', 2) + '</button></span></div>' +
      '<div class="rail-body">' + buildRail() + '</div>' +
      '<div class="sheet-foot"><button type="button" class="btn btn-primary btn-lg" id="sheet-done">Show results</button></div></aside>' +
      '<section class="results" aria-label="Results">' +
      '<div class="results-head"><div><h1>Explore</h1><p class="rcount" id="rcount" aria-live="polite"></p></div>' +
      '<div class="rtools"><button type="button" class="btn filters-btn" id="open-filters" aria-controls="rail" aria-expanded="false">' + U.icon('filter', 2) + 'Filters<span class="ct-inline"></span></button>' +
      '<span class="seg" role="radiogroup" aria-label="Show results as"><label><input type="radio" name="xview" value=""><span>Table</span></label>' +
      '<label><input type="radio" name="xview" value="sky"><span>Sky</span></label></span>' +
      '<label class="sr-only" for="sort-sel">Sort by</label><select class="select" id="sort-sel">' +
      sortOptions().map(function (o) { return '<option value="' + esc(o[0]) + '">' + (o[0] ? 'Sort: ' : 'Sort: ') + esc(o[1]) + '</option>'; }).join('') + '</select>' +
      '<span class="pop-anchor"><button type="button" class="btn" id="cols-btn" aria-haspopup="true" aria-expanded="false" aria-controls="cols-pop">' + U.icon('columns', 1.8) + 'Columns</button>' +
      '<div class="popover" id="cols-pop" role="group" aria-label="Visible columns" hidden style="right:0;top:calc(100% + 8px)"></div></span>' +
      '<button type="button" class="btn" id="rand-btn" title="Open a random transient from these results">' + U.icon('shuffle', 1.8) + 'Random</button>' +
      '<button type="button" class="btn" id="csv-btn" title="Download all filtered rows as CSV">' + U.icon('download', 1.9) + 'CSV</button></div></div>' +
      '<div class="chips" id="chips" aria-label="Active filters"></div>' +
      '<div class="card table-card"><div class="table-wrap" id="twrap"><table class="data clickable" id="rtable"><thead></thead><tbody></tbody></table></div>' +
      '<div class="pager" id="pager"></div></div>' +
      '<div class="card map-card" id="xsky-card" hidden><div class="map-head"><div class="legend" id="xsky-legend"></div>' +
      '<span class="muted" style="font-size:12px">RA 0h at centre · dotted line: Galactic plane</span></div>' +
      '<div class="skymap" id="xsky" role="img" aria-label="Sky map of the filtered transients"><div class="sk"></div></div></div></section></div>';
    wire(root);
    E.built = true;
  }

  // ------------------------------------------------------------------ events
  var evalSoon = U.debounce(function () { update(true); }, 90);
  function wire(root) {
    var rail = $('#rail', root);
    rail.addEventListener('click', function (e) {
      var h = e.target.closest('.facet-h');
      if (h) {
        var open = h.getAttribute('aria-expanded') !== 'true';
        h.setAttribute('aria-expanded', open ? 'true' : 'false');
        document.getElementById(h.getAttribute('aria-controls')).hidden = !open;
        E.open[h.parentNode.getAttribute('data-facet')] = open;
        U.lsSet('tnsx-facets', JSON.stringify(E.open));
        return;
      }
      var more = e.target.closest('[data-more]');
      if (more) { var id = more.getAttribute('data-more'); E.facetMore[id] = !E.facetMore[id]; syncCat(F.byId[id]); return; }
    });
    rail.addEventListener('change', function (e) {
      var t = e.target;
      if (t.hasAttribute('data-cat')) {
        var id = t.getAttribute('data-cat'), sel = (F.state.sel[id] || []).slice(), k = sel.indexOf(t.value);
        if (t.checked && k < 0) sel.push(t.value); else if (!t.checked && k >= 0) sel.splice(k, 1);
        if (sel.length) F.state.sel[id] = sel; else delete F.state.sel[id];
        update(true);
      } else if (t.name === 'srcmode') { F.state.srcAll = t.value !== 'any'; update(true); }
      else if (t.name === 'ptstab') {
        E.ptsTab = t.value;
        $all('[data-ptspane]', rail).forEach(function (p) { p.hidden = p.getAttribute('data-ptspane') !== E.ptsTab; });
      } else if (t.hasAttribute('data-min') || t.hasAttribute('data-max')) {
        var nid = t.getAttribute('data-min') || t.getAttribute('data-max'), d = F.byId[nid];
        var v = F.parseBound(d, t.value), r = (F.state.rng[nid] || [null, null]).slice();
        t.classList.toggle('invalid', t.value.trim() !== '' && v === null);
        if (t.value.trim() !== '' && v === null) return;
        r[t.hasAttribute('data-min') ? 0 : 1] = v;
        if (F.rangeActive(r)) F.state.rng[nid] = r; else delete F.state.rng[nid];
        update(true);
      } else if (t.hasAttribute('data-lo') || t.hasAttribute('data-hi')) { commitSlider(t); update(true); }
    });
    rail.addEventListener('input', function (e) {
      var t = e.target;
      if (t.hasAttribute('data-find')) { E.find[t.getAttribute('data-find')] = t.value; syncCat(F.byId[t.getAttribute('data-find')]); return; }
      if (t.hasAttribute('data-lo') || t.hasAttribute('data-hi')) { commitSlider(t); syncNum(F.byId[t.getAttribute('data-lo') || t.getAttribute('data-hi')], true); evalSoon(); return; }
      if (t.id === 'f-q') { F.state.q = t.value.trim(); evalSoon(); return; }
      if (t.hasAttribute('data-pos')) { F.state[t.getAttribute('data-pos')] = t.value.trim(); evalSoon(); }
    });
    $('#f-q', rail).addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      F.state.q = e.target.value.trim();
      update(true);
      var ex = S.byName.get(U.normQuery(F.state.q));
      if (ex === undefined) ex = S.byRid.get(U.normQuery(F.state.q));
      if (ex !== undefined) X.go('#/object/' + encodeURIComponent(U.V(ex, 'name')));
      else if (F.last.result.length === 1) X.go('#/object/' + encodeURIComponent(U.V(F.last.result[0], 'name')));
    });
    $('#rail-clear', root).addEventListener('click', clearAll);
    $('#chips', root).addEventListener('click', function (e) {
      var b = e.target.closest('button[data-chip]');
      if (!b) return;
      if (b.getAttribute('data-chip') === 'all') { clearAll(); return; }
      var c = E.chips[+b.getAttribute('data-chip')];
      if (c) { c.remove(); update(true); var nb = $('#chips button[data-chip]'); if (nb) nb.focus(); }
    });
    $all('input[name="xview"]', root).forEach(function (r) {
      r.addEventListener('change', function () { F.state.view = r.value; pushUrl(); render(); });
    });
    $('#sort-sel', root).addEventListener('change', function (e) { F.state.sort = e.target.value; F.state.dir = ''; update(true); });
    $('#rtable', root).addEventListener('click', function (e) {
      var sb = e.target.closest('.sortbtn');
      if (sb) { headerSort(sb.getAttribute('data-key')); return; }
      if (e.target.closest('a')) return;
      var tr = e.target.closest('tr[data-i]');
      if (tr) X.go('#/object/' + encodeURIComponent(U.V(+tr.getAttribute('data-i'), 'name')));
    });
    $('#pager', root).addEventListener('click', function (e) {
      var b = e.target.closest('button[data-page]');
      if (!b || b.disabled) return;
      E.page = +b.getAttribute('data-page');
      renderTable(); $('#twrap').scrollTop = 0;
    });
    $('#pager', root).addEventListener('change', function (e) {
      if (e.target.id !== 'page-size') return;
      E.pageSize = +e.target.value; E.page = 0; U.lsSet('tnsx-pagesize', String(E.pageSize)); renderTable();
    });
    $('#rand-btn', root).addEventListener('click', function () {
      var r = F.last.result;
      if (r.length) X.go('#/object/' + encodeURIComponent(U.V(r[Math.floor(Math.random() * r.length)], 'name')));
    });
    $('#csv-btn', root).addEventListener('click', downloadCsv);
    // column chooser
    var cb = $('#cols-btn', root), pop = $('#cols-pop', root);
    cb.addEventListener('click', function (e) {
      e.stopPropagation();
      var open = pop.hidden;
      if (open) renderColsPop();
      pop.hidden = !open; cb.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) { var f = pop.querySelector('input'); if (f) f.focus(); }
    });
    pop.addEventListener('change', function (e) {
      var ids = $all('input[data-col]', pop).filter(function (x) { return x.checked; }).map(function (x) { return x.getAttribute('data-col'); });
      F.state.cols = ids;
      U.lsSet(COLS_KEY, ids.join(','));
      pushUrl(); renderTable();
    });
    pop.addEventListener('keydown', function (e) { if (e.key === 'Escape') { pop.hidden = true; cb.setAttribute('aria-expanded', 'false'); cb.focus(); } });
    document.addEventListener('click', function (e) { if (!pop.hidden && !e.target.closest('#cols-pop')) { pop.hidden = true; cb.setAttribute('aria-expanded', 'false'); } });
    // mobile sheet
    $('#open-filters', root).addEventListener('click', openSheet);
    $('#rail-close', root).addEventListener('click', closeSheet);
    $('#sheet-done', root).addEventListener('click', closeSheet);
    rail.addEventListener('keydown', function (e) { if (e.key === 'Escape' && rail.classList.contains('open')) closeSheet(); });
  }
  function commitSlider(t) {
    var id = t.getAttribute('data-lo') || t.getAttribute('data-hi'), d = F.byId[id];
    var box = $('.nfacet[data-num="' + id + '"]');
    var lo = $('input[data-lo]', box), hi = $('input[data-hi]', box);
    var a = +lo.value, b = +hi.value;
    if (a >= b) { if (t === lo) { a = b - 1; lo.value = a; } else { b = a + 1; hi.value = b; } }
    var r = F.idxToRange(d, a, b);
    if (F.rangeActive(r)) F.state.rng[id] = r; else delete F.state.rng[id];
  }
  function clearAll() {
    var keepSort = F.state.sort, keepDir = F.state.dir, keepCols = F.state.cols, keepView = F.state.view;
    F.state = F.blank();
    F.state.sort = keepSort; F.state.dir = keepDir; F.state.cols = keepCols; F.state.view = keepView;
    E.find = {};
    $all('.facet-find').forEach(function (x) { x.value = ''; });
    syncControls();
    update(true);
  }
  function headerSort(key) {
    var cur = F.last.sortKey, dir = key === cur ? -F.last.sortDir : F.naturalDir(key);
    F.state.sort = key; F.state.dir = dir > 0 ? 'asc' : 'desc';
    update(true);
  }
  var sheetScrim = null;
  function openSheet() {
    var rail = $('#rail');
    rail.classList.add('open');
    $('#open-filters').setAttribute('aria-expanded', 'true');
    sheetScrim = document.createElement('div');
    sheetScrim.className = 'scrim';
    sheetScrim.style.zIndex = 72;
    sheetScrim.addEventListener('click', closeSheet);
    document.body.appendChild(sheetScrim);
    document.documentElement.style.overflow = 'hidden';
    setTimeout(function () { $('#rail-close').focus(); }, 50);
  }
  function closeSheet() {
    var rail = $('#rail');
    if (!rail || !rail.classList.contains('open')) return;
    rail.classList.remove('open');
    $('#open-filters').setAttribute('aria-expanded', 'false');
    if (sheetScrim) { sheetScrim.remove(); sheetScrim = null; }
    document.documentElement.style.overflow = '';
    $('#open-filters').focus();
  }

  // ------------------------------------------------------------------ sync controls <- state
  function syncControls() {
    var q = $('#f-q'); if (q && document.activeElement !== q) q.value = F.state.q || '';
    ['ra', 'dec', 'rad'].forEach(function (k) { var el = $('#f-' + k); if (el && document.activeElement !== el) el.value = F.state[k] || ''; });
    $all('input[name="srcmode"]').forEach(function (r) { r.checked = (r.value === 'any') === !F.state.srcAll; });
    $all('input[name="xview"]').forEach(function (r) { r.checked = r.value === (F.state.view || ''); });
    $('#sort-sel').value = F.state.sort || '';
    if ($('#sort-sel').selectedIndex < 0) $('#sort-sel').selectedIndex = 0;
  }
  function syncCat(d) {
    var box = $('.facet[data-facet="' + d.id + '"]');
    if (!box) return;
    var sel = F.state.sel[d.id] || [], counts = F.last.counts[d.id] || {};
    var find = String(E.find[d.id] || '').toLowerCase(), expanded = !!E.facetMore[d.id], shown = 0, hiddenN = 0;
    $all('.opt', box).forEach(function (lab) {
      var v = d.values[+lab.getAttribute('data-k')], n = counts[v.v] || 0, on = sel.indexOf(v.v) >= 0;
      var cb = lab.querySelector('input');
      cb.checked = on;
      lab.querySelector('.n').textContent = U.fint(n);
      lab.classList.toggle('zero', n === 0 && !on);
      var vis;
      if (find) vis = v.label.toLowerCase().indexOf(find) >= 0;
      else vis = on || expanded || !d.show || shown < d.show;
      if (vis && !find && !on) shown++;
      if (!vis && !find) hiddenN++;
      lab.hidden = !vis;
    });
    var more = $('[data-more]', box);
    if (more) {
      more.hidden = !!find || (!expanded && hiddenN === 0);
      more.textContent = expanded ? 'Show fewer' : 'Show ' + hiddenN + ' more';
    }
    setFacetCount(d.id, sel.length);
  }
  function setFacetCount(id, n) {
    var ct = $('.facet[data-facet="' + id + '"] .facet-h .ct');
    if (!ct) return;
    ct.textContent = n; ct.hidden = !n;
  }
  function histSvg(d, fg, range) {
    var bg = d.bg, nb = bg.length, bw = HW / nb, gap = bw > 4 ? 1 : bw > 2 ? 0.5 : 0;
    var mx = Math.max.apply(null, bg.concat([1])), idx = F.rangeToIdx(d, range), out = '';
    var sc = function (c) { return c > 0 ? Math.max(1.5, Math.sqrt(c / mx) * (HH - 2)) : 0; };
    for (var k = 0; k < nb; k++) {
      var x = (k * bw + gap / 2).toFixed(2), w = Math.max(0.4, bw - gap).toFixed(2), hb = sc(bg[k]), hf = sc(fg[k]);
      if (hb) out += '<rect class="bg" x="' + x + '" y="' + (HH - hb).toFixed(2) + '" width="' + w + '" height="' + hb.toFixed(2) + '"/>';
      if (hf) out += '<rect class="fg' + (k < idx[0] || k >= idx[1] ? ' out' : '') + '" x="' + x + '" y="' + (HH - hf).toFixed(2) + '" width="' + w + '" height="' + hf.toFixed(2) + '"/>';
    }
    return out;
  }
  function syncNum(d, sliding) {
    var box = $('.nfacet[data-num="' + d.id + '"]');
    if (!box) return;
    var r = F.state.rng[d.id] || [null, null], idx = F.rangeToIdx(d, r), last = d.edges.length - 1;
    var fg = F.last.fg[d.id];
    $('svg.hist', box).innerHTML = histSvg(d, fg, r);
    var lo = $('input[data-lo]', box), hi = $('input[data-hi]', box);
    if (!sliding) { lo.value = idx[0]; hi.value = idx[1]; }
    var a = +lo.value, b = +hi.value;
    var fill = $('.fill', box);
    fill.style.left = (a / last * 100) + '%'; fill.style.right = (100 - b / last * 100) + '%';
    lo.setAttribute('aria-valuetext', U.isNum(r[0]) ? d.fmt(r[0]) : 'no minimum');
    hi.setAttribute('aria-valuetext', U.isNum(r[1]) ? d.fmt(r[1]) : 'no maximum');
    var mn = $('input[data-min]', box), mxI = $('input[data-max]', box);
    if (document.activeElement !== mn) { mn.value = U.isNum(r[0]) ? d.fmt(r[0]) : ''; mn.classList.remove('invalid'); }
    if (document.activeElement !== mxI) { mxI.value = U.isNum(r[1]) ? d.fmt(r[1]) : ''; mxI.classList.remove('invalid'); }
    var e = d.edges;
    $('[data-read="' + d.id + '"]', box).textContent = F.rangeActive(r) ? F.fmtRange(d, r) :
      (d.type === 'date' ? U.isoDate(e[0]) + ' – ' + U.isoDate(e[last] - 1) : d.fmt(e[0]) + ' – ' + d.fmt(d.type === 'int' ? e[last] - 1 : e[last]) + (d.unit || ''));
    var inr = 0;
    for (var k = idx[0]; k < idx[1]; k++) inr += fg[k] || 0;
    $('[data-inrange="' + d.id + '"]', box).textContent = U.fint(inr);
  }
  function syncPos() {
    var c = F.last.cone, hint = $('#cone-hint');
    ['ra', 'dec', 'rad'].forEach(function (k) { var el = $('#f-' + k); if (el) el.classList.toggle('invalid', !!c.bad[k]); });
    if (U.isNum(c.ra)) hint.textContent = c.ra.toFixed(5) + '°, ' + U.signed(c.dec, 5) + '° = ' + U.raHms(c.ra) + ' ' + U.decDms(c.dec) + ' · r = ' + c.r + '″' + (c.pair ? ' (read from the RA box)' : '');
    else if (c.bad.ra || c.bad.dec) hint.textContent = 'Could not read the coordinates: RA 0–360° or hh:mm:ss, Dec ±90° or ±dd:mm:ss.';
    else if (c.partial) hint.textContent = 'Give both RA and Dec.';
    else hint.textContent = 'Cone search. Paste “RA Dec” into the RA box to fill both.';
    setFacetCount('pos', U.isNum(c.ra) ? 1 : 0);
  }

  // ------------------------------------------------------------------ chips
  function buildChips() {
    var st = F.state, out = [];
    if (st.q) out.push({ k: 'Name or ID', v: st.q, remove: function () { F.state.q = ''; } });
    var c = F.last.cone;
    if (U.isNum(c.ra)) out.push({ k: 'Within ' + c.r + '″ of', v: c.ra.toFixed(4) + ', ' + U.signed(c.dec, 4), remove: function () { F.state.ra = F.state.dec = F.state.rad = ''; } });
    F.cat.forEach(function (d) {
      (st.sel[d.id] || []).forEach(function (v) {
        var lab = (d.values.filter(function (x) { return x.v === v; })[0] || { label: v }).label;
        if (d.id === 'pre') lab = v;
        var key = d.id === 'src' ? ((st.sel.src || []).length > 1 ? (st.srcAll ? 'Has data from (all)' : 'Has data from (any)') : 'Has data from') : d.label;
        out.push({ k: key, v: lab, remove: function () {
          var s = (F.state.sel[d.id] || []).filter(function (x) { return x !== v; });
          if (s.length) F.state.sel[d.id] = s; else delete F.state.sel[d.id];
        } });
      });
    });
    F.num.forEach(function (d) {
      var r = st.rng[d.id];
      if (F.rangeActive(r)) out.push({ k: d.label, v: F.fmtRange(d, r), remove: function () { delete F.state.rng[d.id]; } });
    });
    E.chips = out;
    var box = $('#chips');
    box.innerHTML = out.map(function (ch, k) {
      return '<span class="chip"><span class="ck">' + esc(ch.k) + ':</span><span class="cv">' + esc(ch.v) + '</span>' +
        '<button type="button" data-chip="' + k + '" aria-label="Remove filter ' + esc(ch.k + ' ' + ch.v) + '">' + U.icon('x', 2.4) + '</button></span>';
    }).join('') + (out.length > 1 ? '<button type="button" class="linkbtn" data-chip="all">Clear all</button>' : '');
    box.hidden = !out.length;
  }

  // ------------------------------------------------------------------ table
  function cellHtml(c, i, ranges) {
    var V = U.V, v;
    switch (c.id) {
      case 'name':
        return '<td class="fix name"><span class="pfx">' + esc(V(i, 'prefix') || '') + '</span><a href="#/object/' + encodeURIComponent(V(i, 'name')) + '">' + esc(V(i, 'name')) + '</a></td>';
      case '_sep': return '<td class="num">' + (F.last.sep ? U.fx(F.last.sep[i], 2) : '') + '</td>';
      case 'type': v = V(i, 'type'); return '<td>' + (v ? '<span class="typ">' + esc(v) + '</span>' : '<span class="none">—</span>') + '</td>';
      case 'z': v = V(i, 'z'); return '<td class="num">' + (U.isNum(v) ? U.fx(v, v < 0.1 ? 4 : 3) : '<span class="none">—</span>') + '</td>';
      case 'disc_mjd': v = V(i, 'disc_mjd'); return '<td class="num" title="MJD ' + U.fx(v, 3) + '">' + U.isoDate(v) + '</td>';
      case 'disc_mag': v = V(i, 'disc_mag');
        return '<td class="num">' + U.fx(v, 2) + (V(i, 'disc_filter') ? ' <span class="muted">' + esc(V(i, 'disc_filter')) + '</span>' : '') + '</td>';
      case 'group': return '<td>' + esc(V(i, 'group') || '') + '</td>';
      case 'region': v = V(i, 'region') || 'WFD';
        return '<td>' + (v === 'WFD' ? '<span class="muted">WFD</span>' : '<span class="typ ddf">' + esc(U.regionLabel(v)) + '</span>') + '</td>';
      case 'debass': v = V(i, 'debass');
        return '<td>' + (v ? '<span class="pill debass">' + esc(K.DEBASS_LABEL[v] || v) + '</span>' : '<span class="none">—</span>') + '</td>';
      case 'n_spec': v = V(i, 'n_spec'); return '<td class="num"' + (V(i, 'spec_types') ? ' title="' + esc(V(i, 'spec_types')) + '"' : '') + '>' + (v > 0 ? U.fint(v) : '<span class="zero">0</span>') + '</td>';
      case 'mdb_call': v = V(i, 'mdb_call');
        if (!v) return '<td><span class="none">—</span></td>';
        return '<td><span class="callpill c-' + (v === 'Ia' ? 'I' : v === 'SN' ? (V(i, 'mdb_sv') === 'ZTF' ? 'S' : 'N') : 'O') + '">' + esc(v === 'other' ? 'not SN' : v) + '</span>' +
          (U.isNum(V(i, 'mdb_psn')) ? ' <span class="muted tabular">' + U.fx(V(i, 'mdb_psn'), 2) + '</span>' : '') + '</td>';
      case 'lead_alert': v = V(i, 'lead_alert');
        if (V(i, 'rubin_first') === 'rubin') return '<td class="num"><span class="pill rubin" title="TNS discovery made in Rubin data">Rubin</span></td>';
        return '<td class="num">' + (U.isNum(v) ? '<span class="' + (v > 0 ? 'lead-pos' : 'muted') + '">' + (v > 0 ? '+' : '') + U.fx(v, 1) + '</span>' : '<span class="none">—</span>') + '</td>';
      case 'n_visits_active': return '<td class="num">' + U.fint(V(i, 'n_visits_active')) + (U.has('n_visits') ? ' <span class="muted">/ ' + U.fint(V(i, 'n_visits')) + '</span>' : '') + '</td>';
      case 'edp2_sep': v = V(i, 'edp2_sep'); return '<td class="num">' + (U.isNum(v) ? '<span' + (v > S.matchR ? ' class="muted"' : '') + '>' + U.fx(v, 2) + '</span>' : '<span class="none">—</span>') + '</td>';
      case 'edp2_ndia': v = V(i, 'edp2_ndia'); return '<td class="num">' + (U.isNum(v) ? U.fint(v) : '<span class="none">—</span>') + '</td>';
      case 'edp2_lead': v = V(i, 'edp2_lead'); return '<td class="num">' + (U.isNum(v) ? U.fx(v, 1) : '<span class="none">—</span>') + '</td>';
      case 'host_status':
        v = V(i, 'host_status');
        if (v == null) return '<td><span class="none">—</span></td>';
        var hf = V(i, 'host_fit');
        return '<td><span class="' + (v === 'associated' ? '' : 'muted') + '">' + esc((X.HOST_STATUS || {})[v] || v) + '</span>' +
          (hf ? '<span class="rng">' + esc((X.HOST_FIT || {})[hf] || hf) + '</span>' : '') + '</td>';
      case 'host_fit': v = V(i, 'host_fit'); return '<td>' + (v ? esc((X.HOST_FIT || {})[v] || v) : '<span class="none">—</span>') + '</td>';
      case 'host_z': v = V(i, 'host_z'); return '<td class="num">' + (U.isNum(v) ? U.fx(v, 4) : '<span class="none">—</span>') + '</td>';
      case 'host_logm_p50': case 'host_sep': case 'host_ddlr':
        v = V(i, c.id); return '<td class="num">' + (U.isNum(v) ? U.fx(v, 2) : '<span class="none">—</span>') + '</td>';
      case 'alert_ids':
        v = String(V(i, 'alert_ids') || '').split(',').filter(Boolean);
        return '<td class="mono"' + (v.length > 1 ? ' title="' + esc(v.join(', ')) + '"' : '') + '>' +
          (v.length ? esc(v[0]) + (v.length > 1 ? ' <span class="muted">+' + (v.length - 1) + '</span>' : '') : '<span class="none">—</span>') + '</td>';
      case 'edp2_id': v = V(i, 'edp2_id'); return '<td class="mono">' + (v != null && v !== '' ? esc(v) : '<span class="none">—</span>') + '</td>';
      case 'edp2_coadd_bands': v = V(i, 'edp2_coadd_bands');
        return '<td class="mono">' + (V(i, 'edp2_coadd') === true ? esc(v || '') : '<span class="none">outside</span>') + '</td>';
      case 'edp2_tc': v = V(i, 'edp2_tc'); return '<td>' + (v === true || v === 1 ? 'yes' : v === false || v === 0 ? 'no' : '<span class="none">—</span>') + '</td>';
      case 'ra': return '<td class="num mono">' + U.fx(V(i, 'ra'), 5) + '</td>';
      case 'dec': return '<td class="num mono">' + U.fx(V(i, 'dec'), 5) + '</td>';
      default:
        if (c.src) {
          var n = V(i, 'n_' + c.src) || 0, t0 = V(i, 't0_' + c.src), t1 = V(i, 't1_' + c.src);
          return '<td class="num"' + (n && U.isNum(t0) ? ' title="' + U.isoDate(t0) + ' – ' + U.isoDate(t1) + '"' : '') + '>' +
            (n ? U.fint(n) : '<span class="zero">–</span>') +
            (ranges && n && U.isNum(t0) ? '<span class="rng">' + Math.floor(t0) + '–' + Math.floor(t1) + '</span>' : '') + '</td>';
        }
        v = V(i, c.id);
        return '<td' + (c.mono ? ' class="mono"' : '') + '>' + esc(v == null ? '' : v) + '</td>';
    }
  }
  function renderTable() {
    var cols = visibleCols().filter(function (c) { return !c.pseudo; }), ranges = colOn('_ranges');
    var res = F.last.result, n = res.length, ps = E.pageSize, pages = Math.max(1, Math.ceil(n / ps));
    if (E.page >= pages) E.page = pages - 1;
    if (E.page < 0) E.page = 0;
    var sk = F.last.sortKey, sd = F.last.sortDir;
    var thead = '<tr>' + cols.map(function (c) {
      var sorted = c.id === sk, aria = sorted ? (sd > 0 ? 'ascending' : 'descending') : 'none';
      return '<th scope="col" class="' + (c.num ? 'num ' : '') + (c.fixed ? 'fix' : '') + '" aria-sort="' + aria + '"' + (c.title ? ' title="' + esc(c.title) + '"' : '') + '>' +
        '<button type="button" class="sortbtn" data-key="' + esc(c.id) + '">' + esc(c.label) + '<span class="arrow" aria-hidden="true">' + (sorted ? (sd > 0 ? '↑' : '↓') : '') + '</span></button>' +
        (c.sub ? '<span class="th-sub">' + esc(c.sub) + '</span>' : '') + '</th>';
    }).join('') + '</tr>';
    var a = E.page * ps, b = Math.min(n, a + ps), body = [];
    for (var k = a; k < b; k++) {
      var i = res[k];
      body.push('<tr data-i="' + i + '"' + (i === S.lastObj ? ' class="sel"' : '') + '>' + cols.map(function (c) { return cellHtml(c, i, ranges); }).join('') + '</tr>');
    }
    var t = $('#rtable');
    t.tHead.innerHTML = thead;
    t.tBodies[0].innerHTML = n ? body.join('') : '<tr><td colspan="' + cols.length + '"><div class="empty"><h3>No transients match</h3><p>Remove a filter above, or <button type="button" class="linkbtn" id="empty-clear">clear all filters</button>.</p></div></td></tr>';
    var ec = $('#empty-clear'); if (ec) ec.addEventListener('click', clearAll);
    var pg = '<span>' + (n ? 'Showing ' + U.fint(a + 1) + '–' + U.fint(b) + ' of ' + U.fint(n) : 'No results') + '</span><span class="pg">' +
      '<label class="sr-only" for="page-size">Rows per page</label><select class="select" id="page-size">' +
      PAGE_SIZES.map(function (s) { return '<option value="' + s + '"' + (s === ps ? ' selected' : '') + '>' + s + ' per page</option>'; }).join('') + '</select>';
    if (pages > 1) {
      pg += '<button type="button" class="btn btn-sm" data-page="' + (E.page - 1) + '"' + (E.page === 0 ? ' disabled' : '') + ' aria-label="Previous page">' + U.icon('left', 2) + '</button>' +
        '<span class="tabular">' + (E.page + 1) + ' / ' + pages + '</span>' +
        '<button type="button" class="btn btn-sm" data-page="' + (E.page + 1) + '"' + (E.page >= pages - 1 ? ' disabled' : '') + ' aria-label="Next page">' + U.icon('right', 2) + '</button>';
    }
    $('#pager').innerHTML = pg + '</span>';
    $('#rand-btn').disabled = !n; $('#csv-btn').disabled = !n;
  }
  function renderColsPop() {
    var vis = visibleCols().map(function (c) { return c.id; });
    $('#cols-pop').innerHTML = '<h4>Columns</h4>' + E.cols.filter(function (c) { return !c.always; }).map(function (c) {
      return '<label class="opt"><input type="checkbox" data-col="' + c.id + '"' + (vis.indexOf(c.id) >= 0 ? ' checked' : '') + '><span class="l">' + esc(c.label) + (c.sub && !c.pseudo ? ' <span class="muted">· ' + esc(c.sub) + '</span>' : '') + '</span></label>';
    }).join('');
  }
  function downloadCsv() {
    var cols = S.cols.slice(), jd = cols.indexOf('disc_mjd'), header = cols.slice();
    header.splice(jd + 1, 0, 'disc_date');
    var sep = F.last.sep;
    if (sep) header.push('cone_sep_arcsec');
    var rows = F.last.result.map(function (i) {
      var r = S.rows[i].slice();
      r.splice(jd + 1, 0, U.isoDateTime(r[jd]));
      if (sep) r.push(U.fx(sep[i], 3));
      return r;
    });
    U.downloadCsv('tns_edp2_' + (S.isPrivate ? 'private_' : '') + rows.length + '_transients.csv', header, rows);
  }

  // ------------------------------------------------------------------ update cycle
  function pushUrl() {
    var q = F.toParams().toString();
    S.listQuery = q;
    U.ssSet('tnsx-list', q);
    U.$all('a[data-nav="explore"]').forEach(function (a) { a.setAttribute('href', X.exploreHash()); });
    if (S.view === 'explore') X.replace('#/explore' + (q ? '?' + q : ''));
  }
  function update(push) {
    if (push) E.page = 0;
    F.evaluate();
    render();
    if (push) pushUrl();
  }
  function render() {
    if (!E.built) return;
    var n = F.last.result.length;
    $('#rcount').innerHTML = '<b>' + U.fint(n) + '</b> of ' + U.fint(S.N) + ' transients';
    $('#sheet-done').textContent = 'Show ' + U.plural(n, 'transient');
    var act = F.activeCount();
    $('#open-filters .ct-inline').textContent = act ? ' · ' + act : '';
    $('#rail-clear').hidden = !act;
    F.cat.forEach(syncCat);
    F.num.forEach(function (d) { syncNum(d); });
    var ptsN = F.num.filter(function (d) { return d.group === 'pts' && F.rangeActive(F.state.rng[d.id]); }).length;
    setFacetCount('pts', ptsN);
    F.num.forEach(function (d) {
      if (d.group === 'pts') { var tab = $('[data-tab="' + d.id + '"]'); if (tab) tab.textContent = d.short + (F.rangeActive(F.state.rng[d.id]) ? ' •' : ''); }
      else if (!d.group) setFacetCount(d.id, F.rangeActive(F.state.rng[d.id]) ? 1 : 0);
    });
    setFacetCount('time', F.num.filter(function (d) { return d.group === 'time' && F.rangeActive(F.state.rng[d.id]); }).length);
    syncPos();
    syncControls();
    buildChips();
    var sky = F.state.view === 'sky';
    $('.table-card').hidden = sky;
    $('#xsky-card').hidden = !sky;
    if (sky) drawSky(); else renderTable();
  }
  // Sky view: the filtered rows over every other transient in the catalogue.
  function drawSky() {
    var res = F.last.result, on = new Uint8Array(S.N), other = [];
    for (var k = 0; k < res.length; k++) on[res[k]] = 1;
    for (var i = 0; i < S.N; i++) if (!on[i]) other.push(i);
    $('#xsky-legend').innerHTML = '<span class="li"><span class="dot" style="background:var(--dot-data)"></span>Matching the filters · ' + U.fint(res.length) + '</span>' +
      (other.length ? '<span class="li"><span class="dot" style="background:var(--dot-none)"></span>Other transients · ' + U.fint(other.length) + '</span>' : '');
    X.ensurePlotly().then(function () {
      if (F.state.view !== 'sky' || S.view !== 'explore') return;
      X.skyMap($('#xsky'), [{ idx: other, dot: '--dot-none', size: 3.2, opacity: 0.9 },
        { idx: res, dot: '--dot-data', size: X.skySize(res.length), opacity: 0.92 }]);
    }).catch(function () {
      $('#xsky').innerHTML = '<div class="lc-msg">The sky map needs Plotly from cdn.jsdelivr.net, which did not load.</div>';
    });
  }

  // ------------------------------------------------------------------ view API
  X.results = function () { return F && F.last ? F.last.result : []; };
  X.views.explore = {
    init: function () {
      build();
      var q0 = U.ssGet('tnsx-list') || '';
      F.state = F.fromParams(new URLSearchParams(q0));
      S.listQuery = q0;
      F.evaluate();
      render();
    },
    show: function (arg, prev) {
      document.title = 'Explore · TNS EDP2 Explorer';
      if (arg !== S.listQuery) {
        F.state = F.fromParams(new URLSearchParams(arg));
        S.listQuery = arg;
        U.ssSet('tnsx-list', arg);
        E.page = 0;
        F.evaluate();
        render();
      } else if (prev !== 'explore' && F.state.view === 'sky') {
        drawSky();
      } else if (prev !== 'explore') {
        // back from an object: show the page that holds it
        var pos = S.lastObj != null ? F.last.result.indexOf(S.lastObj) : -1;
        if (pos >= 0) E.page = Math.floor(pos / E.pageSize);
        renderTable();
        var tr = $('#rtable tr[data-i="' + S.lastObj + '"]');
        if (tr && tr.scrollIntoView) tr.scrollIntoView({ block: 'nearest' });
      }
      U.$all('a[data-nav="explore"]').forEach(function (a) { a.setAttribute('href', X.exploreHash()); });
    },
    onTheme: function () { if (F.state.view === 'sky') drawSky(); }
  };
})();
