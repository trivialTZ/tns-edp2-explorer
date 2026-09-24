/* TNS x EDP2 Explorer — filter model and engine.
 *
 * State lives in F.state and round-trips through the URL (#/explore?…). Evaluation is a
 * single pass that records, per object, how many active filters it fails and, when it is
 * exactly one, which. Facet counts then follow the CELLxGENE rule: a facet's counts reflect
 * every *other* active filter (rows that fail nothing, or fail only that facet).
 */
(function () {
  'use strict';
  var X = window.TNSXApp, S = X.S, U = X.U, K = X.K;
  var F = X.F = { cat: [], num: [], byId: {}, state: null, last: null };

  function blank() { return { q: '', ra: '', dec: '', rad: '', sel: {}, rng: {}, srcAll: true, sort: '', dir: '', cols: null, view: '' }; }
  F.blank = blank;

  // ------------------------------------------------------------------ facet definitions
  var COUNT_EDGES = [0, 1, 2, 3, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000];
  function countEdges(max) {
    var e = COUNT_EDGES.filter(function (v) { return v <= max; });
    e.push(Math.max(max + 1, e[e.length - 1] + 1));
    return e;
  }
  function quantiles(vals, qs) {
    var v = vals.slice().sort(function (a, b) { return a - b; });
    return qs.map(function (q) { return v.length ? v[Math.min(v.length - 1, Math.max(0, Math.round(q * (v.length - 1))))] : null; });
  }
  function niceStep(span, n) {
    var raw = span / n, p = Math.pow(10, Math.floor(Math.log10(raw))), m = raw / p;
    return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
  }
  function linEdges(lo, hi, n) {
    if (!(hi > lo)) hi = lo + 1;
    var st = niceStep(hi - lo, n), a = Math.floor(lo / st) * st, e = [];
    for (var v = a; v < hi + st * 0.999; v += st) e.push(+v.toFixed(6));
    if (e.length < 2) e.push(a + st);
    return e;
  }
  function colValues(get) {
    var out = [];
    for (var i = 0; i < S.N; i++) { var v = get(i); if (U.isNum(v)) out.push(v); }
    return out;
  }
  var fmtDate = function (v) { return U.isoDate(v); };
  function fmtNum(d) { return function (v) { return U.isNum(v) ? (+v.toFixed(d)).toString() : ''; }; }
  function colGetter(c) { var j = S.C[c]; return function (i) { var v = S.rows[i][j]; return U.isNum(v) ? v : null; }; }

  F.init = function () {
    var C = S.C, rows = S.rows;
    F.cat = []; F.num = []; F.byId = {};
    function addCat(d) { d.kind = 'cat'; F.cat.push(d); F.byId[d.id] = d; }
    function addNum(d) { d.kind = 'num'; F.num.push(d); F.byId[d.id] = d; }

    // --- categorical
    var jt = C.type, tc = new Map();
    F.typeKey = new Array(S.N);
    for (var i = 0; i < S.N; i++) {
      var t = jt === undefined ? null : rows[i][jt];
      var k = t == null || t === '' ? '__none__' : String(t);
      F.typeKey[i] = k;
      tc.set(k, (tc.get(k) || 0) + 1);
    }
    var types = Array.from(tc.entries()).sort(function (a, b) { return b[1] - a[1] || a[0].localeCompare(b[0]); });
    addCat({ id: 'type', label: 'TNS classification', values: types.map(function (t) { return { v: t[0], label: t[0] === '__none__' ? 'Untyped' : t[0] }; }),
      get: function (i) { return F.typeKey[i]; }, search: true, open: true, show: 8 });
    var jp = C.prefix;
    addCat({ id: 'pre', label: 'Name prefix', values: [{ v: 'SN', label: 'SN · supernova' }, { v: 'AT', label: 'AT · astronomical transient' }],
      get: function (i) { return rows[i][jp]; }, open: true });
    if (C.n_spec !== undefined) {
      var js = C.n_spec;
      addCat({ id: 'spec', label: 'TNS spectrum', values: [{ v: 'yes', label: 'Has a spectrum' }, { v: 'no', label: 'No spectrum' }],
        get: function (i) { return rows[i][js] > 0 ? 'yes' : 'no'; }, open: false });
    }
    var srcCols = S.srcKeys.map(function (s) { return C['n_' + s]; });
    addCat({ id: 'src', label: 'Has data from', multi: true, open: true,
      values: S.srcKeys.map(function (s) { return { v: s, label: U.srcLabel(s), sym: U.srcSymbol(s) }; }),
      get: function (i) {
        var r = rows[i], out = [];
        for (var a = 0; a < srcCols.length; a++) if (r[srcCols[a]] > 0) out.push(S.srcKeys[a]);
        return out;
      } });
    // survey region (build/assemble.py survey_region): "WFD" or an LSST Deep Drilling Field name
    if (C.region !== undefined) {
      var jr = C.region, rc = new Map();
      for (i = 0; i < S.N; i++) { var rg = rows[i][jr] || 'WFD'; rc.set(rg, (rc.get(rg) || 0) + 1); }
      var regs = Array.from(rc.keys()).sort(function (a, b) { return (b === 'WFD') - (a === 'WFD') || a.localeCompare(b); });
      F.ddfFields = regs.filter(function (r) { return r !== 'WFD'; });
      addCat({ id: 'reg', label: 'Survey region', open: true, get: function (i) { return rows[i][jr] || 'WFD'; },
        values: regs.map(function (r) { return { v: r, label: U.regionLabel(r) }; }),
        note: 'DDF: covered by visits aimed at an LSST Deep Drilling Field. WFD: everything else, including commissioning fields.' });
    }
    if (C.debass !== undefined) {
      var jdb = C.debass;
      addCat({ id: 'debass', label: 'DEBASS follow-up', open: true, get: function (i) { return rows[i][jdb] || '__none__'; },
        values: [{ v: 'FINISHED', label: K.DEBASS_LABEL.FINISHED }, { v: 'YES', label: K.DEBASS_LABEL.YES }, { v: '__none__', label: 'Not a DEBASS target' }],
        note: 'DEBASS sheet “Following?” = FINISHED or YES.' });
    }
    if (C.alert_ids !== undefined) {
      addCat({ id: 'rid', label: 'Rubin alert diaObjectId', open: false, get: function (i) { return X.hasRid(i, 'alert') ? 'yes' : 'no'; },
        values: [{ v: 'yes', label: 'Has an alert-stream ID' }, { v: 'no', label: 'No alert-stream ID' }] });
    }
    addCat({ id: 'cg', label: 'Class group', open: false, get: function (i) { return U.classGroup(rows[i][jt]); },
      values: [{ v: 'Ia', label: 'SN Ia (all subtypes)' }, { v: 'SN', label: 'Other supernovae' }, { v: 'other', label: 'Other classified' }, { v: 'none', label: 'Untyped' }] });
    var jg = C.group, gc = new Map();
    for (i = 0; i < S.N; i++) { var g = jg === undefined ? '' : String(rows[i][jg] == null ? '' : rows[i][jg]); gc.set(g, (gc.get(g) || 0) + 1); }
    addCat({ id: 'grp', label: 'Reporting group', search: true, open: false, show: 8,
      values: Array.from(gc.entries()).sort(function (a, b) { return b[1] - a[1] || a[0].localeCompare(b[0]); })
        .map(function (g) { return { v: g[0], label: g[0] || '(none)' }; }),
      get: function (i) { return String(rows[i][jg] == null ? '' : rows[i][jg]); } });
    // host galaxies (diagnostic): categorical facets over whatever host rows this view holds
    if (C.host_status !== undefined) {
      var HS_LABEL = { associated: 'Associated', ambiguous: 'Ambiguous', 'no-host': 'No host found', failed: 'Not searched', __none__: 'Not in the host sample' };
      var HF_LABEL = { qc_pass: 'Fit passed QC', qc_fail: 'Withheld (QC fail)', pending: 'Fit pending', not_attempted_ambiguous: 'Not fitted: ambiguous host',
        not_attempted_no_host: 'Not fitted: no host', not_attempted_no_catalog_coverage: 'Not fitted: no catalogue coverage',
        not_attempted_implausible_tns_z: 'Not fitted: implausible TNS z', no_host_redshift: 'Not fitted: no redshift',
        photometry_or_handoff_failed: 'Not fitted: photometry failed', __none__: 'Not in the host sample' };
      var hostFacet = function (id, label, col, labels) {
        var j = C[col], cnt = new Map();
        var get = function (i) { var v = rows[i][j]; return v == null || v === '' ? '__none__' : String(v); };
        for (var i3 = 0; i3 < S.N; i3++) { var k3 = get(i3); cnt.set(k3, (cnt.get(k3) || 0) + 1); }
        var vals = Array.from(cnt.keys()).sort(function (a, b) { return (a === '__none__') - (b === '__none__') || cnt.get(b) - cnt.get(a); });
        addCat({ id: id, label: label, open: false, group: 'host', get: get,
          values: vals.map(function (v) { return { v: v, label: labels[v] || v.replace(/_/g, ' ') }; }) });
      };
      hostFacet('hst', 'Host status', 'host_status', HS_LABEL);
      if (C.host_fit !== undefined) hostFacet('hfit', 'Host fit status', 'host_fit', HF_LABEL);
    }
    if (S.isPrivate) {
      addCat({ id: 'em', label: 'DP2 diaObjectId (EDP2 match)', private: true, open: true,
        values: [{ v: '1', label: 'Matched (≤ ' + S.matchR + '″)' }, { v: '0', label: 'Not matched' }],
        get: function (i) { return F.isMatched(i) ? '1' : '0'; } });
      if (C.edp2_coadd !== undefined) {
        var jco = C.edp2_coadd;
        addCat({ id: 'ecov', label: 'EDP2 deep coadd', private: true, open: true,
          values: [{ v: '1', label: 'Inside the coadd footprint' }, { v: '0', label: 'Outside' }],
          get: function (i) { return rows[i][jco] === true ? '1' : '0'; },
          note: 'The position falls inside a DP2 deep-coadd patch (dp2.CoaddPatches).' });
      }
      var jtc = C.edp2_tc;
      addCat({ id: 'etc', label: 'EDP2 time-consistent', private: true, open: false,
        values: [{ v: '1', label: 'Time-consistent' }, { v: '0', label: 'No / not applicable' }],
        get: function (i) { var v = rows[i][jtc]; return v === true || v === 1 ? '1' : '0'; } });
    }

    // --- numeric
    var gd = colGetter('disc_mjd'), dv = colValues(gd);
    var d0 = Math.floor(Math.min.apply(null, dv)), d1 = Math.ceil(Math.max.apply(null, dv)) + 1, de = [];
    for (var v = d0; v < d1 + 7; v += 7) de.push(v);
    addNum({ id: 'disc', label: 'Discovery date', get: gd, edges: de, type: 'date', fmt: fmtDate, open: true });
    var gm = colGetter('disc_mag'), mq = quantiles(colValues(gm), [0.005, 0.995]);
    addNum({ id: 'mag', label: 'Discovery magnitude', get: gm, edges: linEdges(Math.floor(mq[0] * 2) / 2, Math.ceil(mq[1] * 2) / 2, 28), type: 'float', fmt: fmtNum(2), open: false,
      note: 'AB-like TNS discovery magnitude; brighter is smaller.' });
    var gz = colGetter('z'), zq = quantiles(colValues(gz), [0.98]);
    addNum({ id: 'z', label: 'Redshift', get: gz, edges: linEdges(0, Math.max(0.05, zq[0] || 0.2), 24), type: 'float', fmt: fmtNum(4), open: false,
      note: 'Only objects with a TNS redshift pass a redshift range.' });
    S.srcKeys.forEach(function (s) {
      var gs = colGetter('n_' + s), mx = Math.max.apply(null, colValues(gs).concat([1]));
      addNum({ id: 'n_' + s, label: U.srcShort(s) + ' measurements', short: U.srcShort(s), src: s, get: function (i) { return gs(i) || 0; },
        edges: countEdges(mx), type: 'int', fmt: fmtNum(0), group: 'pts' });
    });
    if (C.host_z !== undefined) {
      var ghz = colGetter('host_z'), hzq = quantiles(colValues(ghz), [0.98]);
      addNum({ id: 'hz', label: 'Host redshift', get: ghz, edges: linEdges(0, Math.max(0.05, hzq[0] || 0.2), 24), type: 'float', fmt: fmtNum(3), open: false,
        note: 'The redshift held fixed in the host fit (spectroscopic or photometric).' });
    }
    if (C.host_logm_p50 !== undefined) {
      addNum({ id: 'hlogm', label: 'Host log M*', get: colGetter('host_logm_p50'), edges: linEdges(6, 12, 24), type: 'float', fmt: fmtNum(2), open: false,
        note: 'Bagpipes median, fits that passed QC only. Diagnostic, not for science use.' });
    }
    if (C.n_visits_active !== undefined) {
      var gv = colGetter('n_visits_active'), vmx = Math.max.apply(null, colValues(gv).concat([1]));
      addNum({ id: 'nva', label: 'LSSTCam pointings', get: function (i) { return gv(i) || 0; }, edges: countEdges(vmx), type: 'int', fmt: fmtNum(0), open: false,
        note: 'dp2.Visit centres within 2.1° during [discovery − 30 d, discovery + 100 d].' });
    }
    // first / last photometry epoch over the selected sources (all sources when none are selected)
    var t0c = {}, t1c = {};
    S.srcKeys.forEach(function (s) { if (C['t0_' + s] !== undefined) t0c[s] = C['t0_' + s]; if (C['t1_' + s] !== undefined) t1c[s] = C['t1_' + s]; });
    function tget(map, lo) {
      return function (i) {
        var sel = F.state && F.state.sel.src, keys = sel && sel.length ? sel : S.srcKeys, r = rows[i], best = null;
        for (var a = 0; a < keys.length; a++) {
          var j = map[keys[a]]; if (j === undefined) continue;
          var x = r[j]; if (!U.isNum(x)) continue;
          if (best === null || (lo ? x < best : x > best)) best = x;
        }
        return best;
      };
    }
    var tAll = [];
    S.srcKeys.forEach(function (s) { if (t0c[s] !== undefined) for (var i2 = 0; i2 < S.N; i2++) { var x = rows[i2][t0c[s]]; if (U.isNum(x)) tAll.push(x); } });
    if (tAll.length) {
      var tq = quantiles(tAll, [0.002, 0.998]), te = [];
      for (v = Math.floor(tq[0] / 14) * 14; v < tq[1] + 14; v += 14) te.push(v);
      addNum({ id: 't0', label: 'First photometry point', get: tget(t0c, true), edges: te, type: 'date', fmt: fmtDate, open: false, group: 'time',
        note: 'Over the sources selected in “Has data from”, or all sources.' });
      addNum({ id: 't1', label: 'Last photometry point', get: tget(t1c, false), edges: te, type: 'date', fmt: fmtDate, open: false, group: 'time' });
    }
    if (S.isPrivate) {
      var ge = colGetter('edp2_sep'), eq = quantiles(colValues(ge), [0.99]);
      addNum({ id: 'esep', label: 'EDP2 separation', get: ge, edges: linEdges(0, Math.max(3, eq[0] || 3), 24), type: 'float', fmt: fmtNum(2), unit: '″', private: true, open: false });
      var gn = colGetter('edp2_ndia'), nmx = Math.max.apply(null, colValues(gn).concat([1]));
      addNum({ id: 'endia', label: 'EDP2 nDiaSources', get: gn, edges: countEdges(nmx), type: 'int', fmt: fmtNum(0), private: true, open: false });
      var gl = colGetter('edp2_lead'), lq = quantiles(colValues(gl), [0.01, 0.99]);
      addNum({ id: 'elead', label: 'EDP2 lead time', get: gl, edges: linEdges(lq[0] == null ? -30 : lq[0], lq[1] == null ? 30 : lq[1], 24), type: 'float', fmt: fmtNum(1), unit: ' d', private: true, open: false,
        note: 'TNS discovery − first positive EDP2 detection; > 0 means EDP2 saw it first.' });
    }
    // background (unfiltered) histograms
    F.num.forEach(function (d) { d.bg = hist(d, null); });
    F.state = blank();
  };

  function binOf(e, v) {
    if (v < e[0]) return 0;
    var n = e.length - 1;
    if (v >= e[n]) return n - 1;
    var lo = 0, hi = n;
    while (hi - lo > 1) { var m = (lo + hi) >> 1; if (v >= e[m]) lo = m; else hi = m; }
    return lo;
  }
  F.binOf = binOf;
  function hist(d, pass) {
    var h = new Array(d.edges.length - 1).fill(0);
    for (var i = 0; i < S.N; i++) {
      if (pass && !pass(i)) continue;
      var v = d.get(i);
      if (U.isNum(v)) h[binOf(d.edges, v)]++;
    }
    return h;
  }

  F.isMatched = function (i) {
    var id = U.V(i, 'edp2_id'), sp = U.V(i, 'edp2_sep');
    return id != null && id !== '' && (!U.isNum(sp) || sp <= S.matchR);
  };

  // ------------------------------------------------------------------ range <-> slider index
  F.rangeToIdx = function (d, r) {
    var e = d.edges, last = e.length - 1, lo = r && r[0], hi = r && r[1];
    var a = 0, b = last;
    if (U.isNum(lo)) { a = 0; while (a < last && e[a + 1] <= lo) a++; }
    if (U.isNum(hi)) { var hv = d.type === 'int' ? hi + 1 : hi; b = last; while (b > 0 && e[b - 1] >= hv) b--; }
    if (b <= a) b = Math.min(last, a + 1);
    return [a, b];
  };
  F.idxToRange = function (d, a, b) {
    var e = d.edges, last = e.length - 1;
    var lo = a > 0 ? e[a] : null;
    var hi = b < last ? (d.type === 'int' ? e[b] - 1 : e[b]) : null;
    return [lo, hi];
  };
  F.rangeActive = function (r) { return !!r && (U.isNum(r[0]) || U.isNum(r[1])); };
  F.fmtRange = function (d, r) {
    var f = function (v) { return d.fmt(v) + (d.unit || ''); };
    if (U.isNum(r[0]) && U.isNum(r[1])) return r[0] === r[1] ? f(r[0]) : f(r[0]) + ' – ' + f(r[1]);
    if (U.isNum(r[0])) return '≥ ' + f(r[0]);
    return '≤ ' + f(r[1]);
  };

  // ------------------------------------------------------------------ URL
  function fmtBound(d, v) {
    if (!U.isNum(v)) return '';
    if (d.type === 'date' && Math.abs(v - Math.round(v)) < 1e-6) return U.isoDate(v);
    return String(+v.toFixed(d.type === 'int' ? 0 : 5));
  }
  function parseBound(d, s) {
    s = String(s || '').trim();
    if (!s) return null;
    var v = d.type === 'date' ? U.parseMjdOrDate(s) : U.parseNum(s);
    return U.isNum(v) ? v : null;
  }
  F.parseBound = parseBound;
  F.toParams = function (st) {
    st = st || F.state;
    var p = new URLSearchParams();
    if (st.q) p.set('q', st.q);
    if (st.ra) p.set('ra', st.ra);
    if (st.dec) p.set('dec', st.dec);
    if (st.rad) p.set('rad', st.rad);
    F.cat.forEach(function (d) { (st.sel[d.id] || []).forEach(function (v) { p.append(d.id, v); }); });
    if (!st.srcAll && (st.sel.src || []).length) p.set('srcmode', 'any');
    F.num.forEach(function (d) {
      var r = st.rng[d.id];
      if (F.rangeActive(r)) p.set(d.id, fmtBound(d, r[0]) + '..' + fmtBound(d, r[1]));
    });
    if (st.sort) p.set('sort', st.sort);
    if (st.dir) p.set('dir', st.dir);
    if (st.cols) p.set('cols', st.cols.join(','));
    if (st.view === 'sky') p.set('view', 'sky');
    return p;
  };
  F.fromParams = function (p) {
    var st = blank();
    st.q = p.get('q') || '';
    st.ra = p.get('ra') || ''; st.dec = p.get('dec') || ''; st.rad = p.get('rad') || '';
    F.cat.forEach(function (d) {
      var vals = p.getAll(d.id);
      if (d.id === 'spec') vals = vals.map(function (v) { return v === '1' ? 'yes' : v; });   // first-release links
      var ok = {}; d.values.forEach(function (x) { ok[x.v] = 1; });
      vals = vals.filter(function (v, k) { return ok[v] && vals.indexOf(v) === k; });
      if (vals.length) st.sel[d.id] = vals;
    });
    st.srcAll = p.get('srcmode') !== 'any';
    F.num.forEach(function (d) {
      var s = p.get(d.id);
      if (s == null) return;
      var parts = s.indexOf('..') >= 0 ? s.split('..') : [s, ''];   // "a..b", "a.." or a bare minimum
      var r = [parseBound(d, parts[0]), parseBound(d, parts[1])];
      if (F.rangeActive(r)) st.rng[d.id] = r;
    });
    // parameters from the first release of the site
    function legacy(id, lo, hi) {
      var d = F.byId[id]; if (!d || st.rng[id]) return;
      var r = [lo != null ? parseBound(d, p.get(lo)) : null, hi != null ? parseBound(d, p.get(hi)) : null];
      if (F.rangeActive(r)) st.rng[id] = r;
    }
    legacy('disc', 'mjd0', 'mjd1'); legacy('mag', 'mag0', 'mag1'); legacy('z', 'z0', 'z1');
    legacy('t0', 't0a', 't0b'); legacy('t1', 't1a', 't1b'); legacy('elead', 'el0', 'el1');
    S.srcKeys.forEach(function (s) { legacy('n_' + s, 'min_' + s, null); });
    st.sort = p.get('sort') || '';
    st.dir = p.get('dir') === 'asc' || p.get('dir') === 'desc' ? p.get('dir') : '';
    var cols = p.get('cols');
    st.cols = cols ? cols.split(',').filter(Boolean) : null;
    st.view = p.get('view') === 'sky' ? 'sky' : '';
    return st;
  };

  // ------------------------------------------------------------------ evaluation
  F.cone = function (st) {
    st = st || F.state;
    var ra = U.parseRA(st.ra), dec = U.parseDec(st.dec), pair = false;
    if (st.ra && !st.dec) { var cp = U.splitCoordPair(st.ra); if (cp) { ra = U.parseRA(cp[0]); dec = U.parseDec(cp[1]); pair = true; } }
    var rad = U.parseNum(st.rad);
    var bad = { ra: st.ra !== '' && !U.isNum(ra), dec: st.dec !== '' && !pair && !U.isNum(dec), rad: st.rad !== '' && !(U.isNum(rad) && rad > 0) };
    if (U.isNum(ra) && U.isNum(dec)) return { ra: ra, dec: dec, r: U.isNum(rad) && rad > 0 ? rad : K.DEFAULT_CONE_AS, pair: pair, bad: bad };
    return { bad: bad, partial: !!(st.ra || st.dec) };
  };

  F.evaluate = function () {
    var st = F.state, N = S.N, rows = S.rows, C = S.C;
    var preds = [];
    // Names and internal names match as substrings; Rubin diaObjectIds by exact value or a prefix of 6+ digits.
    var qs = String(st.q || '').split(',').map(U.normQuery).filter(Boolean), rq = qs.map(U.isRidQuery);
    if (qs.length) preds.push({ id: 'q', test: function (i) {
      var s = S.search[i];
      for (var a = 0; a < qs.length; a++) if (s.indexOf(qs[a]) >= 0 || (rq[a] && X.ridHit(i, qs[a]))) return true;
      return false;
    } });
    var cone = F.cone(st), sep = null;
    if (U.isNum(cone.ra)) {
      sep = new Float64Array(N).fill(NaN);
      var cr = cone.r / 3600, jra = C.ra, jdec = C.dec;
      var cosd = Math.cos(Math.min(90, Math.abs(cone.dec) + cr) * Math.PI / 180);
      preds.push({ id: 'cone', test: function (i) {
        var r = rows[i];
        if (Math.abs(r[jdec] - cone.dec) > cr) return false;
        var dra = Math.abs(r[jra] - cone.ra); if (dra > 180) dra = 360 - dra;
        if (dra * cosd > cr + 1e-9) return false;
        var d = U.sepDeg(cone.ra, cone.dec, r[jra], r[jdec]);
        if (d > cr) return false;
        sep[i] = d * 3600;
        return true;
      } });
    }
    F.cat.forEach(function (d) {
      var sel = st.sel[d.id];
      if (!sel || !sel.length) return;
      var set = new Set(sel);
      if (d.multi) {
        var all = st.srcAll;
        preds.push({ id: d.id, test: function (i) {
          var have = d.get(i), hit = 0;
          for (var a = 0; a < have.length; a++) if (set.has(have[a])) hit++;
          return all ? hit === set.size : hit > 0;
        } });
      } else preds.push({ id: d.id, test: function (i) { return set.has(d.get(i)); } });
    });
    F.num.forEach(function (d) {
      var r = st.rng[d.id];
      if (!F.rangeActive(r)) return;
      var lo = r[0], hi = r[1];
      preds.push({ id: d.id, test: function (i) {
        var v = d.get(i);
        if (!U.isNum(v)) return false;
        return (!U.isNum(lo) || v >= lo) && (!U.isNum(hi) || v <= hi);
      } });
    });

    // Per row: how many filters it fails (0, 1 or 2 = "two or more") and, when exactly one, which.
    var fails = new Uint8Array(N), which = new Int16Array(N).fill(-1), result = [], np = preds.length, at = {};
    preds.forEach(function (p, k) { at[p.id] = k; });
    for (var i = 0; i < N; i++) {
      var nf = 0;
      for (var a = 0; a < np && nf < 2; a++) if (!preds[a].test(i)) { nf++; which[i] = a; }
      fails[i] = nf;
      if (nf === 0) result.push(i);
    }
    // facet counts: every other filter applies
    var counts = {}, fg = {};
    F.cat.forEach(function (d) { counts[d.id] = {}; });
    F.num.forEach(function (d) { fg[d.id] = new Array(d.edges.length - 1).fill(0); });
    var srcD = F.byId.src, srcAnd = st.srcAll && (st.sel.src || []).length > 0;
    var own = function (d) { return at[d.id] === undefined ? -2 : at[d.id]; };
    var catOwn = F.cat.map(own), numOwn = F.num.map(own);
    for (i = 0; i < N; i++) {
      var nfi = fails[i], w = which[i];
      if (nfi > 1) continue;                                   // fails two or more filters
      for (a = 0; a < F.cat.length; a++) {
        var d = F.cat[a];
        if (nfi && w !== catOwn[a]) continue;
        if (d === srcD && srcAnd && nfi) continue;             // AND: adding a source never rescues a row
        var c = counts[d.id], v = d.get(i);
        if (d.multi) { for (var b = 0; b < v.length; b++) c[v[b]] = (c[v[b]] || 0) + 1; }
        else c[v] = (c[v] || 0) + 1;
      }
      for (a = 0; a < F.num.length; a++) {
        var n = F.num[a];
        if (nfi && w !== numOwn[a]) continue;
        var x = n.get(i);
        if (U.isNum(x)) fg[n.id][binOf(n.edges, x)]++;
      }
    }
    var sk = st.sort, dir;
    if (!sk) sk = sep ? '_sep' : '_npts';
    if (sk === '_sep' && !sep) sk = '_npts';
    if (sk !== '_sep' && sk !== 'name' && sk !== '_npts' && !U.has(sk)) sk = '_npts';
    dir = st.dir === 'asc' ? 1 : st.dir === 'desc' ? -1 : F.naturalDir(sk);
    F.last = { result: F.sortRows(result, sk, dir, sep), counts: counts, fg: fg, sep: sep, cone: cone, sortKey: sk, sortDir: dir };
    return F.last;
  };

  // Total measurements (detections + forced photometry) across every source, per row.
  var nTot = null;
  F.nTot = function (i) {
    if (!nTot) {
      nTot = new Float64Array(S.N);
      var js = S.srcKeys.map(function (k) { return S.C['n_' + k]; }).filter(function (j) { return j != null; });
      for (var r = 0; r < S.N; r++) { var s = 0; for (var a = 0; a < js.length; a++) s += S.rows[r][js[a]] || 0; nTot[r] = s; }
    }
    return nTot[i];
  };
  var ASC_DEFAULT = { name: 1, type: 1, group: 1, _sep: 1, disc_mag: 1, edp2_sep: 1 };
  F.naturalDir = function (k) { return ASC_DEFAULT[k] || /^t0_/.test(k) ? 1 : -1; };
  F.sortRows = function (idx, key, dir, sep) {
    var get;
    if (key === '_sep') get = function (i) { return sep ? sep[i] : null; };
    else if (key === 'name') get = function (i) { return S.nameKey[i]; };
    else if (key === '_npts') get = F.nTot;
    else { var j = S.C[key]; get = function (i) { return S.rows[i][j]; }; }
    var jd = S.C.disc_mjd;
    var arr = idx.map(function (i) { return [get(i), i]; });
    function tie(i1, i2) { return (S.rows[i2][jd] || 0) - (S.rows[i1][jd] || 0) || i1 - i2; }
    arr.sort(function (a, b) {
      var x = a[0], y = b[0];
      var xn = x == null || x === '' || (typeof x === 'number' && isNaN(x));
      var yn = y == null || y === '' || (typeof y === 'number' && isNaN(y));
      if (xn || yn) { if (xn && yn) return tie(a[1], b[1]); return xn ? 1 : -1; }   // empty values last either way
      var c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
      return c !== 0 ? c * dir : tie(a[1], b[1]);
    });
    return arr.map(function (a) { return a[1]; });
  };
  F.activeCount = function (st) {
    st = st || F.state;
    var n = 0;
    if (st.q) n++;
    if (U.isNum(F.cone(st).ra)) n++;
    F.cat.forEach(function (d) { n += (st.sel[d.id] || []).length; });
    F.num.forEach(function (d) { if (F.rangeActive(st.rng[d.id])) n++; });
    return n;
  };
})();
