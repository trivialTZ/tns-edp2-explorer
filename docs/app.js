/* TNS x EDP2 Explorer — core: state, utilities, data loading, theme, router, search.
 *
 * Vanilla JS, no build step. Data arrives through <script> tags that call
 * window.TNSX (SCHEMA.md section 2), so the site works over https and from file://.
 * Modules share one internal namespace, window.TNSXApp:
 *   app.js (this file) · filters.js · explore.js · home.js · object.js · about.js
 * Routes:  #/  ·  #/explore?<filters>  ·  #/object/<name>  ·  #/about
 */
(function () {
  'use strict';
  var X = window.TNSXApp = {};

  // ------------------------------------------------------------------ constants
  var K = X.K = {
    PLOTLY_URL: 'https://cdn.jsdelivr.net/npm/plotly.js-dist-min@3.7.0/plotly.min.js',
    PLOTLY_SRI: 'sha384-l4G4qURPwALv583BKlynU/4LiUx0rk9jcTX58Aq+Jc+jgWb52zeH2geZkSS3UPPs',
    ZP: 31.4,                 // AB mag of 1 nJy
    TICK_RADIUS_DEG: 1.75,    // pointing ticks: visit centre within this radius
    DEFAULT_MATCH_R: 2.0,     // arcsec, common.MATCH_RADIUS_AS
    SHARD_SIZE: 100,
    MJD_UNIX: 40587,          // MJD of 1970-01-01
    DEFAULT_CONE_AS: 10,
    PRIVATE_BANNER: 'PROPRIETARY Rubin DP2 data. For Rubin data-rights holders only. Do not redistribute.',
    // Band families (SCHEMA.md "Band labels"). LSST u..y use Rubin-like hues re-stepped per
    // theme; ZTF/TNS filters share the colour of the matching band. Broad white-light filters
    // (w, L, Clear) are neutral so no band colour sits near the violet UI accent.
    FAMILIES: ['u', 'g', 'r', 'i', 'z', 'y', 'o', 'c', 'w', 'L', 'V', 'B', 'R', 'I', 'Clear', 'other'],
    FAM_COLORS: {
      light: { u: '#1f6fe0', g: '#45b35f', r: '#b3261a', i: '#b88300', z: '#d23d98', y: '#8a3b2c',
        o: '#e0701a', c: '#1799a8', w: '#6f6a60', L: '#9a8c74', V: '#6b8e23', B: '#2340a0', R: '#d9534f',
        I: '#7a5c00', Clear: '#3f3d38', other: '#a8a498' },
      dark: { u: '#4a8cf0', g: '#38aa63', r: '#c23624', i: '#b39015', z: '#d45aa6', y: '#bb6533',
        o: '#e07a2a', c: '#2bb3c0', w: '#a39d90', L: '#bfae8f', V: '#93b340', B: '#6f86e0', R: '#e8706b',
        I: '#d9b550', Clear: '#e0ddd4', other: '#6d6a62' }
    },
    // Marker per source: filled = detections, open = forced photometry of the same survey.
    SRC_SYMBOL: { edp2_dia: 'circle', edp2_fp: 'circle-open', lsst_alert: 'diamond', lsst_alert_fp: 'diamond-open',
      ztf: 'square', ztf_fp: 'square-open', tns: 'star' },
    EXTRA_SYMBOLS: ['triangle-up', 'pentagon', 'hexagon', 'cross', 'x', 'hourglass'],
    LIMIT_SYMBOL: 'triangle-down-open',
    SRC_SHORT: { edp2_dia: 'EDP2 DIA', edp2_fp: 'EDP2 forced', lsst_alert: 'LSST alerts', lsst_alert_fp: 'LSST alert FP',
      ztf: 'ZTF', ztf_fp: 'ZTF forced', tns: 'TNS' },
    KIND_LABEL: ['detection', 'forced', 'upper limit'],
    // Columns the object page knows how to show; anything else is listed as key: value.
    KNOWN_COLS: ['name', 'prefix', 'ra', 'dec', 'type', 'z', 'group', 'disc_mjd', 'disc_mag', 'disc_filter', 'internal',
      'n_visits', 'n_visits_active', 'alert_ids', 'shard', 'n_spec', 'spec_types',
      'edp2_id', 'edp2_sep', 'edp2_ndia', 'edp2_lead', 'edp2_tc']
  };
  var FAM_EXACT = { R: 'R', I: 'I', V: 'V', B: 'B', L: 'L' };
  var FAM_LOWER = { u: 'u', g: 'g', r: 'r', i: 'i', z: 'z', y: 'y', o: 'o', c: 'c', w: 'w', v: 'V', b: 'B', l: 'L', clear: 'Clear' };

  // ------------------------------------------------------------------ state
  var S = X.S = {
    catalogRaw: null, meta: {}, cols: [], rows: [], C: {}, N: 0,
    byName: new Map(), search: [], nameKey: [],
    srcKeys: [], isPrivate: false, matchR: K.DEFAULT_MATCH_R,
    view: null, lastObj: null, listQuery: '',
    visits: null, visitsState: 'idle', nearCache: new Map(),
    shards: {}, shardPromises: {}, plotlyPromise: null,
    theme: 'auto'
  };
  X.views = {};

  // ------------------------------------------------------------------ data callbacks (defined before any data script)
  var TNSX = window.TNSX = window.TNSX || {};
  TNSX.onCatalog = function (d) { S.catalogRaw = d; };
  TNSX.onVisits = function (d) { ingestVisits(d); };
  TNSX.onShard = function (n, d) { S.shards[Number(n)] = d || {}; };

  // ------------------------------------------------------------------ helpers
  var U = X.U = {};
  U.$ = function (sel, root) { return (root || document).querySelector(sel); };
  U.$all = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  U.esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  U.isNum = function (v) { return typeof v === 'number' && isFinite(v); };
  U.fx = function (v, d) { return U.isNum(v) ? v.toFixed(d) : ''; };
  U.fint = function (v) { return U.isNum(v) ? Math.round(v).toLocaleString('en-US') : ''; };
  U.pad2 = function (n) { return (n < 10 ? '0' : '') + n; };
  U.pad3 = function (n) { return ('00' + n).slice(-3); };
  U.mjdDate = function (mjd) { return new Date((mjd - K.MJD_UNIX) * 86400000); };
  U.isoDate = function (mjd) { return U.isNum(mjd) ? U.mjdDate(mjd).toISOString().slice(0, 10) : ''; };
  U.isoDateTime = function (mjd) { return U.isNum(mjd) ? U.mjdDate(mjd).toISOString().slice(0, 16).replace('T', ' ') : ''; };
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  U.MONTHS = MONTHS;
  U.niceDate = function (mjd) {
    if (!U.isNum(mjd)) return '';
    var d = U.mjdDate(mjd);
    return d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
  };
  U.monthYear = function (mjd) { var d = U.mjdDate(mjd); return MONTHS[d.getUTCMonth()] + ' ' + d.getUTCFullYear(); };
  U.dateToMjd = function (y, m, d, hh, mm, ss) { return Date.UTC(y, m - 1, d, hh || 0, mm || 0, ss || 0) / 86400000 + K.MJD_UNIX; };
  U.mag = function (f) { return f > 0 ? K.ZP - 2.5 * Math.log10(f) : null; };
  U.flux = function (m) { return Math.pow(10, (K.ZP - m) / 2.5); };
  U.cssVar = function (name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); };
  U.isDark = function () {
    var t = document.documentElement.getAttribute('data-theme');
    if (t === 'dark') return true;
    if (t === 'light') return false;
    return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  };
  U.famColor = function (f) { return K.FAM_COLORS[U.isDark() ? 'dark' : 'light'][f] || K.FAM_COLORS.light.other; };
  U.lsGet = function (k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } };
  U.lsSet = function (k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* storage blocked */ } };
  U.ssGet = function (k) { try { return window.sessionStorage.getItem(k); } catch (e) { return null; } };
  U.ssSet = function (k, v) { try { window.sessionStorage.setItem(k, v); } catch (e) { /* storage blocked */ } };
  U.debounce = function (fn, ms) { var t; return function () { var a = arguments; clearTimeout(t); t = setTimeout(function () { fn.apply(null, a); }, ms); }; };
  U.idle = window.requestIdleCallback ? function (f) { return window.requestIdleCallback(f, { timeout: 1500 }); } : function (f) { return setTimeout(f, 300); };
  U.V = function (i, c) { var j = S.C[c]; return j === undefined ? undefined : S.rows[i][j]; };
  U.has = function (c) { return S.C[c] !== undefined; };
  U.fullName = function (i) { var p = U.V(i, 'prefix'); return (p ? p + ' ' : '') + U.V(i, 'name'); };
  U.srcLabel = function (k) { var s = S.meta.sources && S.meta.sources[k]; return (s && s.label) || k; };
  U.srcShort = function (k) { return K.SRC_SHORT[k] || U.srcLabel(k); };
  U.cssEscape = function (s) { return window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^\w-]/g, '\\$&'); };
  U.isSN = function (t) { return !!t && /^(SN|SLSN)/.test(t); };
  U.plural = function (n, one, many) { return U.fint(n) + ' ' + (n === 1 ? one : (many || one + 's')); };

  var famCache = new Map();
  function famOf(tok) {
    if (!tok) return null;
    if (FAM_EXACT[tok]) return FAM_EXACT[tok];
    return FAM_LOWER[tok.toLowerCase()] || null;
  }
  U.bandFamily = function (band) {
    if (famCache.has(band)) return famCache.get(band);
    var parts = String(band == null ? '' : band).split('-');
    var f = famOf(parts[parts.length - 1].trim());
    if (!f && parts.length > 1) f = famOf(parts[0].trim());   // tolerate "o-ATLAS" order too
    f = f || 'other';
    famCache.set(band, f);
    return f;
  };

  function sexa(v, secDigits) {
    var a = Math.abs(v), d = Math.floor(a), m = Math.floor((a - d) * 60);
    var sec = +(((a - d) * 60 - m) * 60).toFixed(secDigits);
    if (sec >= 60) { sec -= 60; m += 1; }
    if (m >= 60) { m -= 60; d += 1; }
    return [d, m, (sec < 10 ? '0' : '') + sec.toFixed(secDigits)];
  }
  U.raHms = function (ra) {
    if (!U.isNum(ra)) return '';
    var p = sexa((((ra % 360) + 360) % 360) / 15, 2);
    return U.pad2(p[0] % 24) + ':' + U.pad2(p[1]) + ':' + p[2];
  };
  U.decDms = function (dec) {
    if (!U.isNum(dec)) return '';
    var p = sexa(dec, 1);
    return (dec < 0 ? '−' : '+') + U.pad2(p[0]) + ':' + U.pad2(p[1]) + ':' + p[2];
  };
  U.signed = function (v, d) { return U.isNum(v) ? (v < 0 ? '−' : '+') + Math.abs(v).toFixed(d) : ''; };
  U.sepDeg = function (ra1, dec1, ra2, dec2) {
    var r = Math.PI / 180, dra = (ra2 - ra1) * r, dd = (dec2 - dec1) * r;
    var a = Math.sin(dd / 2) * Math.sin(dd / 2) + Math.cos(dec1 * r) * Math.cos(dec2 * r) * Math.sin(dra / 2) * Math.sin(dra / 2);
    return 2 * Math.asin(Math.min(1, Math.sqrt(a))) / r;
  };
  // TNS names sort chronologically: year, then name length, then letters (2025z < 2025aa).
  U.tnsNameKey = function (n) {
    var m = /^(\d{4})([a-z]+)$/i.exec(n || '');
    return m ? m[1] + U.pad2(m[2].length) + m[2].toLowerCase() : '9999' + String(n || '');
  };
  U.normQuery = function (s) {
    s = String(s || '').toLowerCase().replace(/\s+/g, '');
    return /^(sn|at)\d{4}/.test(s) ? s.slice(2) : s;
  };
  U.fmtBuilt = function (b) {
    if (!b) return '';
    var d = new Date(b);
    return isNaN(d) ? String(b) : d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  };

  // ---- parsing user input
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
  U.parseRA = function (s) {
    s = cleanCoord(s);
    if (!s) return null;
    var v;
    if (!isSexaStr(s)) v = Number(s.replace(/\s*(deg|[dD°º])$/, ''));
    else {
      var p = parseSexa(s);
      if (!p || p.sign < 0) return NaN;
      v = /[dD°º]/.test(s) && !/[hH]/.test(s) ? p.val : p.val * 15;
    }
    return isFinite(v) && v >= 0 && v < 360 ? v : NaN;
  };
  U.parseDec = function (s) {
    s = cleanCoord(s);
    if (!s) return null;
    var v;
    if (!isSexaStr(s)) v = Number(s.replace(/\s*(deg|[dD°º])$/, ''));
    else { var p = parseSexa(s); if (!p) return NaN; v = p.sign * p.val; }
    return isFinite(v) && v >= -90 && v <= 90 ? v : NaN;
  };
  // "RA Dec" typed into one box
  U.splitCoordPair = function (s) {
    s = cleanCoord(s);
    if (s.indexOf(',') >= 0) { var q = s.split(','); if (q.length === 2) return [q[0], q[1]]; }
    var m = /^(\S+)\s+([-+]\S+)$/.exec(s);
    if (m) return [m[1], m[2]];
    var t = s.split(/\s+/);
    if (t.length === 2 && !isSexaStr(t[0]) && !isSexaStr(t[1])) return [t[0], t[1]];
    if (t.length === 6) return [t.slice(0, 3).join(' '), t.slice(3).join(' ')];
    return null;
  };
  U.parseCoordPair = function (s) {
    var p = U.splitCoordPair(s);
    if (!p) return null;
    var ra = U.parseRA(p[0]), dec = U.parseDec(p[1]);
    return U.isNum(ra) && U.isNum(dec) ? { ra: ra, dec: dec } : null;
  };
  U.parseNum = function (s) {
    s = String(s == null ? '' : s).trim().replace(/[−]/g, '-');
    if (!s) return null;
    var v = Number(s);
    return isFinite(v) ? v : NaN;
  };
  // MJD or calendar date (YYYY-MM-DD[ HH:MM[:SS]])
  U.parseMjdOrDate = function (s) {
    s = String(s == null ? '' : s).trim();
    if (!s) return null;
    var m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}(?:\.\d*)?))?)?Z?$/.exec(s);
    if (m) return U.dateToMjd(+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
    var v = Number(s);
    return isFinite(v) ? v : NaN;
  };

  // ---- icons (stroke icons drawn on a 24 grid)
  var ICONS = {
    search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
    ext: '<path d="M8 16L16 8M9 8h7v7"/>',
    arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    left: '<path d="M15 6l-6 6 6 6"/>',
    right: '<path d="M9 6l6 6-6 6"/>',
    chev: '<path d="M6 9l6 6 6-6"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
    filter: '<path d="M4 6h16M7 12h10M10 18h4"/>',
    columns: '<rect x="4" y="5" width="16" height="14" rx="2"/><path d="M10 5v14M16 5v14"/>',
    shuffle: '<path d="M4 7h3.5c2 0 3 1 4.5 3.5S15 17 17.5 17H20M4 17h3.5c1.2 0 2-.4 2.8-1.2M14 8.2c.8-.8 1.8-1.2 3.5-1.2H20M17 4l3 3-3 3M17 14l3 3-3 3"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4"/>',
    moon: '<path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z"/>',
    auto: '<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" stroke="none"/>',
    lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>'
  };
  U.icon = function (name, extra) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="' + (extra || 1.9) +
      '" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICONS[name] || '') + '</svg>';
  };
  // Small SVG of a Plotly marker symbol (legend chips, source cards).
  U.symbolSvg = function (symbol, color) {
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
  };
  U.srcSymbol = function (k) { return K.SRC_SYMBOL[k] || 'circle'; };

  // ---- CSV + clipboard
  function csvCell(v) {
    if (v == null || (typeof v === 'number' && !isFinite(v))) return '';
    var s = String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  U.downloadCsv = function (filename, header, rows) {
    var lines = [header.map(csvCell).join(',')];
    for (var k = 0; k < rows.length; k++) lines.push(rows[k].map(csvCell).join(','));
    var blob = new Blob([lines.join('\n') + '\n'], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  };
  U.copyText = function (text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    return new Promise(function (resolve, reject) {
      var ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy') ? resolve() : reject(new Error('copy failed')); } catch (e) { reject(e); }
      ta.remove();
    });
  };

  // ---- custom hover card (Plotly charts and SVG histograms)
  U.hover = {
    show: function (html, x, y) {
      var el = document.getElementById('hovercard');
      el.innerHTML = html;
      el.hidden = false;
      var w = el.offsetWidth, h = el.offsetHeight, vw = window.innerWidth, vh = window.innerHeight;
      var left = x + 16, top = y + 16;
      if (left + w > vw - 8) left = Math.max(8, x - w - 16);
      if (top + h > vh - 8) top = Math.max(8, y - h - 16);
      el.style.left = left + 'px'; el.style.top = top + 'px';
    },
    hide: function () { var el = document.getElementById('hovercard'); if (el) el.hidden = true; }
  };
  window.addEventListener('scroll', function () { U.hover.hide(); }, { passive: true });

  // ------------------------------------------------------------------ script loading
  U.loadScript = function (src, opts) {
    return new Promise(function (resolve, reject) {
      var el = document.createElement('script');
      el.src = src;
      el.async = true;
      if (opts && opts.integrity) { el.integrity = opts.integrity; el.crossOrigin = 'anonymous'; }
      el.onload = function () { resolve(); };
      el.onerror = function () { el.remove(); reject(new Error('could not load ' + src)); };
      document.head.appendChild(el);
    });
  };
  X.loadShard = function (n) {
    if (S.shards[n]) return Promise.resolve(S.shards[n]);
    if (S.shardPromises[n]) return S.shardPromises[n];
    var src = 'data/lc/' + U.pad3(n) + '.js';
    var p = U.loadScript(src).then(function () {
      if (!S.shards[n]) throw new Error(src + ' loaded but did not call TNSX.onShard(' + n + ', …)');
      return S.shards[n];
    });
    S.shardPromises[n] = p;
    p.catch(function () { delete S.shardPromises[n]; });
    return p;
  };
  X.shardOf = function (i) { var s = U.V(i, 'shard'); return U.isNum(s) ? s : Math.floor(i / K.SHARD_SIZE); };
  X.ensurePlotly = function () {
    if (window.Plotly) return Promise.resolve(window.Plotly);
    if (!S.plotlyPromise) {
      S.plotlyPromise = U.loadScript(K.PLOTLY_URL, { integrity: K.PLOTLY_SRI }).then(function () {
        if (!window.Plotly) throw new Error('Plotly did not initialise');
        return window.Plotly;
      });
      S.plotlyPromise.catch(function () { S.plotlyPromise = null; });
    }
    return S.plotlyPromise;
  };
  X.loadVisits = function () {
    if (S.visitsState !== 'idle') return;
    S.visitsState = 'loading';
    U.loadScript('data/visits.js').then(function () {
      if (!S.visits) throw new Error('visits.js did not call TNSX.onVisits');
    }).catch(function (e) {
      S.visitsState = 'error';
      console.warn(e.message);
      if (X.onVisitsChanged) X.onVisitsChanged();
    });
  };
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
    if (X.onVisitsChanged) X.onVisitsChanged();
  }
  X.nearbyVisits = function (i) {
    if (!S.visits) return null;
    if (S.nearCache.has(i)) return S.nearCache.get(i);
    var r = Math.PI / 180, ra = U.V(i, 'ra') * r, dec = U.V(i, 'dec') * r;
    var ox = Math.cos(dec) * Math.cos(ra), oy = Math.cos(dec) * Math.sin(ra), oz = Math.sin(dec);
    var cmin = Math.cos(K.TICK_RADIUS_DEG * r), v = S.visits, out = [];
    for (var k = 0; k < v.n; k++) {
      var c = ox * v.x[k] + oy * v.y[k] + oz * v.z[k];
      if (c >= cmin) out.push({ mjd: v.mjd[k], band: v.band[k], sep: Math.acos(Math.min(1, c)) / r });
    }
    S.nearCache.set(i, out);
    return out;
  };

  // Start the catalogue download now; everything else waits for DOMContentLoaded.
  X.catalogLoad = U.loadScript('data/catalog.js');

  function initCatalog(d) {
    S.meta = d.meta || {};
    S.cols = d.cols || [];
    S.rows = d.rows || [];
    S.N = S.rows.length;
    S.cols.forEach(function (c, j) { S.C[c] = j; });
    S.isPrivate = S.meta.mode === 'private';
    S.matchR = U.isNum(S.meta.match_radius_arcsec) ? S.meta.match_radius_arcsec : K.DEFAULT_MATCH_R;
    S.srcKeys = Object.keys(S.meta.sources || {}).filter(function (k) { return U.has('n_' + k); });
    var jn = S.C.name, ji = S.C.internal;
    for (var i = 0; i < S.N; i++) {
      var r = S.rows[i], name = String(r[jn]);
      S.byName.set(name, i);
      S.byName.set(name.toLowerCase(), i);
      var internal = ji === undefined ? '' : String(r[ji] || '');
      S.search[i] = '|' + name.toLowerCase() + '|' + internal.toLowerCase().replace(/\s+/g, '').split(',').join('|') + '|';
      S.nameKey[i] = U.tnsNameKey(name);
    }
    // totals used by Home and About
    var pts = 0;
    Object.keys(S.meta.sources || {}).forEach(function (k) { pts += S.meta.sources[k].n_points || 0; });
    S.totalPoints = pts;
    var jt = S.C.type, typed = 0, dmin = Infinity, dmax = -Infinity, jd = S.C.disc_mjd;
    for (i = 0; i < S.N; i++) {
      if (jt !== undefined && S.rows[i][jt]) typed++;
      var dm = S.rows[i][jd];
      if (U.isNum(dm)) { if (dm < dmin) dmin = dm; if (dm > dmax) dmax = dm; }
    }
    S.nTyped = typed; S.discMin = dmin; S.discMax = dmax;

    if (S.isPrivate) {
      document.documentElement.classList.add('is-private');
      var b = document.getElementById('private-strip');
      b.innerHTML = U.icon('lock', 2) + '<span>' + U.esc(K.PRIVATE_BANNER) + '</span>';
      b.hidden = false;
    }
    if (S.meta.fixture) {
      var mb = document.getElementById('mode-badge');
      mb.textContent = 'Synthetic fixture';
      mb.hidden = false;
    }
    var built = U.fmtBuilt(S.meta.built);
    document.getElementById('footer-built').textContent = 'TNS × EDP2 Explorer · ' + U.fint(S.N) + ' transients · ' +
      (S.isPrivate ? 'private build' : 'public build') + (built ? ' · built ' + built : '');
  }

  // ------------------------------------------------------------------ theme
  var THEMES = ['auto', 'light', 'dark'];
  function initTheme() {
    var t = U.lsGet('tnsx-theme');
    applyTheme(THEMES.indexOf(t) >= 0 ? t : 'auto', true);
    document.getElementById('theme-btn').addEventListener('click', function () {
      applyTheme(THEMES[(THEMES.indexOf(S.theme) + 1) % THEMES.length]);
      U.lsSet('tnsx-theme', S.theme);
    });
    if (window.matchMedia) {
      var mq = window.matchMedia('(prefers-color-scheme: dark)');
      var fn = function () { if (S.theme === 'auto') themeChanged(); };
      if (mq.addEventListener) mq.addEventListener('change', fn); else if (mq.addListener) mq.addListener(fn);
    }
  }
  function applyTheme(t, quiet) {
    S.theme = t;
    if (t === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', t);
    var label = { auto: 'automatic', light: 'light', dark: 'dark' }[t];
    var btn = document.getElementById('theme-btn');
    btn.innerHTML = U.icon(t === 'auto' ? 'auto' : t === 'light' ? 'sun' : 'moon', 1.8);
    btn.setAttribute('aria-label', 'Colour theme: ' + label + ' (click to change)');
    btn.title = 'Theme: ' + label;
    if (!quiet) themeChanged();
  }
  function themeChanged() {
    Object.keys(X.views).forEach(function (k) { if (X.views[k].onTheme && S.view === k) X.views[k].onTheme(); });
  }

  // ------------------------------------------------------------------ router
  X.go = function (hash) { if (location.hash === hash) route(); else location.hash = hash; };
  X.replace = function (hash) { if (location.hash !== hash) location.replace(hash); };
  X.exploreHash = function () { return '#/explore' + (S.listQuery ? '?' + S.listQuery : ''); };
  function route() {
    U.hover.hide();
    closeSpotlight();
    var h = location.hash || '#/';
    if (/^#\/\?/.test(h)) { location.replace('#/explore' + h.slice(2)); return; }   // links from the first release
    var name = 'home', arg = null;
    if (h.indexOf('#/object/') === 0) {
      name = 'object'; arg = h.slice(9).split('?')[0];
      try { arg = decodeURIComponent(arg); } catch (e) { /* keep raw */ }
    } else if (h === '#/object') {
      location.replace(S.lastObj != null ? '#/object/' + encodeURIComponent(U.V(S.lastObj, 'name')) : X.exploreHash());
      return;
    } else if (h.indexOf('#/explore') === 0) {
      name = 'explore'; arg = h.indexOf('?') >= 0 ? h.slice(h.indexOf('?') + 1) : '';
    } else if (h.indexOf('#/about') === 0) name = 'about';
    var prev = S.view;
    S.view = name;
    document.documentElement.setAttribute('data-route', name);
    ['home', 'explore', 'object', 'about'].forEach(function (k) { document.getElementById('view-' + k).hidden = k !== name; });
    U.$all('.nav a').forEach(function (a) {
      if (a.getAttribute('data-nav') === name) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    U.$all('a[data-nav="explore"]').forEach(function (a) { a.setAttribute('href', X.exploreHash()); });
    X.views[name].show(arg, prev);
    if (prev !== name && name !== 'explore') window.scrollTo(0, 0);
  }
  X.route = route;

  // ------------------------------------------------------------------ search suggestions (hero + spotlight)
  function matchItems(raw, limit) {
    var q = U.normQuery(raw);
    var items = [];
    var cp = U.parseCoordPair(raw);
    if (cp) items.push({ kind: 'cone', ra: cp.ra, dec: cp.dec });
    if (!q) return items;
    var hits = [];
    for (var i = 0; i < S.N; i++) {
      var s = S.search[i], at = s.indexOf(q);
      if (at < 0) continue;
      var name = s.slice(1, s.indexOf('|', 1)), score;
      if (name === q) score = 0;
      else if (name.indexOf(q) === 0) score = 1;
      else if (s.indexOf('|' + q) >= 0) score = 2;
      else score = 3;
      hits.push([score, i]);
    }
    hits.sort(function (a, b) { return a[0] - b[0] || (S.nameKey[b[1]] < S.nameKey[a[1]] ? -1 : 1); });
    hits.slice(0, limit).forEach(function (h) { items.push({ kind: 'obj', i: h[1] }); });
    if (hits.length > limit) items.push({ kind: 'all', q: raw.trim(), n: hits.length });
    if (!hits.length && !cp) items.push({ kind: 'none', q: raw.trim() });
    return items;
  }
  function hl(text, q) {
    var t = String(text), k = t.toLowerCase().replace(/\s+/g, '').indexOf(q);
    if (!q || k < 0 || /\s/.test(t)) return U.esc(t);
    return U.esc(t.slice(0, k)) + '<mark>' + U.esc(t.slice(k, k + q.length)) + '</mark>' + U.esc(t.slice(k + q.length));
  }
  function itemHtml(it, q, id, sel) {
    var attrs = ' role="option" id="' + id + '" aria-selected="' + (sel ? 'true' : 'false') + '"';
    if (it.kind === 'obj') {
      var i = it.i, name = String(U.V(i, 'name')), type = U.V(i, 'type');
      var internal = String(U.V(i, 'internal') || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
      var hitInt = internal.filter(function (s) { return s.toLowerCase().replace(/\s+/g, '').indexOf(q) >= 0; });
      return '<li' + attrs + '><span class="s-name"><span class="pfx">' + U.esc(U.V(i, 'prefix') || '') + '</span> ' + hl(name, q) + '</span>' +
        '<span class="s-meta">' + (type ? U.esc(type) + ' · ' : '') + U.esc(U.niceDate(U.V(i, 'disc_mjd'))) + '</span>' +
        (hitInt.length && name.indexOf(q) < 0 ? '<span class="s-sub">' + hitInt.slice(0, 3).map(function (s) { return hl(s, q); }).join(', ') + '</span>' :
          internal.length ? '<span class="s-sub">' + U.esc(internal.slice(0, 3).join(', ')) + '</span>' : '') + '</li>';
    }
    if (it.kind === 'cone') {
      return '<li class="s-action"' + attrs + '><span class="s-name">Search around RA ' + it.ra.toFixed(4) + '°, Dec ' + U.signed(it.dec, 4) + '°</span>' +
        '<span class="s-meta">cone search, ' + K.DEFAULT_CONE_AS + '″</span></li>';
    }
    if (it.kind === 'all') {
      return '<li class="s-action"' + attrs + '><span class="s-name">See all ' + U.fint(it.n) + ' matches for “' + U.esc(it.q) + '”</span><span class="s-meta">Explore →</span></li>';
    }
    return '<li class="s-empty" role="option" id="' + id + '" aria-disabled="true"><span class="s-name">No transient matches “' + U.esc(it.q) + '”</span>' +
      '<span class="s-meta">try a TNS name, an internal name or “RA Dec”</span></li>';
  }
  function chooseItem(it) {
    if (!it) return;
    if (it.kind === 'obj') X.go('#/object/' + encodeURIComponent(U.V(it.i, 'name')));
    else if (it.kind === 'cone') X.go('#/explore?ra=' + it.ra.toFixed(5) + '&dec=' + it.dec.toFixed(5) + '&rad=' + K.DEFAULT_CONE_AS);
    else if (it.kind === 'all') X.go('#/explore?q=' + encodeURIComponent(it.q));
  }
  // Wire an <input> to a suggestion listbox (combobox pattern).
  X.attachSuggest = function (input, list, opts) {
    opts = opts || {};
    var items = [], sel = -1, uid = 'sg' + Math.random().toString(36).slice(2, 7);
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-expanded', 'false');
    input.setAttribute('aria-controls', list.id || (list.id = uid));
    list.setAttribute('role', 'listbox');
    function render() {
      var q = U.normQuery(input.value);
      items = matchItems(input.value, opts.limit || 7);
      if (!items.length) { close(); return; }
      if (sel >= items.length) sel = items.length - 1;
      list.innerHTML = items.map(function (it, k) { return itemHtml(it, q, uid + '-' + k, k === sel); }).join('');
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      if (sel >= 0) input.setAttribute('aria-activedescendant', uid + '-' + sel); else input.removeAttribute('aria-activedescendant');
    }
    function close() { list.hidden = true; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); sel = -1; }
    input.addEventListener('input', function () { sel = input.value.trim() ? 0 : -1; render(); });
    input.addEventListener('focus', function () { if (input.value.trim()) render(); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); if (list.hidden) render(); sel = Math.min(items.length - 1, sel + 1); render(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); render(); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        if (!input.value.trim()) return;
        items = matchItems(input.value, opts.limit || 7);
        var it = items[sel >= 0 ? sel : 0];
        if (it && it.kind !== 'none') { close(); chooseItem(it); if (opts.onChoose) opts.onChoose(); }
      } else if (e.key === 'Escape') { if (!list.hidden) { e.stopPropagation(); close(); } else if (opts.onEscape) opts.onEscape(); }
    });
    input.addEventListener('blur', function () { setTimeout(close, 150); });
    list.addEventListener('mousedown', function (e) { e.preventDefault(); });
    list.addEventListener('click', function (e) {
      var li = e.target.closest('li[role="option"]');
      if (!li || li.getAttribute('aria-disabled')) return;
      var k = +li.id.split('-').pop();
      close(); chooseItem(items[k]); if (opts.onChoose) opts.onChoose();
    });
    list.addEventListener('mousemove', function (e) {
      var li = e.target.closest('li[role="option"]');
      if (!li) return;
      var k = +li.id.split('-').pop();
      if (k !== sel) { sel = k; U.$all('li', list).forEach(function (x, j) { x.setAttribute('aria-selected', j === k ? 'true' : 'false'); }); }
    });
  };

  // ---- spotlight overlay (top bar search, Cmd/Ctrl+K, "/")
  var spot = null;
  function openSpotlight() {
    if (!S.N) return;
    if (spot) { spot.input.focus(); return; }
    var scrim = document.createElement('div');
    scrim.className = 'scrim';
    var dlg = document.createElement('div');
    dlg.className = 'spotlight-dlg';
    dlg.setAttribute('role', 'dialog');
    dlg.setAttribute('aria-modal', 'true');
    dlg.setAttribute('aria-label', 'Search transients');
    dlg.innerHTML = '<div class="spot-field">' + U.icon('search', 2) + '<input type="search" placeholder="TNS name, internal name or RA Dec" aria-label="Search transients" autocomplete="off" spellcheck="false"></div>' +
      '<ul class="suggest" hidden></ul><p class="spot-hint">↑↓ to move · Enter to open · Esc to close</p>';
    document.body.appendChild(scrim);
    document.body.appendChild(dlg);
    var input = dlg.querySelector('input');
    spot = { scrim: scrim, dlg: dlg, input: input, ret: document.activeElement };
    X.attachSuggest(input, dlg.querySelector('.suggest'), { limit: 8, onChoose: closeSpotlight, onEscape: closeSpotlight });
    scrim.addEventListener('click', closeSpotlight);
    dlg.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeSpotlight(); if (e.key === 'Tab') { e.preventDefault(); input.focus(); } });
    input.focus();
  }
  function closeSpotlight() {
    if (!spot) return;
    var ret = spot.ret;
    spot.scrim.remove(); spot.dlg.remove(); spot = null;
    if (ret && ret.focus && document.body.contains(ret)) ret.focus({ preventScroll: true });
  }
  X.openSpotlight = openSpotlight;
  function initShell() {
    var mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
    document.getElementById('kbd-hint').textContent = mac ? '⌘K' : 'Ctrl K';
    document.getElementById('open-search').addEventListener('click', openSpotlight);
    document.addEventListener('keydown', function (e) {
      var t = e.target, tag = t && t.tagName, typing = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || (t && t.isContentEditable);
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); openSpotlight(); return; }
      if (!typing && e.key === '/' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); openSpotlight(); return; }
      if (!typing && X.views[S.view] && X.views[S.view].onKey) X.views[S.view].onKey(e);
    });
  }

  // ------------------------------------------------------------------ boot
  X.boot = function () {
    initTheme();
    initShell();
    X.catalogLoad.then(function () {
      if (!S.catalogRaw) throw new Error('data/catalog.js loaded but did not call TNSX.onCatalog');
      initCatalog(S.catalogRaw);
      S.catalogRaw = null;
      X.F.init();
      Object.keys(X.views).forEach(function (k) { if (X.views[k].init) X.views[k].init(); });
      document.getElementById('boot-generic').hidden = true;
      window.addEventListener('hashchange', route);
      route();
      U.idle(X.loadVisits);
    }).catch(function (e) {
      console.error(e);
      document.getElementById('boot-generic').hidden = true;
      document.getElementById('boot-home').hidden = true;
      var box = document.getElementById('boot-error');
      box.hidden = false;
      box.innerHTML = '<div class="prose"><p class="eyebrow">Something went wrong</p><h1>The catalogue did not load</h1>' +
        '<p>' + U.esc(e.message) + '.</p><p>This page expects <code class="mono">data/catalog.js</code> next to <code class="mono">index.html</code>. ' +
        'It is written by <code class="mono">build/assemble.py</code> (or <code class="mono">build/make_fixture.py</code> for test data).</p></div>';
    });
  };
  document.addEventListener('DOMContentLoaded', function () { X.boot(); });
})();
