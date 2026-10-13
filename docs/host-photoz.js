/* Candidate-galaxy redshift audit: public aggregates and encrypted team rows. */
(function () {
  'use strict';
  var X = window.TNSXApp, S = X.S, U = X.U, esc = U.esc;
  var request = null, search = '';
  var TEAM_COLS = ['transient_id', 'name', 'candidate_uid', 'association_status', 'confirmed_host_identity',
    'spectrum_status', 'candidate_specz', 'catalog_photoz', 'catalog_photoz_method', 'photoz_status',
    'photoz_quality_pass', 'sed_status', 'sed_rubin_z', 'sed_rubin_pass', 'sed_legacy_z', 'sed_legacy_pass',
    'sed_ps1_z', 'sed_ps1_pass', 'sed_adopted_as_hostz', 'science_usable'];
  var SED_FIELDS = ['z16', 'z84', 'z025', 'z975', 'temperature', 'temperature_calibration_available', 'source_validation_pass', 'review_flags'];
  var INTERVAL_FIELDS = ['low68', 'high68', 'low95', 'high95', 'support_pass'];
  ['rubin', 'legacy', 'ps1'].forEach(function (source) { SED_FIELDS.forEach(function (field) { TEAM_COLS.push('sed_'+source+'_'+field); }); });
  ['legacy_griz', 'legacy_grz'].forEach(function (method) { INTERVAL_FIELDS.forEach(function (field) { TEAM_COLS.push('expanded_'+method+'_'+field); }); });
  var SUPPLEMENTAL = ['supplemental_sed_fits_json', 'supplemental_photometry_outcomes_json', 'supplemental_catalog_photoz_json'];
  TEAM_COLS = TEAM_COLS.concat(SUPPLEMENTAL);
  var LABELS = {
    n_transients: 'Transients reviewed', n_selected_candidates: 'Selected candidate galaxies',
    n_selected_catalog_photoz: 'Candidates with catalog photo-z', n_selected_identity_matched_photoz: 'Identity matched photo-z',
    n_selected_screened_photoz: 'Candidate photo-z passing the screen', n_selected_missing_photoz: 'Candidate photo-z unavailable',
    n_selected_review_photoz: 'Candidate photo-z requiring review', n_selected_candidate_spectra: 'Candidates with secure source spectra',
    n_confirmed_host_identities: 'Independently confirmed host identities', n_science_usable: 'Science usable photo-z',
    n_sed_targets: 'Separate SED diagnostic targets', n_sed_finite: 'Targets with finite SED profiles',
    n_sed_screened: 'Targets with screened SED profiles', n_sed_consistent: 'Targets with consistent provisional SED constraints',
    n_sed_conflicts: 'Targets with cross-survey SED disagreements', n_validation_galaxies: 'Unique spectroscopic controls',
    n_selected_unique_galaxies: 'Unique selected candidate galaxies', n_no_selected_host: 'Transients without a selected galaxy',
    n_new_adopted_host_redshifts: 'Newly adopted host redshifts', n_sed_fit_groups: 'Independent aperture fit groups',
    n_target_aperture_fits: 'Target aperture fits', n_targets_with_eligible_photometry: 'Targets with eligible photometry',
    n_existing_provisional_host_specz: 'Existing provisional host spectra',
    n_supplemental_sed_fits: 'Separate supplemental aperture fits', n_priority_survey_outcomes: 'Priority survey-query outcomes',
    n_priority_survey_galaxies: 'Priority galaxies checked in additional surveys', n_supplemental_catalog_photoz_references: 'Supplemental catalog photo-z references'
  };
  var TIERS = {unresolved: 'Training membership / lineage unresolved', known_overlap_excluded: 'Declared training overlap excluded',
    local_run_holdout: 'Blinded local fixed-run holdout; ancestry unresolved'};
  window.TNSX.onHostPhotoz = function (data) { S.hostPhotozPublic = data; };
  X.checkHostPhotozTable = function (table) {
    if (!table || !Array.isArray(table.cols) || table.cols.join('|') !== TEAM_COLS.join('|') || !Array.isArray(table.rows)) throw new Error('unexpected candidate-redshift table');
    var seen = new Set();
    table.rows.forEach(function (row) {
      if (!Array.isArray(row) || row.length !== TEAM_COLS.length || typeof row[0] !== 'string' || seen.has(row[0]) || row[18] !== false || row[19] !== false) throw new Error('unexpected candidate-redshift row');
      seen.add(row[0]);
      SUPPLEMENTAL.forEach(function (column) {
        var raw = row[TEAM_COLS.indexOf(column)];
        if (raw == null) return;
        var items = JSON.parse(raw);
        if (!Array.isArray(items) || items.length>100 || items.some(function (item) { return !item || item.diagnostic_only!==true || item.adopted_as_hostz===true || item.use_for_fitting===true; })) throw new Error('unexpected supplemental diagnostics');
      });
    });
    return true;
  };
  function num(value, decimals) { return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(decimals == null ? 4 : decimals) : '—'; }
  function percent(value) { return typeof value === 'number' && Number.isFinite(value) ? (100*value).toFixed(1)+'%' : '—'; }
  function text(value) { return value == null || value === '' ? '—' : esc(String(value).replace(/_/g, ' ')); }
  function method(value) {
    var parts=String(value).split(':'), base=parts[0], suffix=parts[1];
    if (base==='own_sed_v9') return (suffix==='legacy' ? 'Legacy' : suffix==='rubin_dp2' ? 'Rubin' : 'Pan-STARRS')+' · v9 SED';
    if (base==='legacy_griz_wise' || base==='legacy_grz_wise') return 'Legacy '+(base.indexOf('griz')>=0 ? 'griz' : 'grz')+' + WISE'+(suffix ? ' · '+(suffix==='released' ? 'published intervals' : 'expanded intervals') : '');
    if (base.indexOf('dp2_')===0) return 'Rubin '+esc(base.slice(4).toUpperCase());
    return text(value);
  }
  function summary(data) {
    var keys = Object.keys(data.summary || {}).filter(function (key) { return LABELS[key] && data.summary[key] != null; });
    if (!keys.length) return '<p class="muted">The final audited release is being prepared. No provisional numbers are published here.</p>';
    return '<div class="hp-counts">'+keys.map(function (key) { return '<div class="card stat"><strong>'+U.fint(data.summary[key])+'</strong><span>'+esc(LABELS[key])+'</span></div>'; }).join('')+'</div>';
  }
  function validation(data) {
    var rows = data.validation || [];
    if (!rows.length) return '<p class="muted">No validation summary is attached to this release.</p>';
    return '<div class="card table-card"><div class="table-wrap"><table class="data"><thead><tr><th>Estimator / scope</th><th>N galaxies</th><th>Median bias</th><th>NMAD</th><th>Outliers</th><th>68% coverage</th><th>95% coverage</th><th>Independence evidence</th></tr></thead><tbody>'+rows.map(function (r) {
      return '<tr><th scope="row">'+method(r.method)+'<small class="hp-sub">'+text(r.scope)+'</small></th><td class="num">'+U.fint(r.n)+'</td><td class="num">'+num(r.median_bias)+'</td><td class="num">'+num(r.nmad)+'</td><td class="num">'+U.fint(r.n_outliers)+'/'+U.fint(r.n)+' · '+percent(r.outlier_fraction)+'</td><td class="num">'+percent(r.coverage68)+'</td><td class="num">'+percent(r.coverage95)+'</td><td>'+esc(TIERS[r.independence] || 'Unresolved')+'</td></tr>';
    }).join('')+'</tbody></table></div></div>';
  }
  function objects() {
    if (!(X.team && X.team.unlocked) || !S.hostPhotozTeam) return '<div class="card hp-access"><h2>Candidate galaxy results</h2><p>Per-object audit rows are available through the existing encrypted team-access layer for Rubin data-rights holders.</p>'+(X.teamOffer() ? '<button type="button" id="hp-unlock" class="teambtn">Unlock team access</button>' : '<p class="muted">No candidate-redshift team table is attached to this build.</p>')+'</div>';
    var table = S.hostPhotozTeam, at = {};
    table.cols.forEach(function (column, i) { at[column] = i; });
    var rows = table.rows.filter(function (r) { return !search || [r[at.transient_id], r[at.name], r[at.candidate_uid]].some(function (x) { return x != null && String(x).toLowerCase().indexOf(search.toLowerCase()) >= 0; }); });
    var body = rows.slice(0, 200).map(function (r) {
      function value(column) { return r[at[column]]; }
      var name = value('name') || value('transient_id');
      var label = '<span class="mono">'+esc(name)+'</span>';
      if (value('name') && S.byName.has(String(value('name')))) label = '<a href="#/object/'+encodeURIComponent(value('name'))+'">'+label+'</a>';
      var diagnostics = ['rubin', 'legacy', 'ps1'].map(function (source) {
        var prefix='sed_'+source+'_', z=value(prefix+'z');
        if (z == null) return '<p>'+source.toUpperCase()+': no diagnostic fit attached.</p>';
        return '<p><strong>'+source.toUpperCase()+'</strong> · z='+num(z)+' · '+(value(prefix+'pass') ? 'local screen pass' : 'review / failed screen')+'<br>68% profile interval: ['+num(value(prefix+'z16'))+', '+num(value(prefix+'z84'))+']; 95%: ['+num(value(prefix+'z025'))+', '+num(value(prefix+'z975'))+']<br>Temperature '+num(value(prefix+'temperature'),2)+' · '+(value(prefix+'temperature_calibration_available') ? 'development calibration available' : 'temperature calibration unavailable')+'<br>Fresh source validation: '+(value(prefix+'source_validation_pass') ? 'predeclared source gate passed' : 'not passed')+'<br>Review flags: '+text(value(prefix+'review_flags'))+'</p>';
      }).join('');
      var expanded = ['legacy_griz', 'legacy_grz'].map(function (method) {
        var prefix='expanded_'+method+'_';
        if (value(prefix+'low68') == null && value(prefix+'low95') == null) return '';
        return '<p><strong>'+method.replace(/_/g,' ')+'</strong> expanded catalog interval<br>68%: ['+num(value(prefix+'low68'))+', '+num(value(prefix+'high68'))+']; 95%: ['+num(value(prefix+'low95'))+', '+num(value(prefix+'high95'))+']<br>Development support domain: '+(value(prefix+'support_pass') ? 'within measured z and magnitude range' : 'outside / unverified')+'</p>';
      }).join('');
      function extra(column) { return value(column) == null ? [] : JSON.parse(value(column)); }
      var supplements = extra('supplemental_sed_fits_json').map(function (item) {
        return '<p><strong>'+text(item.source_catalog)+' · '+text(item.aperture)+'</strong><br>Diagnostic z='+num(item.z_best)+'; 68% ['+num(item.z16)+', '+num(item.z84)+']; 95% ['+num(item.z025)+', '+num(item.z975)+']<br>Quality screen: '+(item.quality_pass ? 'local pass' : 'review / failed')+'; covariance used: '+(item.covariance_used ? 'yes' : 'no')+'<br>Fit flags: '+text(item.review_flags)+'<br>Photometry flags: '+text(item.input_photometry_review_flags)+'</p>';
      }).join('');
      supplements += extra('supplemental_catalog_photoz_json').map(function (item) {
        return '<p><strong>'+text(item.source_catalog)+' catalog reference</strong> · '+text(item.method)+'<br>z='+num(item.photoz_point)+'; published σ='+num(item.photoz_sigma)+'; 68% ['+num(item.photoz_lo68)+', '+num(item.photoz_hi68)+']<br>Catalog quality: '+text(item.quality ? JSON.stringify(item.quality) : null)+'</p>';
      }).join('');
      supplements += extra('supplemental_photometry_outcomes_json').map(function (item) {
        return '<p><strong>'+text(item.source_catalog)+'</strong> · '+text(item.outcome)+'<br>Identity: '+(item.identity_verified ? 'verified counterpart' : 'unverified / unavailable')+'; usable bands: '+num(item.usable_band_count,0)+'; neighbor records: '+num(item.neighbor_records,0)+'<br>Limitation: '+text(item.main_limitation)+'</p>';
      }).join('');
      return '<tr><th scope="row">'+label+'<small class="hp-sub mono">'+text(value('candidate_uid'))+'</small></th><td>'+text(value('association_status'))+'<small class="hp-sub">Host identity: '+(value('confirmed_host_identity') ? 'confirmed' : 'unconfirmed')+'</small></td><td class="num">'+num(value('candidate_specz'))+'<small class="hp-sub">'+text(value('spectrum_status'))+'</small></td><td class="num">'+num(value('catalog_photoz'))+'<small class="hp-sub">'+text(value('catalog_photoz_method'))+'</small>'+(expanded ? '<details><summary>Separate expanded intervals</summary>'+expanded+'<p>Diagnostic expansion only; the original point estimate is unchanged. Being within the development range does not guarantee population coverage.</p></details>' : '')+'</td><td>'+text(value('photoz_status'))+'<small class="hp-sub">'+(value('photoz_quality_pass') ? 'Candidate photo-z screen pass' : 'Review / unavailable')+'</small></td><td><details><summary>SED diagnostics</summary><p>'+text(value('sed_status'))+'</p>'+diagnostics+'<p>Not adopted as host redshift. Finite values and local QC do not establish accuracy or calibrated intervals.</p></details>'+(supplements ? '<details><summary>Additional survey diagnostics</summary>'+supplements+'<p>Each aperture is fitted separately. These values and published photo-z references are not adopted as host redshifts.</p></details>' : '')+'</td></tr>';
    }).join('');
    return '<h2>Candidate galaxy results <span class="chip">Team access</span></h2><p>These are candidate-galaxy measurements. An association still requires an independent host check. SED diagnostics remain separate from the catalog photo-z and spectrum.</p><label class="hp-search">Find by transient, TNS name or candidate ID<input id="hp-search" type="search" value="'+esc(search)+'" autocomplete="off"></label><p class="muted">'+U.fint(rows.length)+' matching rows'+(rows.length>200 ? '; showing the first 200, use the filter to narrow the list' : '')+'.</p><div class="card table-card"><div class="table-wrap hp-object-table"><table class="data"><thead><tr><th>Transient / candidate</th><th>Association</th><th>Candidate spectrum z</th><th>Catalog photo-z</th><th>Photo-z status</th><th>Separate SED audit</th></tr></thead><tbody>'+body+'</tbody></table></div></div>';
  }
  function render() {
    var root = document.getElementById('view-host-photoz'), data = S.hostPhotozPublic || {summary:{}, validation:[], status:'pending'};
    root.innerHTML = '<div class="wrap"><article class="prose wide hp-page"><p class="eyebrow">Host redshift audit</p><h1 tabindex="-1">Candidate-galaxy redshifts</h1><p class="lede">A galaxy redshift and a transient’s host identity are separate pieces of evidence. This page keeps catalog photo-z, original spectra and exploratory SED fits distinct.</p><div class="card hp-notice"><strong>Diagnostic results</strong><p>Unresolved means the available evidence has not settled the question. Missing a catalog spectrum does not mean the galaxy has never been observed. A failed or unvalidated SED fit is never adopted as a host redshift.</p></div><h2>Latest audited release</h2><p class="muted">'+(data.status==='complete' ? esc(data.release)+' · final source manifest <span class="mono">'+esc(data.manifest_sha256.slice(0,12))+'…</span>' : 'Publication pending the final release')+'</p>'+summary(data)+'<h2>Spectrum comparison</h2><p>Each denominator counts distinct physical galaxies. Residuals are (z<sub>photo</sub>−z<sub>spec</sub>)/(1+z<sub>spec</sub>); outliers exceed 0.15 in absolute value. Screened samples are selected and do not represent every faint candidate.</p>'+validation(data)+'<h2>Training and uncertainty limits</h2><ul><li>Legacy training flags false in both variants exclude declared overlap; they do not establish independence from all training surveys, releases or calibration.</li><li>Rubin training membership remains unresolved unless exact model-specific evidence is supplied.</li><li>A blinded local fixed-template run tests that run without using control redshifts. Historical template selection and calibration ancestry can still be unresolved.</li><li>Profile-likelihood densities are not fully marginalized or calibrated redshift posteriors. Reported intervals require empirical coverage checks.</li></ul>'+objects()+'</article></div>';
    var unlock = document.getElementById('hp-unlock');
    if (unlock) unlock.onclick = function () { X.team.openDialog(); };
    var field = document.getElementById('hp-search');
    if (field) field.oninput = function () { search = field.value; var start=field.selectionStart; render(); var next=document.getElementById('hp-search'); next.focus(); next.setSelectionRange(start,start); };
  }
  X.views['host-photoz'] = {show:function () {
    document.title = 'Candidate galaxy redshifts · TNS EDP2 Explorer';
    if (!request) request=U.loadScript('data/host_photoz.js?t='+Date.now()).then(render).catch(function () { render(); });
    render();
  }};
})();
