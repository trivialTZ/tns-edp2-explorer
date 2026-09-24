/* TNS x EDP2 Explorer: vanilla JS, no build step.
 *
 * Data arrives through <script> tags that call window.TNSX (SCHEMA.md section 2),
 * so the site works over https and from file://. Views are hash routes:
 *   #/?<filters>        search panel + object list
 *   #/object/<name>     object page with lightcurve
 *   #/about             sources, stats, notes, credits
 */
(function () {
  'use strict';

  // ------------------------------------------------------------------ constants
  var PLOTLY_URL = 'https://cdn.jsdelivr.net/npm/plotly.js-dist-min@3.7.0/plotly.min.js';
  var PLOTLY_SRI = 'sha384-l4G4qURPwALv583BKlynU/4LiUx0rk9jcTX58Aq+Jc+jgWb52zeH2geZkSS3UPPs';
  var ZP = 31.4;                  // AB mag of 1 nJy
  var TICK_RADIUS_DEG = 1.75;     // pointing ticks: visit centre within this radius
  var DEFAULT_MATCH_R = 2.0;      // arcsec, common.MATCH_RADIUS_AS
  var SHARD_SIZE = 100;
  var MJD_UNIX = 40587;           // MJD of 1970-01-01
  var DEFAULT_CONE_AS = 10;
  var PAGE_SIZES = [50, 100, 250, 500];
  var PRIVATE_BANNER = 'PROPRIETARY Rubin DP2 data. For Rubin data-rights holders only. Do not redistribute.';

  // Band families (SCHEMA.md "Band labels"). LSST u..y use Rubin-like hues,
  // re-stepped per theme so both pass the palette checks; other families sit
  // near the LSST band closest in wavelength.
  var FAMILIES = ['u', 'g', 'r', 'i', 'z', 'y', 'o', 'c', 'w', 'L', 'V', 'B', 'R', 'I', 'Clear', 'other'];
  var FAM_COLORS = {
    light: { u: '#1f6fe0', g: '#45b35f', r: '#b3261a', i: '#b88300', z: '#d23d98', y: '#8a3b2c',
      o: '#e0701a', c: '#1799a8', w: '#5b5fc7', L: '#8e44ad', V: '#6b8e23', B: '#2340a0', R: '#d9534f',
      I: '#7a5c00', Clear: '#39414c', other: '#9aa0a8' },
    dark: { u: '#4a8cf0', g: '#38aa63', r: '#c23624', i: '#b39015', z: '#d45aa6', y: '#bb6533',
      o: '#e07a2a', c: '#2bb3c0', w: '#8185e0', L: '#b07cd0', V: '#93b340', B: '#6f86e0', R: '#e8706b',
      I: '#d9b550', Clear: '#cfd5dd', other: '#6f7782' }
  };
  var FAM_EXACT = { R: 'R', I: 'I', V: 'V', B: 'B', L: 'L' };
  var FAM_LOWER = { u: 'u', g: 'g', r: 'r', i: 'i', z: 'z', y: 'y', o: 'o', c: 'c', w: 'w', v: 'V', b: 'B', l: 'L', clear: 'Clear' };

  // Marker per source (filled = detections, open = forced photometry of the same survey).
  var SRC_SYMBOL = { edp2_dia: 'circle', edp2_fp: 'circle-open', lsst_alert: 'diamond', lsst_alert_fp: 'diamond-open',
    ztf: 'square', ztf_fp: 'square-open', tns: 'star' };
  var EXTRA_SYMBOLS = ['triangle-up', 'pentagon', 'hexagon', 'cross', 'x', 'hourglass'];
  var LIMIT_SYMBOL = 'triangle-down-open';
  var SRC_SHORT = { edp2_dia: 'EDP2 DIA', edp2_fp: 'EDP2 forced', lsst_alert: 'LSST alerts', lsst_alert_fp: 'LSST alert FP',
    ztf: 'ZTF', ztf_fp: 'ZTF forced', tns: 'TNS' };
  var KIND_LABEL = ['detection', 'forced', 'upper limit'];

  // Columns the object header knows how to show; anything else is listed as key: value.
  var KNOWN_COLS = ['name', 'prefix', 'ra', 'dec', 'type', 'z', 'group', 'disc_mjd', 'disc_mag', 'disc_filter', 'internal',
    'n_visits', 'n_visits_active', 'alert_ids', 'shard', 'n_spec', 'spec_types',
    'edp2_id', 'edp2_sep', 'edp2_ndia', 'edp2_lead', 'edp2_tc'];

  // ------------------------------------------------------------------ state
  var S = {
    catalogRaw: null, meta: {}, cols: [], rows: [], C: {}, N: 0,
    byName: new Map(), search: [], nameKey: [],
    srcKeys: [], isPrivate: false, matchR: DEFAULT_MATCH_R,
    types: [], groups: [],
    filtered: [], sep: null, filterSpec: null,
    sortKey: 'disc_mjd', sortDir: -1, page: 0, pageSize: 100,
    listQuery: null, view: null, curObj: null, lastObj: null,
    visits: null, visitsState: 'idle', nearCache: new Map(),
    shards: {}, shardPromises: {},
    plotlyPromise: null,
    lc: { srcOff: new Set(), famOff: new Set(), showUL: true, showFP: true, snCut: true, y: 'flux', x: 'mjd', ticks: true },
    obj: null, // per-object plot data {i, name, pts, bands, srcs, near}
    theme: 'auto'
  };

  // ------------------------------------------------------------------ data callbacks (before any data script)
  var TNSX = window.TNSX = window.TNSX || {};
  TNSX.onCatalog = function (d) { S.catalogRaw = d; };
  TNSX.onVisits = function (d) { ingestVisits(d); };
  TNSX.onShard = function (n, d) { S.shards[Number(n)] = d || {}; };

  // ------------------------------------------------------------------ small helpers
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function fx(v, d) { return isNum(v) ? v.toFixed(d) : ''; }
  function fint(v) { return isNum(v) ? Math.round(v).toLocaleString('en-US') : ''; }
  function pad3(n) { return ('00' + n).slice(-3); }
  function mjdDate(mjd) { return new Date((mjd - MJD_UNIX) * 86400000); }
  function isoDate(mjd) { return isNum(mjd) ? mjdDate(mjd).toISOString().slice(0, 10) : ''; }
  function isoDateTime(mjd) { return isNum(mjd) ? mjdDate(mjd).toISOString().slice(0, 16).replace('T', ' ') : ''; }
  function dateToMjd(y, m, d, hh, mm, ss) { return Date.UTC(y, m - 1, d, hh || 0, mm || 0, ss || 0) / 86400000 + MJD_UNIX; }
  function mag(f) { return f > 0 ? ZP - 2.5 * Math.log10(f) : null; }
  function flux(m) { return Math.pow(10, (ZP - m) / 2.5); }
  function srcLabel(k) { var s = S.meta.sources && S.meta.sources[k]; return (s && s.label) || k; }
  function srcShort(k) { return SRC_SHORT[k] || (S.meta.sources && S.meta.sources[k] && S.meta.sources[k].label) || k; }
  function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
  function isDark() {
    var t = document.documentElement.getAttribute('data-theme');
    if (t === 'dark') return true;
    if (t === 'light') return false;
    return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  }
  function famColor(f) { return FAM_COLORS[isDark() ? 'dark' : 'light'][f] || FAM_COLORS.light.other; }
  function lsGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* private window */ } }
  function ssGet(k) { try { return window.sessionStorage.getItem(k); } catch (e) { return null; } }
  function ssSet(k, v) { try { window.sessionStorage.setItem(k, v); } catch (e) { /* storage blocked */ } }
  function debounce(fn, ms) { var t; return function () { var a = arguments; clearTimeout(t); t = setTimeout(function () { fn.apply(null, a); }, ms); }; }
  function V(i, c) { var j = S.C[c]; return j === undefined ? undefined : S.rows[i][j]; }
  function has(c) { return S.C[c] !== undefined; }
  function fullName(i) { var p = V(i, 'prefix'); return (p ? p + ' ' : '') + V(i, 'name'); }

  var famCache = new Map();
  function famOf(tok) {
    if (!tok) return null;
    if (FAM_EXACT[tok]) return FAM_EXACT[tok];
    return FAM_LOWER[tok.toLowerCase()] || null;
  }
  function bandFamily(band) {
    if (famCache.has(band)) return famCache.get(band);
    var parts = String(band == null ? '' : band).split('-');
    var f = famOf(parts[parts.length - 1].trim());
    if (!f && parts.length > 1) f = famOf(parts[0].trim());   // tolerate "o-ATLAS" order too
    f = f || 'other';
    famCache.set(band, f);
    return f;
  }

  // sexagesimal with rounding carried through seconds -> minutes -> degrees/hours
  function sexa(v, secDigits) {
    var a = Math.abs(v), d = Math.floor(a), m = Math.floor((a - d) * 60);
    var sec = +(((a - d) * 60 - m) * 60).toFixed(secDigits);
    if (sec >= 60) { sec -= 60; m += 1; }
    if (m >= 60) { m -= 60; d += 1; }
    return [d, m, (sec < 10 ? '0' : '') + sec.toFixed(secDigits)];
  }
  function raHms(ra) {
    if (!isNum(ra)) return '';
    var p = sexa((((ra % 360) + 360) % 360) / 15, 2);
    return pad2(p[0] % 24) + ':' + pad2(p[1]) + ':' + p[2];
  }
  function decDms(dec) {
    if (!isNum(dec)) return '';
    var p = sexa(dec, 1);
    return (dec < 0 ? '-' : '+') + pad2(p[0]) + ':' + pad2(p[1]) + ':' + p[2];
  }
  function fmtBuilt(b) {
    if (!b) return '';
    var d = new Date(b);
    return isNaN(d) ? String(b) : d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function sepDeg(ra1, dec1, ra2, dec2) {
    var r = Math.PI / 180, dra = (ra2 - ra1) * r, dd = (dec2 - dec1) * r;
    var a = Math.sin(dd / 2) * Math.sin(dd / 2) + Math.cos(dec1 * r) * Math.cos(dec2 * r) * Math.sin(dra / 2) * Math.sin(dra / 2);
    return 2 * Math.asin(Math.min(1, Math.sqrt(a))) / r;
  }

  // TNS names sort chronologically as year, then name length, then letters (2025z < 2025aa).
  function tnsNameKey(n) {
    var m = /^(\d{4})([a-z]+)$/i.exec(n || '');
    return m ? m[1] + pad2(m[2].length) + m[2].toLowerCase() : '9999' + String(n || '');
  }
  function normQuery(s) {
    s = String(s || '').toLowerCase().replace(/\s+/g, '');
    return /^(sn|at)\d{4}/.test(s) ? s.slice(2) : s;
  }

  // ------------------------------------------------------------------ parsing user input
  function parseSexa(s) {
    s = s.trim();
    var sign = 1;
    if (/^[-+]/.test(s)) { if (s[0] === '-') sign = -1; s = s.slice(1).trim(); }
    var parts = s.split(/[\s:hHdDmMsSº°'′"″]+/).filter(Boolean);
    if (!parts.length || parts.length > 3) return null;
    for (var k = 0; k < parts.length; k++) if (!/^(\d+\.?\d*|\.\d+)$/.test(parts[k])) return null;
    var a = +parts[0], b = parts.length > 1 ? +parts[1] : 0, c = parts.length > 2 ? +parts[2] : 0;
    if (b >= 60 || c >= 60) return null;
    return { sign: sign, val: a + b / 60 + c / 3600 };
  }
  function cleanCoord(s) { return String(s || '').replace(/[−–—]/g, '-').trim(); }
  function isSexaStr(s) { return /[:hHmMsS'′"″]|\d\s+\d/.test(s) || /\d[dD°º]\s*\d/.test(s); }
  function parseRA(s) {
    s = cleanCoord(s);
    if (!s) return null;
    var v;
    if (!isSexaStr(s)) {
      v = Number(s.replace(/\s*(deg|[dD°º])$/, ''));
    } else {
      var p = parseSexa(s);
      if (!p || p.sign < 0) return NaN;
      v = /[dD°º]/.test(s) && !/[hH]/.test(s) ? p.val : p.val * 15;
    }
    return isFinite(v) && v >= 0 && v < 360 ? v : NaN;
  }
  function parseDec(s) {
    s = cleanCoord(s);
    if (!s) return null;
    var v;
    if (!isSexaStr(s)) v = Number(s.replace(/\s*(deg|[dD°º])$/, ''));
    else { var p = parseSexa(s); if (!p) return NaN; v = p.sign * p.val; }
    return isFinite(v) && v >= -90 && v <= 90 ? v : NaN;
  }
  // Accept "RA Dec" pasted into the RA box.
  function splitCoordPair(s) {
    s = cleanCoord(s);
    if (s.indexOf(',') >= 0) { var q = s.split(','); if (q.length === 2) return [q[0], q[1]]; }
    var m = /^(\S+)\s+([-+]\S+)$/.exec(s);
    if (m) return [m[1], m[2]];
    var t = s.split(/\s+/);
    if (t.length === 2 && !isSexaStr(t[0]) && !isSexaStr(t[1])) return [t[0], t[1]];
    if (t.length === 6) return [t.slice(0, 3).join(' '), t.slice(3).join(' ')];
    return null;
  }
  function parseNum(s) {
    s = String(s == null ? '' : s).trim();
    if (!s) return null;
    var v = Number(s);
    return isFinite(v) ? v : NaN;
  }
  // MJD or calendar date (YYYY-MM-DD[ HH:MM[:SS]]).
  function parseMjdOrDate(s) {
    s = String(s == null ? '' : s).trim();
    if (!s) return null;
    var m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}(?:\.\d*)?))?)?Z?$/.exec(s);
    if (m) return dateToMjd(+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
    var v = Number(s);
    return isFinite(v) ? v : NaN;
  }

  // ------------------------------------------------------------------ script loading
  function loadScript(src, opts) {
    return new Promise(function (resolve, reject) {
      var el = document.createElement('script');
      el.src = src;
      el.async = true;
      if (opts && opts.integrity) { el.integrity = opts.integrity; el.crossOrigin = 'anonymous'; }
      el.onload = function () { resolve(); };
      el.onerror = function () { el.remove(); reject(new Error('could not load ' + src)); };
      document.head.appendChild(el);
    });
  }
  function loadShard(n) {
    if (S.shards[n]) return Promise.resolve(S.shards[n]);
    if (S.shardPromises[n]) return S.shardPromises[n];
    var src = 'data/lc/' + pad3(n) + '.js';
    var p = loadScript(src).then(function () {
      if (!S.shards[n]) throw new Error(src + ' loaded but did not call TNSX.onShard(' + n + ', …)');
      return S.shards[n];
    });
    S.shardPromises[n] = p;
    p.catch(function () { delete S.shardPromises[n]; });
    return p;
  }
  function ensurePlotly() {
    if (window.Plotly) return Promise.resolve(window.Plotly);
    if (!S.plotlyPromise) {
      S.plotlyPromise = loadScript(PLOTLY_URL, { integrity: PLOTLY_SRI }).then(function () {
        if (!window.Plotly) throw new Error('Plotly did not initialise');
        return window.Plotly;
      });
      S.plotlyPromise.catch(function () { S.plotlyPromise = null; });
    }
    return S.plotlyPromise;
  }
  function loadVisits() {
    if (S.visitsState !== 'idle') return;
    S.visitsState = 'loading';
    loadScript('data/visits.js').then(function () {
      if (!S.visits) throw new Error('visits.js did not call TNSX.onVisits');
    }).catch(function (e) {
      S.visitsState = 'error';
      console.warn(e.message);
      if (S.view === 'object') updatePlot();
    });
  }
  function ingestVisits(d) {
    var cols = (d && d.cols) || ['mjd', 'band', 'ra', 'dec'];
    var rows = (d && d.rows) || [];
    var im = cols.indexOf('mjd'), ib = cols.indexOf('band'), ir = cols.indexOf('ra'), id = cols.indexOf('dec');
    var n = rows.length, r = Math.PI / 180;
    var v = { n: n, mjd: new Float64Array(n), band: new Array(n), x: new Float64Array(n), y: new Float64Array(n), z: new Float64Array(n) };
    for (var k = 0; k < n; k++) {
      var row = rows[k], ra = row[ir] * r, dec = row[id] * r;
      v.mjd[k] = row[im];
      v.band[k] = row[ib];
      v.x[k] = Math.cos(dec) * Math.cos(ra); v.y[k] = Math.cos(dec) * Math.sin(ra); v.z[k] = Math.sin(dec);
    }
    S.visits = v;
    S.visitsState = 'ready';
    S.nearCache.clear();
    if (S.view === 'object' && S.obj) { S.obj.near = null; updatePlot(); }
  }
  function nearbyVisits(i) {
    if (!S.visits) return null;
    if (S.nearCache.has(i)) return S.nearCache.get(i);
    var r = Math.PI / 180, ra = V(i, 'ra') * r, dec = V(i, 'dec') * r;
    var ox = Math.cos(dec) * Math.cos(ra), oy = Math.cos(dec) * Math.sin(ra), oz = Math.sin(dec);
    var cmin = Math.cos(TICK_RADIUS_DEG * r), v = S.visits, out = [];
    for (var k = 0; k < v.n; k++) {
      var c = ox * v.x[k] + oy * v.y[k] + oz * v.z[k];
      if (c >= cmin) out.push({ mjd: v.mjd[k], band: v.band[k], sep: Math.acos(Math.min(1, c)) / r });
    }
    S.nearCache.set(i, out);
    return out;
  }

  // ------------------------------------------------------------------ boot
  function boot() {
    initTheme();
    loadScript('data/catalog.js').then(function () {
      if (!S.catalogRaw) throw new Error('data/catalog.js loaded but did not call TNSX.onCatalog');
      initCatalog(S.catalogRaw);
      S.catalogRaw = null;
      buildListView();
      buildAboutView();
      // The object page's prev/next walks the current list, so build it even when the
      // first route is an object page (restoring this tab's last list if there was one).
      var h = location.hash || '';
      var q0 = h.indexOf('#/object/') === 0 ? (ssGet('tnsx-list') || '') : null;
      if (q0 != null) {
        paramsToForm(new URLSearchParams(q0));
        S.listQuery = q0;
        applyFilters({ keepPage: false });
        updateNavLinks();
      }
      window.addEventListener('hashchange', route);
      document.addEventListener('keydown', onKey);
      route();
      var idle = window.requestIdleCallback || function (f) { return setTimeout(f, 400); };
      idle(loadVisits);
    }).catch(function (e) {
      console.error(e);
      $('#view-loading').innerHTML = '<div class="error-box"><strong>Could not load the catalog.</strong><br>' +
        esc(e.message) + '.<br>Expected <code>data/catalog.js</code> next to <code>index.html</code>; ' +
        'it is written by <code>build/assemble.py</code> (or <code>build/make_fixture.py</code> for test data).</div>';
    });
  }

  function initCatalog(d) {
    S.meta = d.meta || {};
    S.cols = d.cols || [];
    S.rows = d.rows || [];
    S.N = S.rows.length;
    S.cols.forEach(function (c, j) { S.C[c] = j; });
    S.isPrivate = S.meta.mode === 'private';
    S.matchR = isNum(S.meta.match_radius_arcsec) ? S.meta.match_radius_arcsec : DEFAULT_MATCH_R;
    S.srcKeys = Object.keys(S.meta.sources || {}).filter(function (k) { return has('n_' + k); });

    var jn = S.C.name, ji = S.C.internal, jt = S.C.type, jg = S.C.group;
    var tc = new Map(), gc = new Map();
    for (var i = 0; i < S.N; i++) {
      var r = S.rows[i], name = String(r[jn]);
      S.byName.set(name, i);
      S.byName.set(name.toLowerCase(), i);
      var internal = ji === undefined ? '' : String(r[ji] || '');
      S.search[i] = '|' + name.toLowerCase() + '|' + internal.toLowerCase().replace(/\s+/g, '').split(',').join('|') + '|';
      S.nameKey[i] = tnsNameKey(name);
      var t = jt === undefined ? null : r[jt];
      var tk = t == null || t === '' ? '__none__' : String(t);
      tc.set(tk, (tc.get(tk) || 0) + 1);
      var g = jg === undefined ? '' : String(r[jg] == null ? '' : r[jg]);
      gc.set(g, (gc.get(g) || 0) + 1);
    }
    S.types = Array.from(tc.entries()).sort(function (a, b) {
      if (a[0] === '__none__') return -1; if (b[0] === '__none__') return 1;
      return b[1] - a[1] || a[0].localeCompare(b[0]);
    });
    S.groups = Array.from(gc.entries()).sort(function (a, b) { return b[1] - a[1] || a[0].localeCompare(b[0]); });

    if (S.isPrivate) {
      var b = $('#private-banner');
      b.textContent = PRIVATE_BANNER;
      b.hidden = false;
      document.body.classList.add('has-banner');
    }
    if (S.meta.fixture) {
      var mb = $('#mode-badge');
      mb.textContent = 'Synthetic fixture data';
      mb.hidden = false;
    }
    var built = fmtBuilt(S.meta.built);
    $('#footer-built').textContent = (built ? 'Built ' + built + ' · ' : '') + fint(S.N) + ' objects · ' +
      (S.isPrivate ? 'private build' : 'public build');
  }

  // ------------------------------------------------------------------ theme
  var THEMES = ['auto', 'light', 'dark'];
  function initTheme() {
    var t = lsGet('tnsx-theme');
    applyTheme(THEMES.indexOf(t) >= 0 ? t : 'auto');
    $('#theme-btn').addEventListener('click', function () {
      applyTheme(THEMES[(THEMES.indexOf(S.theme) + 1) % THEMES.length]);
      lsSet('tnsx-theme', S.theme);
    });
    if (window.matchMedia) {
      var mq = window.matchMedia('(prefers-color-scheme: dark)');
      var fn = function () { if (S.theme === 'auto') onThemeChanged(); };
      if (mq.addEventListener) mq.addEventListener('change', fn); else if (mq.addListener) mq.addListener(fn);
    }
  }
  function applyTheme(t) {
    S.theme = t;
    if (t === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', t);
    var label = { auto: 'Auto', light: 'Light', dark: 'Dark' }[t];
    $('#theme-label').textContent = label;
    $('#theme-btn').setAttribute('aria-label', 'Colour theme: ' + label + ' (click to change)');
    onThemeChanged();
  }
  function onThemeChanged() {
    if (S.view === 'object' && S.obj) { renderChips(); updatePlot(); }
  }

  // ------------------------------------------------------------------ routing
  function setView(v) {
    S.view = v;
    ['loading', 'list', 'object', 'about'].forEach(function (k) { $('#view-' + k).hidden = k !== v; });
    $all('.topnav a').forEach(function (a) {
      if (a.getAttribute('data-nav') === v) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
  }
  function route() {
    var h = location.hash || '#/';
    if (h.indexOf('#/object/') === 0) {
      var nm = h.slice(9).split('?')[0];
      try { nm = decodeURIComponent(nm); } catch (e) { /* keep raw */ }
      showObject(nm);
    } else if (h === '#/object') {
      if (S.lastObj != null) location.replace('#/object/' + encodeURIComponent(V(S.lastObj, 'name')));
      else location.replace(listHash());
    } else if (h.indexOf('#/about') === 0) {
      setView('about');
      document.title = 'About · TNS EDP2 Explorer';
      window.scrollTo(0, 0);
    } else {
      var q = h.indexOf('?') >= 0 ? h.slice(h.indexOf('?') + 1) : '';
      if (q !== S.listQuery) {
        paramsToForm(new URLSearchParams(q));
        S.listQuery = q;
        ssSet('tnsx-list', q);
        applyFilters({ keepPage: false });
      }
      showList();
    }
  }
  function listHash() { return '#/' + (S.listQuery ? '?' + S.listQuery : ''); }
  function updateNavLinks() {
    var h = listHash();
    $all('a[data-nav="list"], a.brand').forEach(function (a) { a.setAttribute('href', h); });
  }
  function onKey(e) {
    if (S.view !== 'object' || e.altKey || e.ctrlKey || e.metaKey) return;
    var t = e.target, tag = t && t.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || (t && t.isContentEditable)) return;
    if (e.key === 'ArrowLeft' || e.key === '[') { gotoRelative(-1) && e.preventDefault(); }
    else if (e.key === 'ArrowRight' || e.key === ']') { gotoRelative(1) && e.preventDefault(); }
  }
  function gotoObject(i) { location.hash = '#/object/' + encodeURIComponent(V(i, 'name')); }
  function gotoRelative(d) {
    var pos = S.filtered.indexOf(S.curObj);
    if (pos < 0) return false;
    var j = pos + d;
    if (j < 0 || j >= S.filtered.length) return false;
    gotoObject(S.filtered[j]);
    return true;
  }

  // ------------------------------------------------------------------ list view: search panel
  function buildListView() {
    var root = $('#view-list');
    var M = S.meta;
    var typeRows = S.types.map(function (t, k) {
      var label = t[0] === '__none__' ? '(untyped)' : t[0];
      return '<label class="check" for="ty' + k + '"><input type="checkbox" id="ty' + k + '" name="type" value="' + esc(t[0]) + '">' +
        '<span class="txt">' + esc(label) + '</span><span class="cnt">' + fint(t[1]) + '</span></label>';
    }).join('');
    var groupOpts = '<option value="">(any group)</option>' + S.groups.map(function (g) {
      return '<option value="' + esc(g[0]) + '">' + esc(g[0] || '(none)') + ' (' + fint(g[1]) + ')</option>';
    }).join('');
    var srcRows = S.srcKeys.map(function (k) {
      var s = M.sources[k] || {};
      return '<div class="src-row"><label class="check" for="src_' + esc(k) + '" title="' + esc(s.desc || '') + '">' +
        '<input type="checkbox" id="src_' + esc(k) + '" name="src" value="' + esc(k) + '">' +
        '<span class="txt">' + esc(s.label || k) + '</span><span class="cnt">' + fint(s.n_objects) + '</span></label>' +
        '<input type="number" min="1" step="1" name="min_' + esc(k) + '" id="min_' + esc(k) + '" placeholder="≥1" ' +
        'aria-label="Minimum number of points from ' + esc(s.label || k) + '"></div>';
    }).join('');

    var privateGroup = '';
    if (S.isPrivate) {
      privateGroup =
        '<fieldset class="fgroup private-group"><legend>EDP2 match (private)</legend>' +
        '<div class="row"><label class="lbl" for="f-em">Matched</label><select id="f-em" name="em" class="grow">' +
        '<option value="">(any)</option><option value="1">matched (≤ ' + S.matchR + '″)</option><option value="0">not matched</option></select></div>' +
        '<div class="row"><label class="lbl" for="f-esep">Max sep.</label><input id="f-esep" name="esep" type="number" min="0" step="0.1" placeholder="arcsec" class="grow"><span class="unit">″</span></div>' +
        '<div class="row"><label class="lbl" for="f-endia">Min nDia</label><input id="f-endia" name="endia" type="number" min="0" step="1" placeholder="DiaObject nDiaSources" class="grow"></div>' +
        '<div class="range"><label class="lbl" for="f-el0">Lead (d)</label><input id="f-el0" name="el0" type="number" step="any" placeholder="min" aria-label="Minimum EDP2 lead days">' +
        '<span class="dash">–</span><input id="f-el1" name="el1" type="number" step="any" placeholder="max" aria-label="Maximum EDP2 lead days"></div>' +
        '<p class="hint full-hint">Lead = TNS discovery − first positive EDP2 detection; &gt; 0 means EDP2 saw it first.</p>' +
        '<label class="check" for="f-etc"><input type="checkbox" id="f-etc" name="etc" value="1"><span class="txt">Time-consistent match only</span></label>' +
        '</fieldset>';
    }

    var sortOpts = sortOptions().map(function (o) { return '<option value="' + esc(o[0]) + '">' + esc(o[1]) + '</option>'; }).join('');

    root.innerHTML =
      '<div class="list-layout">' +
      '<details class="panel filters" open><summary><span>Search &amp; filters</span><span class="chev" aria-hidden="true">▾</span></summary>' +
      '<form class="filter-form" id="filter-form" autocomplete="off" novalidate>' +
      '<fieldset class="fgroup"><legend>Name</legend>' +
      '<div class="row"><label class="lbl" for="f-q">Name</label><input id="f-q" name="q" type="search" class="grow" placeholder="2025abc, ZTF25…, ATLAS25…" aria-describedby="h-q"></div>' +
      '<p class="hint" id="h-q">TNS or internal name; commas for several. Enter opens a single match.</p>' +
      '</fieldset>' +
      '<fieldset class="fgroup"><legend>Cone search</legend>' +
      '<div class="row"><label class="lbl" for="f-ra">RA</label><input id="f-ra" name="ra" type="text" class="grow" placeholder="deg or hh:mm:ss" inputmode="text"></div>' +
      '<div class="row"><label class="lbl" for="f-dec">Dec</label><input id="f-dec" name="dec" type="text" class="grow" placeholder="deg or ±dd:mm:ss"></div>' +
      '<div class="row"><label class="lbl" for="f-rad">Radius</label><input id="f-rad" name="rad" type="number" min="0" step="any" class="grow" placeholder="' + DEFAULT_CONE_AS + '"><span class="unit">arcsec</span></div>' +
      '<p class="hint" id="h-cone" aria-live="polite"></p>' +
      '</fieldset>' +
      '<fieldset class="fgroup"><legend>TNS classification</legend>' +
      '<div class="row"><span class="lbl" id="lbl-pre">Prefix</span><div class="segmented" role="radiogroup" aria-labelledby="lbl-pre">' +
      '<label><input type="radio" name="pre" value="" checked><span>Any</span></label>' +
      '<label><input type="radio" name="pre" value="SN"><span>SN</span></label>' +
      '<label><input type="radio" name="pre" value="AT"><span>AT</span></label></div></div>' +
      '<div class="typebox-tools"><span class="muted" id="lbl-types" style="font-size:12.5px">Type <span id="type-sel-n"></span></span>' +
      '<input type="search" id="type-find" placeholder="filter types" aria-label="Filter the type list"><button type="button" class="linkbtn" id="type-clear">clear</button></div>' +
      '<div class="typebox checks" role="group" aria-labelledby="lbl-types" id="typebox">' + typeRows + '</div>' +
      (has('n_spec') ? '<div class="row"><label class="check" for="f-spec"><input type="checkbox" id="f-spec" name="spec" value="1"><span class="txt">Has a TNS spectrum</span></label></div>' : '') +
      '<div class="row"><label class="lbl" for="f-grp">Group</label><select id="f-grp" name="grp" class="grow">' + groupOpts + '</select></div>' +
      '</fieldset>' +
      '<fieldset class="fgroup"><legend>Discovery</legend>' +
      '<div class="range"><label class="lbl" for="f-mjd0">Date</label><input id="f-mjd0" name="mjd0" type="text" placeholder="MJD or date" aria-label="Discovered on or after (MJD or YYYY-MM-DD)">' +
      '<span class="dash">–</span><input id="f-mjd1" name="mjd1" type="text" placeholder="MJD or date" aria-label="Discovered on or before (MJD or YYYY-MM-DD)"></div>' +
      '<p class="hint" id="h-mjd"></p>' +
      '<div class="range"><label class="lbl" for="f-mag0">Mag</label><input id="f-mag0" name="mag0" type="number" step="any" placeholder="bright" aria-label="Discovery magnitude, brightest">' +
      '<span class="dash">–</span><input id="f-mag1" name="mag1" type="number" step="any" placeholder="faint" aria-label="Discovery magnitude, faintest"></div>' +
      '<div class="range"><label class="lbl" for="f-z0">Redshift</label><input id="f-z0" name="z0" type="number" step="any" min="0" placeholder="min" aria-label="Minimum redshift">' +
      '<span class="dash">–</span><input id="f-z1" name="z1" type="number" step="any" min="0" placeholder="max" aria-label="Maximum redshift"></div>' +
      '</fieldset>' +
      '<fieldset class="fgroup"><legend>Photometry</legend>' +
      '<div class="row"><label class="lbl" for="f-srcmode">Has data</label><select id="f-srcmode" name="srcmode" class="grow"><option value="all">from all checked</option><option value="any">from any checked</option></select></div>' +
      '<div class="src-row muted" style="font-size:11.5px"><span>Source (objects)</span><span>min pts</span></div>' +
      srcRows +
      '<div class="range"><label class="lbl" for="f-t0a">First pt</label><input id="f-t0a" name="t0a" type="text" placeholder="after" aria-label="First point on or after (MJD or date)">' +
      '<span class="dash">–</span><input id="f-t0b" name="t0b" type="text" placeholder="before" aria-label="First point on or before (MJD or date)"></div>' +
      '<div class="range"><label class="lbl" for="f-t1a">Last pt</label><input id="f-t1a" name="t1a" type="text" placeholder="after" aria-label="Last point on or after (MJD or date)">' +
      '<span class="dash">–</span><input id="f-t1b" name="t1b" type="text" placeholder="before" aria-label="Last point on or before (MJD or date)"></div>' +
      '<p class="hint full-hint">First/last point uses the checked sources (all sources if none checked).</p>' +
      (has('n_visits_active') ? '<div class="row"><label class="lbl" for="f-nva">Pointings</label><input id="f-nva" name="nva" type="number" min="0" step="1" class="grow" placeholder="min active"><span class="unit" title="dp2.Visit centres within 2.1° during [disc − 30, disc + 100] d">active ≥</span></div>' : '') +
      '</fieldset>' +
      privateGroup +
      '<fieldset class="fgroup"><legend>Sort</legend>' +
      '<div class="row"><label class="lbl" for="f-sort">Sort by</label><select id="f-sort" name="sort" class="grow">' + sortOpts + '</select></div>' +
      '<div class="row"><label class="lbl" for="f-dir">Order</label><select id="f-dir" name="dir" class="grow"><option value="">(natural)</option><option value="asc">ascending</option><option value="desc">descending</option></select></div>' +
      '</fieldset>' +
      '<div class="form-actions"><button type="button" class="btn" id="btn-reset">Reset</button>' +
      '<button type="button" class="btn btn-primary" id="btn-random" title="Open a random object from the current list">Show random object</button></div>' +
      '</form></details>' +
      '<div class="panel results">' +
      '<div class="results-head"><div class="results-count" id="results-count" aria-live="polite"></div>' +
      '<div class="results-tools"><label for="page-size" class="muted" style="font-size:12.5px">Rows</label>' +
      '<select id="page-size">' + PAGE_SIZES.map(function (n) { return '<option' + (n === S.pageSize ? ' selected' : '') + '>' + n + '</option>'; }).join('') + '</select>' +
      '<button type="button" class="btn btn-sm" id="btn-csv" title="Download every row of the filtered table as CSV">' + ICON.download + 'CSV</button></div></div>' +
      '<div class="table-wrap" id="list-wrap"><table class="data" id="list-table"><thead></thead><tbody></tbody></table></div>' +
      '<div class="pager" id="pager"></div>' +
      '</div></div>';

    // On phones the filter panel starts collapsed so the list is visible without scrolling.
    if (window.matchMedia && window.matchMedia('(max-width: 700px)').matches) $('.filters', root).open = false;
    var form = $('#filter-form');
    var run = debounce(function () { applyFilters({ keepPage: false }); pushListHash(); }, 140);
    form.addEventListener('input', function (e) {
      var t = e.target;
      if (t.id === 'type-find') { filterTypeList(t.value); return; }
      if (t.name && t.name.indexOf('min_') === 0 && t.value) { var cb = $('#src_' + cssEscape(t.name.slice(4))); if (cb) cb.checked = true; }
      run();
    });
    form.addEventListener('change', function (e) { if (e.target.id !== 'type-find') run(); });
    form.addEventListener('submit', function (e) { e.preventDefault(); });
    $('#f-q').addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      applyFilters({ keepPage: false }); pushListHash();
      var q = normQuery(e.target.value);
      var exact = S.byName.get(q);
      if (exact !== undefined) gotoObject(exact);
      else if (S.filtered.length === 1) gotoObject(S.filtered[0]);
    });
    $('#type-clear').addEventListener('click', function () {
      $all('input[name="type"]', form).forEach(function (c) { c.checked = false; });
      run();
    });
    $('#btn-reset').addEventListener('click', function () {
      paramsToForm(new URLSearchParams(''));
      filterTypeList('');
      $('#type-find').value = '';
      applyFilters({ keepPage: false }); pushListHash();
    });
    $('#btn-random').addEventListener('click', function () {
      var pool = S.filtered.length ? S.filtered : null;
      if (!pool) return;
      gotoObject(pool[Math.floor(Math.random() * pool.length)]);
    });
    $('#page-size').addEventListener('change', function (e) { S.pageSize = +e.target.value; S.page = 0; renderResults(); });
    $('#btn-csv').addEventListener('click', downloadListCsv);
    $('#list-table').addEventListener('click', function (e) {
      var sb = e.target.closest('.sortbtn');
      if (sb) { onHeaderSort(sb.getAttribute('data-key')); return; }
      if (e.target.closest('a')) return;
      var tr = e.target.closest('tr[data-i]');
      if (tr) gotoObject(+tr.getAttribute('data-i'));
    });
    $('#pager').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-page]');
      if (!b || b.disabled) return;
      S.page = +b.getAttribute('data-page');
      renderResults();
      $('#list-wrap').scrollTop = 0;
    });
  }
  function cssEscape(s) { return window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^\w-]/g, '\\$&'); }
  function filterTypeList(q) {
    q = String(q || '').toLowerCase();
    $all('#typebox .check').forEach(function (l) { l.hidden = !!q && l.textContent.toLowerCase().indexOf(q) < 0; });
  }

  function sortOptions() {
    var o = [['', 'Automatic (newest, or nearest in a cone)'], ['disc_mjd', 'Discovery date'], ['name', 'Name'], ['type', 'Type'],
      ['z', 'Redshift'], ['disc_mag', 'Discovery mag'], ['group', 'Reporting group']];
    if (has('n_spec')) o.push(['n_spec', 'Number of spectra']);
    S.srcKeys.forEach(function (k) { o.push(['n_' + k, 'Points: ' + srcShort(k)]); });
    S.srcKeys.forEach(function (k) { if (has('t0_' + k)) o.push(['t0_' + k, 'First point: ' + srcShort(k)]); });
    if (has('n_visits_active')) o.push(['n_visits_active', 'Active pointings']);
    if (S.isPrivate) {
      if (has('edp2_sep')) o.push(['edp2_sep', 'EDP2 separation']);
      if (has('edp2_ndia')) o.push(['edp2_ndia', 'EDP2 nDiaSources']);
      if (has('edp2_lead')) o.push(['edp2_lead', 'EDP2 lead days']);
    }
    o.push(['_sep', 'Cone separation']);
    return o;
  }
  var ASC_DEFAULT = { name: 1, type: 1, group: 1, _sep: 1, disc_mag: 1, edp2_sep: 1 };
  function naturalDir(k) { return ASC_DEFAULT[k] || /^t0_/.test(k) ? 1 : -1; }

  // ------------------------------------------------------------------ form <-> URL params
  function formToParams() {
    var form = $('#filter-form');
    var p = new URLSearchParams();
    $all('input, select', form).forEach(function (el) {
      if (!el.name) return;
      if (el.type === 'checkbox' || el.type === 'radio') { if (el.checked && el.value !== '') p.append(el.name, el.value); }
      else if (String(el.value).trim() !== '') {
        if (el.name === 'srcmode' && el.value === 'all') return;
        p.append(el.name, String(el.value).trim());
      }
    });
    return p;
  }
  function paramsToForm(p) {
    var form = $('#filter-form');
    $all('input, select', form).forEach(function (el) {
      if (!el.name) return;
      if (el.type === 'checkbox') el.checked = p.getAll(el.name).indexOf(el.value) >= 0;
      else if (el.type === 'radio') el.checked = (p.get(el.name) || '') === el.value;
      else if (el.tagName === 'SELECT') {
        var v = p.get(el.name);
        el.value = v == null ? (el.name === 'srcmode' ? 'all' : '') : v;
        if (el.selectedIndex < 0) el.selectedIndex = 0;
      } else el.value = p.get(el.name) || '';
    });
  }
  function pushListHash() {
    var q = formToParams().toString();
    S.listQuery = q;
    ssSet('tnsx-list', q);
    var h = listHash();
    updateNavLinks();
    if (S.view === 'list' && location.hash !== h && !(h === '#/' && !location.hash)) location.replace(h);
  }

  // ------------------------------------------------------------------ filtering
  function readFilters() {
    var form = $('#filter-form');
    var get = function (n) { var el = form.elements[n]; return el ? el.value : ''; };
    var f = { errors: {} };
    function mark(id, bad) { var el = document.getElementById(id); if (el) el.classList.toggle('invalid', !!bad); }

    var q = String(get('q') || '').split(',').map(normQuery).filter(Boolean);
    f.q = q.length ? q : null;

    // cone
    var raS = get('ra'), decS = get('dec'), ra = parseRA(raS), dec = parseDec(decS), pairNote = '';
    if (raS && !decS) {
      var pair = splitCoordPair(raS);
      if (pair) { ra = parseRA(pair[0]); dec = parseDec(pair[1]); pairNote = ' (RA and Dec read from the RA box)'; }
    }
    var rad = parseNum(get('rad'));
    mark('f-ra', isNaN(ra)); mark('f-dec', isNaN(dec) && !pairNote); mark('f-rad', isNaN(rad) || rad < 0);
    var hc = $('#h-cone');
    if (isNum(ra) && isNum(dec)) {
      f.cone = { ra: ra, dec: dec, r: isNum(rad) && rad > 0 ? rad : DEFAULT_CONE_AS };
      hc.className = 'hint';
      hc.textContent = ra.toFixed(5) + '°, ' + (dec >= 0 ? '+' : '') + dec.toFixed(5) + '° = ' + raHms(ra) + ' ' + decDms(dec) +
        ' · r = ' + f.cone.r + '″' + pairNote;
    } else if (raS || decS) {
      hc.className = 'hint err';
      hc.textContent = isNaN(ra) || isNaN(dec) ? 'Could not read the coordinates (RA 0–360° or hh:mm:ss, Dec ±90° or ±dd:mm:ss).' : 'Give both RA and Dec.';
    } else { hc.textContent = ''; }

    // classification
    var types = $all('input[name="type"]:checked', form).map(function (c) { return c.value; });
    f.types = types.length ? new Set(types) : null;
    $('#type-sel-n').textContent = types.length ? '(' + types.length + ' selected)' : '';
    var pre = form.querySelector('input[name="pre"]:checked');
    f.pre = pre ? pre.value : '';
    f.grp = get('grp');
    f.grpSet = f.grp !== '';
    f.spec = !!(form.elements.spec && form.elements.spec.checked);

    // discovery
    f.mjd0 = parseMjdOrDate(get('mjd0')); f.mjd1 = parseMjdOrDate(get('mjd1'));
    mark('f-mjd0', isNaN(f.mjd0)); mark('f-mjd1', isNaN(f.mjd1));
    var hm = [];
    if (isNum(f.mjd0)) hm.push('from ' + (/-/.test(get('mjd0')) ? 'MJD ' + f.mjd0.toFixed(2) : isoDateTime(f.mjd0)));
    if (isNum(f.mjd1)) hm.push('to ' + (/-/.test(get('mjd1')) ? 'MJD ' + f.mjd1.toFixed(2) : isoDateTime(f.mjd1)));
    $('#h-mjd').textContent = hm.length ? hm.join(' ') + ' (UTC)' : '';
    f.mag0 = parseNum(get('mag0')); f.mag1 = parseNum(get('mag1'));
    f.z0 = parseNum(get('z0')); f.z1 = parseNum(get('z1'));
    ['mag0', 'mag1', 'z0', 'z1'].forEach(function (k) { mark('f-' + k, isNaN(f[k])); });

    // photometry
    f.src = [];
    S.srcKeys.forEach(function (k) {
      var cb = document.getElementById('src_' + k);
      var mn = parseNum(get('min_' + k));
      mark('min_' + k, isNaN(mn));
      if (cb && cb.checked) f.src.push({ j: S.C['n_' + k], min: isNum(mn) && mn > 1 ? mn : 1, k: k });
    });
    f.srcAny = get('srcmode') === 'any';
    f.t0a = parseMjdOrDate(get('t0a')); f.t0b = parseMjdOrDate(get('t0b'));
    f.t1a = parseMjdOrDate(get('t1a')); f.t1b = parseMjdOrDate(get('t1b'));
    ['t0a', 't0b', 't1a', 't1b'].forEach(function (k) { mark('f-' + k, isNaN(f[k])); });
    f.tRange = isNum(f.t0a) || isNum(f.t0b) || isNum(f.t1a) || isNum(f.t1b);
    var tk = (f.src.length ? f.src.map(function (s) { return s.k; }) : S.srcKeys);
    f.t0cols = tk.map(function (k) { return S.C['t0_' + k]; }).filter(function (j) { return j !== undefined; });
    f.t1cols = tk.map(function (k) { return S.C['t1_' + k]; }).filter(function (j) { return j !== undefined; });
    f.nva = parseNum(get('nva'));
    mark('f-nva', isNaN(f.nva));

    if (S.isPrivate) {
      f.em = get('em');
      f.esep = parseNum(get('esep')); f.endia = parseNum(get('endia'));
      f.el0 = parseNum(get('el0')); f.el1 = parseNum(get('el1'));
      f.etc = !!(form.elements.etc && form.elements.etc.checked);
      ['esep', 'endia', 'el0', 'el1'].forEach(function (k) { mark('f-' + k, isNaN(f[k])); });
    }

    // sort
    var sk = get('sort'), sd = get('dir');
    if (!sk) sk = f.cone ? '_sep' : 'disc_mjd';
    if (sk === '_sep' && !f.cone) sk = 'disc_mjd';
    if (sk !== '_sep' && sk !== 'name' && !has(sk)) sk = 'disc_mjd';
    f.sortKey = sk;
    f.sortDir = sd === 'asc' ? 1 : sd === 'desc' ? -1 : naturalDir(sk);
    return f;
  }

  function isMatched(i) {
    var id = V(i, 'edp2_id'), sp = V(i, 'edp2_sep');
    return id != null && id !== '' && (!isNum(sp) || sp <= S.matchR);
  }

  function applyFilters(opts) {
    var f = readFilters();
    S.filterSpec = f;
    var C = S.C, rows = S.rows, N = S.N, out = [];
    var sep = f.cone ? new Float64Array(N).fill(NaN) : null;
    var jra = C.ra, jdec = C.dec, jt = C.type, jp = C.prefix, jg = C.group, jd = C.disc_mjd, jm = C.disc_mag, jz = C.z,
      jns = C.n_spec, jnva = C.n_visits_active;
    var num = function (v) { return typeof v === 'number' && isFinite(v); };
    var coneR = f.cone ? f.cone.r / 3600 : 0;
    // smallest cos(dec) inside the cone's dec band: RA offsets beyond coneR / cosd cannot match
    var cosd = f.cone ? Math.cos(Math.min(90, Math.abs(f.cone.dec) + coneR) * Math.PI / 180) : 1;
    for (var i = 0; i < N; i++) {
      var r = rows[i];
      if (f.q) {
        var s = S.search[i], ok = false;
        for (var a = 0; a < f.q.length; a++) if (s.indexOf(f.q[a]) >= 0) { ok = true; break; }
        if (!ok) continue;
      }
      if (f.cone) {
        var ddec = Math.abs(r[jdec] - f.cone.dec);
        if (ddec > coneR) continue;
        var dra = Math.abs(r[jra] - f.cone.ra); if (dra > 180) dra = 360 - dra;
        if (dra * cosd > coneR + 1e-9) continue;
        var d = sepDeg(f.cone.ra, f.cone.dec, r[jra], r[jdec]);
        if (d > coneR) continue;
        sep[i] = d * 3600;
      }
      if (f.types) { var t = r[jt]; if (!f.types.has(t == null || t === '' ? '__none__' : String(t))) continue; }
      if (f.pre && r[jp] !== f.pre) continue;
      if (f.grpSet && String(r[jg] == null ? '' : r[jg]) !== f.grp) continue;
      if (f.spec && !(r[jns] > 0)) continue;
      if (num(f.mjd0) && !(r[jd] >= f.mjd0)) continue;
      if (num(f.mjd1) && !(r[jd] <= f.mjd1)) continue;
      if (num(f.mag0) && !(r[jm] >= f.mag0)) continue;
      if (num(f.mag1) && !(r[jm] <= f.mag1)) continue;
      if (num(f.z0) && !(r[jz] != null && r[jz] >= f.z0)) continue;
      if (num(f.z1) && !(r[jz] != null && r[jz] <= f.z1)) continue;
      if (f.src.length) {
        var hit = 0;
        for (var b = 0; b < f.src.length; b++) if ((r[f.src[b].j] || 0) >= f.src[b].min) hit++;
        if (f.srcAny ? hit === 0 : hit < f.src.length) continue;
      }
      if (f.tRange) {
        var t0 = Infinity, t1 = -Infinity, c;
        for (c = 0; c < f.t0cols.length; c++) { var v0 = r[f.t0cols[c]]; if (num(v0) && v0 < t0) t0 = v0; }
        for (c = 0; c < f.t1cols.length; c++) { var v1 = r[f.t1cols[c]]; if (num(v1) && v1 > t1) t1 = v1; }
        if (num(f.t0a) && !(t0 >= f.t0a && t0 !== Infinity)) continue;
        if (num(f.t0b) && !(t0 <= f.t0b)) continue;
        if (num(f.t1a) && !(t1 >= f.t1a)) continue;
        if (num(f.t1b) && !(t1 <= f.t1b && t1 !== -Infinity)) continue;
      }
      if (num(f.nva) && !((r[jnva] || 0) >= f.nva)) continue;
      if (S.isPrivate) {
        if (f.em === '1' && !isMatched(i)) continue;
        if (f.em === '0' && isMatched(i)) continue;
        var es = r[C.edp2_sep];
        if (num(f.esep) && !(num(es) && es <= f.esep)) continue;
        if (num(f.endia) && !((r[C.edp2_ndia] || 0) >= f.endia)) continue;
        var el = r[C.edp2_lead];
        if (num(f.el0) && !(num(el) && el >= f.el0)) continue;
        if (num(f.el1) && !(num(el) && el <= f.el1)) continue;
        if (f.etc && r[C.edp2_tc] !== true && r[C.edp2_tc] !== 1) continue;
      }
      out.push(i);
    }
    S.sep = sep;
    S.sortKey = f.sortKey;
    S.sortDir = f.sortDir;
    S.filtered = sortRows(out, f.sortKey, f.sortDir);
    if (!opts || !opts.keepPage) S.page = 0;
    renderResults();
  }

  function sortRows(idx, key, dir) {
    var get;
    if (key === '_sep') get = function (i) { return S.sep ? S.sep[i] : null; };
    else if (key === 'name') get = function (i) { return S.nameKey[i]; };
    else { var j = S.C[key]; get = function (i) { return S.rows[i][j]; }; }
    var jd = S.C.disc_mjd;
    var arr = idx.map(function (i) { var v = get(i); return [v, i]; });
    arr.sort(function (a, b) {
      var x = a[0], y = b[0];
      var xn = x == null || x === '' || (typeof x === 'number' && isNaN(x));
      var yn = y == null || y === '' || (typeof y === 'number' && isNaN(y));
      if (xn || yn) { if (xn && yn) return tiebreak(a[1], b[1]); return xn ? 1 : -1; }   // nulls last either way
      var c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
      return c !== 0 ? c * dir : tiebreak(a[1], b[1]);
    });
    function tiebreak(i1, i2) { return (S.rows[i2][jd] || 0) - (S.rows[i1][jd] || 0) || i1 - i2; }
    return arr.map(function (a) { return a[1]; });
  }

  function onHeaderSort(key) {
    var form = $('#filter-form');
    var dir = key === S.sortKey ? -S.sortDir : naturalDir(key);
    form.elements.sort.value = key;
    form.elements.dir.value = dir > 0 ? 'asc' : 'desc';
    applyFilters({ keepPage: false });
    pushListHash();
  }

  // ------------------------------------------------------------------ results table
  function listColumns() {
    var cols = [{ key: 'name', label: 'Name', cls: 'name' }];
    if (S.filterSpec && S.filterSpec.cone) cols.push({ key: '_sep', label: 'Sep.', sub: 'arcsec', num: true });
    cols.push({ key: 'type', label: 'Type' }, { key: 'z', label: 'z', num: true },
      { key: 'disc_mjd', label: 'Discovered', sub: 'UTC date' }, { key: 'disc_mag', label: 'Disc. mag', sub: 'filter', num: true },
      { key: 'group', label: 'Group' });
    if (has('n_spec')) cols.push({ key: 'n_spec', label: 'Spectra', num: true });
    S.srcKeys.forEach(function (k) {
      cols.push({ key: 'n_' + k, label: srcShort(k), sub: has('t0_' + k) ? 'pts · first–last MJD' : 'pts', num: true, src: k,
        title: srcLabel(k) });
    });
    if (has('n_visits_active')) cols.push({ key: 'n_visits_active', label: 'Pointings', sub: 'active / all', num: true,
      title: 'dp2.Visit centres within 2.1° in [disc − 30, disc + 100] d / any time' });
    if (S.isPrivate) {
      if (has('edp2_sep')) cols.push({ key: 'edp2_sep', label: 'EDP2 sep.', sub: 'arcsec', num: true, title: 'Separation to nearest EDP2 DiaObject' });
      if (has('edp2_ndia')) cols.push({ key: 'edp2_ndia', label: 'EDP2 nDia', num: true, title: 'DiaObject nDiaSources' });
      if (has('edp2_lead')) cols.push({ key: 'edp2_lead', label: 'EDP2 lead', sub: 'days', num: true, title: 'TNS discovery − first positive EDP2 detection' });
    }
    return cols;
  }

  function cellHtml(col, i) {
    var r = S.rows[i], v;
    switch (col.key) {
      case 'name': {
        var p = V(i, 'prefix');
        return '<td class="name"><span class="pfx' + (p === 'SN' ? ' sn' : '') + '">' + esc(p || '') + '</span>' +
          '<a href="#/object/' + encodeURIComponent(V(i, 'name')) + '">' + esc(V(i, 'name')) + '</a></td>';
      }
      case '_sep': return '<td class="num">' + (S.sep ? fx(S.sep[i], 2) : '') + '</td>';
      case 'type': v = V(i, 'type'); return '<td class="type-cell"' + (v ? ' title="' + esc(v) + '"' : '') + '>' + (v ? esc(v) : '<span class="muted">—</span>') + '</td>';
      case 'z': v = V(i, 'z'); return '<td class="num">' + (isNum(v) ? fx(v, v < 0.1 ? 4 : 3) : '') + '</td>';
      case 'disc_mjd': v = V(i, 'disc_mjd'); return '<td class="num" title="MJD ' + fx(v, 3) + '">' + isoDate(v) + '</td>';
      case 'disc_mag': v = V(i, 'disc_mag');
        return '<td class="num">' + fx(v, 2) + (V(i, 'disc_filter') ? ' <span class="muted">' + esc(V(i, 'disc_filter')) + '</span>' : '') + '</td>';
      case 'group': return '<td>' + esc(V(i, 'group') || '') + '</td>';
      case 'n_spec': v = V(i, 'n_spec');
        return '<td class="num"' + (V(i, 'spec_types') ? ' title="' + esc(V(i, 'spec_types')) + '"' : '') + '>' + (v > 0 ? fint(v) : '<span class="muted">0</span>') + '</td>';
      case 'n_visits_active':
        return '<td class="num">' + fint(V(i, 'n_visits_active')) + (has('n_visits') ? ' <span class="muted">/ ' + fint(V(i, 'n_visits')) + '</span>' : '') + '</td>';
      case 'edp2_sep': v = V(i, 'edp2_sep'); return '<td class="num">' + (isNum(v) ? '<span' + (v > S.matchR ? ' class="muted"' : '') + '>' + fx(v, 2) + '</span>' : '') + '</td>';
      case 'edp2_ndia': return '<td class="num">' + fint(V(i, 'edp2_ndia')) + '</td>';
      case 'edp2_lead': return '<td class="num">' + fx(V(i, 'edp2_lead'), 1) + '</td>';
      default:
        if (col.src) {
          var n = r[S.C['n_' + col.src]] || 0, t0 = V(i, 't0_' + col.src), t1 = V(i, 't1_' + col.src);
          return '<td class="num cnt-cell"><span class="n' + (n ? '' : ' zero') + '">' + fint(n) + '</span>' +
            (n && isNum(t0) ? '<span class="rng" title="' + isoDate(t0) + ' – ' + isoDate(t1) + '">' + Math.floor(t0) + '–' + Math.floor(t1) + '</span>' : '') + '</td>';
        }
        v = V(i, col.key);
        return '<td>' + esc(v == null ? '' : v) + '</td>';
    }
  }

  function renderResults() {
    var cols = listColumns();
    var n = S.filtered.length, ps = S.pageSize, pages = Math.max(1, Math.ceil(n / ps));
    if (S.page >= pages) S.page = pages - 1;
    if (S.page < 0) S.page = 0;
    var thead = '<tr>' + cols.map(function (c) {
      var sorted = c.key === S.sortKey;
      var aria = sorted ? (S.sortDir > 0 ? 'ascending' : 'descending') : 'none';
      return '<th scope="col" class="' + (c.num ? 'num ' : '') + (c.cls || '') + '" aria-sort="' + aria + '"' + (c.title ? ' title="' + esc(c.title) + '"' : '') + '>' +
        '<button type="button" class="sortbtn" data-key="' + esc(c.key) + '">' + esc(c.label) +
        '<span class="arrow" aria-hidden="true">' + (sorted ? (S.sortDir > 0 ? '▲' : '▼') : '') + '</span></button>' +
        (c.sub ? '<span class="th-sub">' + esc(c.sub) + '</span>' : '') + '</th>';
    }).join('') + '</tr>';
    var a = S.page * ps, b = Math.min(n, a + ps), body = [];
    for (var k = a; k < b; k++) {
      var i = S.filtered[k];
      body.push('<tr data-i="' + i + '"' + (i === S.lastObj ? ' class="sel"' : '') + '>' + cols.map(function (c) { return cellHtml(c, i); }).join('') + '</tr>');
    }
    if (!n) body.push('<tr class="empty-row"><td colspan="' + cols.length + '">No objects match these filters.</td></tr>');
    var tbl = $('#list-table');
    tbl.tHead.innerHTML = thead;
    tbl.tBodies[0].innerHTML = body.join('');
    $('#results-count').innerHTML = fint(n) + ' object' + (n === 1 ? '' : 's') +
      (n !== S.N ? ' <span class="sub">of ' + fint(S.N) + '</span>' : '') +
      (n > ps ? ' <span class="sub">· showing ' + fint(a + 1) + '–' + fint(b) + '</span>' : '');
    var pg = '';
    if (pages > 1) {
      pg = btnPage('«', 0, S.page === 0, 'First page') + btnPage('‹ Prev', S.page - 1, S.page === 0, 'Previous page') +
        '<span class="pageinfo">Page ' + (S.page + 1) + ' of ' + pages + '</span>' +
        btnPage('Next ›', S.page + 1, S.page >= pages - 1, 'Next page') + btnPage('»', pages - 1, S.page >= pages - 1, 'Last page');
    }
    $('#pager').innerHTML = pg;
    $('#pager').hidden = pages <= 1;
    $('#btn-random').disabled = n === 0;
    $('#btn-csv').disabled = n === 0;
  }
  function btnPage(label, p, dis, aria) {
    return '<button type="button" class="btn btn-sm" data-page="' + p + '"' + (dis ? ' disabled' : '') + ' aria-label="' + aria + '">' + label + '</button>';
  }

  function showList() {
    var from = S.view;
    setView('list');
    document.title = 'TNS EDP2 Explorer';
    updateNavLinks();
    if (from !== 'list' && S.lastObj != null) {
      var pos = S.filtered.indexOf(S.lastObj);
      if (pos >= 0 && Math.floor(pos / S.pageSize) !== S.page) { S.page = Math.floor(pos / S.pageSize); }
      renderResults();
      var tr = $('#list-table tr[data-i="' + S.lastObj + '"]');
      if (tr && tr.scrollIntoView) tr.scrollIntoView({ block: 'nearest' });
    }
  }

  // ------------------------------------------------------------------ CSV
  function csvCell(v) {
    if (v == null || (typeof v === 'number' && !isFinite(v))) return '';
    var s = String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function downloadCsv(filename, header, rows) {
    var lines = [header.map(csvCell).join(',')];
    for (var k = 0; k < rows.length; k++) lines.push(rows[k].map(csvCell).join(','));
    var blob = new Blob([lines.join('\n') + '\n'], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }
  function downloadListCsv() {
    var cols = S.cols.slice();
    var jd = cols.indexOf('disc_mjd');
    var header = cols.slice();
    header.splice(jd + 1, 0, 'disc_date');
    if (S.sep) header.push('cone_sep_arcsec');
    var rows = S.filtered.map(function (i) {
      var r = S.rows[i].slice();
      r.splice(jd + 1, 0, isoDateTime(r[jd]));
      if (S.sep) r.push(fx(S.sep[i], 3));
      return r;
    });
    downloadCsv('tns_edp2_' + (S.isPrivate ? 'private_' : '') + rows.length + '_objects.csv', header, rows);
  }

  // ------------------------------------------------------------------ object page
  var ICON = {
    ext: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
    download: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>'
  };

  function showObject(name) {
    setView('object');
    window.scrollTo(0, 0);
    var i = S.byName.get(name);
    if (i === undefined) i = S.byName.get(normQuery(name));
    var root = $('#view-object');
    if (i === undefined) {
      purgePlot();
      S.curObj = null; S.obj = null;
      document.title = 'Not found · TNS EDP2 Explorer';
      root.innerHTML = '<div class="obj-nav"><a class="btn" href="' + esc(listHash()) + '">← Back to list</a></div>' +
        '<div class="panel obj-head"><h1 tabindex="-1">Not found</h1><p>No object named <strong>' + esc(name) +
        '</strong> in this catalog (' + fint(S.N) + ' TNS objects inside the EDP2 visit footprint).</p>' +
        '<p><a href="https://www.wis-tns.org/object/' + encodeURIComponent(normQuery(name)) + '" target="_blank" rel="noopener">Look it up on TNS</a></p></div>';
      return;
    }
    purgePlot();
    S.curObj = i; S.lastObj = i;
    $('#nav-object').hidden = false;
    $('#nav-object').setAttribute('href', '#/object/' + encodeURIComponent(V(i, 'name')));
    document.title = fullName(i) + ' · TNS EDP2 Explorer';
    root.innerHTML = objNavHtml(i) + objHeadHtml(i) +
      '<div class="panel lc-panel" id="lc-panel"><div class="lc-controls" id="lc-controls"></div>' +
      '<div class="lc-plot" id="lc-plot" role="img" aria-label="Lightcurve of ' + esc(fullName(i)) + '"><div class="lc-msg"><span class="spinner" aria-hidden="true"></span> Loading lightcurve…</div></div>' +
      '<div class="lc-foot" id="lc-foot"></div>' +
      '<details class="pts-details" id="pts-details"><summary>Photometry table (points shown in the plot)</summary><div id="pts-table"></div></details></div>';
    root.querySelector('.obj-nav').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-rel]');
      if (b && !b.disabled) gotoRelative(+b.getAttribute('data-rel'));
    });
    $('#pts-details').addEventListener('toggle', function (e) { if (e.target.open) renderPointsTable(); });
    var h1 = root.querySelector('h1');
    if (h1 && document.activeElement && document.activeElement !== document.body) h1.focus({ preventScroll: true });

    var shard = V(i, 'shard');
    if (!isNum(shard)) shard = Math.floor(i / SHARD_SIZE);
    S.obj = null;
    Promise.all([loadShard(shard), ensurePlotly()]).then(function (res) {
      if (S.curObj !== i) return;
      var lcs = (res[0] || {})[V(i, 'name')] || {};
      prepareObject(i, lcs);
      renderChips();
      updatePlot();
    }).catch(function (e) {
      if (S.curObj !== i) return;
      console.error(e);
      var msg = /plotly/i.test(e.message) ? 'Could not load the plotting library from cdn.jsdelivr.net (offline?).' :
        'Could not load the lightcurve file (' + esc(e.message) + ').';
      plotMessage(msg + ' <button type="button" class="btn btn-sm" id="lc-retry">Retry</button>');
      $('#lc-retry').addEventListener('click', function () { showObject(name); });
    });
    if (S.visitsState === 'idle') loadVisits();
  }

  function purgePlot() {
    var el = $('#lc-plot');
    if (el && window.Plotly && el._fullLayout) window.Plotly.purge(el);
  }
  function plotMessage(html) {
    purgePlot();
    var el = $('#lc-plot');
    if (el) el.innerHTML = '<div class="lc-msg">' + html + '</div>';
  }

  function objNavHtml(i) {
    var pos = S.filtered.indexOf(i), n = S.filtered.length;
    var prev = pos > 0 ? S.filtered[pos - 1] : null, next = pos >= 0 && pos < n - 1 ? S.filtered[pos + 1] : null;
    return '<nav class="obj-nav" aria-label="Object navigation"><a class="btn" href="' + esc(listHash()) + '">← List</a>' +
      '<button type="button" class="btn" data-rel="-1"' + (prev == null ? ' disabled' : '') + ' title="Previous in list (← or [)">‹ ' +
      (prev != null ? esc(V(prev, 'name')) : 'Prev') + '</button>' +
      '<button type="button" class="btn" data-rel="1"' + (next == null ? ' disabled' : '') + ' title="Next in list (→ or ])">' +
      (next != null ? esc(V(next, 'name')) : 'Next') + ' ›</button>' +
      '<span class="pos">' + (pos >= 0 ? fint(pos + 1) + ' of ' + fint(n) + ' in the current list' : 'not in the current filtered list') + '</span></nav>';
  }

  function kv(label, html, sub) {
    return '<div><dt>' + esc(label) + '</dt><dd>' + html + (sub ? '<div class="sub">' + sub + '</div>' : '') + '</dd></div>';
  }
  function extLink(href, label, title) {
    return '<a href="' + esc(href) + '" target="_blank" rel="noopener noreferrer"' + (title ? ' title="' + esc(title) + '"' : '') + '>' + esc(label) + ICON.ext + '</a>';
  }

  function objHeadHtml(i) {
    var name = V(i, 'name'), pre = V(i, 'prefix'), type = V(i, 'type'), z = V(i, 'z');
    var ra = V(i, 'ra'), dec = V(i, 'dec'), disc = V(i, 'disc_mjd');
    var internal = String(V(i, 'internal') || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    var alerts = String(V(i, 'alert_ids') || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    var h = '<div class="panel obj-head"><div class="obj-title"><h1 tabindex="-1">' + (pre ? '<span class="pre">' + esc(pre) + '</span> ' : '') + esc(name) + '</h1>' +
      (type ? '<span class="tag">' + esc(type) + '</span>' : '<span class="tag untyped">untyped</span>') +
      (isNum(z) ? '<span class="muted">z = ' + fx(z, 4) + '</span>' : '') + '</div><dl class="kv">';
    h += kv('RA, Dec (J2000)', fx(ra, 6) + '°, ' + (dec >= 0 ? '+' : '') + fx(dec, 6) + '°', esc(raHms(ra) + '  ' + decDms(dec)));
    h += kv('TNS discovery', esc(isoDateTime(disc)) + ' UTC', 'MJD ' + fx(disc, 4));
    h += kv('Discovery mag', isNum(V(i, 'disc_mag')) ? fx(V(i, 'disc_mag'), 2) + (V(i, 'disc_filter') ? ' <span class="muted">(' + esc(V(i, 'disc_filter')) + ')</span>' : '') : '—');
    h += kv('Reporting group', esc(V(i, 'group') || '—'));
    h += kv('Internal names', internal.length ? internal.map(esc).join(', ') : '—');
    if (has('n_spec')) {
      var ns = V(i, 'n_spec') || 0, st = String(V(i, 'spec_types') || '');
      h += kv('TNS spectra', ns ? fint(ns) + (st ? ' <span class="muted">(' + esc(st.split(',').join(', ')) + ')</span>' : '') : 'none reported');
    }
    if (has('n_visits')) h += kv('LSSTCam pointings', fint(V(i, 'n_visits')) + ' <span class="muted">within 2.1°</span>',
      has('n_visits_active') ? fint(V(i, 'n_visits_active')) + ' during [disc − 30, disc + 100] d' : '');
    if (has('alert_ids')) h += kv('Rubin alert IDs (Fink)', alerts.length ? alerts.map(function (a) { return '<span class="mono">' + esc(a) + '</span>'; }).join('<br>') : '—');
    var pts = S.srcKeys.map(function (k) { var n = V(i, 'n_' + k) || 0; return n ? esc(srcShort(k)) + ' ' + fint(n) : ''; }).filter(Boolean);
    h += kv('Measurements', pts.length ? pts.join(' · ') : 'none', pts.length ? 'detections + forced photometry; limits not counted' : '');
    // columns this page does not know yet
    var extra = S.cols.filter(function (c) {
      if (KNOWN_COLS.indexOf(c) >= 0) return false;
      var m = /^(n|t0|t1)_(.+)$/.exec(c);
      return !(m && ((S.meta.sources || {})[m[2]] || SRC_SHORT[m[2]]));
    });
    extra.forEach(function (c) { var v = V(i, c); h += kv(c, v == null || v === '' ? '—' : esc(typeof v === 'object' ? JSON.stringify(v) : v)); });
    h += '</dl>';
    if (S.isPrivate) {
      h += '<dl class="kv private-kv">';
      h += kv('EDP2 DiaObject', V(i, 'edp2_id') ? '<span class="mono">' + esc(V(i, 'edp2_id')) + '</span> ' + (isMatched(i) ? '<span class="tag priv">matched</span>' : '<span class="tag untyped">outside ' + S.matchR + '″</span>') : '—');
      h += kv('EDP2 separation', isNum(V(i, 'edp2_sep')) ? fx(V(i, 'edp2_sep'), 3) + '″' : '—');
      h += kv('EDP2 nDiaSources', isNum(V(i, 'edp2_ndia')) ? fint(V(i, 'edp2_ndia')) : '—');
      h += kv('EDP2 lead', isNum(V(i, 'edp2_lead')) ? fx(V(i, 'edp2_lead'), 2) + ' d' : '—', 'TNS discovery − first positive EDP2 detection');
      var tc = V(i, 'edp2_tc');
      h += kv('Time-consistent', tc === true || tc === 1 ? 'yes' : tc === false || tc === 0 ? 'no' : '—');
      h += '</dl>';
    }
    // link-outs
    var L = [];
    L.push(extLink('https://www.wis-tns.org/object/' + encodeURIComponent(name), 'TNS'));
    L.push(extLink('https://www.wiserep.org/search?name=' + encodeURIComponent(name), 'WISeREP', 'WISeREP spectra search'));
    var ztf = [];
    internal.forEach(function (s) { var m = s.match(/\bZTF\d{2}[a-z]{7}\b/g); if (m) m.forEach(function (x) { if (ztf.indexOf(x) < 0) ztf.push(x); }); });
    ztf.forEach(function (id) {
      L.push(extLink('https://alerce.online/object/' + id, 'ALeRCE ' + id));
    });
    alerts.forEach(function (id) { L.push(extLink('https://lsst.fink-portal.org/' + encodeURIComponent(id), 'Fink LSST ' + id)); });
    if (isNum(ra) && isNum(dec)) {
      L.push(extLink('https://www.legacysurvey.org/viewer?ra=' + ra.toFixed(6) + '&dec=' + dec.toFixed(6) + '&layer=ls-dr10&zoom=16&mark=' + ra.toFixed(6) + ',' + dec.toFixed(6), 'Legacy Survey viewer'));
    }
    h += '<div class="links" aria-label="External links">' + L.join('') + '</div></div>';
    return h;
  }

  // ------------------------------------------------------------------ lightcurve
  function prepareObject(i, lcs) {
    var order = S.srcKeys.slice();
    Object.keys(lcs).forEach(function (k) { if (order.indexOf(k) < 0) order.push(k); });
    var pts = [], srcCount = {}, famCount = {}, famBands = {}, nUL = 0, nFP = 0;
    order.forEach(function (s) {
      var lc = lcs[s];
      if (!lc || !lc.t) return;
      var n = lc.t.length;
      for (var k = 0; k < n; k++) {
        var b = lc.b ? lc.b[k] : '', fam = bandFamily(b), kind = lc.k ? lc.k[k] : 0;
        pts.push({ s: s, t: lc.t[k], b: b, fam: fam, f: lc.f ? lc.f[k] : null, e: lc.e ? lc.e[k] : null,
          k: kind, l: lc.l ? lc.l[k] : null, x: lc.x ? lc.x[k] : '' });
        srcCount[s] = (srcCount[s] || 0) + 1;
        famCount[fam] = (famCount[fam] || 0) + 1;
        (famBands[fam] = famBands[fam] || {})[b] = 1;
        if (kind === 2) nUL++; else if (kind === 1) nFP++;
      }
    });
    var srcs = order.filter(function (s) { return srcCount[s]; });
    var extraSym = 0, sym = {};
    srcs.forEach(function (s) { sym[s] = SRC_SYMBOL[s] || EXTRA_SYMBOLS[extraSym++ % EXTRA_SYMBOLS.length]; });
    S.obj = { i: i, name: V(i, 'name'), disc: V(i, 'disc_mjd'), pts: pts, srcs: srcs, srcCount: srcCount, sym: sym,
      fams: FAMILIES.filter(function (f) { return famCount[f]; }), famCount: famCount, famBands: famBands,
      nUL: nUL, nFP: nFP, shown: [] };
  }

  function symbolSvg(symbol, color) {
    var open = /-open$/.test(symbol), base = symbol.replace(/-open$/, ''), d;
    var poly = function (n, r, rot) {
      var p = [];
      for (var k = 0; k < n; k++) { var a = rot + k * 2 * Math.PI / n; p.push((r * Math.cos(a)).toFixed(2) + ' ' + (r * Math.sin(a)).toFixed(2)); }
      return 'M' + p.join(' L') + 'Z';
    };
    switch (base) {
      case 'circle': d = 'M5 0 A5 5 0 1 1 -5 0 A5 5 0 1 1 5 0Z'; break;
      case 'square': d = 'M-4.3 -4.3 H4.3 V4.3 H-4.3Z'; break;
      case 'diamond': d = 'M0 -5.8 L5.8 0 L0 5.8 L-5.8 0Z'; break;
      case 'triangle-up': d = 'M0 -5.5 L5.5 4.5 L-5.5 4.5Z'; break;
      case 'triangle-down': d = 'M0 5.5 L5.5 -4.5 L-5.5 -4.5Z'; break;
      case 'pentagon': d = poly(5, 5.5, -Math.PI / 2); break;
      case 'hexagon': d = poly(6, 5.5, 0); break;
      case 'star': {
        var p = [];
        for (var k = 0; k < 10; k++) { var r = k % 2 ? 2.6 : 6, a = -Math.PI / 2 + k * Math.PI / 5; p.push((r * Math.cos(a)).toFixed(2) + ' ' + (r * Math.sin(a)).toFixed(2)); }
        d = 'M' + p.join(' L') + 'Z'; break;
      }
      case 'cross': d = 'M-1.8 -5.5 H1.8 V-1.8 H5.5 V1.8 H1.8 V5.5 H-1.8 V1.8 H-5.5 V-1.8 H-1.8Z'; break;
      case 'x': d = 'M-4.5 -2 L-2 -4.5 L0 -2.5 L2 -4.5 L4.5 -2 L2.5 0 L4.5 2 L2 4.5 L0 2.5 L-2 4.5 L-4.5 2 L-2.5 0Z'; break;
      default: d = 'M-5 5 L5 -5 L5 5 L-5 -5Z';
    }
    return '<svg viewBox="-7 -7 14 14" aria-hidden="true"><path d="' + d + '" fill="' + (open ? 'none' : color) + '" stroke="' + color + '" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  }

  function renderChips() {
    var o = S.obj, box = $('#lc-controls');
    if (!o || !box) return;
    var L = S.lc, fg = cssVar('--fg-2') || '#333';
    if (!o.pts.length) {
      box.innerHTML = '';
      return;
    }
    var srcChips = o.srcs.map(function (s) {
      var on = !L.srcOff.has(s);
      return '<label class="chip' + (on ? '' : ' off') + '" title="' + esc(srcLabel(s) + ': ' + ((S.meta.sources[s] || {}).desc || '')) + '">' +
        '<input type="checkbox" data-src="' + esc(s) + '"' + (on ? ' checked' : '') + '>' + symbolSvg(o.sym[s], fg) +
        '<span>' + esc(srcShort(s)) + '</span><span class="cnt">' + fint(o.srcCount[s]) + '</span></label>';
    }).join('');
    var famChips = o.fams.map(function (f) {
      var on = !L.famOff.has(f);
      var bands = Object.keys(o.famBands[f] || {}).join(', ');
      return '<label class="chip' + (on ? '' : ' off') + '" title="Band labels: ' + esc(bands) + '">' +
        '<input type="checkbox" data-fam="' + esc(f) + '"' + (on ? ' checked' : '') + '>' +
        '<span class="sw" style="background:' + famColor(f) + '"></span><span>' + esc(f) + '</span><span class="cnt">' + fint(o.famCount[f]) + '</span></label>';
    }).join('');
    box.innerHTML =
      '<div class="ctl-group"><span class="ctl-label" id="lbl-srcs">Sources <button type="button" class="linkbtn" data-all="src">all</button> · <button type="button" class="linkbtn" data-none="src">none</button></span>' +
      '<div class="chips" role="group" aria-labelledby="lbl-srcs">' + srcChips + '</div></div>' +
      '<div class="ctl-group"><span class="ctl-label" id="lbl-fams">Bands <button type="button" class="linkbtn" data-all="fam">all</button> · <button type="button" class="linkbtn" data-none="fam">none</button></span>' +
      '<div class="chips" role="group" aria-labelledby="lbl-fams">' + famChips + '</div></div>' +
      '<div class="ctl-group"><span class="ctl-label">Display</span><div class="opts">' +
      seg('ymode', 'Y axis', [['flux', 'Flux (nJy)'], ['mag', 'AB mag']], L.y) +
      seg('xmode', 'X axis', [['mjd', 'MJD'], ['rel', 'Days since disc.']], L.x) +
      '</div><div class="opts">' +
      '<label class="check" for="opt-ul"><input type="checkbox" id="opt-ul"' + (L.showUL ? ' checked' : '') + (o.nUL ? '' : ' disabled') + '><span>Upper limits <span class="cnt">' + fint(o.nUL) + '</span></span></label>' +
      '<label class="check" for="opt-fp"><input type="checkbox" id="opt-fp"' + (L.showFP ? ' checked' : '') + (o.nFP ? '' : ' disabled') + '><span>Forced photometry <span class="cnt">' + fint(o.nFP) + '</span></span></label>' +
      '<label class="check" for="opt-sn" id="opt-sn-wrap" title="In AB mag, hide forced-photometry points with S/N below 3 (their magnitudes are meaningless)"' + (L.y === 'mag' ? '' : ' hidden') + '><input type="checkbox" id="opt-sn"' + (L.snCut ? ' checked' : '') + '><span>Forced S/N ≥ 3 only</span></label>' +
      '<label class="check" for="opt-ticks"><input type="checkbox" id="opt-ticks"' + (L.ticks ? ' checked' : '') + '><span>Pointing ticks</span></label>' +
      '<button type="button" class="btn btn-sm" id="btn-lc-csv" title="Download the points shown in the plot">' + ICON.download + 'CSV</button>' +
      '</div></div>';
    box.onchange = function (e) {
      var t = e.target;
      if (t.hasAttribute('data-src')) toggleSet(L.srcOff, t.getAttribute('data-src'), !t.checked);
      else if (t.hasAttribute('data-fam')) toggleSet(L.famOff, t.getAttribute('data-fam'), !t.checked);
      else if (t.name === 'ymode') { L.y = t.value; $('#opt-sn-wrap').hidden = L.y !== 'mag'; }
      else if (t.name === 'xmode') L.x = t.value;
      else if (t.id === 'opt-ul') L.showUL = t.checked;
      else if (t.id === 'opt-fp') L.showFP = t.checked;
      else if (t.id === 'opt-ticks') L.ticks = t.checked;
      else if (t.id === 'opt-sn') L.snCut = t.checked;
      else return;
      var chip = t.closest('.chip');
      if (chip) chip.classList.toggle('off', !t.checked);
      updatePlot();
    };
    box.onclick = function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      if (b.id === 'btn-lc-csv') { downloadLcCsv(); return; }
      var all = b.getAttribute('data-all'), none = b.getAttribute('data-none'), which = all || none;
      if (!which) return;
      e.preventDefault();
      var set = which === 'src' ? L.srcOff : L.famOff, keys = which === 'src' ? o.srcs : o.fams;
      keys.forEach(function (k) { toggleSet(set, k, !!none); });
      renderChips(); updatePlot();
    };
  }
  function toggleSet(set, k, add) { if (add) set.add(k); else set.delete(k); }
  function seg(name, label, opts, cur) {
    return '<span class="muted" style="font-size:12px" id="lbl-' + name + '">' + esc(label) + '</span><span class="segmented" role="radiogroup" aria-labelledby="lbl-' + name + '">' +
      opts.map(function (o) {
        return '<label><input type="radio" name="' + name + '" value="' + o[0] + '"' + (o[0] === cur ? ' checked' : '') + '><span>' + esc(o[1]) + '</span></label>';
      }).join('') + '</span>';
  }

  // Points that pass the toggles, converted to the current axes.
  function shownPoints() {
    var o = S.obj, L = S.lc, out = [];
    o.nLowSN = 0;
    var LN = 2.5 / Math.LN10;
    for (var k = 0; k < o.pts.length; k++) {
      var p = o.pts[k];
      if (L.srcOff.has(p.s) || L.famOff.has(p.fam)) continue;
      if (p.k === 2 && !L.showUL) continue;
      if (p.k === 1 && !L.showFP) continue;
      var y = null, ey = null, lim = false, m = null, me = null, lm = null;
      if (p.k === 2) {
        lm = isNum(p.l) ? p.l : (isNum(p.e) && p.e > 0 ? ZP - 2.5 * Math.log10(5 * p.e) : null);
        if (lm == null) continue;
        lim = true;
        y = L.y === 'mag' ? lm : flux(lm);
      } else {
        if (!isNum(p.f)) continue;
        if (p.f > 0) { m = mag(p.f); me = isNum(p.e) ? LN * p.e / p.f : null; }
        if (L.y === 'mag') {
          if (!(p.f > 0)) continue;
          if (p.k === 1 && L.snCut && isNum(p.e) && p.e > 0 && p.f / p.e < 3) { o.nLowSN++; continue; }
          y = m; ey = me;
        }
        else { y = p.f; ey = isNum(p.e) ? p.e : null; }
      }
      out.push({ p: p, x: L.x === 'rel' ? p.t - o.disc : p.t, y: y, ey: ey, lim: lim, mag: m, magErr: me, limMag: lm });
    }
    return out;
  }

  function quantile(sorted, q) {
    if (!sorted.length) return null;
    var pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }
  // y range from detections + forced points (robust to a few wild values); limits only
  // stretch it in mag space, where they sit a few mag below the data.
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
      if (mode === 'mag') { lims.forEach(function (v) { a = Math.min(a, v); b = Math.max(b, v); }); }
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
    var o = S.obj, el = $('#lc-plot');
    if (!o || !el || !window.Plotly) return;
    var L = S.lc, dark = isDark();
    var shown = shownPoints();
    o.shown = shown;
    var traces = [], groups = new Map();
    shown.forEach(function (s) {
      var cls = s.lim ? 'l' : s.p.k === 1 ? 'f' : 'd';
      var key = s.p.s + '|' + s.p.fam + '|' + cls;
      var g = groups.get(key);
      if (!g) { g = { s: s.p.s, fam: s.p.fam, cls: cls, x: [], y: [], e: [], text: [] }; groups.set(key, g); }
      g.x.push(s.x); g.y.push(s.y); g.e.push(s.ey == null ? 0 : s.ey); g.text.push(hoverText(s));
    });
    var surface = cssVar('--surface') || (dark ? '#161a21' : '#fff');
    groups.forEach(function (g) {
      var col = famColor(g.fam), sym = o.sym[g.s] || 'circle';
      if (g.cls === 'f' && !/-open$/.test(sym)) sym += '-open';
      if (g.cls === 'l') sym = LIMIT_SYMBOL;
      var open = /-open$/.test(sym);
      traces.push({
        type: 'scatter', mode: 'markers', x: g.x, y: g.y, text: g.text,
        hovertemplate: '%{text}<extra></extra>',
        marker: { symbol: sym, size: g.cls === 'l' ? 8 : g.s === 'tns' ? 10 : 8, color: col,
          opacity: g.cls === 'l' ? 0.7 : g.cls === 'f' ? 0.8 : 0.95,
          line: { color: open ? col : surface, width: open ? 1.5 : 0.8 } },
        error_y: g.cls === 'l' ? { visible: false } : { type: 'data', array: g.e, visible: true, thickness: 1, width: 0, color: col },
        showlegend: false, cliponaxis: true
      });
    });

    var disc = o.disc, win = S.meta.window || {};
    var X = function (t) { return L.x === 'rel' ? t - disc : t; };
    var near = null, tickTraces = [];
    if (L.ticks && S.visits) {
      near = o.near || (o.near = nearbyVisits(o.i));
      var byBand = {};
      near.forEach(function (v) { (byBand[v.band] = byBand[v.band] || []).push(v); });
      Object.keys(byBand).sort(function (a, b) { return FAMILIES.indexOf(bandFamily(a)) - FAMILIES.indexOf(bandFamily(b)); }).forEach(function (b) {
        var vs = byBand[b], col = famColor(bandFamily(b));
        tickTraces.push({
          type: 'scatter', mode: 'markers', xaxis: 'x', yaxis: 'y2',
          x: vs.map(function (v) { return X(v.mjd); }), y: vs.map(function () { return 0.5; }),
          text: vs.map(function (v) {
            return 'LSSTCam pointing (coverage not guaranteed)<br>band ' + esc(b) + ' · MJD ' + v.mjd.toFixed(4) + ' (' + esc(isoDateTime(v.mjd)) + ')<br>' +
              'visit centre ' + v.sep.toFixed(2) + '° from the object';
          }),
          hovertemplate: '%{text}<extra></extra>',
          marker: { symbol: 'line-ns-open', size: 13, color: col, line: { color: col, width: near.length > 400 ? 1.1 : 1.6 },
            opacity: near.length > 400 ? 0.6 : 0.95 },
          showlegend: false
        });
      });
    }
    var ticksOn = L.ticks && S.visits;
    var grid = cssVar('--plot-grid'), fg2 = cssVar('--fg-2'), muted = cssVar('--muted'), border = cssVar('--border-strong');
    var shapes = [], ann = [];
    if (isNum(win.mjd_start) && isNum(win.mjd_end)) {
      shapes.push({ type: 'rect', xref: 'x', yref: 'paper', x0: X(win.mjd_start), x1: X(win.mjd_end), y0: 0, y1: 1,
        fillcolor: cssVar('--plot-window'), line: { width: 0 }, layer: 'below' });
      ann.push({ text: 'EDP2 window', xref: 'x', yref: 'paper', x: X(win.mjd_start), y: 1, xanchor: 'left', yanchor: 'top',
        xshift: 3, yshift: -2, showarrow: false, font: { size: 10.5, color: muted } });
    }
    if (isNum(disc)) {
      shapes.push({ type: 'line', xref: 'x', yref: 'paper', x0: X(disc), x1: X(disc), y0: 0, y1: 1,
        line: { color: cssVar('--plot-disc'), width: 1.3, dash: 'dash' } });
      ann.push({ text: 'TNS discovery', xref: 'x', yref: 'paper', x: X(disc), y: 1, xanchor: 'right', yanchor: 'bottom',
        showarrow: false, font: { size: 10.5, color: cssVar('--plot-disc') } });
    }
    if (ticksOn) {
      ann.push({ text: 'LSSTCam pointing ≤' + TICK_RADIUS_DEG + '° (coverage not guaranteed)', xref: 'paper', yref: 'paper', x: 0, y: 0.072,
        xanchor: 'left', yanchor: 'bottom', showarrow: false, font: { size: 10, color: muted } });
    }
    var yr = yRange(shown, L.y);
    var layout = {
      margin: { l: 64, r: 14, t: 24, b: 44 },
      paper_bgcolor: surface, plot_bgcolor: surface,
      font: { family: cssVar('--font') || 'sans-serif', size: 12, color: fg2 },
      hovermode: 'closest', dragmode: 'zoom', showlegend: false,
      hoverlabel: { bgcolor: cssVar('--surface-2'), bordercolor: border, font: { color: cssVar('--fg'), size: 12 } },
      uirevision: o.name + '|' + L.x + '|' + L.y,
      xaxis: { title: { text: L.x === 'rel' ? 'Days since TNS discovery (MJD ' + fx(disc, 2) + ')' : 'MJD', standoff: 8 },
        gridcolor: grid, zeroline: false, showline: true, linecolor: border, ticks: 'outside', tickcolor: border,
        anchor: ticksOn ? 'y2' : 'y', automargin: true, exponentformat: 'none', separatethousands: false,
        tickformat: L.x === 'rel' ? '' : 'd', hoverformat: '.3f' },
      yaxis: { title: { text: L.y === 'mag' ? 'AB magnitude' : 'Flux (nJy)', standoff: 6 }, gridcolor: grid,
        zeroline: L.y === 'flux', zerolinecolor: cssVar('--plot-zero'), showline: true, linecolor: border,
        ticks: 'outside', tickcolor: border, domain: ticksOn ? [0.11, 1] : [0, 1], automargin: true,
        exponentformat: 'SI' },
      shapes: shapes, annotations: ann
    };
    if (yr) { layout.yaxis.range = yr.range; layout.yaxis.autorange = false; }
    else if (L.y === 'mag') layout.yaxis.autorange = 'reversed';
    if (ticksOn) layout.yaxis2 = { domain: [0, 0.065], range: [0, 1], showticklabels: false, showgrid: false, zeroline: false, fixedrange: true, showline: false };
    var config = { responsive: true, displaylogo: false, modeBarButtonsToRemove: ['lasso2d', 'select2d'],
      toImageButtonOptions: { filename: 'lc_' + (V(o.i, 'prefix') || '') + o.name, scale: 2 } };
    if (!o.pts.length && !tickTraces.length) {
      plotMessage('No photometry for this object from any source in this build.');
      renderFoot(near, 0);
      return;
    }
    if (el.querySelector('.lc-msg')) el.innerHTML = '';
    window.Plotly.react(el, traces.concat(tickTraces), layout, config);
    renderFoot(near, yr ? yr.nAbove : 0);
    if ($('#pts-details') && $('#pts-details').open) renderPointsTable();
  }

  function hoverText(s) {
    var p = s.p, o = S.obj, dt = p.t - o.disc, parts = [];
    parts.push('<b>' + esc(srcShort(p.s)) + '</b> · ' + esc(p.b) + ' · ' + KIND_LABEL[p.k]);
    parts.push('MJD ' + p.t.toFixed(4) + ' (' + (dt >= 0 ? '+' : '') + dt.toFixed(2) + ' d)');
    if (s.lim) parts.push('limit ' + fx(s.limMag, 2) + ' mag' + (S.lc.y === 'flux' ? ' (' + fmtFlux(s.y) + ' nJy)' : ''));
    else {
      parts.push(fmtFlux(p.f) + (isNum(p.e) ? ' ± ' + fmtFlux(p.e) : '') + ' nJy' + (isNum(p.e) && p.e > 0 ? ' (S/N ' + (p.f / p.e).toFixed(1) + ')' : ''));
      if (s.mag != null) parts.push(fx(s.mag, 3) + (s.magErr != null ? ' ± ' + fx(s.magErr, 3) : '') + ' mag');
    }
    if (p.x) parts.push('<i>' + esc(String(p.x).slice(0, 160)) + '</i>');
    return parts.join('<br>');
  }
  function fmtFlux(v) {
    if (!isNum(v)) return '—';
    var a = Math.abs(v);
    return a >= 1e5 ? v.toExponential(3) : a >= 100 ? v.toFixed(0) : v.toFixed(1);
  }

  function renderFoot(near, nAbove) {
    var el = $('#lc-foot'), o = S.obj;
    if (!el || !o) return;
    var L = S.lc, left = [];
    if (!o.pts.length) left.push('No photometry for this object from any source in this build');
    else left.push(fint(o.shown.length) + ' of ' + fint(o.pts.length) + ' points shown');
    if (nAbove) left.push(nAbove + ' upper limit' + (nAbove > 1 ? 's' : '') + ' above the plotted flux range (zoom out or use AB mag)');
    if (L.y === 'mag') left.push('mag shows flux > 0 only' + (o.nLowSN ? ' (' + fint(o.nLowSN) + ' forced points with S/N < 3 hidden)' : ''));
    var right = '';
    if (L.ticks) {
      if (S.visitsState === 'ready' && near) {
        var bands = {};
        near.forEach(function (v) { bands[v.band] = (bands[v.band] || 0) + 1; });
        right = '<span class="tick-legend">' + fint(near.length) + ' LSSTCam pointing' + (near.length === 1 ? '' : 's') + ' ≤' + TICK_RADIUS_DEG + '° (coverage not guaranteed)' +
          Object.keys(bands).sort(function (a, b) { return FAMILIES.indexOf(bandFamily(a)) - FAMILIES.indexOf(bandFamily(b)); }).map(function (b) {
            return ' <span class="tk-item"><span class="tk" style="background:' + famColor(bandFamily(b)) + '"></span> ' + esc(b) + ' ' + bands[b] + '</span>';
          }).join('') + '</span>';
      } else if (S.visitsState === 'error') right = 'Pointing ticks unavailable (data/visits.js did not load)';
      else right = '<span class="spinner" aria-hidden="true"></span>Loading LSSTCam pointings…';
    }
    el.innerHTML = '<span>' + left.join(' · ') + '</span><span>' + right + '</span>';
  }

  function lcRows() {
    var o = S.obj;
    return o.shown.slice().sort(function (a, b) { return a.p.t - b.p.t; }).map(function (s) {
      var p = s.p;
      return [p.s, p.b, p.fam, p.t, +(p.t - o.disc).toFixed(5), KIND_LABEL[p.k], p.f, p.e,
        s.mag != null ? +s.mag.toFixed(4) : null, s.magErr != null ? +s.magErr.toFixed(4) : null,
        s.limMag != null ? +s.limMag.toFixed(3) : null, p.x];
    });
  }
  var LC_HEADER = ['source', 'band', 'band_family', 'mjd', 'days_since_disc', 'kind', 'flux_njy', 'flux_err_njy', 'mag_ab', 'mag_err', 'lim_mag', 'note'];
  function downloadLcCsv() {
    var o = S.obj;
    if (!o) return;
    downloadCsv((V(o.i, 'prefix') || '') + o.name + '_lightcurve.csv', LC_HEADER, lcRows());
  }
  function renderPointsTable() {
    var o = S.obj, box = $('#pts-table');
    if (!o || !box) return;
    var rows = lcRows(), MAX = 3000;
    var body = rows.slice(0, MAX).map(function (r) {
      return '<tr><td>' + esc(srcShort(r[0])) + '</td><td>' + esc(r[1]) + '</td><td class="num">' + fx(r[3], 4) + '</td><td class="num">' + fx(r[4], 2) +
        '</td><td>' + r[5] + '</td><td class="num">' + fmtFlux(r[6]) + '</td><td class="num">' + fmtFlux(r[7]) + '</td><td class="num">' +
        (r[8] != null ? fx(r[8], 3) : '') + '</td><td class="num">' + (r[9] != null ? fx(r[9], 3) : '') + '</td><td class="num">' +
        (r[10] != null ? fx(r[10], 2) : '') + '</td><td>' + esc(r[11] || '') + '</td></tr>';
    }).join('');
    box.innerHTML = '<div class="table-wrap"><table class="data"><thead><tr><th>Source</th><th>Band</th><th class="num">MJD</th><th class="num">Δt (d)</th>' +
      '<th>Kind</th><th class="num">Flux (nJy)</th><th class="num">± (nJy)</th><th class="num">AB mag</th><th class="num">±</th><th class="num">Limit</th><th>Note</th></tr></thead>' +
      '<tbody>' + (body || '<tr class="empty-row"><td colspan="11">No points shown.</td></tr>') + '</tbody></table></div>' +
      (rows.length > MAX ? '<p class="muted">First ' + MAX + ' of ' + fint(rows.length) + ' rows; the CSV has all of them.</p>' : '');
  }

  // ------------------------------------------------------------------ about page
  function fmtStat(v) {
    if (v === true) return 'yes';
    if (v === false) return 'no';
    if (v == null) return '—';
    if (typeof v === 'number') {
      if (Number.isInteger(v)) return fint(v);
      return Math.abs(v) < 1 ? v.toFixed(3) : v.toFixed(2);
    }
    if (Array.isArray(v)) return v.map(fmtStat).join(', ');
    return esc(v);
  }
  function statRows(obj, depth) {
    var out = '';
    Object.keys(obj || {}).forEach(function (k) {
      var v = obj[k];
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        out += '<tr><td class="stat-key' + (depth ? ' stat-indent' : '') + '" colspan="2"><strong>' + esc(k) + '</strong></td></tr>' + statRows(v, depth + 1);
      } else {
        out += '<tr><td class="stat-key' + (depth ? ' stat-indent' : '') + '">' + esc(k) + '</td><td class="num">' + fmtStat(v) + '</td></tr>';
      }
    });
    return out;
  }
  function buildAboutView() {
    var M = S.meta, src = M.sources || {};
    var srcRows = Object.keys(src).map(function (k) {
      var s = src[k];
      return '<tr><td><span class="chip" style="cursor:default">' + symbolSvg(SRC_SYMBOL[k] || 'circle', 'currentColor') + esc(srcShort(k)) + '</span></td>' +
        '<td><strong>' + esc(s.label || k) + '</strong><br><span class="muted">' + esc(s.desc || '') + '</span></td><td>' + esc(s.survey || '') + '</td>' +
        '<td class="num">' + fint(s.n_objects) + '</td><td class="num">' + fint(s.n_points) + '</td></tr>';
    }).join('');
    var win = M.window || {};
    var notes = (M.notes || []).map(function (n) { return '<li>' + esc(n) + '</li>'; }).join('');
    var stats = M.stats && Object.keys(M.stats).length ? statRows(M.stats, 0) : '';
    $('#view-about').innerHTML =
      '<div class="about">' +
      '<section class="panel"><h2>About this explorer</h2>' +
      '<p>' + fint(S.N) + ' Transient Name Server (TNS) objects discovered between 2025-03 and 2026-01 whose positions fall inside the ' +
      'Rubin Data Preview 2 (DP2) visit footprint, with lightcurves from several sources overlaid. Search on the left of the ' +
      '<a href="' + esc(listHash()) + '">search page</a>, click an object for its lightcurve, and share the page URL to link to an object or a filtered list.</p>' +
      '<p>This is a <strong>' + (S.isPrivate ? 'private' : 'public') + ' build</strong>' + (M.built ? ', made ' + esc(fmtBuilt(M.built)) : '') + '.' +
      (S.isPrivate ? ' It contains proprietary Rubin DP2 catalog data (DiaSource, forced photometry, match results) for Rubin data-rights holders only. Do not redistribute.' :
        ' It contains only public data; proprietary Rubin DP2 catalog photometry is not included.') + '</p>' +
      (M.fixture ? '<p class="error-box">This build uses a <strong>synthetic fixture</strong>: every name, position and lightcurve is randomly generated for testing.</p>' : '') +
      '</section>' +
      '<section class="panel"><h2>Photometry sources</h2><div class="table-wrap"><table class="data"><thead><tr><th>Marker</th><th>Source</th><th>Survey</th><th class="num">Objects</th><th class="num">Points</th></tr></thead>' +
      '<tbody>' + (srcRows || '<tr class="empty-row"><td colspan="5">No sources.</td></tr>') + '</tbody></table></div>' +
      '<ul><li>Fluxes are in nJy (AB zero point 31.4: m = 31.4 − 2.5 log<sub>10</sub> f). Magnitudes are shown only for positive flux; upper limits are drawn as down-pointing triangles at the limiting magnitude.</li>' +
      '<li>Filled markers are detections; open markers of the same shape are forced photometry from the same survey; each source keeps epochs within [discovery − 150 d, discovery + 400 d].</li>' +
      '<li>Band colours group filters by family (u g r i z y o c w L V B R I Clear; anything else is grey). ZTF and TNS filters share the colour of the matching LSST band.</li>' +
      '<li>Pointing ticks along the bottom of a lightcurve are dp2.Visit pointings whose centre lies within ' + TICK_RADIUS_DEG + '° of the object. ' +
      'A tick means LSSTCam pointed nearby, not that the object landed on a detector: coverage is not guaranteed.</li>' +
      (isNum(win.mjd_start) ? '<li>The shaded band marks the EDP2 visit window, MJD ' + fx(win.mjd_start, 3) + '–' + fx(win.mjd_end, 3) + ' (' + isoDate(win.mjd_start) + ' to ' + isoDate(win.mjd_end) + ').</li>' : '') +
      '</ul></section>' +
      (stats ? '<section class="panel"><h2>Cross-match statistics</h2><p class="muted">Aggregate numbers from the TNS × EDP2 cross-match.</p><div class="table-wrap"><table class="data"><tbody>' + stats + '</tbody></table></div></section>' : '') +
      (notes ? '<section class="panel"><h2>Notes</h2><ul>' + notes + '</ul></section>' : '') +
      '<section class="panel"><h2>Data credits</h2><ul>' +
      '<li><strong>Transient Name Server (TNS)</strong>, the IAU mechanism for reporting new transients: names, positions, discovery data, classifications, redshifts and reported photometry. ' +
      'Discovery and classification credit belongs to the reporting groups listed on each object. <a href="https://www.wis-tns.org/" target="_blank" rel="noopener">wis-tns.org</a></li>' +
      '<li><strong>Zwicky Transient Facility (ZTF)</strong> alert and forced photometry served by the <strong>ALeRCE</strong> broker (Förster et al. 2021, AJ 161, 242). ' +
      'ZTF is supported by the NSF and a collaboration including Caltech, IPAC and partner institutions (Bellm et al. 2019, PASP 131, 018002). <a href="https://alerce.online/" target="_blank" rel="noopener">alerce.online</a></li>' +
      '<li><strong>Rubin alerts</strong> via the <strong>Fink</strong> broker (Möller et al. 2021, MNRAS 501, 3272). <a href="https://lsst.fink-portal.org/" target="_blank" rel="noopener">lsst.fink-portal.org</a></li>' +
      '<li><strong>NSF–DOE Vera C. Rubin Observatory</strong> Data Preview 2: dp2.Visit pointing metadata' + (S.isPrivate ? ' and DP2 DiaObject, DiaSource and forced-photometry catalogs (proprietary)' : '') +
      ' (Ivezić et al. 2019, ApJ 873, 111). <a href="https://rubinobservatory.org/" target="_blank" rel="noopener">rubinobservatory.org</a></li>' +
      '<li>Link-outs: <a href="https://www.wiserep.org/" target="_blank" rel="noopener">WISeREP</a> (Yaron &amp; Gal-Yam 2012, PASP 124, 668) and the ' +
      '<a href="https://www.legacysurvey.org/" target="_blank" rel="noopener">DESI Legacy Imaging Surveys</a> viewer. Plots use <a href="https://plotly.com/javascript/" target="_blank" rel="noopener">Plotly.js</a>; the site layout follows LSST DESC FASTDB.</li>' +
      '</ul></section></div>';
  }

  // ------------------------------------------------------------------ go
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
