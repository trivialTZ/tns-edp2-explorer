/* TNS x EDP2 Explorer — team access: the password-unlocked EDP2 layer.
 *
 * Rubin DP2 (EDP2) catalogue data is proprietary. The public site carries it only as
 * AES-256-GCM ciphertext in data/edp2/ (SCHEMA.md section 3, written by
 * build/crypto_layer.py). Rubin data-rights holders unlock it with the team password:
 * WebCrypto derives the key in this browser (PBKDF2-SHA256, then AES-GCM) and nothing is
 * sent anywhere. The raw key bytes are kept with the build's salt in sessionStorage, or in
 * localStorage with "Remember on this device", so a rebuild with a new salt invalidates
 * old keys. It all fails closed: on any error the key is forgotten and the site stays (or
 * becomes) public, with a short notice.
 *
 * X.team: ready (Promise of the decrypted catalogue payload, or null), apply(catalog, payload),
 * shard(n), mergeShard(pub, enc), initUi(), unlocked.
 */
(function () {
  'use strict';
  var X = window.TNSXApp, S = X.S, U = X.U;
  var T = X.team = { unlocked: false, ready: null };
  var DIR = 'data/edp2/', STORE = 'tnsx-team-key', NOTICE = 'tnsx-team-notice';
  var CHECK_TEXT = 'tnsx-edp2 key check v1', AAD_PREFIX = 'tnsx-edp2/v1/';   // build/crypto_layer.py
  var MIN_ITER = 600000, MAX_ITER = 10000000;
  var subtle = window.crypto && window.crypto.subtle;                           // absent outside secure contexts
  var NO_CRYPTO = 'This browser cannot decrypt on this page: WebCrypto is only available over https or on localhost.';
  var key = null, tag = '', keyinfo = null, kiPromise = null, blobs = {};
  var te = new TextEncoder();

  var TNSX = window.TNSX;
  TNSX.onKeyInfo = function (d) { keyinfo = d; };
  TNSX.onEnc = function (name, blob) { blobs[String(name)] = blob; };

  // ------------------------------------------------------------------ bytes, storage, notices
  function b64d(s) {
    var bin = atob(s), u = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  }
  function b64e(u) {
    var s = '';
    for (var i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
    return btoa(s);
  }
  function forget() {
    try { window.sessionStorage.removeItem(STORE); } catch (e) { /* storage blocked */ }
    try { window.localStorage.removeItem(STORE); } catch (e) { /* storage blocked */ }
  }
  function readStored() {
    var raw = U.ssGet(STORE) || U.lsGet(STORE);
    if (!raw) return null;
    try {
      var o = JSON.parse(raw);
      if (o && o.v === 1 && typeof o.salt === 'string' && typeof o.key === 'string') return o;
    } catch (e) { /* malformed: forget it below */ }
    forget();
    return null;
  }
  function notice(msg) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { notice(msg); });
      return;
    }
    var el = document.getElementById('team-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'team-toast';
      el.className = 'toast';
      el.setAttribute('role', 'status');
      document.body.appendChild(el);
    }
    el.innerHTML = U.icon('lock', 2) + '<span>' + U.esc(msg) + '</span>' +
      '<button type="button" class="toast-x" aria-label="Dismiss">' + U.icon('x', 2) + '</button>';
    el.hidden = false;
    el.querySelector('button').onclick = function () { el.hidden = true; };
    clearTimeout(notice.timer);
    notice.timer = setTimeout(function () { el.hidden = true; }, 15000);
  }
  // Forget the key and fall back to the public site. `reload` when EDP2 data may already be on screen.
  function fail(reason, reload) {
    key = null;
    T.unlocked = false;
    forget();
    var msg = 'Team access is locked again: ' + reason + '. Unlock it from the top bar to try again.';
    if (reload) { U.ssSet(NOTICE, msg); window.location.reload(); return; }
    notice(msg);
  }

  // ------------------------------------------------------------------ loading and crypto
  function loadKeyInfo() {
    if (!kiPromise) {
      keyinfo = null;
      kiPromise = U.loadScript(DIR + 'keyinfo.js?t=' + Date.now()).then(function () {
        var k = keyinfo;
        if (!k || k.v !== 1 || k.kdf !== 'PBKDF2-SHA256' || !(k.iter >= MIN_ITER && k.iter <= MAX_ITER) ||
            typeof k.salt !== 'string' || !k.check || typeof k.check.iv !== 'string' || typeof k.check.ct !== 'string') {
          throw new Error('data/edp2/keyinfo.js is not valid');
        }
        return k;
      });
      kiPromise.catch(function () { kiPromise = null; });
    }
    return kiPromise;
  }
  function loadBlob(name, file) {
    delete blobs[name];
    return U.loadScript(DIR + file).then(function () {
      var b = blobs[name];
      delete blobs[name];
      if (!b || typeof b.iv !== 'string' || typeof b.ct !== 'string') throw new Error(file + ' is not an encrypted ' + name + ' blob');
      return b;
    });
  }
  function deriveBits(password, ki) {
    return subtle.importKey('raw', te.encode(password.normalize('NFC')), 'PBKDF2', false, ['deriveBits']).then(function (base) {
      return subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: b64d(ki.salt), iterations: ki.iter }, base, 256);
    }).then(function (bits) { return new Uint8Array(bits); });
  }
  function importKey(raw) {
    if (raw.length !== 32) return Promise.reject(new Error('the stored key has the wrong length'));
    return subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['decrypt']);
  }
  function decrypt(k, name, blob) {
    return subtle.decrypt({ name: 'AES-GCM', iv: b64d(blob.iv), additionalData: te.encode(AAD_PREFIX + name), tagLength: 128 }, k, b64d(blob.ct))
      .then(function (buf) { return new TextDecoder('utf-8', { fatal: true }).decode(buf); });
  }
  function decryptJson(k, name, blob) { return decrypt(k, name, blob).then(function (t) { return JSON.parse(t); }); }
  function verify(k, ki) {
    return decrypt(k, 'check', ki.check).then(function (t) {
      if (t !== CHECK_TEXT) throw new Error('key check failed');
      return k;
    });
  }

  // ------------------------------------------------------------------ boot: stored key -> decrypted catalogue payload
  T.ready = (function () {
    var pending = U.ssGet(NOTICE);
    if (pending) {
      try { window.sessionStorage.removeItem(NOTICE); } catch (e) { /* storage blocked */ }
      notice(pending);
    }
    var st = readStored();
    if (!st) return Promise.resolve(null);
    if (!subtle) { fail('this page cannot decrypt (WebCrypto needs https or localhost)'); return Promise.resolve(null); }
    var v = '?v=' + encodeURIComponent(st.salt.slice(0, 16));        // cache key per build
    var pCat = loadBlob('catalog', 'catalog.js' + v);
    pCat.catch(function () { /* reported through the chain below */ });
    return loadKeyInfo().then(function (ki) {
      if (ki.salt !== st.salt) throw new Error('stale');
      return importKey(b64d(st.key)).then(function (k) { return verify(k, ki); });
    }).then(function (k) {
      return pCat.then(function (blob) { return decryptJson(k, 'catalog', blob); }).then(function (p) {
        key = k;
        tag = v;
        return p;
      });
    }).catch(function (e) {
      console.warn('team access: ' + (e && e.message));
      fail(e && e.message === 'stale' ? 'the site data was rebuilt with a new key' : 'the encrypted data could not be read');
      return null;
    });
  })();

  // Merge the decrypted EDP2 columns and sources into the public catalogue {meta, cols, rows}.
  // Everything is validated before `d` is touched; on failure the catalogue stays public.
  T.apply = function (d, p) {
    try {
      var cols = p.cols, rows = p.rows, names = p.names, srcs = p.sources || {};
      if (p.v !== 1 || !Array.isArray(cols) || !Array.isArray(rows) || !Array.isArray(names) || rows.length !== names.length) {
        throw new Error('unexpected catalogue payload');
      }
      cols.forEach(function (c) {
        if (!/^((n|t0|t1)_)?edp2_[a-z0-9_]+$/.test(c) || d.cols.indexOf(c) >= 0) throw new Error('unexpected column ' + c);
      });
      Object.keys(srcs).forEach(function (k) { if (!/^edp2_[a-z0-9_]+$/.test(k)) throw new Error('unexpected source ' + k); });
      var at = new Map();
      names.forEach(function (n, k) { at.set(String(n), k); });
      var jn = d.cols.indexOf('name'), nc = cols.length;
      var blank = cols.map(function (c) { return /^n_/.test(c) ? 0 : null; });
      var add = d.rows.map(function (r) {
        var k = at.get(String(r[jn])), e = k === undefined ? blank : rows[k];
        if (!Array.isArray(e) || e.length !== nc) throw new Error('unexpected catalogue row');
        return e;
      });
      d.rows.forEach(function (r, i) { Array.prototype.push.apply(r, add[i]); });
      d.cols = d.cols.concat(cols);
      var merged = {};
      Object.keys(srcs).forEach(function (k) { merged[k] = srcs[k]; });            // EDP2 first, as in the private build
      Object.keys(d.meta.sources || {}).forEach(function (k) { if (!merged[k]) merged[k] = d.meta.sources[k]; });
      d.meta.sources = merged;
      d.meta.mode = 'private';
      d.meta.team = true;
      if (Array.isArray(p.notes)) d.meta.notes = p.notes;
      if (U.isNum(p.match_radius_arcsec)) d.meta.match_radius_arcsec = p.match_radius_arcsec;
      T.unlocked = true;
      return true;
    } catch (e) {
      console.warn('team access: ' + e.message);
      fail('the encrypted catalogue does not match this build');
      return false;
    }
  };

  // Decrypted EDP2 lightcurves for shard n: {name: {edp2_dia: LC, edp2_fp: LC}}.
  T.shard = function (n) {
    var name = 'lc-' + U.pad3(n);
    return loadBlob(name, U.pad3(n) + '.js' + tag).then(function (b) { return decryptJson(key, name, b); }).then(function (e) {
      if (!e || typeof e !== 'object' || Array.isArray(e)) throw new Error('unexpected ' + name + ' payload');
      Object.keys(e).forEach(function (o) {
        var s = e[o];
        if (!s || typeof s !== 'object') throw new Error('unexpected ' + name + ' payload');
        Object.keys(s).forEach(function (k) {
          if (!/^edp2_[a-z0-9_]+$/.test(k) || !s[k] || !Array.isArray(s[k].t)) throw new Error('unexpected ' + name + ' payload');
        });
      });
      return e;
    }).catch(function (err) {
      console.warn('team access: ' + err.message);
      fail('an encrypted lightcurve file could not be read', true);
      throw err;
    });
  };
  T.mergeShard = function (pub, enc) {
    Object.keys(enc).forEach(function (o) {
      var t = pub[o] || (pub[o] = {});
      Object.keys(enc[o]).forEach(function (k) { t[k] = enc[o][k]; });
    });
    return pub;
  };

  // ------------------------------------------------------------------ unlock with a password
  function userError(msg) { var e = new Error(msg); e.user = true; return e; }
  function unlock(password, remember) {
    if (!subtle) return Promise.reject(userError(NO_CRYPTO));
    var ki;
    return loadKeyInfo().catch(function () { throw userError('Team access is not available in this build.'); }).then(function (k) {
      ki = k;
      return deriveBits(password, ki);
    }).then(function (raw) {
      return importKey(raw).then(function (k) { return verify(k, ki); }).then(function () { return raw; },
        function () { throw userError('That password did not unlock the data.'); });
    }).then(function (raw) {
      forget();
      try {
        var box = remember ? window.localStorage : window.sessionStorage;
        box.setItem(STORE, JSON.stringify({ v: 1, salt: ki.salt, key: b64e(raw) }));
        if (!box.getItem(STORE)) throw new Error('not stored');
      } catch (e) {
        throw userError('This browser blocks site storage, so the key cannot be kept.');
      }
    });
  }

  // ------------------------------------------------------------------ top-bar button and dialog
  var dlg = null;
  function openDialog() {
    if (dlg) return;
    var scrim = document.createElement('div');
    scrim.className = 'scrim';
    var box = document.createElement('div');
    box.className = 'team-dlg card';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-labelledby', 'team-h');
    box.setAttribute('aria-describedby', 'team-d');
    box.innerHTML = '<form id="team-form" novalidate>' +
      '<div class="team-head">' + U.icon('lock', 1.9) + '<h2 id="team-h">Team access</h2></div>' +
      '<p class="team-text" id="team-d">Rubin DP2 (EDP2) catalogue photometry is proprietary and only for Rubin data-rights holders. ' +
      'This site stores it encrypted. The team password decrypts it in this browser, and nothing is sent anywhere.</p>' +
      '<input type="text" name="username" value="TNS EDP2 Explorer team" autocomplete="username" hidden>' +
      '<label class="team-lbl" for="team-pw">Team password</label>' +
      '<input class="input" type="password" id="team-pw" name="password" autocomplete="current-password" spellcheck="false" autocapitalize="off">' +
      '<p class="team-err" id="team-err" role="alert" hidden></p>' +
      '<label class="team-remember"><input type="checkbox" id="team-remember"><span>Remember on this device</span></label>' +
      '<p class="team-hint">Unchecked, the key is forgotten when you close this tab. Lock forgets it at any time.</p>' +
      '<div class="team-actions"><button type="button" class="btn" id="team-cancel">Cancel</button>' +
      '<button type="submit" class="btn btn-primary" id="team-go">Unlock</button></div></form>';
    document.body.appendChild(scrim);
    document.body.appendChild(box);
    var form = box.querySelector('form'), input = box.querySelector('#team-pw'), err = box.querySelector('#team-err');
    var go = box.querySelector('#team-go'), remember = box.querySelector('#team-remember');
    dlg = { scrim: scrim, box: box, ret: document.activeElement };
    function showErr(msg) { err.textContent = msg; err.hidden = !msg; input.classList.toggle('invalid', !!msg); }
    function disable(msg) { showErr(msg); input.disabled = true; go.disabled = true; remember.disabled = true; }
    if (!subtle) disable(NO_CRYPTO);
    else loadKeyInfo().catch(function () { if (dlg) disable('Team access is not available in this build.'); });
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var pw = input.value.trim();
      if (!pw) { showErr('Enter the team password.'); input.focus(); return; }
      showErr('');
      input.disabled = true; go.disabled = true;
      go.textContent = 'Unlocking…';
      unlock(pw, remember.checked).then(function () {
        input.value = '';
        go.textContent = 'Unlocked';
        window.location.reload();
      }).catch(function (e2) {
        input.disabled = false; go.disabled = false;
        go.textContent = 'Unlock';
        showErr(e2 && e2.user ? e2.message : 'Something went wrong while unlocking. Try again.');
        if (!(e2 && e2.user)) console.warn('team access: ' + (e2 && e2.message));
        input.focus();
        input.select();
      });
    });
    box.querySelector('#team-cancel').addEventListener('click', closeDialog);
    scrim.addEventListener('click', closeDialog);
    box.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.stopPropagation(); closeDialog(); return; }
      if (e.key !== 'Tab') return;
      var f = U.$all('input:not([disabled]):not([hidden]), button:not([disabled])', box);
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
    (input.disabled ? box.querySelector('#team-cancel') : input).focus();
  }
  function closeDialog() {
    if (!dlg) return;
    var ret = dlg.ret;
    dlg.scrim.remove();
    dlg.box.remove();
    dlg = null;
    if (ret && ret.focus && document.body.contains(ret)) ret.focus({ preventScroll: true });
  }
  function lock() {
    forget();
    key = null;
    window.location.reload();
  }

  // Called once the catalogue is initialised: a real private build needs no button, a public
  // build shows it only when it ships the encrypted layer (meta.team_access).
  T.initUi = function () {
    var btn = document.getElementById('team-btn');
    if (!btn) return;
    var offer = S.meta.mode === 'public' && !!S.meta.team_access;
    if (!T.unlocked && !offer) { btn.hidden = true; return; }
    if (T.unlocked) {
      btn.innerHTML = U.icon('unlock', 1.9) + '<span class="tb-l">Lock</span>';
      btn.title = 'Forget the team key in this browser and return to the public site';
      btn.setAttribute('aria-label', 'Lock: forget the team key');
      btn.classList.add('on');
    } else {
      btn.innerHTML = U.icon('lock', 1.9) + '<span class="tb-l">Team access</span>';
      btn.title = 'Unlock the Rubin DP2 (EDP2) layer with the team password';
      btn.setAttribute('aria-label', 'Team access: unlock the EDP2 layer');
    }
    btn.onclick = function () { if (T.unlocked) lock(); else openDialog(); };
    btn.hidden = false;
  };
})();
